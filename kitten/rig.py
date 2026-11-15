"""Pure-python 2D skeletal rig for the kitten (no Qt here, so it can be tested anywhere).

Local frame: x points where the kitten faces, y points down, (0, 0) is the ground point under
his middle. Rig.frame() returns a list of draw items in WORLD coordinates that draw.py paints.

Pieces: pelvis + chest (spine bean), 4 legs (2-bone IK, planted paws), neck, image head
(expressions, blink lids, ear flicks, eye glow), 7-segment verlet tail, navy bandana.
"""
import math
import random

# ----------------------------------------------------------------- proportions (px at size 1)
PELVIS = (-25.0, -38.0)
CHEST = (15.0, -42.0)
R_PELVIS, R_CHEST = 18.0, 21.0
LEG = {  # name: (neutral foot x, hip offset from its body anchor, upper, lower, bend sign, far?)
    "hn": (-24.0, (-1.0, 9.0), 20.0, 19.0, -1, False),
    "hf": (-19.0, (3.0, 7.0), 20.0, 19.0, -1, True),
    "fn": (17.0, (2.0, 10.0), 18.0, 18.0, 1, False),
    "ff": (22.0, (6.0, 8.0), 18.0, 18.0, 1, True),
}
HEAD_W = 120.0  # on-screen head width at size 1
TAIL_N = 7
TAIL_SEG = 9.5

# gait table: (max speed, cycle length, duty, lift, phase offsets hn, fn, hf, ff)
GAITS = {
    "walk": (140, 46.0, 0.62, 6.0, (0.0, 0.25, 0.5, 0.75)),
    "trot": (330, 64.0, 0.50, 9.0, (0.0, 0.5, 0.5, 0.0)),
    "gallop": (1e9, 110.0, 0.40, 11.0, (0.0, 0.58, 0.10, 0.68)),
}


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(v, a, b):
    return a if v < a else b if v > b else v


def smooth(t):
    t = clamp(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def ik2(hx, hy, fx, fy, a, b, bend):
    """Two-bone IK in a y-down frame. Returns (knee, foot) - foot is pulled in if out of reach."""
    dx, dy = fx - hx, fy - hy
    d = math.hypot(dx, dy) or 1e-6
    if d > a + b - 0.01:
        k = (a + b - 0.01) / d
        fx, fy = hx + dx * k, hy + dy * k
        dx, dy, d = fx - hx, fy - hy, a + b - 0.01
    d = max(d, abs(a - b) + 0.01)
    ca = clamp((a * a + d * d - b * b) / (2 * a * d), -1.0, 1.0)
    ang = math.atan2(dy, dx) + bend * math.acos(ca)
    return (hx + a * math.cos(ang), hy + a * math.sin(ang)), (fx, fy)


class Leg:
    def __init__(self, name):
        self.name = name
        nx, hip, a, b, bend, far = LEG[name]
        self.nx, self.hip, self.a, self.b, self.bend, self.far = nx, hip, a, b, bend, far
        self.fx = 0.0  # planted world x (ground mode)
        self.swing = None  # (from_x, to_x, t, dur, lift)
        self.local = (nx, 0.0)


class Rig:
    PARAMS = dict(crouch=0.0, sit=0.0, lie=0.0, stretch=0.0, lean=0.0, head_rot=0.0, head_dx=0.0,
                  head_dy=0.0, tail_up=0.75, tail_wag=0.15, air=0.0, reach=0.0, paw=0.0, paw_x=40.0,
                  paw_y=-30.0, puff=0.0, glow=1.0, hang=0.0, climb=0.0, tuck=0.0, look_down=0.0, upright=0.0)

    def __init__(self, scale=1.0):
        self.scale = scale
        self.p = dict(self.PARAMS)
        self.t = dict(self.PARAMS)
        self.tau = 0.07  # pose crossfade time constant (~200 ms to settle)
        self.legs = {n: Leg(n) for n in LEG}
        self.phase = 0.0
        self.gait = "walk"
        self.time = 0.0
        # pose state set by the body/motor each frame
        self.x, self.y = 0.0, 0.0      # world root
        self.facing = 1
        self.rot = 0.0                 # degrees, whole-body
        self.mode = "ground"           # ground | air | climb | hang | peek | held
        self.vx = self.vy = 0.0
        self.ground_speed = 0.0
        self.view = "side"
        self.expr = "neutral"
        self.flip_t = 1.0              # turn animation 0..1 (squash through x=0)
        self.clip = None               # world-space half-plane (y) below which nothing is drawn
        self.peek_up = 1.0             # peek: how far the head is up over the edge
        self.zoom = 1.0                # extra scale (giant face)
        self.squash_y = 0.0            # landing absorb (spring, never overshoots)
        self.squash_v = 0.0
        self.blink = 0.0
        self.next_blink = 2.0
        self.ear = [0.0, 0.0]
        self.ear_t = [3.0, 5.0]
        self.tail = None
        self.tail_prev = None
        self.events = []               # footsteps etc. for the sound layer
        self.hold_blink = False

    # --------------------------------------------------------------- params
    def set(self, **kw):
        for k, v in kw.items():
            if k in self.t:
                self.t[k] = float(v)
            else:
                setattr(self, k, v)

    def reset_pose(self):
        for k, v in self.PARAMS.items():
            self.t[k] = v

    def snap(self):
        self.p.update(self.t)

    # --------------------------------------------------------------- transforms
    def to_world(self, lx, ly):
        s = self.scale * self.zoom
        fx = lx * self.facing * (2 * self.flip_t - 1 if self.flip_t < 1 else 1)
        a = math.radians(self.rot)
        c, si = math.cos(a), math.sin(a)
        x, y = fx * s, ly * s
        return self.x + x * c - y * si, self.y + x * si + y * c

    def to_local(self, wx, wy):
        s = self.scale * self.zoom
        a = math.radians(self.rot)
        c, si = math.cos(a), math.sin(a)
        dx, dy = wx - self.x, wy - self.y
        x, y = dx * c + dy * si, -dx * si + dy * c
        f = self.facing * (2 * self.flip_t - 1 if self.flip_t < 1 else 1)
        if abs(f) < 1e-3:
            f = 1e-3
        return x / s / f, y / s

    # --------------------------------------------------------------- gait / feet
    def place_feet(self):
        """Plant all paws at their neutral spots (after landing, teleports, turns)."""
        for leg in self.legs.values():
            leg.fx = self.x + self.facing * leg.nx * self.scale
            leg.swing = None

    def move_feet(self, dx):
        for leg in self.legs.values():
            leg.fx += dx
            if leg.swing:
                f, t, tt, d, lf = leg.swing
                leg.swing = (f + dx, t + dx, tt, d, lf)

    def _gait_for(self, v):
        for name in ("walk", "trot", "gallop"):
            if v <= GAITS[name][0]:
                return name
        return "gallop"

    def update_feet(self, dt, dx):
        """dx = how far the root moved along the ground this frame (world px)."""
        v = abs(dx) / dt if dt > 0 else 0.0
        self.ground_speed = lerp(self.ground_speed, v, 1 - math.exp(-dt / 0.1))
        s = self.scale
        g = self._gait_for(self.ground_speed if v > 1 else 0)
        if g != self.gait and v > 1:
            self.gait = g
        _, L, duty, lift, offs = GAITS[self.gait]
        L *= s
        direction = 1 if dx >= 0 else -1
        moving = v > 4
        old = self.phase
        if moving:
            self.phase = (self.phase + abs(dx) / L) % 1.0
        order = ("hn", "fn", "hf", "ff")
        for i, n in enumerate(order):
            leg = self.legs[n]
            neutral = self.x + self.facing * leg.nx * s
            if leg.swing:
                f, t, tt, d, lf = leg.swing
                if moving:  # keep re-aiming the swing so it lands ahead of the moving body
                    t = self.x + self.facing * leg.nx * s + direction * L * duty * 0.5 \
                        + direction * v * max(0.0, d - tt) * 0.9
                else:
                    t = neutral
                tt += dt
                if tt >= d:
                    leg.fx = t
                    leg.swing = None
                    self.events.append(("step", leg.far))
                else:
                    leg.swing = (f, t, tt, d, lf)
                continue
            if moving:
                p0 = (old + offs[i]) % 1.0
                p1 = (self.phase + offs[i]) % 1.0
                crossed = (p0 < duty <= p1) or (p1 < p0 and (duty > p0 or duty <= p1))
                behind = (leg.fx - neutral) * direction < -L * duty * 0.75
                if crossed or behind:
                    d = clamp((1 - duty) * L / max(v, 1.0), 0.07, 0.3)
                    leg.swing = (leg.fx, neutral, 0.0, d, lift * s * (0.8 + 0.2 * random.random()))
            else:
                # idle: a lazy corrective step if a paw is far from where it should be
                if abs(leg.fx - neutral) > 6 * s and not any(l.swing for l in self.legs.values()):
                    leg.swing = (leg.fx, neutral, 0.0, 0.16, 5 * s)

    def foot_world(self, leg):
        if leg.swing:
            f, t, tt, d, lf = leg.swing
            k = smooth(tt / d)
            return lerp(f, t, k), self.y - math.sin(math.pi * clamp(tt / d, 0, 1)) * lf
        return leg.fx, self.y

    # --------------------------------------------------------------- update
    def update(self, dt, dx=0.0):
        self.time += dt
        a = 1 - math.exp(-dt / self.tau)
        for k in self.p:
            self.p[k] += (self.t[k] - self.p[k]) * a
        # landing absorb: critically damped spring back to 0 (no bounce-back)
        w = 14.0
        acc = -2 * w * self.squash_v - w * w * self.squash_y
        self.squash_v += acc * dt
        self.squash_y += self.squash_v * dt
        if self.squash_y < 0:
            self.squash_y, self.squash_v = 0.0, 0.0
        if self.flip_t < 1:
            self.flip_t = min(1.0, self.flip_t + dt / 0.16)
        # blink / ear flicks
        if not self.hold_blink:
            self.next_blink -= dt
            if self.next_blink <= 0:
                self.blink = 0.0001
                self.next_blink = random.uniform(2.5, 6.0) * (0.5 if random.random() < 0.2 else 1)
            if self.blink > 0:
                self.blink += dt / 0.16
                if self.blink >= 1:
                    self.blink = 0.0
        for i in range(2):
            self.ear_t[i] -= dt
            if self.ear_t[i] <= 0:
                self.ear_t[i] = random.uniform(3.0, 9.0)
                self.ear[i] = 1.0
            self.ear[i] = max(0.0, self.ear[i] - dt / 0.22)
        if self.mode == "ground":
            self.update_feet(dt, dx)
        self.update_tail(dt)

    def land(self, impact):
        """impact = downward speed in px/s. Knees bend, body sinks, then rises - never bounces."""
        self.squash_v = clamp(impact / 2600.0, 0.15, 1.0) * 9.0
        self.place_feet()

    def turn(self, facing):
        if facing != self.facing:
            self.facing = facing
            self.flip_t = 0.0
            self.place_feet()
            self.tail = None

    def blinking(self):
        if self.hold_blink:
            return 2
        if self.blink <= 0:
            return 0
        return 1 if (self.blink < 0.25 or self.blink > 0.75) else 2

    # --------------------------------------------------------------- skeleton
    def skeleton(self):
        P = self.p
        crouch = clamp(P["crouch"] + self.squash_y * 0.55, 0.0, 1.3)
        sit, lie, st = P["sit"], P["lie"], P["stretch"]
        g = GAITS[self.gait]
        moving = self.mode == "ground" and self.ground_speed > 8
        ph = self.phase * 2 * math.pi
        sp = clamp(self.ground_speed / 400.0, 0, 1)
        # body bob and spine flex tied to speed
        bob = 0.0
        flex = 0.0
        pitch = P["lean"]
        if moving:
            if self.gait == "walk":
                bob = 1.2 * math.cos(2 * ph)
            elif self.gait == "trot":
                bob = 2.4 * math.cos(2 * ph)
            else:
                bob = 4.0 * math.sin(ph)
                flex = 5.5 * math.sin(ph)
                pitch += 0.08 * math.cos(ph)
        breath = math.sin(self.time * 2.4) * 0.9 * (1 if not moving else 0)
        drop = crouch * 13
        px, py = PELVIS[0] - flex, PELVIS[1] + drop + bob * 0.6
        cx, cy = CHEST[0] + flex, CHEST[1] + drop + bob - breath
        # sit: haunches down, chest up
        px, py = lerp(px, -11, sit), lerp(py, -19, sit)
        cx, cy = lerp(cx, 12, sit), lerp(cy, -50, sit)
        # lie / loaf
        px, py = lerp(px, -16, lie), lerp(py, -19, lie)
        cx, cy = lerp(cx, 15, lie), lerp(cy, -21, lie)
        # stretch: front low, butt up
        px, py = lerp(px, -22, st), lerp(py, -46, st)
        cx, cy = lerp(cx, 22, st), lerp(cy, -24, st)
        # air: body stretched in rise, tucked at the top
        if self.mode == "air":
            cx += P["reach"] * 3
            px -= P["reach"] * 3
        # pitch around the middle
        mx, my = (px + cx) / 2, (py + cy) / 2
        c, s = math.cos(pitch), math.sin(pitch)

        def rp(x, y):
            dx, dy = x - mx, y - my
            return mx + dx * c - dy * s, my + dx * s + dy * c
        pel, che = rp(px, py), rp(cx, cy)
        return pel, che, sp, crouch

    def frame(self):
        """Build the draw list (world coordinates)."""
        if self.view == "peek":
            return self.frame_peek()
        P = self.p
        s = self.scale * self.zoom
        pel, che, sp, crouch = self.skeleton()
        items = []
        W = self.to_world
        ang = math.atan2(che[1] - pel[1], che[0] - pel[0])
        nx, ny = -math.sin(ang), math.cos(ang)  # body "down" normal
        anchors = {"h": pel, "f": che}
        feet = {}
        far_items, near_items, details, raised = [], [], [], []
        for n, leg in self.legs.items():
            base = anchors[n[0]]
            hx = base[0] + leg.hip[0] * math.cos(ang) - leg.hip[1] * math.sin(ang)
            hy = base[1] + leg.hip[0] * math.sin(ang) + leg.hip[1] * math.cos(ang)
            # where the paw wants to be (local)
            if self.mode == "ground":
                fwx, fwy = self.foot_world(leg)
                lx, ly = self.to_local(fwx, fwy)
            else:
                lx, ly = leg.nx, 0.0
            pose_w = 0.0
            tx, ty = lx, ly
            if self.mode == "air":
                # rising: front reach forward, hind trail; falling: all reach down for the landing
                r = P["reach"]
                tu = P["tuck"]
                if n[0] == "f":
                    tx, ty = lerp(hx + 14, hx + 4, tu), lerp(hy + 22, hy + 12, tu)
                else:
                    tx, ty = lerp(hx - 14, hx + 2, tu), lerp(hy + 22, hy + 12, tu)
                tx, ty = lerp(tx, leg.nx, r), lerp(ty, hy + leg.a + leg.b - 3, r)
                pose_w = 1.0
            elif self.mode == "climb":
                cyc = (self.phase + {"hn": 0, "fn": .5, "hf": .5, "ff": 0}[n]) % 1
                tx = leg.nx + 9 * math.cos(cyc * 2 * math.pi)
                ty = -max(0.0, math.sin(cyc * 2 * math.pi)) * 6
                pose_w = 1.0
            elif self.mode == "hang":
                if n[0] == "f":
                    tx, ty = che[0] + 26 + (4 if leg.far else 0), che[1] - 14
                else:
                    sw = math.sin(self.time * 2.0 + (1 if leg.far else 0)) * 3
                    tx, ty = hx - 8 + sw, hy + 28
                pose_w = 1.0
            # sit / lie / stretch targets
            if self.mode == "ground":
                sit, lie, st = P["sit"], P["lie"], P["stretch"]
                if n[0] == "h":
                    sx, sy = leg.nx + 13, 0.0
                    lx2, ly2 = hx + 16, -3.0
                    stx, sty = leg.nx - 6, 0.0
                else:
                    sx, sy = leg.nx - 3, 0.0
                    lx2, ly2 = hx + 15, -3.0
                    stx, sty = leg.nx + 26, 0.0
                w = max(sit, lie, st)
                if w > 0.001:
                    bx = (sx * sit + lx2 * lie + stx * st) / (sit + lie + st)
                    by = (sy * sit + ly2 * lie + sty * st) / (sit + lie + st)
                    tx, ty = lerp(tx, bx, w), lerp(ty, by, w)
                    pose_w = w
            # paw override (tap, swipe, salute, groom) on the near front leg; far front copies a bit
            if n == "fn" and P["paw"] > 0.001:
                tx, ty = lerp(tx, P["paw_x"], P["paw"]), lerp(ty, P["paw_y"], P["paw"])
            knee, foot = ik2(hx, hy, tx, ty, leg.a, leg.b, leg.bend)
            feet[n] = foot
            lifted = foot[1] < -1.5 or pose_w > 0.5 and self.mode != "ground"
            pr = 6.5 if n[0] == "f" else 7.0
            ur = 7.6 if n[0] == "f" else 8.2
            lr = 6.0
            chain = [(hx, hy, ur), (knee[0], knee[1], lr + 0.8), (foot[0], foot[1] - 2.5, lr)]
            circles = []
            for (x0, y0, r0), (x1, y1, r1) in zip(chain, chain[1:]):
                d = math.hypot(x1 - x0, y1 - y0)
                k = max(2, int(d / 3.0))
                for j in range(k + 1):
                    t = j / k
                    circles.append(("c", lerp(x0, x1, t), lerp(y0, y1, t), lerp(r0, r1, t)))
            if n[0] == "h":
                circles.append(("c", hx + 1, hy - 3, 12.5 * (1 + 0.15 * P["sit"])))  # thigh
            paw_ang = 0.0 if not lifted else (0.5 if n[0] == "f" else -0.4)
            circles.append(("e", foot[0] + 2.0, foot[1] - 3.2, pr + 1.2, 4.6, paw_ang))
            if n == "fn" and P["paw"] > 0.5 and P["paw_y"] < -50:
                raised.extend(circles)  # paw up by the face: drawn over the head (salute, groom)
            else:
                (far_items if leg.far else near_items).extend(circles)
            if not leg.far:
                # toe lines
                for k in (-1, 1):
                    details.append([(foot[0] + 2 + k * 2.6, foot[1] - 5.5), (foot[0] + 2 + k * 2.2, foot[1] - 1.5)])
        # torso bean (circles along the spine)
        torso = []
        for j in range(13):
            t = j / 12
            x, y = lerp(pel[0], che[0], t), lerp(pel[1], che[1], t)
            r = lerp(R_PELVIS, R_CHEST, t) * (1 + 0.06 * math.sin(math.pi * t)) * (1 + 0.08 * P["puff"])
            torso.append(("c", x, y, r))
        # chest ruff tufts
        for k in range(4):
            a2 = ang + math.radians(70 + k * 18)
            torso.append(("c", che[0] + math.cos(a2) * (R_CHEST - 1), che[1] + math.sin(a2) * (R_CHEST - 1), 5.5))
        # tail (world verlet -> local)
        tail = []
        if self.tail:
            pts = [self.to_local(*p) for p in self.tail]
            n_ = len(pts)
            for j in range(n_ - 1):
                (x0, y0), (x1, y1) = pts[j], pts[j + 1]
                for q in range(3):
                    t = q / 3
                    u = (j + t) / (n_ - 1)
                    r = 7.0 + 1.6 * math.sin(u * math.pi * 0.9) + (1.6 if u > 0.8 else 0)
                    tail.append(("c", lerp(x0, x1, t), lerp(y0, y1, t), r * (1 + 0.2 * P["puff"])))
            tail.append(("c", pts[-1][0], pts[-1][1], 7.2 * (1 + 0.2 * P["puff"])))
        # ---- emit in draw order (world coords)
        sc = s

        def conv(lst):
            out = []
            for it in lst:
                if it[0] == "c":
                    x, y = W(it[1], it[2])
                    out.append(("c", x, y, it[3] * sc))
                else:
                    x, y = W(it[1], it[2])
                    out.append(("e", x, y, it[3] * sc, it[4] * sc, self._wangle(it[5])))
            return out
        items.append(("blob", "far", conv(far_items)))
        items.append(("blob", "body", conv(tail + torso + near_items)))
        # thigh contour + toes
        hn_hip = self.legs["hn"]
        tc = []
        for k in range(7):
            a3 = math.radians(-40 + k * 25)
            tc.append(W(pel[0] + 1 + math.cos(a3) * 11, pel[1] + 6 + math.sin(a3) * 11))
        items.append(("lines", "shade", [tc] + [[W(*p) for p in d] for d in details], 1.4 * sc))
        # bandana + head at the neck
        lean = P["lean"]
        nkx, nky = che[0] + 13 + P["head_dx"], che[1] - 19 + P["head_dy"]
        if P["sit"] > 0.01:
            nky -= 4 * P["sit"]
        bandana = [(-17, -2), (-6, -9), (16, -9), (19, -1), (12, 10), (6, 20), (-2, 9)]
        bw = [W(nkx + bx, nky + by + 4) for bx, by in bandana]
        items.append(("poly", "bandana", bw))
        items.append(("lines", "bandana_line", [[W(nkx - 3, nky + 2), W(nkx + 5, nky + 13)]], 1.2 * sc))
        hrot = P["head_rot"] - math.degrees(lean) * 0.4 + P["look_down"] * 18
        items.append(self._head_item(nkx, nky + 2, hrot))
        if raised:
            items.append(("blob", "body", conv(raised)))
        return items

    def _wangle(self, a):
        f = self.facing
        return math.degrees(a) * f + self.rot

    def _head_item(self, lx, ly, rot_deg, view="side"):
        x, y = self.to_world(lx, ly)
        mirror = self.facing < 0
        sx = (2 * self.flip_t - 1) if self.flip_t < 1 else 1.0
        net = rot_deg * self.facing + self.rot
        net = net + (math.copysign(8, self.facing * -1) - net) * self.p["upright"] if self.p["upright"] > 0.01 else net
        return ("head", view, self.expr, x, y, net,
                HEAD_W * self.scale * self.zoom, mirror, self.blinking(), list(self.ear), self.p["glow"], sx)

    def frame_peek(self):
        """Front-facing peek over an edge: head + two paws, everything below the edge clipped."""
        up = self.peek_up
        items = []
        W = self.to_world
        s = self.scale * self.zoom
        paws = []
        for k in (-1, 1):
            px = k * 36
            py = lerp(12, -2, up)
            x, y = W(px, py)
            paws.append(("e", x, y, 13 * s, 9 * s, self.rot))
        hx, hy = 0, lerp(70, -14, up) + math.sin(self.time * 2.4) * 0.8
        x, y = W(hx, hy)
        items.append(("head", "front", self.expr, x, y, self.p["head_rot"] + self.rot,
                      HEAD_W * 1.12 * self.scale * self.zoom, False, self.blinking(), list(self.ear),
                      self.p["glow"], 1.0))
        items.append(("blob", "body", paws))
        items.append(("lines", "shade", [[W(px + d, -6), W(px + d, 2)] for px in (-36, 36) for d in (-4, 4)],
                      1.3 * s))
        return items

    # --------------------------------------------------------------- tail
    def tail_rest(self):
        """Rest shape of the tail in local coords, from the pelvis back/up."""
        P = self.p
        pel, che, sp, crouch = self.skeleton()
        bx, by = pel[0] - R_PELVIS * 0.8, pel[1] - 4
        up = P["tail_up"]
        wag = P["tail_wag"]
        pts = [(bx, by)]
        ang = math.radians(lerp(185, 245, up))  # pointing back, then up
        if self.mode == "ground" and self.ground_speed > 200:
            ang = math.radians(lerp(180, 205, up))
        if P["lie"] > 0.5:
            ang = math.radians(175)
        x, y = bx, by
        for i in range(1, TAIL_N):
            curl = lerp(0.0, 0.32, up) + 0.2 * P["lie"]
            ang += curl * (1 if P["lie"] < 0.5 else -1.6) + wag * 0.35 * math.sin(self.time * 3.1 - i * 0.6)
            x += math.cos(ang) * TAIL_SEG
            y += math.sin(ang) * TAIL_SEG
            pts.append((x, y))
        return pts

    def update_tail(self, dt):
        if self.view == "peek":
            self.tail = None
            return
        rest = [self.to_world(*p) for p in self.tail_rest()]
        if not self.tail or len(self.tail) != len(rest):
            self.tail = list(rest)
            self.tail_prev = list(rest)
            return
        seg = TAIL_SEG * self.scale * self.zoom
        stiff = 1 - math.exp(-dt / 0.06)
        grav = 900 * dt * dt if self.mode == "hang" else 0
        new = [rest[0]]
        for i in range(1, len(rest)):
            x, y = self.tail[i]
            px, py = self.tail_prev[i]
            vx, vy = (x - px) * 0.86, (y - py) * 0.86 + grav
            nx, ny = x + vx, y + vy
            k = stiff * (1.0 - 0.07 * i)
            nx += (rest[i][0] - nx) * k
            ny += (rest[i][1] - ny) * k
            new.append((nx, ny))
        for _ in range(2):  # length constraints
            for i in range(1, len(new)):
                ax, ay = new[i - 1]
                bx, by = new[i]
                d = math.hypot(bx - ax, by - ay) or 1e-6
                new[i] = (ax + (bx - ax) * seg / d, ay + (by - ay) * seg / d)
        self.tail_prev = self.tail
        self.tail = new

    def shift(self, dx, dy):
        """Rigidly move everything (riding a moving window)."""
        self.x += dx
        self.y += dy
        self.move_feet(dx)
        if self.tail:
            self.tail = [(x + dx, y + dy) for x, y in self.tail]
            self.tail_prev = [(x + dx, y + dy) for x, y in self.tail_prev]

    def bounds(self, items, pad=6):
        xs, ys = [], []
        for it in items:
            if it[0] == "blob":
                for c in it[2]:
                    r = c[3] if c[0] == "c" else max(c[3], c[4])
                    xs += [c[1] - r, c[1] + r]
                    ys += [c[2] - r, c[2] + r]
            elif it[0] in ("poly",):
                xs += [p[0] for p in it[2]]
                ys += [p[1] for p in it[2]]
            elif it[0] == "head":
                r = it[6] * 0.85
                xs += [it[3] - r, it[3] + r]
                ys += [it[4] - r * 1.7, it[4] + r * 0.5]
        if not xs:
            return self.x - 10, self.y - 10, self.x + 10, self.y + 10
        return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad

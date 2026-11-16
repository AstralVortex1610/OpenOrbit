"""Pure-python 2D rig for the kitten (no Qt here, so it can be tested anywhere).

v3 "mochi" style: an original soft round white cartoon cat drawn entirely from procedural shapes
(no sprites) - huge squishy head, tiny dot eyes, ':3' mouth, pink blush, stubby legs, short soft tail,
thick soft hand-drawn outline.

Local frame: x points where the kitten faces, y points down, (0, 0) is the ground point under
his middle. Rig.frame() returns a list of draw items in WORLD coordinates that draw.py paints.

Animation feel (emulates hand-drawn GIFs):
  * the POSE is sampled "on twos" (12 poses/s) and held, while position / physics stay smooth
  * line boil: every outline vertex wobbles a hair every couple of poses
  * mochi body: squash & stretch plus an underdamped jiggle spring (wobbly settle, overshoot)
  * springy follow-through on head / ears, idle life (breathing, glances, blinks)
  * a small particle layer (hearts, sparkles, zzz, sweat, tears, puffs, ? and !)
"""
import math
import random

# ----------------------------------------------------------------- proportions (px at size 1)
PELVIS = (-30.0, -32.0)
CHEST = (12.0, -35.0)
R_PELVIS, R_CHEST = 19.0, 20.0
HA, HB = 54.0, 45.0          # head half width / half height (the big mochi head)
HEAD_FWD, HEAD_UP = 22.0, 50.0   # head centre relative to the chest
LEG = {  # name: (neutral foot x, hip offset from its body anchor, natural length, width, far?)
    "hn": (-28.0, (-2.0, 12.0), 22.0, 13.0, False),
    "hf": (-20.0, (6.0, 10.0), 22.0, 12.0, True),
    "fn": (14.0, (0.0, 12.0), 22.0, 12.5, False),
    "ff": (22.0, (8.0, 10.0), 22.0, 11.5, True),
}
HEAD_W = 2 * HA
TAIL_N = 6
TAIL_SEG = 7.0
EAR_DROOP_SIGN = 1.0
POSE_FPS = 12.0              # "on twos" at 24 fps
BOIL = 0.55                  # outline wobble (local px)
GRIP = (40.0, -49.0)         # where the front paws hook an edge in hang mode (local)

# gait table: (max speed, cycle length, duty, lift, phase offsets hn, fn, hf, ff)
GAITS = {
    "walk": (140, 30.0, 0.60, 6.0, (0.0, 0.5, 0.5, 0.0)),
    "trot": (330, 40.0, 0.50, 8.0, (0.0, 0.5, 0.5, 0.0)),
    "gallop": (1e9, 66.0, 0.40, 10.0, (0.0, 0.55, 0.12, 0.66)),
}


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(v, a, b):
    return a if v < a else b if v > b else v


def smooth(t):
    t = clamp(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _noise(i, seed):
    v = math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
    return (v - math.floor(v)) * 2.0 - 1.0


def ik2(hx, hy, fx, fy, a, b, bend):
    """Two-bone IK in a y-down frame (kept for tools). Returns (knee, foot)."""
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
        nx, hip, ln, w, far = LEG[name]
        self.nx, self.hip, self.len, self.w, self.far = nx, hip, ln, w, far
        self.fx = 0.0  # planted world x (ground mode)
        self.swing = None  # (from_x, to_x, t, dur, lift)
        self.local = (nx, 0.0)


# expression table (all procedural). eyes: dot round wide big happy closed half flat smug angry squeeze
# spiral heart cry. mouth: w open o meow pout flat wobble strain tongue smirk grin wail yawn.
EXPRS = {
    "neutral": dict(eyes="dot", mouth="w", blush=0.6, pupil=0.42),
    "content": dict(eyes="happy", mouth="w", blush=0.8),
    "happy": dict(eyes="happy", mouth="open", blush=0.85),
    "plead": dict(eyes="big", mouth="wobble", blush=0.75, tear=0.8, pupil=1.0, brows="worried"),
    "angry": dict(eyes="angry", mouth="pout", blush=0.55, puff=1.0, pupil=0.12, brows="angry"),
    "pout": dict(eyes="angry", mouth="pout", blush=1.0, puff=1.0, pupil=0.3),
    "sulky": dict(eyes="half", mouth="pout", blush=0.5, puff=0.45, pupil=0.25),
    "curious": dict(eyes="round", mouth="o", blush=0.5, pupil=0.7),
    "love": dict(eyes="heart", mouth="open", blush=1.0),
    "hunt": dict(eyes="round", mouth="w", blush=0.3, pupil=0.95, brows="angry"),
    "judge": dict(eyes="flat", mouth="flat", blush=0.25, pupil=0.28),
    "strain": dict(eyes="squeeze", mouth="strain", blush=0.8, pupil=0.2),
    "dizzy": dict(eyes="spiral", mouth="wobble", blush=0.5),
    "meow": dict(eyes="dot", mouth="meow", blush=0.6, pupil=0.6),
    "shocked": dict(eyes="wide", mouth="o", blush=0.15),
    "surprised": dict(eyes="wide", mouth="o", blush=0.4),
    "sleepy": dict(eyes="closed", mouth="w", blush=0.6),
    "tease": dict(eyes="smug", mouth="tongue", blush=0.6),
    "smug": dict(eyes="smug", mouth="smirk", blush=0.5),
    "laugh": dict(eyes="squeeze", mouth="grin", blush=0.95, tear=0.35),
    "cry": dict(eyes="cry", mouth="wail", blush=0.85, stream=1.0),
    "blush": dict(eyes="happy", mouth="w", blush=1.6, lines=1.0),
    "yawn": dict(eyes="squeeze", mouth="yawn", blush=0.5),
    "sparkle": dict(eyes="round", mouth="w", blush=0.9, pupil=0.85),
}


class Rig:
    PARAMS = dict(crouch=0.0, sit=0.0, lie=0.0, stretch=0.0, lean=0.0, head_rot=0.0, head_dx=0.0,
                  head_dy=0.0, tail_up=0.75, tail_wag=0.15, air=0.0, reach=0.0, paw=0.0, paw_x=40.0,
                  paw_y=-30.0, puff=0.0, glow=1.0, hang=0.0, climb=0.0, tuck=0.0, look_down=0.0, upright=0.0,
                  sq=0.0, arch=0.0, knead=0.0, beg=0.0, ears_down=0.0, tilt=0.0, paddle=0.0, life=1.0,
                  sleep=0.0, pupil=0.0, aura=0.0, slide=0.0, limp=0.0, lash=0.0, lean_in=0.0,
                  # v3
                  dance=0.0, hug=0.0, hug_x=60.0, hug_y=-120.0, stand=0.0, melt=0.0, kick=0.0, wave=0.0,
                  cheeks=0.0, hide=0.0, roll=0.0)

    def __init__(self, scale=1.0):
        self.scale = scale
        self.p = dict(self.PARAMS)
        self.t = dict(self.PARAMS)
        self.tau = 0.07  # pose crossfade time constant
        self.legs = {n: Leg(n) for n in LEG}
        self.phase = 0.0
        self.gait = "walk"
        self.time = 0.0
        self.x, self.y = 0.0, 0.0      # world root
        self.facing = 1
        self.rot = 0.0                 # degrees, whole-body
        self.mode = "ground"           # ground | air | climb | hang | peek | held
        self.vx = self.vy = 0.0
        self.ground_speed = 0.0
        self.view = "side"
        self.expr = "neutral"
        self.flip_t = 1.0              # turn animation 0..1 (squash through x=0)
        self.clip = None
        self.peek_up = 1.0
        self.zoom = 1.0
        self.squash_y = 0.0            # landing absorb (spring)
        self.squash_v = 0.0
        self.blink = 0.0
        self.next_blink = 2.0
        self.ear = [0.0, 0.0]
        self.ear_t = [3.0, 5.0]
        self.tail = None
        self.tail_prev = None
        self.events = []
        self.hold_blink = False
        # ---- cartoon layer state
        self.sqk = 0.0                 # current squash(-)/stretch(+) of the whole body
        self.jig = 0.0                 # mochi jiggle spring (adds to sqk)
        self.jig_v = 0.0
        self._k_prev = 0.0
        self.look_at = None
        self.look = [0.0, 0.0]
        self.sac = (0.0, 0.0)
        self.sac_t = 1.0
        self.idle_rot = 0.0
        self.idle_rot_tgt = 0.0
        self.idle_t = 2.0
        self.lag = [0.0, 0.0]
        self.lag_v = [0.0, 0.0]
        self.prev_v = (0.0, 0.0)
        self.band = 0.0
        self.band_v = 0.0
        self.ear_sp = 0.0
        self.ear_sp_v = 0.0
        self.pupil_cur = 0.42
        self.fx = []
        self.fx_on = {}
        self.fx_acc = {}
        self.head_w = (0.0, 0.0, 0.0)
        self.head_m = None             # head-local -> world affine (a, b, c, d, e, f)
        self.held_t = 0.0
        self.twos = True               # pose on twos
        self._cache = None
        self._tick = -1
        self._key = None
        self._kdraw = None

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
        self.fx_on = {}

    def snap(self):
        self.p.update(self.t)
        self._cache = None

    # --------------------------------------------------------------- particles
    def emit(self, kind, x=None, y=None, vx=0.0, vy=-40.0, life=1.0, size=1.0, rot=0.0):
        hx, hy, hs = self.head_w
        if x is None:
            x, y = hx, hy - hs * 0.62
        if len(self.fx) > 60:
            self.fx.pop(0)
        self.fx.append([kind, x, y, vx, vy, 0.0, life, size * self.scale, rot])

    def eye_world(self, i):
        """World position of eye i (0 = back, 1 = front) from the last drawn head."""
        m = self.head_m
        if m is None:
            hx, hy, hs = self.head_w
            return hx, hy
        u, v = self._eye_uv(self.view if self.view != "peek" else "front")[i]
        return m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]

    @staticmethod
    def _eye_uv(view):
        if view == "front":
            return [(-20.0, 4.0), (20.0, 4.0)]
        return [(-2.0, 4.0), (34.0, 3.0)]

    def _emitters(self, dt):
        hx, hy, hs = self.head_w
        f = self.facing
        for kind, rate in list(self.fx_on.items()):
            if rate <= 0:
                continue
            acc = self.fx_acc.get(kind, random.random()) + rate * dt
            while acc >= 1.0:
                acc -= 1.0
                if kind == "heart":
                    self.emit("heart", hx + random.uniform(-0.35, 0.35) * hs, hy - hs * 0.42,
                              random.uniform(-20, 20), random.uniform(-70, -45), 1.4, random.uniform(0.8, 1.2))
                elif kind == "zzz":
                    self.emit("zzz", hx + f * hs * 0.3, hy - hs * 0.42, f * 18, -30, 2.2, random.uniform(0.8, 1.1))
                elif kind == "sweat":
                    self.emit("sweat", hx - f * hs * 0.42, hy - hs * 0.4, -f * 40, -60, 0.7, 1.0)
                elif kind == "sparkle":
                    self.emit("sparkle", hx + random.uniform(-0.65, 0.65) * hs, hy + random.uniform(-0.7, 0.1) * hs,
                              0, -10, 0.6, random.uniform(0.6, 1.1))
                elif kind == "purr":
                    self.emit("purr", hx - f * hs * 0.5, hy + hs * 0.15, -f * 30, -14, 0.9, 1.0)
                elif kind == "star":
                    self.emit("star", hx, hy - hs * 0.5, 0, 0, 1.0, 1.0, rot=random.uniform(0, 6.28))
                elif kind == "vein":
                    self.emit("vein", hx + f * hs * 0.3, hy - hs * 0.36, 0, 0, 0.5, 1.0)
                elif kind == "note":
                    self.emit("note", hx + f * hs * 0.45, hy - hs * 0.35, f * 25, -50, 1.2, 1.0)
                elif kind == "tears":
                    for i in (0, 1):
                        ex, ey = self.eye_world(i)
                        side = -1 if i == 0 else 1
                        self.emit("tear", ex, ey + 4 * self.scale, side * f * random.uniform(40, 110),
                                  random.uniform(-120, -60), 0.75, random.uniform(0.8, 1.1))
                elif kind == "hmph":
                    self.emit("puff", hx + f * hs * 0.55, hy + hs * 0.12, f * 70, -10, 0.55, 0.7)
                elif kind == "dust":
                    self.emit("puff", self.x - f * 26 * self.scale, self.y - 4, -f * 60, -25, 0.45,
                              random.uniform(0.6, 1.0))
                elif kind == "motion":
                    self.emit("speed", self.x - f * 60 * self.scale, self.y - random.uniform(20, 60) * self.scale,
                              0, 0, 0.25, 1.0)
            self.fx_acc[kind] = acc

    def _update_fx(self, dt):
        self._emitters(dt)
        keep = []
        for p in self.fx:
            p[5] += dt
            if p[5] >= p[6]:
                continue
            p[1] += p[3] * dt
            p[2] += p[4] * dt
            if p[0] in ("sweat", "tear"):
                p[4] += 500 * dt
            elif p[0] in ("heart", "zzz", "note"):
                p[3] += math.sin(p[5] * 6 + id(p) % 7) * 30 * dt
            elif p[0] == "star":
                p[8] += dt * 5.0
            elif p[0] == "puff":
                p[3] *= 0.92
                p[4] *= 0.92
            keep.append(p)
        self.fx = keep

    def fx_items(self):
        out = []
        hx, hy, hs = self.head_w
        for kind, x, y, vx, vy, age, life, size, rot in self.fx:
            t = age / life
            a = (min(1.0, t * 6) * (1 - smooth((t - 0.6) / 0.4))) if t > 0.0 else 0.0
            if kind == "star":
                x = hx + math.cos(rot) * hs * 0.42
                y = hy - hs * 0.52 + math.sin(rot) * hs * 0.1
                a = 1.0 if t < 0.85 else (1 - t) / 0.15
            s = size * (1 + 0.6 * t if kind == "puff" else 1.0)
            if kind in ("heart", "sparkle"):
                s *= 0.6 + 0.4 * smooth(t * 4)
            if kind == "heart":  # hand-drawn hop: hearts pulse on twos
                s *= 1.0 + 0.12 * (int(age * 6) % 2)
            out.append((kind, x, y, s, a, rot))
        return ("fx", out)

    # --------------------------------------------------------------- transforms
    def to_world(self, lx, ly, k=None):
        s = self.scale * self.zoom
        if k is None:
            k = self.sqk + self.jig
        if k:
            lx, ly = lx * (1 - 0.5 * k), ly * (1 + k)
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
        k = self.sqk + self.jig
        return x / s / f / (1 - 0.5 * k), y / s / (1 + k)

    # --------------------------------------------------------------- gait / feet
    def place_feet(self):
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
                if moving:
                    t = self.x + self.facing * leg.nx * s + direction * L * duty * 0.5 \
                        + direction * v * max(0.0, d - tt) * 0.9
                else:
                    t = neutral
                tt += dt
                if tt >= d:
                    leg.fx = t
                    leg.swing = None
                    self.events.append(("step", leg.far))
                    if moving and self.gait != "gallop" and not leg.far:
                        self.jig_v -= 0.35  # each footfall squishes the mochi a little
                else:
                    leg.swing = (f, t, tt, d, lf)
                continue
            if moving:
                p0 = (old + offs[i]) % 1.0
                p1 = (self.phase + offs[i]) % 1.0
                crossed = (p0 < duty <= p1) or (p1 < p0 and (duty > p0 or duty <= p1))
                behind = (leg.fx - neutral) * direction < -L * duty * 0.75
                if crossed or behind:
                    d = clamp((1 - duty) * L / max(v, 1.0), 0.07, 0.24)
                    leg.swing = (leg.fx, neutral, 0.0, d, lift * s * (0.8 + 0.2 * random.random()))
            else:
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
        w = 14.0
        acc = -2 * w * self.squash_v - w * w * self.squash_y
        self.squash_v += acc * dt
        self.squash_y += self.squash_v * dt
        if self.squash_y < 0:
            self.squash_y, self.squash_v = 0.0, 0.0
        if self.flip_t < 1:
            self.flip_t = min(1.0, self.flip_t + dt / 0.16)
        if not self.hold_blink:
            self.next_blink -= dt
            if self.next_blink <= 0:
                self.blink = 0.0001
                self.next_blink = random.uniform(2.5, 6.0) * (0.5 if random.random() < 0.2 else 1)
            if self.blink > 0:
                self.blink += dt / 0.18
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
        self._cartoon(dt)
        self.update_tail(dt)
        self._update_fx(dt)

    def _cartoon(self, dt):
        P = self.p
        # -- squash & stretch target
        if self.mode == "air":
            k = clamp(abs(self.vy) / 2200.0, 0.0, 0.26) * (1.0 if self.vy < 0 else 0.8)
            if P["tuck"] > 0.5 and abs(self.vy) < 350:
                k = -0.08
        elif self.mode == "ground":
            k = -0.95 * self.squash_y - 0.09 * P["crouch"] + 0.04 * P["arch"] - 0.32 * P["melt"]
            if self.ground_speed > 8 and self.gait != "gallop":
                k -= 0.05 * max(0.0, math.cos(self.phase * 4 * math.pi))  # waddle squish per step
            if P["sleep"] > 0.1:
                k += 0.025 * P["sleep"] * math.sin(self.time * 1.6)  # slow breathing blob
        elif self.mode == "held":
            k = -0.12 - 0.14 * P["limp"]  # dangling mochi stretches long
        else:
            k = 0.0
        k += P["sq"]
        if P["dance"] > 0.01:
            k += P["dance"] * (-0.07 * abs(math.sin(self.time * math.pi * 2.2)))
        self.sqk += (k - self.sqk) * (1 - math.exp(-dt / 0.035))
        # -- mochi jiggle: sudden pose changes ring an underdamped spring (wobbly settle)
        dk = k - self._k_prev
        self._k_prev = k
        if abs(dk) > 0.004:
            self.jig_v -= dk * 11.0
        wj, zj = 21.0, 0.2
        self.jig_v += (-2 * zj * wj * self.jig_v - wj * wj * self.jig) * dt
        self.jig = clamp(self.jig + self.jig_v * dt, -0.2, 0.2)
        # -- follow-through
        vx, vy = self.vx, self.vy
        if self.mode == "ground":
            vx, vy = self.ground_speed * (1 if self.vx >= 0 else -1), 0.0
        ax = clamp((vx - self.prev_v[0]) / max(dt, 1e-3), -6000, 6000)
        ay = clamp((vy - self.prev_v[1]) / max(dt, 1e-3), -6000, 6000)
        self.prev_v = (vx, vy)
        if self.mode in ("hang", "held", "climb"):
            ax = ay = 0.0
        w, z = 15.0, 0.3
        for i, acc in enumerate((ax * self.facing, ay)):
            f = -acc * 0.0012 - 2 * z * w * self.lag_v[i] - w * w * self.lag[i]
            self.lag_v[i] += f * dt
            self.lag[i] = clamp(self.lag[i] + self.lag_v[i] * dt, -8.0, 8.0)
        drive = self.lag_v[1] * 0.9 + self.lag_v[0] * 0.5 + self.jig_v * 6
        w2, z2 = 13.0, 0.22
        f = drive * 0.6 - 2 * z2 * w2 * self.ear_sp_v - w2 * w2 * self.ear_sp
        self.ear_sp_v += f * dt
        self.ear_sp = clamp(self.ear_sp + self.ear_sp_v * dt, -25, 25)
        # -- idle life
        idle = P["life"] > 0.5 and self.mode == "ground" and self.ground_speed < 6
        self.idle_t -= dt
        if self.idle_t <= 0:
            self.idle_t = random.uniform(1.6, 4.2)
            self.idle_rot_tgt = random.choice([-8, -4, 0, 4, 7]) if idle else 0.0
            self.sac = (random.uniform(-0.6, 0.7), random.uniform(-0.45, 0.35))
        self.sac_t -= dt
        if self.sac_t <= 0 and self.look_at is None:
            self.sac_t = random.uniform(0.5, 1.8)
            self.sac = (clamp(self.sac[0] + random.uniform(-0.4, 0.4), -0.8, 0.8),
                        clamp(self.sac[1] + random.uniform(-0.25, 0.25), -0.6, 0.5))
        self.idle_rot += ((self.idle_rot_tgt if idle else 0.0) - self.idle_rot) * (1 - math.exp(-dt / 0.25))
        hx, hy, hs = self.head_w
        if self.look_at is not None and hs > 0:
            dx = (self.look_at[0] - hx) / (hs * 3.0)
            dy = (self.look_at[1] - hy) / (hs * 3.0)
            m = math.hypot(dx, dy)
            if m > 1:
                dx, dy = dx / m, dy / m
            tgt = (dx * (1 if self.facing > 0 else -1), dy)
        else:
            tgt = self.sac
        if self.expr in ("plead", "love"):
            tgt = (tgt[0] * 0.3, tgt[1] * 0.3 - 0.25)
        a = 1 - math.exp(-dt / 0.06)
        self.look[0] += (tgt[0] - self.look[0]) * a
        self.look[1] += (tgt[1] - self.look[1]) * a
        e = EXPRS.get(self.expr, {})
        pt = clamp(e.get("pupil", 0.42) + P["pupil"], 0.05, 1.0)
        self.pupil_cur += (pt - self.pupil_cur) * (1 - math.exp(-dt / 0.12))

    def land(self, impact):
        """impact = downward speed in px/s. Squash on contact, then a wobbly mochi settle."""
        self.squash_v = clamp(impact / 2600.0, 0.15, 1.0) * 9.0
        self.jig_v -= clamp(impact / 2600.0, 0.1, 1.0) * 3.2
        self.place_feet()

    def turn(self, facing):
        if facing != self.facing:
            self.facing = facing
            self.flip_t = 0.0
            self.place_feet()
            self.tail = None
            self._cache = None

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
        moving = self.mode == "ground" and self.ground_speed > 8
        ph = self.phase * 2 * math.pi
        sp = clamp(self.ground_speed / 400.0, 0, 1)
        bob = 0.0
        flex = 0.0
        pitch = P["lean"]
        if moving:
            if self.gait == "walk":
                bob = -2.6 * abs(math.sin(2 * ph))   # bouncy waddle: up between footfalls
                pitch += 0.05 * math.sin(2 * ph)
            elif self.gait == "trot":
                bob = -3.6 * abs(math.sin(2 * ph))
                pitch += 0.04 * math.sin(2 * ph)
            else:
                bob = 4.5 * math.sin(ph)
                flex = 6.5 * math.sin(ph)
                pitch += 0.09 * math.cos(ph)
        slp = P["sleep"]
        breath = math.sin(self.time * lerp(2.4, 1.5, slp)) * (0.9 + 1.4 * slp) * (1 if not moving else 0)
        if self.mode == "ground" and not moving and P["life"] > 0.5:
            pitch += 0.025 * math.sin(self.time * 0.85) + 0.012 * math.sin(self.time * 2.3)
        if P["dance"] > 0.01:
            pitch += P["dance"] * 0.13 * math.sin(self.time * math.pi * 1.1)
        arch = P["arch"]
        drop = crouch * 10 - arch * 9
        px, py = PELVIS[0] - flex, PELVIS[1] + drop + bob * 0.6
        cx, cy = CHEST[0] + flex, CHEST[1] + drop + bob - breath
        px, py = lerp(px, -7, sit), lerp(py, -24, sit)
        cx, cy = lerp(cx, 8, sit), lerp(cy, -42, sit)
        px, py = lerp(px, -22, lie), lerp(py, -19, lie)
        cx, cy = lerp(cx, 14, lie), lerp(cy, -20, lie)
        px, py = lerp(px, -28, st), lerp(py, -42, st)
        cx, cy = lerp(cx, 20, st), lerp(cy, -22, st)
        stand = P["stand"]
        px, py = lerp(px, -8, stand), lerp(py, -22, stand)
        cx, cy = lerp(cx, 3, stand), lerp(cy, -50, stand)
        if self.mode == "air":
            cx += P["reach"] * 4
            px -= P["reach"] * 4
        if self.mode == "hang":
            cx, cy = GRIP[0] - 78, GRIP[1]
            px, py = cx - 34, cy + 2 * math.sin(self.time * 2.0)
        mx, my = (px + cx) / 2, (py + cy) / 2
        c, s = math.cos(pitch), math.sin(pitch)

        def rp(x, y):
            dx, dy = x - mx, y - my
            return mx + dx * c - dy * s, my + dx * s + dy * c
        pel, che = rp(px, py), rp(cx, cy)
        return pel, che, sp, crouch

    def grip_local(self):
        return GRIP

    def head_center(self, che):
        P = self.p
        if self.mode == "hang":
            return GRIP[0] - HB * 0.82, GRIP[1] + 2.0
        if self.mode == "climb":
            return che[0] + 46, che[1] - 8
        x = che[0] + HEAD_FWD + P["head_dx"] + self.lag[0] * 0.6 + P["lean_in"] * 6
        y = che[1] - HEAD_UP + P["head_dy"] + self.lag[1] - 4 * P["sit"] + 10 * P["melt"]
        if self.mode == "ground" and self.ground_speed > 8 and P["life"] > 0.5:
            y += 1.8 * math.sin(self.phase * 4 * math.pi + 0.7)
        return x, y

    # --------------------------------------------------------------- frame building
    def frame(self):
        """Build the draw list (world coordinates). The local pose is rebuilt on twos and held."""
        tick = int(self.time * POSE_FPS)
        key = (self.view, self.mode, self.facing, self.expr, self.hold_blink)
        if (not self.twos or self._cache is None or tick != self._tick or key != self._key
                or self.flip_t < 1):
            self._tick, self._key = tick, key
            self._cache = self.build_peek() if self.view == "peek" else self.build_local()
            self._kdraw = (self.sqk + self.jig) if self.view != "peek" else 0.0
        return self._emit(self._cache, self._kdraw)

    # ---- local geometry ------------------------------------------------------
    def _head_outline(self, view, puff, cheeks, ears, seed):
        """Mochi head outline (with the two ears spliced in) in head-local units."""
        n = 64
        pts = []
        ex = 2.55
        bulge = 0.07 + 0.09 * cheeks
        for i in range(n):
            t = math.pi + 2 * math.pi * i / n   # start at the left, go over the top
            c, s = math.cos(t), math.sin(t)
            u = HA * math.copysign(abs(c) ** (2 / ex), c)
            v = HB * math.copysign(abs(s) ** (2 / ex), s)
            if v > 0:
                u *= 1 + bulge * (v / HB)   # cheeks: wider low
                v *= 1 - 0.06 * abs(u / HA)
            if puff > 0.02:
                r = 1 + puff * 0.07 * (1 if i % 2 else -0.3)
                u, v = u * r, v * r
            pts.append((u, v))
        # ears: (centre u on top, tilt deg, height)
        if view == "front":
            spec = [(-31.0, -16.0, 1.0), (31.0, 16.0, 1.0)]
        else:
            spec = [(-27.0, -20.0, 0.95), (25.0, 12.0, 1.0)]
        ear_tris = []
        for j, (eu, tilt, hk) in enumerate(spec):
            hb = 14.0
            l, r_ = eu - hb, eu + hb
            idx = [i for i, (u, v) in enumerate(pts) if v < 0 and l <= u <= r_]
            if not idx:
                continue
            i0, i1 = min(idx), max(idx)
            bl, br = pts[i0], pts[i1]
            bcx, bcy = (bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2 + 3
            ang = math.radians(tilt + (ears[j] if j < len(ears) else 0) * (-1 if j == 0 else 1))
            h = 19.0 * hk * (1 - 0.15 * abs(ears[j] if j < len(ears) else 0) / 50)
            tip = (bcx + math.sin(ang) * h, bcy - math.cos(ang) * h)
            ca, sa = math.cos(ang), math.sin(ang)
            bl2, br2 = bl, br   # base stays on the head outline: a clean join, only the tip moves
            tri = [bl2, (lerp(bl2[0], tip[0], 0.82), lerp(bl2[1], tip[1], 0.82)),
                   (lerp(tip[0], bl2[0], 0.06) + sa * 1.2, lerp(tip[1], bl2[1], 0.06) - ca * 1.2),
                   (tip[0] + sa * 1.5, tip[1] - ca * 1.5),
                   (lerp(tip[0], br2[0], 0.06) + sa * 1.2, lerp(tip[1], br2[1], 0.06) - ca * 1.2),
                   (lerp(br2[0], tip[0], 0.82), lerp(br2[1], tip[1], 0.82)), br2]
            pts = pts[:i0] + [bl] + tri + [br] + pts[i1 + 1:]
            inner = [(lerp(bcx, bl2[0], 0.55) + sa * 2, lerp(bcy, bl2[1], 0.55) - 2),
                     (lerp(tip[0], bcx, 0.28), lerp(tip[1], bcy, 0.28)),
                     (lerp(bcx, br2[0], 0.55) + sa * 2, lerp(bcy, br2[1], 0.55) - 2)]
            ear_tris.append(inner)
        pts = [(u + _noise(i, seed) * BOIL, v + _noise(i + 101, seed) * BOIL) for i, (u, v) in enumerate(pts)]
        return pts, ear_tris

    def _body_outline(self, pel, che, r1, r2, sag, puff, arch, seed):
        (x1, y1), (x2, y2) = pel, che
        dx, dy = x2 - x1, y2 - y1
        d = math.hypot(dx, dy) or 1e-3
        phi = math.atan2(dy, dx)
        beta = math.acos(clamp((r1 - r2) / d, -1, 1))
        pts = []
        n2 = 18
        for i in range(n2 + 1):  # front cap (chest)
            a = phi - beta + 2 * beta * i / n2
            pts.append((x2 + math.cos(a) * r2, y2 + math.sin(a) * r2, a))
        for i in range(n2 + 1):  # back cap (pelvis)
            a = phi + beta + (2 * math.pi - 2 * beta) * i / n2
            pts.append((x1 + math.cos(a) * r1, y1 + math.sin(a) * r1, a))
        out = []
        for i, (x, y, a) in enumerate(pts):
            ny = math.sin(a)
            if ny > 0:
                y += sag * ny * ny          # soft mochi belly droops
            else:
                y -= arch * 9 * (-ny) * 1.0
            if puff > 0.02:
                r = puff * 4.5 * (1 if i % 2 else -0.4)
                x += math.cos(a) * r
                y += math.sin(a) * r
            x += _noise(i + 7, seed) * BOIL
            y += _noise(i + 211, seed) * BOIL
            out.append((x, y))
        return out

    def build_local(self):
        P = self.p
        pel, che, sp, crouch = self.skeleton()
        seed = int(self.time * POSE_FPS) // 2
        ang = math.atan2(che[1] - pel[1], che[0] - pel[0])
        ca, sa = math.cos(ang), math.sin(ang)
        hc = self.head_center(che)
        L = dict(far=[], near=[], near_over=[], raised=[], raised_far=[], toes=[])
        # ---- legs
        for n, leg in self.legs.items():
            base = pel if n[0] == "h" else che
            hx = base[0] + leg.hip[0] * ca - leg.hip[1] * sa
            hy = base[1] + leg.hip[0] * sa + leg.hip[1] * ca
            if self.mode == "ground":
                lx, ly = self.to_local(*self.foot_world(leg))
            else:
                lx, ly = leg.nx, 0.0
            tx, ty = lx, ly
            maxlen = leg.len + 4
            front = n[0] == "f"
            if self.mode == "air":
                r, tu = P["reach"], P["tuck"]
                if front:
                    tx, ty = lerp(hx + 12, hx + 6, tu), lerp(hy + 16, hy + 9, tu)
                else:
                    tx, ty = lerp(hx - 12, hx + 2, tu), lerp(hy + 16, hy + 9, tu)
                tx, ty = lerp(tx, hx + (3 if front else -2), r), lerp(ty, hy + leg.len, r)
            elif self.mode == "climb":
                cyc = (self.phase + {"hn": 0, "fn": .5, "hf": .5, "ff": 0}[n]) % 1
                tx = leg.nx + 8 * math.cos(cyc * 2 * math.pi)
                ty = -max(0.0, math.sin(cyc * 2 * math.pi)) * 6
                if P["slide"] > 0.01 and front:  # paws up, claws out, sliding
                    tx = lerp(tx, hc[0] + (8 if leg.far else -6), P["slide"])
                    ty = lerp(ty, -2, P["slide"])
                    maxlen = 70
            elif self.mode == "hang":
                if front:  # short arms up the sides of his head, paws hooked over the edge
                    hx, hy = GRIP[0] - 30, GRIP[1] + (-34 if leg.far else 36)
                    tx, ty = GRIP[0] + 3, GRIP[1] + (-44 if leg.far else 46)
                    maxlen = 40
                else:
                    sw = math.sin(self.time * 2.0 + (1 if leg.far else 0)) * 3
                    tx, ty = hx - leg.len, hy + sw
                    pd = P["paddle"]
                    if pd > 0.01:
                        ph2 = self.time * 15 + (math.pi if leg.far else 0)
                        tx += pd * (5 * math.sin(ph2) + 3)
                        ty += pd * 9 * math.cos(ph2)
            elif self.mode == "held":
                dlx, dly = self._down_local()
                pd = P["paddle"] * (1 - P["limp"])
                ph2 = self.time * 13 + (math.pi if leg.far else 0) + (0.0 if front else 1.7)
                reach = leg.len * lerp(0.85, 1.05, P["limp"])
                tx = hx + dlx * reach + pd * 7 * math.cos(ph2)
                ty = hy + dly * reach + pd * 6 * math.sin(ph2)
            if self.mode == "ground":
                sit, lie, st = P["sit"], P["lie"], P["stretch"]
                if not front:
                    sx_, sy_ = pel[0] + 14, 0.0
                    lx2, ly2 = pel[0] + 10, -2.0
                    stx, sty = leg.nx - 4, 0.0
                else:
                    sx_, sy_ = che[0] + (6 if leg.far else 2), 0.0
                    lx2, ly2 = che[0] + 22 + (6 if leg.far else 0), -3.0
                    stx, sty = leg.nx + 26, 0.0
                w = max(sit, lie, st)
                if w > 0.001:
                    bx = (sx_ * sit + lx2 * lie + stx * st) / (sit + lie + st)
                    by = (sy_ * sit + ly2 * lie + sty * st) / (sit + lie + st)
                    tx, ty = lerp(tx, bx, w), lerp(ty, by, w)
                    maxlen = leg.len + 30 * lie + 20 * st
                if P["kick"] > 0.01:  # rolling on his side, legs kicking the air (laughing)
                    ph2 = self.time * 14 + (math.pi if leg.far else 0) + (0 if front else 1.3)
                    tx = lerp(tx, hx + (10 if front else -10) + 6 * math.cos(ph2), P["kick"])
                    ty = lerp(ty, hy - 4 + 7 * math.sin(ph2), P["kick"])
                if front:
                    bg = P["beg"]
                    if bg > 0.01:  # paws together under the chin
                        tx = lerp(tx, hc[0] + (14 if leg.far else 2), bg)
                        ty = lerp(ty, hc[1] + HB * 0.8 + (-1 if leg.far else 1), bg)
                        maxlen = lerp(maxlen, 90, bg)
                    kn = P["knead"]
                    if kn > 0.01:
                        ph3 = self.time * 7.5 + (math.pi if leg.far else 0)
                        ty -= kn * 6 * max(0.0, math.sin(ph3))
                        tx += kn * 2 * math.cos(ph3)
                    hd = P["hide"]
                    if hd > 0.01:  # paws over the cheeks (shy)
                        tx = lerp(tx, hc[0] + (42 if leg.far else -16), hd)
                        ty = lerp(ty, hc[1] + 19, hd)
                        maxlen = lerp(maxlen, 100, hd)
                    dn = P["dance"]
                    if dn > 0.01:  # arms swing up by the cheeks, alternating with the beat
                        beat = math.sin(self.time * math.pi * 2.2 + (math.pi if leg.far else 0))
                        up = max(0.0, beat)
                        tx = lerp(tx, hc[0] + (30 if leg.far else -4) + 6 * beat, dn)
                        ty = lerp(ty, hc[1] + HB * 0.95 - 26 * up, dn)
                        maxlen = lerp(maxlen, 100, dn)
                    hg = P["hug"]
                    if hg > 0.01:  # arms wrapped round the thing in front of his face
                        tx = lerp(tx, hc[0] + HA * (0.95 if leg.far else 0.8), hg)
                        ty = lerp(ty, hc[1] + (6 if leg.far else 16), hg)
                        maxlen = lerp(maxlen, 120, hg)
                    wv = P["wave"]
                    if wv > 0.01 and n == "fn":  # paw up beside the cheek, waving
                        tx = lerp(tx, hc[0] + HA + 4 + 9 * math.sin(self.time * 12), wv)
                        ty = lerp(ty, hc[1] + 2 - 4 * abs(math.cos(self.time * 12)), wv)
                        maxlen = lerp(maxlen, 110, wv)
            if n == "fn" and P["paw"] > 0.001:
                tx, ty = lerp(tx, P["paw_x"], P["paw"]), lerp(ty, P["paw_y"], P["paw"])
                maxlen = lerp(maxlen, 120, P["paw"])
            raised = front and (
                (n == "fn" and P["paw"] > 0.5 and P["paw_y"] < -30)
                or (self.mode == "ground" and (P["beg"] > 0.5 or P["hide"] > 0.5 or P["dance"] > 0.5
                                               or P["hug"] > 0.5 or (n == "fn" and P["wave"] > 0.5)))
                or (self.mode == "climb" and P["slide"] > 0.5))
            hang_arm = front and self.mode == "hang"
            if raised:
                # short Peach-style arm: it comes out from under the chin, not from the hidden shoulder
                hx, hy = hc[0] + (14 if leg.far else -6), hc[1] + HB * 0.9
                maxlen = 32
                if n == "fn" and P["wave"] > 0.5:
                    hx, hy, maxlen = hc[0] + 26, hc[1] + HB * 0.82, 48
                if P["hug"] > 0.5:
                    hx, hy, maxlen = hc[0] + (30 if leg.far else 22), hc[1] + HB * 0.85, 48
            # stubby straight leg, pulled in if out of reach
            ddx, ddy = tx - hx, ty - hy
            dd = math.hypot(ddx, ddy) or 1e-3
            if dd > maxlen:
                tx, ty = hx + ddx * maxlen / dd, hy + ddy * maxlen / dd
            foot = (tx, ty)
            lifted = foot[1] < -2.5 or (self.mode != "ground")
            if lifted:
                pang = math.atan2(ty - hy, tx - hx) - math.pi / 2
            else:
                pang = 0.0
            mid = (lerp(hx, tx, 0.5) + (1.2 if front else -1.2), lerp(hy, ty, 0.5))
            item = dict(pts=[(hx, hy), mid, foot], w=leg.w, far=leg.far,
                        paw=(foot[0] + 2.0 * math.cos(pang), foot[1] - 3.2 + 2.0 * math.sin(pang), 8.0, 5.4,
                             math.degrees(pang)), toes=not leg.far)
            if raised or hang_arm:
                (L["raised_far"] if leg.far else L["raised"]).append(item)
            elif leg.far:
                L["far"].append(item)
            elif front and ((self.mode == "ground" and P["sit"] > 0.5) or (n == "fn" and P["paw"] > 0.5)):
                L["near_over"].append(item)
            else:
                L["near"].append(item)
        # ---- body
        sag = 3.0 + 3.0 * P["melt"] + 2.0 * P["lie"]
        r1 = R_PELVIS * (1 + 0.08 * P["puff"]) * (1 + 0.15 * P["melt"]) * (1 + 0.22 * P["sit"])
        r2 = R_CHEST * (1 + 0.08 * P["puff"])
        L["body"] = self._body_outline(pel, che, r1, r2, sag, P["puff"], P["arch"], seed)
        L["body_light"] = (che[0] - 4, che[1] - 12, R_CHEST * 2.6)
        # ---- tail
        tail = []
        if self.tail:
            tail = [self.to_local(*q) for q in self.tail]
            tail = [(x + _noise(i + 33, seed) * BOIL, y + _noise(i + 77, seed) * BOIL) for i, (x, y) in enumerate(tail)]
        L["tail"] = tail
        L["tail_w"] = 7.0 * (1 + 0.7 * P["puff"])
        # ---- head
        net = P["head_rot"] - math.degrees(P["lean"]) * 0.4 + P["look_down"] * 14 + P["tilt"] + self.idle_rot \
            - self.lag[1] * 1.2
        up = P["upright"]
        if self.mode == "climb":
            up = max(up, 0.7)
        if self.mode == "hang":
            up = max(up, 0.9)
        L["head"] = dict(c=hc, rot=net, upright=up, face=self.face("side"),
                         outline=self._head_outline("side", P["puff"], self._cheeks(), self.ear_angles(), seed))
        if abs(P["roll"]) > 0.5 and self.mode == "ground":
            a = math.radians(P["roll"])
            ca2, sa2 = math.cos(a), math.sin(a)
            pvx, pvy = -4.0, -38.0

            def rr(x, y):
                dx, dy = x - pvx, y - pvy
                return pvx + dx * ca2 - dy * sa2, pvy + dx * sa2 + dy * ca2
            low = max([rr(*q)[1] for q in L["body"]] + [rr(*hc)[1] + HB * 0.95])
            L["roll"] = (ca2, sa2, pvx, pvy, -low)
        return L

    def _cheeks(self):
        e = EXPRS.get(self.expr) or {}
        return max(e.get("puff", 0.0), self.p["cheeks"])

    def build_peek(self):
        up = self.peek_up
        P = self.p
        seed = int(self.time * POSE_FPS) // 2
        L = dict(far=[], near=[], near_over=[], raised=[], raised_far=[], toes=[], body=None, tail=[])
        hx, hy = 0.0, lerp(80, -32, up) + math.sin(self.time * 2.4) * 0.8
        L["head"] = dict(c=(hx, hy), rot=P["head_rot"] + P["tilt"], upright=0.0, face=self.face("front"),
                         outline=self._head_outline("front", P["puff"], self._cheeks(), self.ear_angles(), seed),
                         peek=True)
        paws = []
        for k in (-1, 1):
            px = k * 34
            py = lerp(14, -1, up)
            paws.append(dict(pts=[(px, py + 4), (px, py + 2), (px, py)], w=12.0, far=False,
                             paw=(px, py - 1, 12.0, 8.0, 0.0), toes=True, up=True))
        L["raised"] = paws
        return L

    # ---- local -> world -----------------------------------------------------
    def _emit(self, L, k):
        s = self.scale * self.zoom
        if L.get("roll"):
            ca2, sa2, pvx, pvy, lift = L["roll"]

            def W(x, y):
                dx, dy = x - pvx, y - pvy
                return self.to_world(pvx + dx * ca2 - dy * sa2, pvy + dx * sa2 + dy * ca2 + lift, k)
        else:
            W = lambda x, y: self.to_world(x, y, k)
        items = []
        f = self.facing

        def legs(lst, out):
            for it in lst:
                pts = [W(*q) for q in it["pts"]]
                cx, cy, rx, ry, a = it["paw"]
                px, py = W(cx, cy)
                pa = a * f + self.rot if f > 0 else 180 - a + self.rot
                toes = []
                if it["toes"]:
                    for d in (-1, 1):
                        toes.append([W(cx + d * 2.6, cy - 1.0), W(cx + d * 2.3, cy + 2.6)])
                out.append(("leg", pts, it["w"] * s, (px, py, rx * s, ry * s, self.rot if not it.get("up") else self.rot),
                            "far" if it["far"] else "near", toes))
        if L.get("tail"):
            items.append(("tube", [W(*q) for q in L["tail"]], L["tail_w"] * s, "near"))
        legs(L["far"], items)
        legs(L["near"], items)
        if L.get("body"):
            gx, gy, gr = L["body_light"]
            items.append(("shape", "body", [W(*q) for q in L["body"]], (*W(gx, gy), gr * s)))
        legs(L["near_over"], items)
        h = L.get("head")
        if h:
            items.extend(self._head_items(h, W, s))
        legs(L["raised_far"], items)
        legs(L["raised"], items)
        if self.fx:
            items.append(self.fx_items())
        return items

    def _head_items(self, h, W, s):
        cx, cy = h["c"]
        f = self.facing
        sx_flip = (2 * self.flip_t - 1) if self.flip_t < 1 else 1.0
        rot = h["rot"]
        if h.get("upright", 0) > 0.01:
            net = rot * f + self.rot
            tgt = -8.0 * f
            net = net + (tgt - net) * h["upright"]
            rot = (net - self.rot) * f
        a = math.radians(rot)
        ca, sa = math.cos(a), math.sin(a)

        def H(u, v):  # head-local -> rig-local
            return cx + u * ca - v * sa, cy + u * sa + v * ca
        ox, oy = W(*H(0, 0))
        ux, uy = W(*H(1, 0))
        vx, vy = W(*H(0, 1))
        m = (ux - ox, uy - oy, vx - ox, vy - oy, ox, oy)
        self.head_m = m
        self.head_w = (ox, oy, HEAD_W * s)
        pts, ears = h["outline"]
        wpts = [W(*H(u, v)) for u, v in pts]
        out = []
        face = h["face"]
        if face.get("aura", 0) > 0.01:
            out.append(("aura", m, face))
        lu, lv = -HA * 0.15, -HB * 0.55
        out.append(("shape", "head", wpts, (*W(*H(lu, lv)), HA * 2.1 * s)))
        out.append(("shape", "ear_in", [[W(*H(u, v)) for u, v in tri] for tri in ears], None))
        out.append(("face", m, face))
        return out

    def _down_local(self):
        a = math.radians(self.rot)
        f = self.facing if self.flip_t >= 1 else (self.facing or 1)
        return math.sin(a) * f, math.cos(a)

    def face(self, view):
        """Procedural face settings for draw.py."""
        e = EXPRS.get(self.expr) or EXPRS["neutral"]
        P = self.p
        b = self.blink
        lid = 0.0
        if self.hold_blink:
            lid = 1.0
        elif b > 0:
            lid = math.sin(math.pi * clamp(b, 0, 1)) ** 0.7
        cyan = clamp(max(P["aura"], (P["glow"] - 1.0) / 0.6), 0.0, 1.0)
        eyes = e.get("eyes", "dot")
        return dict(view="front" if view == "front" else "side", eyes=eyes, mouth=e.get("mouth", "w"),
                    look=(self.look[0], self.look[1]), pupil=self.pupil_cur, lid=lid,
                    tear=e.get("tear", 0.0), stream=e.get("stream", 0.0), blush=e.get("blush", 0.6),
                    lines=e.get("lines", 0.0), brows=e.get("brows"), cheeks=self._cheeks(),
                    cyan=cyan, aura=P["aura"], time=self.time, seed=int(self.time * POSE_FPS) // 2,
                    mouth_open=0.5 + 0.5 * math.sin(self.time * 10))

    def ear_angles(self):
        out = []
        for i in range(2):
            a = self.ear[i]
            flick = 16.0 * (a * (1 - a) * 4)
            droop = -36.0 * self.p["ears_down"] * EAR_DROOP_SIGN
            out.append(-(flick + droop + self.ear_sp * (1 if i == 0 else 0.8)))
        return out

    # --------------------------------------------------------------- tail
    def tail_rest(self):
        P = self.p
        pel, che, sp, crouch = self.skeleton()
        bx, by = pel[0] - R_PELVIS * 0.85, pel[1] + 2
        up = P["tail_up"]
        wag = P["tail_wag"] + P["lash"] * 1.6
        pts = [(bx, by)]
        ang = math.radians(lerp(190, 250, up))
        if self.mode == "ground" and self.ground_speed > 200:
            ang = math.radians(lerp(185, 210, up))
        if P["lie"] > 0.5:
            ang = math.radians(178)
        x, y = bx, by
        for i in range(1, TAIL_N):
            curl = lerp(0.05, 0.42, up) + 0.2 * P["lie"]
            spd = 3.4 + 7.0 * P["lash"]
            idle_curl = 0.07 * math.sin(self.time * 0.7 + i * 0.5) * P["life"]
            ang += curl * (1 if P["lie"] < 0.5 else -1.6) + wag * 0.4 * math.sin(self.time * spd - i * 0.6) + idle_curl
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
        stiff = 1 - math.exp(-dt / 0.05)
        grav = 900 * dt * dt if self.mode in ("hang", "held") else 0
        new = [rest[0]]
        for i in range(1, len(rest)):
            x, y = self.tail[i]
            px, py = self.tail_prev[i]
            vx, vy = (x - px) * 0.84, (y - py) * 0.84 + grav
            nx, ny = x + vx, y + vy
            k = stiff * (1.0 - 0.08 * i)
            nx += (rest[i][0] - nx) * k
            ny += (rest[i][1] - ny) * k
            new.append((nx, ny))
        for _ in range(2):
            for i in range(1, len(new)):
                ax, ay = new[i - 1]
                bx, by = new[i]
                d = math.hypot(bx - ax, by - ay) or 1e-6
                new[i] = (ax + (bx - ax) * seg / d, ay + (by - ay) * seg / d)
        self.tail_prev = self.tail
        self.tail = new

    def shift(self, dx, dy):
        self.x += dx
        self.y += dy
        self.move_feet(dx)
        if self.tail:
            self.tail = [(x + dx, y + dy) for x, y in self.tail]
            self.tail_prev = [(x + dx, y + dy) for x, y in self.tail_prev]

    def bounds(self, items, pad=6):
        xs, ys = [], []
        for it in items:
            k = it[0]
            if k == "shape" and it[1] in ("body", "head"):
                xs += [q[0] for q in it[2]]
                ys += [q[1] for q in it[2]]
            elif k in ("leg", "tube"):
                w = it[2] * 0.5 + 6
                for q in it[1]:
                    xs += [q[0] - w, q[0] + w]
                    ys += [q[1] - w, q[1] + w]
                if k == "leg":
                    px, py, rx, ry = it[3][:4]
                    xs += [px - rx - 3, px + rx + 3]
                    ys += [py - rx - 3, py + rx + 3]
            elif k == "aura":
                m = it[1]
                r = HA * 1.9 * math.hypot(m[0], m[1])
                xs += [m[4] - r, m[4] + r]
                ys += [m[5] - r, m[5] + r]
            elif k == "fx":
                for f in it[1]:
                    xs += [f[1] - 30 * f[3], f[1] + 30 * f[3]]
                    ys += [f[2] - 30 * f[3], f[2] + 30 * f[3]]
            elif k == "blob":
                for c in it[2]:
                    r = c[3] if c[0] == "c" else max(c[3], c[4])
                    xs += [c[1] - r, c[1] + r]
                    ys += [c[2] - r, c[2] + r]
        if not xs:
            return self.x - 10, self.y - 10, self.x + 10, self.y + 10
        return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad

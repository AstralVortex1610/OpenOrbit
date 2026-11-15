"""Body physics + locomotion + navigation for the kitten. Pure python (no Qt).

Every helper is a generator that advances one frame per `yield`; Actor.step(dt) runs physics
and the rig each frame. Real gravity, no rubber bounce: landings stop dead and the legs absorb.
"""
import math
import random
import time

from .rig import Rig, clamp

G = 3400.0           # px/s^2
ACCEL = 1700.0
DECEL = 2600.0
WALK, TROT, RUN = 110.0, 260.0, 560.0
CLIMB_SPEED = 190.0


class Actor:
    def __init__(self, world, scale=1.0, sfx=None, fps=60):
        self.world = world
        self.rig = Rig(scale)
        self.scale = scale
        self.sfx = sfx
        self.fps = fps
        self.dt = 1.0 / fps
        self.x, self.y = -1000.0, -1000.0
        self.vx = self.vy = 0.0
        self.mode = "off"            # off | ground | air | climb | hang | peek | held
        self.plat = None
        self.goal_x = None
        self.speed = WALK
        self.backwards = False
        self.spin = None             # degrees/s while airborne (flips); None = auto-righting
        self.allow_offscreen = False
        self.landed_flag = False
        self.ride_rect = None
        self.wall = None
        self.last_impact = 0.0
        self.time = 0.0

    # ------------------------------------------------------------------ basics
    @property
    def visible(self):
        return self.mode != "off"

    def snd(self, name, gain=1.0):
        if self.sfx:
            try:
                self.sfx.play(name, gain)
            except Exception:
                pass

    def put(self, x, plat=None, mode="ground"):
        self.plat = plat or self.world.ground
        self.x, self.y = x, self.plat.y
        self.vx = self.vy = 0.0
        self.mode = mode
        self.goal_x = None
        self.rig.mode = "ground" if mode == "ground" else mode
        self.rig.view = "side"
        self.rig.rot = 0.0
        self.rig.clip = None
        self.rig.x, self.rig.y = self.x, self.y
        self.rig.place_feet()
        self.rig.tail = None
        self.ride_rect = self.world.rect_of(self.plat.hwnd) if self.plat.hwnd else None

    def hide(self):
        self.mode = "off"
        self.rig.clip = None
        if self.sfx:
            self.sfx.loop("purr", False)

    def area(self):
        return self.world.area()

    # ------------------------------------------------------------------ per-frame physics
    def step(self, dt=None):
        dt = dt or self.dt
        self.time += dt
        self.world.refresh()
        r = self.rig
        dx = 0.0
        if self.mode == "ground":
            dx = self._ground(dt)
        elif self.mode == "air":
            self._air(dt)
        elif self.mode == "climb":
            r.phase = (r.phase + abs(self.vy) * dt / 44.0) % 1.0
            self.y += self.vy * dt
        r.mode = {"ground": "ground", "air": "air", "climb": "climb", "hang": "hang",
                  "held": "air"}.get(self.mode, "ground")
        if self.mode != "hang":
            r.x, r.y = self.x, self.y
        r.update(dt, dx)
        for ev in r.events:
            if ev[0] == "step" and self.mode == "ground" and r.ground_speed > 20:
                self.snd("step", 0.6 if ev[1] else 1.0)
        r.events.clear()

    def _ground(self, dt):
        L, T, R, B = self.area()
        p = self.plat
        # ride / lose the window we stand on
        if p is not None and not p.ground:
            rect = self.world.rect_of(p.hwnd)
            if rect is None:
                return self.fall()
            if self.ride_rect and rect != self.ride_rect:
                ddx, ddy = rect[0] - self.ride_rect[0], rect[1] - self.ride_rect[1]
                self.x += ddx
                self.y += ddy
                self.rig.shift(ddx, ddy)
                if self.goal_x is not None:
                    self.goal_x += ddx
            self.ride_rect = rect
            fresh = self.world.same(p, self.x)
            if fresh is None:
                if abs(rect[1] - p.y) > 2 or not (rect[0] - 4 <= self.x <= rect[0] + rect[2] + 4):
                    return self.fall()
                fresh = p
                fresh.y = rect[1]
            self.plat = p = fresh
            self.y = p.y
        elif p is not None:
            p = self.plat = self.world.ground
            self.y = p.y
        # locomotion towards goal_x
        want = 0.0
        if self.goal_x is not None:
            d = self.goal_x - self.x
            if abs(d) < 1.0 and abs(self.vx) < 30:
                self.x = self.goal_x
                self.goal_x = None
                self.vx = 0.0
            else:
                want = math.copysign(min(self.speed, math.sqrt(2 * DECEL * abs(d) * 0.9)), d)
        a = ACCEL if abs(want) > abs(self.vx) and want * self.vx >= 0 else DECEL
        dv = want - self.vx
        self.vx += clamp(dv, -a * dt, a * dt)
        nx = self.x + self.vx * dt
        if not self.allow_offscreen and p.ground:
            nx = clamp(nx, L + 30, R - 30)
        if not p.has(nx):
            # walked off the end of a window: drop
            self.x = nx
            return self.fall()
        dx = nx - self.x
        self.x = nx
        return dx

    def fall(self):
        self.mode = "air"
        self.plat = None
        self.vy = max(self.vy, 0.0)
        self.rig.mode = "air"
        return 0.0

    def _air(self, dt):
        L, T, R, B = self.area()
        r = self.rig
        self.vy += G * dt
        nx = self.x + self.vx * dt
        ny = self.y + self.vy * dt
        if not self.allow_offscreen:
            if nx < L + 25:
                nx, self.vx = L + 25, 0.0
            elif nx > R - 25:
                nx, self.vx = R - 25, 0.0
        if self.vy > 0:
            p = self.world.landing(nx, self.y, ny)
            if p is not None:
                self.x, self.y = nx, p.y
                self._land(p)
                return
        self.x, self.y = nx, ny
        # pose: rising = stretched, top = tucked, falling = legs reach for the ground
        r.set(reach=1.0 if self.vy > 250 else 0.0, tuck=1.0 if abs(self.vy) < 350 else 0.0)
        if self.spin is not None:
            r.rot += self.spin * dt
        else:
            # mid-air righting twist: always comes down feet first
            r.rot = r.rot * math.exp(-dt / 0.12)
        if self.y > B + 400:  # safety
            self.put(clamp(self.x, L + 40, R - 40))

    def _land(self, p):
        impact = self.vy
        self.last_impact = impact
        self.vy = 0.0
        self.vx *= 0.25
        self.mode = "ground"
        self.plat = p
        self.spin = None
        self.rig.rot = 0.0
        self.rig.mode = "ground"
        self.rig.x, self.rig.y = self.x, self.y
        self.rig.land(impact)
        self.rig.set(reach=0, tuck=0)
        self.goal_x = None
        self.ride_rect = self.world.rect_of(p.hwnd) if p.hwnd else None
        self.landed_flag = True
        self.snd("land", clamp(impact / 2500.0, 0.25, 1.0))

    # ------------------------------------------------------------------ helpers (generators)
    def wait(self, sec):
        for _ in range(max(1, int(sec * self.fps))):
            yield

    def face(self, d):
        d = 1 if d >= 0 else -1
        if self.rig.facing != d:
            self.rig.turn(d)
            yield from self.wait(0.16)

    def walk_to(self, x, speed=WALK, face=True, timeout=12.0):
        if self.mode != "ground":
            return False
        L, T, R, B = self.area()
        if self.plat is not None and self.plat.ground and not self.allow_offscreen:
            x = clamp(x, L + 30, R - 30)
        if face and abs(x - self.x) > 2:
            yield from self.face(1 if x > self.x else -1)
        self.speed = speed
        self.goal_x = x
        n = 0
        while self.mode == "ground" and self.goal_x is not None and n < timeout * self.fps:
            n += 1
            yield
        self.goal_x = None
        return self.mode == "ground" and abs(self.x - x) < 6

    def jump_to(self, tx, ty, think=False, spin=None):
        """Crouch (and wiggle if it's a big one), then a ballistic arc that lands on (tx, ty)."""
        if self.mode != "ground":
            return False
        r = self.rig
        dx, dy = tx - self.x, ty - self.y
        if abs(dx) > 4:
            yield from self.face(1 if dx > 0 else -1)
        big = think or abs(dx) > 220 or dy < -140
        if big:
            r.set(head_rot=-12 if dy < 0 else 12, look_down=0)
            yield from self.wait(0.35)  # look at it, decide
        r.set(crouch=1.0, lean=-0.12 if dy < -40 else 0.05, tail_up=0.25)
        yield from self.wait(0.16)
        if big:
            for i in range(int(0.5 * self.fps)):  # butt wiggle
                r.set(lean=-0.12 + 0.06 * math.sin(i * 0.9))
                yield
        apex = min(self.y, ty) - (30 + 0.16 * abs(dx))
        h1 = max(1.0, self.y - apex)
        h2 = max(1.0, ty - apex)
        t = math.sqrt(2 * h1 / G) + math.sqrt(2 * h2 / G)
        self.vx = dx / t
        self.vy = -math.sqrt(2 * G * h1)
        r.set(crouch=0.0, lean=0.0, head_rot=0.0, tail_up=0.6)
        self.mode = "air"
        self.plat = None
        self.spin = spin
        self.snd("jump")
        n = 0
        while self.mode == "air" and n < 6 * self.fps:
            n += 1
            yield
        self.spin = None
        yield from self.wait(0.12)
        return self.mode == "ground"

    def hop(self, height=60, flips=0.0, vx=0.0, wind=0.12):
        """Vertical hop; flips>0 = forward somersaults, <0 = backflips (land on his feet)."""
        if self.mode != "ground":
            return
        self.rig.set(crouch=0.8)
        yield from self.wait(wind)
        self.rig.set(crouch=0)
        self.vy = -math.sqrt(2 * G * height)
        self.vx = vx
        self.mode = "air"
        self.plat = None
        if flips:
            air = 2 * math.sqrt(2 * height / G)
            self.spin = 360.0 * flips * self.rig.facing / air
            self.rig.set(tuck=1.0)
        self.snd("jump", 0.6)
        n = 0
        while self.mode == "air" and n < 4 * self.fps:
            n += 1
            yield
        self.spin = None

    def climb(self, wall_x, side, top_y, onto=None):
        """Claws up a vertical edge (wall on the kitten's `side`), then hops over the top."""
        r = self.rig
        yield from self.face(side)
        r.set(crouch=0.6)
        yield from self.wait(0.12)
        self.mode = "climb"
        self.plat = None
        self.x = wall_x
        r.rot = -90.0 * side
        r.set(crouch=0.0, upright=0.85, tail_up=0.3)
        self.vy = -CLIMB_SPEED
        n = 0
        while self.y > top_y + 8 and n < 12 * self.fps:
            n += 1
            if n % 14 == 0:
                self.snd("step", 0.8)
            yield
        r.set(upright=0.0)
        if onto is not None:
            # hop over the edge onto the top
            self.mode = "air"
            self.vx = side * 140.0
            self.vy = -620.0
            self.snd("jump", 0.5)
            n = 0
            while self.mode == "air" and n < 3 * self.fps:
                n += 1
                yield
        return self.mode == "ground"

    def go_to(self, goal_fn, gx, speed=TROT, max_hops=8):
        """Navigate over surfaces to the platform satisfying goal_fn, then walk to gx on it."""
        for _ in range(max_hops):
            if self.mode == "air":
                for _ in range(int(3 * self.fps)):
                    if self.mode != "air":
                        break
                    yield
            if self.mode != "ground":
                return False
            self.world.refresh(force=True)
            cur = self.world.same(self.plat, self.x) or self.world.ground
            self.plat = cur
            acts = self.world.plan(cur, self.x, goal_fn)
            if acts is None:
                return False
            if not acts:
                ok = yield from self.walk_to(clamp(gx, cur.l + 20, cur.r - 20), speed)
                return ok and goal_fn(self.plat)
            for a in acts:
                if a[0] == "walk":
                    yield from self.walk_to(a[1], speed)
                    yield from self.wait(0.1)
                elif a[0] == "jump":
                    Q, lx = a[1], a[2]
                    yield from self.jump_to(lx, Q.y)
                elif a[0] == "climb":
                    Q, wall, side = a[1], a[2], a[3]
                    yield from self.climb(wall, side, Q.y, onto=Q)
                if self.mode != "ground":
                    break
        return self.mode == "ground" and goal_fn(self.plat)

    def to_ground(self, gx=None, speed=TROT):
        gx = self.x if gx is None else gx
        ok = yield from self.go_to(lambda p: p.ground, gx, speed)
        return ok

    def leave(self, speed=TROT):
        """Trot off the nearest side of the screen."""
        if self.mode == "off":
            return
        if self.mode == "peek":
            yield from self.peek_out()
            return
        if self.mode in ("hang", "climb"):
            self.rig.rot = 0.0
            yield from let_go(self)
        if self.mode != "ground" or not self.plat.ground:
            yield from self.to_ground()
        L, T, R, B = self.area()
        side = 1 if self.x > (L + R) / 2 else -1
        self.allow_offscreen = True
        yield from self.walk_to(R + 140 if side > 0 else L - 140, speed, timeout=15)
        self.allow_offscreen = False
        self.hide()

    def enter_side(self, x, side=None, speed=TROT):
        L, T, R, B = self.area()
        if side is None:
            side = -1 if x < (L + R) / 2 else 1
        self.allow_offscreen = True
        self.put(L - 120 if side < 0 else R + 120)
        self.rig.facing = -side
        self.rig.place_feet()
        self.rig.reset_pose()
        self.rig.snap()
        self.rig.expr = "neutral"
        yield from self.walk_to(x, speed)
        self.allow_offscreen = False

    def peek_in(self, x, edge_y, rot=0.0, up=1.0, dur=0.6):
        """Front-facing peek up over an edge (paws on the edge), everything below it hidden."""
        r = self.rig
        self.mode = "peek"
        self.x, self.y = x, edge_y
        r.x, r.y, r.rot = x, edge_y, rot
        r.view = "peek"
        r.reset_pose()
        r.snap()
        r.peek_up = 0.0
        c, si = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        r.clip = [(x + px * c - py * si, edge_y + px * si + py * c)
                  for px, py in ((-3000, -3000), (3000, -3000), (3000, 0), (-3000, 0))]
        n = max(1, int(dur * self.fps))
        for i in range(1, n + 1):
            t = i / n
            r.peek_up = up * (1 - (1 - t) ** 3)
            yield

    def peek_out(self, dur=0.35):
        r = self.rig
        u0 = r.peek_up
        n = max(1, int(dur * self.fps))
        for i in range(1, n + 1):
            r.peek_up = u0 * (1 - i / n) - 0.15 * (i / n)
            yield
        self.hide()

    def hop_out_of_peek(self):
        """From peeking over the bottom edge to standing on it."""
        r = self.rig
        L, T, R, B = self.area()
        r.view = "side"
        r.rot = 0.0
        r.clip = None
        x = self.x
        self.put(x)
        self.y = B + 40
        self.vx, self.vy = 0.0, -math.sqrt(2 * G * 90)
        self.mode = "air"
        self.plat = None
        r.mode = "air"
        r.tail = None
        n = 0
        while self.mode == "air" and n < 3 * self.fps:
            n += 1
            yield

    def tween_params(self, dur, **kw):
        self.rig.set(**kw)
        yield from self.wait(dur)



def hang_pose(actor, gx, gy, t, swing=14.0):
    """One frame of dangling from an edge by the front paws at (gx, gy)."""
    a, r = actor, actor.rig
    a.mode = "hang"
    a.plat = None
    r.mode = "hang"
    r.view = "side"
    r.set(upright=0.9, tail_up=0.0, tail_wag=0.05)
    r.rot = -90.0 * r.facing + swing * math.sin(t * 2.2)
    pel, che, _, _ = r.skeleton()
    r.x, r.y = 0.0, 0.0
    wx, wy = r.to_world(che[0] + 26, che[1] - 14)
    r.x, r.y = gx - wx, gy - wy
    a.x, a.y = r.x, r.y


def hang_at(actor, gx, gy, dur, swing=14.0):
    n = max(1, int(dur * actor.fps))
    for i in range(n):
        hang_pose(actor, gx, gy, i / actor.fps, swing * (1 - 0.4 * i / n))
        yield


def let_go(actor):
    """Drop from a hang: falls, twists upright, lands on his feet."""
    a, r = actor, actor.rig
    r.set(upright=0.0, tail_up=0.75, tail_wag=0.15)
    a.mode = "air"
    a.vx, a.vy = 0.0, 0.0
    a.x, a.y = r.x, r.y
    n = 0
    while a.mode == "air" and n < 4 * a.fps:
        n += 1
        yield

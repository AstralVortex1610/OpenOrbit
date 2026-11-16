"""The kitten: a transparent always-on-top window that paints a skeletal rig (rig.py) moved by real
physics and route planning over your windows (motion.py, world.py), with quiet sound effects.
Behaviour scripts are generators advanced once per 60 Hz physics step."""
import math
import os
import queue
import random
import subprocess
import threading
import time

from PySide6.QtCore import Qt, QTimer, QRect
from PySide6.QtGui import QPainter, QCursor, QGuiApplication
from PySide6.QtWidgets import QWidget, QInputDialog, QLineEdit, QApplication

from . import win32, brain, draw
from .ears import resource
from .motion import Actor, WALK, TROT, RUN, G, hang_pose, hang_at, let_go, held_pose, scruff_world
from .rig import clamp
from .sfx import Sfx
from .world import World

FPS = 60
DT = 1.0 / FPS


BASE_SIZE = 0.68  # Nov 16: Affan wanted him smaller on screen (about 100 px tall)


class Pet(QWidget):
    def __init__(self, cfg):
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool
                         | Qt.WindowDoesNotAcceptFocus | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.cfg = cfg
        self.stats = brain.Stats()
        self.name = brain.orbit.user_name()
        self.my_pid = os.getpid()
        self.events = queue.Queue()

        self.k = win32.system_scale() * BASE_SIZE * float(cfg.get("size", 1.0))
        self.sfx = Sfx(cfg)
        self.world = World(self.work_area, self.my_pid)
        self.actor = Actor(self.world, self.k, self.sfx, FPS)
        self.rig = self.actor.rig
        self.art = draw.HeadArt(resource("assets", "rig"))
        self.items = []
        self.geo = None

        self.script = None
        self.mission = None
        self.dragging = False
        self.drag_samples = []
        self.resume_after_landing = None
        self.fling = False
        self.pet_time = 0.0
        self.purring_for = set()
        self.hold = None             # scruff-grab physics state while dragging
        self.fling_speed = 0.0
        self.petted_pose = False

        # watchers
        self.scroll_since = None
        self.scroll_hwnd = None
        self.last_catch = 0.0
        self.active_seconds = 0.0
        self.watch_since = None
        self.watch_key = None
        self.watched_keys = {}
        self.recent_stunts = []
        self.prev_fg_rect = None
        self.prev_fg = None

        self.last_tick = time.time()
        self.acc = 0.0
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(int(1000 / FPS))
        self.interval = int(1000 / FPS)
        self.slow = QTimer(self)
        self.slow.timeout.connect(self.think)
        self.slow.start(1000)
        self.hide()

    # ------------------------------------------------------------------ geometry
    def work_area(self):
        scr = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
        g = scr.availableGeometry()
        return g.left(), g.top(), g.right(), g.bottom()

    @property
    def flying(self):
        return self.fling

    # ------------------------------------------------------------------ frame loop
    def tick(self):
        now = time.time()
        self.acc += min(0.1, now - self.last_tick)
        self.last_tick = now
        steps = 0
        while self.acc >= DT * 0.999 and steps < 6:
            self.acc -= DT
            steps += 1
            try:
                self.step()
            except Exception:
                self.script, self.mission = None, None
                if self.actor.visible:
                    self.start("leave", self.actor.leave())
        if steps:
            self.place()
        self.pace()

    def pace(self):
        """60 fps while moving, ~20 fps while resting, 10 fps when nobody is on screen."""
        a = self.actor
        if not a.visible and not self.dragging:
            want = 100
        elif (a.mode in ("ground", "hang") and abs(a.vx) < 1 and self.rig.ground_speed < 2
              and self.rig.flip_t >= 1 and not self.dragging
              and not any(l.swing for l in self.rig.legs.values())
              and self.rig.squash_y < 0.01 and self.mission in ("watch", "summon", "notepad")):
            want = 50
        else:
            want = int(1000 / FPS)
        if want != self.interval:
            self.interval = want
            self.timer.start(want)

    def place(self):
        a = self.actor
        if not a.visible and not self.dragging:
            if self.isVisible():
                self.hide()
            self.items = []
            return
        self.items = self.rig.frame()
        x0, y0, x1, y1 = self.rig.bounds(self.items, pad=8)
        q = 48
        w = int(math.ceil((x1 - x0) / q) * q)
        h = int(math.ceil((y1 - y0) / q) * q)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        geo = QRect(int(cx - w / 2), int(cy - h / 2), w, h)
        if self.geo is None or self.geo != geo:
            self.setGeometry(geo)
            self.geo = geo
        if not self.isVisible():
            self.show()
        self.update()

    def paintEvent(self, _):
        if not self.items or self.geo is None:
            return
        p = QPainter(self)
        p.translate(-self.geo.left(), -self.geo.top())
        draw.paint(p, self.items, self.art, self.k * self.rig.zoom, self.rig.clip)
        p.end()

    # ------------------------------------------------------------------ mouse: grab & fling
    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton and self.actor.visible:
            self.grab(QCursor.pos())

    def mouseMoveEvent(self, e):
        if self.dragging:
            self.drag_samples.append((time.time(), QCursor.pos()))
            self.drag_samples = self.drag_samples[-6:]

    def mouseReleaseEvent(self, e):
        if not self.dragging:
            return
        self.release()

    # grabbed by the scruff: he does NOT just come along. A spring tether between the cursor and his
    # scruff makes the drag lag; he squirms, paddles, lashes his tail and pulls away from the cursor,
    # and tugs free if you yank too hard or drag too lazily. Held long enough he goes limp and sulks
    # ("scruff freeze"), then starts wriggling again.
    HOLD_K = 55.0        # tether stiffness (1/s^2)
    HOLD_D = 9.0         # damping
    SQUIRM_S, LIMP_S = 2.4, 1.9

    def grab(self, c):
        a, r = self.actor, self.rig
        self.dragging = True
        if self.script is not None and self.resume_after_landing is None:
            self.resume_after_landing = self.mission
        self.script, self.mission = None, None
        r.view = "side"
        r.clip = None
        r.zoom = 1.0
        r.expr = "shocked"
        r.reset_pose()
        r.set(paddle=1.0, lash=1.0, upright=0.85, tail_up=0.2, ears_down=0.9)
        self._purr("pet", False)
        self.sfx.play("meow")
        sx, sy = scruff_world(r) if a.mode in ("ground", "air") else (c.x(), c.y())
        self.hold = dict(sx=sx, sy=sy, vx=0.0, vy=0.0, t=0.0, phase="squirm", pt=0.0, esc=0.0,
                         cx=c.x(), cy=c.y(), cvx=0.0, cvy=0.0, swing=0.0, swing_v=0.0, slow=0.0)
        a.vx = a.vy = 0.0
        self.drag_samples = [(time.time(), c)]

    def release(self, escaped=False):
        h = self.hold or {}
        self.dragging = False
        self.hold = None
        r = self.rig
        r.set(paddle=0.0, lash=0.0, upright=0.0, limp=0.0, ears_down=0.0)
        vx, vy = h.get("vx", 0.0), h.get("vy", 0.0)
        if escaped:
            r.expr = "angry"
            vx, vy = vx * 0.4 + h.get("away", 1) * 380, min(vy, 0) - 520
            self.sfx.play("hiss", 0.5)
        self.launch(clamp(vx, -3000, 3000), clamp(vy, -3000, 3000))

    def hold_step(self, c, dt):
        """One physics step of being held. Returns True if he wriggled free."""
        h, a, r = self.hold, self.actor, self.rig
        k = self.k
        h["t"] += dt
        h["pt"] += dt
        cvx, cvy = (c.x() - h["cx"]) / dt, (c.y() - h["cy"]) / dt
        jerk = math.hypot(cvx - h["cvx"], cvy - h["cvy"]) / dt
        h["cvx"] += (cvx - h["cvx"]) * 0.5
        h["cvy"] += (cvy - h["cvy"]) * 0.5
        h["cx"], h["cy"] = c.x(), c.y()
        squirm = h["phase"] == "squirm"
        # phases: squirm <-> limp sulk
        if squirm and h["pt"] > self.SQUIRM_S:
            h["phase"], h["pt"] = "limp", 0.0
            r.expr = "sulky"
            r.set(paddle=0.0, limp=1.0, lash=0.0, tail_up=0.0, ears_down=1.0)
        elif not squirm and h["pt"] > self.LIMP_S:
            h["phase"], h["pt"] = "squirm", 0.0
            r.expr = "angry"
            r.set(paddle=1.0, limp=0.0, lash=1.0, ears_down=0.9)
            self.sfx.play("mew_short", 0.8)
        if squirm and h["t"] > 0.35 and r.expr == "shocked":
            r.expr = "angry"
        r.fx_on = {"vein": 1.6} if squirm and h["t"] > 0.5 else {}
        # he pulls away from the cursor in tugs; his weight hangs below it
        away = -1 if h["sx"] < c.x() - 4 else 1 if h["sx"] > c.x() + 4 else (-r.facing)
        h["away"] = away
        tug = (0.55 + 0.45 * math.sin(h["t"] * 6.5)) if squirm else 0.0
        fx = self.HOLD_K * (c.x() - h["sx"]) - self.HOLD_D * h["vx"] + away * 900 * tug * k
        fy = self.HOLD_K * (c.y() + 6 * k - h["sy"]) - self.HOLD_D * h["vy"] + 600 * k
        h["vx"] += fx * dt
        h["vy"] += fy * dt
        h["sx"] += h["vx"] * dt
        h["sy"] += h["vy"] * dt
        # the tether can only stretch so far: the grip slides along with the cursor
        d = math.hypot(c.x() - h["sx"], c.y() - h["sy"])
        maxd = 70 * k
        if d > maxd:
            ux, uy = (h["sx"] - c.x()) / d, (h["sy"] - c.y()) / d
            h["sx"], h["sy"] = c.x() + ux * maxd, c.y() + uy * maxd
        # escape: a hard yank, or he wins the tug-of-war while you drag lazily
        speed = math.hypot(h["cvx"], h["cvy"])
        h["slow"] = h["slow"] + dt if (squirm and speed < 90) else max(0.0, h["slow"] - dt * 2)
        if squirm:
            h["esc"] += dt * (0.22 + (0.35 if h["slow"] > 0.8 else 0.0) + (0.5 if d > maxd * 0.92 else 0.0))
        if squirm and (jerk > 90000 * k or h["esc"] >= 1.0) and h["t"] > 0.6:
            return True
        # body swing (pendulum on the scruff) + wriggle
        sw_t = clamp(-h["vx"] * 0.035, -35, 35)
        h["swing_v"] += ((sw_t - h["swing"]) * 90 - 7 * h["swing_v"]) * dt
        h["swing"] += h["swing_v"] * dt
        wr = (math.sin(h["t"] * 17) * 9 + math.sin(h["t"] * 5.3) * 6) if squirm else math.sin(h["t"] * 1.8) * 2
        f = r.facing
        if squirm and abs(h["vx"]) > 60 and (h["vx"] > 0) == (f > 0) and h["pt"] > 0.3:
            pass
        held_pose(a, h["sx"], h["sy"], -88 * f + h["swing"] + wr + away * f * 10 * tug, h["t"])
        a.vx, a.vy = h["vx"], h["vy"]
        return False

    def mouseDoubleClickEvent(self, e):
        self.start("shoo", self.s_sulk_away())

    def launch(self, vx, vy):
        a = self.actor
        a.mode = "air"
        a.plat = None
        a.vx, a.vy = vx, vy
        a.spin = None  # auto-righting: twists to land on his feet
        self.fling = True
        self.fling_speed = math.hypot(vx, vy)
        self.rig.set(paddle=0.0, lash=0.0, upright=0.0, limp=0.0)
        self.rig.fx_on = {}

    def knock(self, vx, vy):
        if not self.actor.visible:
            return
        if self.script is not None and self.resume_after_landing is None:
            self.resume_after_landing = self.mission
        self.script, self.mission = None, None
        self.rig.view = "side"
        self.rig.clip = None
        self.rig.expr = "surprised"
        self.sfx.play("hiss", 0.6)
        self.rig.rot = random.choice([-40, 40])
        self.launch(vx, vy)

    # ------------------------------------------------------------------ physics step
    def step(self):
        while not self.events.empty():
            self.on_event(*self.events.get_nowait())
        a, r = self.actor, self.rig
        c = QCursor.pos()
        hx, hy, hs = r.head_w
        r.look_at = (c.x(), c.y()) if (a.visible and abs(c.x() - hx) < 700 * self.k
                                       and abs(c.y() - hy) < 500 * self.k) else None
        if self.dragging:
            if self.hold is None:
                self.grab(c)
            if self.hold_step(c, DT):
                self.release(escaped=True)
            a.step()
            return
        if self.fling and a.mode != "air":
            self.fling = False
            again = self.resume_after_landing
            self.resume_after_landing = None
            self.start("landed", self.s_landed(again))
        self.window_bumps()
        if self.script is not None:
            try:
                next(self.script)
            except StopIteration:
                self.script = None
                was = self.mission
                self.mission = None
                if a.visible and was != "leave":
                    self.start("leave", self.s_leave())
        self.petting()
        a.step()

    def petting(self):
        """Hover / stroke the cursor over him while he rests: eyes close, he leans into your hand,
        purrs, kneads and little hearts float up. Leaves the moment you stop."""
        a, r = self.actor, self.rig
        calm = self.mission in (None, "watch", "summon", "notepad", "plea", "idle")
        if not a.visible or self.geo is None or a.mode not in ("ground",) or abs(a.vx) > 5 or not calm:
            if self.pet_time > 0:
                self._unpet()
            return
        c = QCursor.pos()
        if not self.items:
            return
        x0, y0, x1, y1 = self.rig.bounds(self.items, pad=0)
        if x0 < c.x() < x1 and y0 < c.y() < y1:
            self.pet_time += DT
            if self.pet_time > 0.45:
                hx, hy, hs = r.head_w
                side = 1 if (c.x() - hx) * r.facing > 0 else -1
                r.expr = "blush" if (self.pet_time % 5.0) > 3.2 else "content"
                r.set(lean_in=side * 1.0, tilt=-10 * side + 4 * math.sin(self.pet_time * 2.2), ears_down=0.35,
                      knead=1.0 if r.p["sit"] > 0.5 else 0.0, tail_wag=0.5, aura=0.0)
                r.fx_on = {"purr": 1.8, "heart": 0.9}
                self.petted_pose = True
                self._purr("pet", True)
        elif self.pet_time > 0:
            self._unpet()

    def _unpet(self):
        r = self.rig
        self.pet_time = 0.0
        if self.petted_pose:
            self.petted_pose = False
            if r.expr in ("happy", "content", "blush"):
                r.expr = "neutral"
            r.set(lean_in=0.0, tilt=0.0, ears_down=0.0, knead=0.0, tail_wag=0.15)
            r.fx_on = {}
        self._purr("pet", False)

    def _purr(self, who, on):
        if on:
            self.purring_for.add(who)
        else:
            self.purring_for.discard(who)
        self.sfx.loop("purr", bool(self.purring_for), gain=0.45)

    def window_bumps(self):
        """Drag a window into him and he gets knocked away (unless it's the one he stands on)."""
        h = win32.foreground()
        r = win32.rect(h) if h else None
        a = self.actor
        if h and r and h == self.prev_fg and self.prev_fg_rect and r != self.prev_fg_rect \
                and r[2] == self.prev_fg_rect[2] and r[3] == self.prev_fg_rect[3] and self.script is not None \
                and self.mission not in ("watch",) and a.visible and a.mode == "ground" \
                and (a.plat is None or a.plat.hwnd != h):
            dx, dy = r[0] - self.prev_fg_rect[0], r[1] - self.prev_fg_rect[1]
            m = 30 * self.k
            hit = (r[0] - m < a.x < r[0] + r[2] + m) and (r[1] - m < a.y - 40 * self.k < r[1] + r[3] + m)
            if hit and abs(dx) + abs(dy) > 6:
                self.knock(dx * FPS * 1.2, dy * FPS * 1.2 - 700)
        self.prev_fg, self.prev_fg_rect = h, r

    # ------------------------------------------------------------------ the 1-second brain
    def think(self):
        try:
            self.sfx.tick()
            self._think()
        except Exception:
            pass

    def _think(self):
        if win32.keys_down(win32.VK_CONTROL, win32.VK_MENU, win32.VK_SHIFT, 0x4B):  # Ctrl+Alt+Shift+K
            self.ask_quit()
            return
        seen = brain.look(self.my_pid)
        idle = win32.idle_seconds()
        if idle < 60:
            self.active_seconds += 1

        # 1. doomscrolling: highest priority
        if brain.is_doomscroll(seen, self.cfg):
            if self.scroll_hwnd != (seen.hwnd, seen.title):
                self.scroll_hwnd, self.scroll_since = (seen.hwnd, seen.title), time.time()
            grace = self.cfg["doomscroll_grace_seconds"]
            if time.time() - self.scroll_since >= grace and time.time() - self.last_catch > 8 \
                    and self.mission not in ("catch",) and not self.flying and not self.dragging:
                self.start("catch", self.s_catch(seen))
            return
        self.scroll_hwnd = self.scroll_since = None

        # 2. break time
        if self.active_seconds >= self.cfg["break_every_minutes"] * 60 and self.script is None and idle < 30:
            self.active_seconds = 0
            self.do_stunt(is_break=True)
            return
        if idle > 300:
            self.active_seconds = max(0, self.active_seconds - 5)  # being away counts as a break

        # 3. watching something good together
        cat = brain.watch_category(seen)
        if cat and seen.rect and not win32.is_minimized(seen.hwnd):
            key = (seen.hwnd, seen.title[:40])
            if key != self.watch_key:
                self.watch_key, self.watch_since = key, time.time()
            last = self.watched_keys.get(key, 0)
            if self.script is None and time.time() - self.watch_since > self.cfg["watch_after_seconds"] \
                    and time.time() - last > 3600:
                self.watched_keys[key] = time.time()
                if random.random() < self.cfg["watch_chance"]:
                    self.stats.watched(cat, seen.title)
                    self.start("watch", self.s_watch(seen, cat))
        else:
            self.watch_key = None

    def ask_quit(self):
        if getattr(self, "_asking", False):
            return
        self._asking = True
        try:
            txt, ok = QInputDialog.getText(None, "Kitty", "Secret passphrase:", QLineEdit.Password)
        finally:
            self._asking = False
        if ok and txt.strip().lower() == str(self.cfg["passphrase"]).strip().lower():
            os.makedirs(brain.APP_DIR, exist_ok=True)
            with open(brain.QUIT_FLAG, "w") as f:
                f.write(str(time.time()))
            QApplication.quit()

    # ------------------------------------------------------------------ events from ears
    def on_event(self, kind, val):
        if kind == "loud":
            if self.script is not None and self.mission != "catch":
                self.start("startle", self.s_startle(self.mission))
            elif self.script is None and random.random() < 0.3:
                self.start("startle", self.s_curious_peek())
        elif kind == "heard" and val:
            if val in ("mute", "unmute"):
                self.cfg["sound_muted"] = val == "mute"
                brain.save_config(self.cfg)
                if val == "unmute":
                    self.sfx.play("mew_short")
                return
            if self.mission == "catch":
                return  # nice try
            if val == "summon":
                self.start("summon", self.s_summon())
            elif val == "break":
                self.do_stunt(is_break=True)
            elif val == "shoo":
                if self.script is not None or self.actor.visible:
                    self.start("shoo", self.s_sulk_away())
            elif val == "praise":
                self.start("praise", self.s_praise())
            elif val == "scold":
                self.start("scold", self.s_scolded())
            elif val == "dance":
                self.start("stunt", self.s_dance())
            elif val == "flip":
                self.start("stunt", self.s_backflip())

    # ------------------------------------------------------------------ scripting helpers
    def start(self, mission, gen):
        if self.actor.mode in ("hang", "climb", "held", "peek") and mission not in ("landed",):
            gen = self._then(self._settle(), gen)
        self.mission, self.script = mission, gen

    @staticmethod
    def _then(a, b):
        yield from a
        yield from b

    def _settle(self):
        """Get back to a normal stance before a new script (let go of edges, finish peeks)."""
        a = self.actor
        if a.mode == "peek":
            yield from a.peek_out(0.2)
        elif a.mode in ("hang", "climb"):
            self.rig.rot = 0.0
            yield from let_go(a)
        self._purr("watch", False)

    def wait(self, sec):
        yield from self.actor.wait(sec)

    def area(self):
        return self.work_area()

    def arrive(self, x, how="auto"):
        """Get on screen near x: peek up from the taskbar edge and hop out, or trot in from a side."""
        a = self.actor
        if a.visible:
            if a.mode == "air":
                yield from self.wait(1.5)
            return
        L, T, R, B = self.area()
        x = clamp(x, L + 80, R - 80)
        self.rig.reset_pose()
        self.rig.expr = "neutral"
        if how == "peek" or (how == "auto" and random.random() < 0.5):
            yield from a.peek_in(x, B)
            yield from self.wait(0.3)
            yield from a.hop_out_of_peek()
        else:
            yield from a.enter_side(x, speed=TROT)

    def look_around(self, n=2):
        for _ in range(n):
            self.rig.set(head_rot=random.choice([-12, -6, 6, 10]))
            yield from self.wait(random.uniform(0.4, 0.9))
        self.rig.set(head_rot=0)

    def wiggle(self, sec=0.6):
        r = self.rig
        r.set(crouch=0.9, tail_up=0.3)
        for i in range(int(sec * FPS)):
            r.set(lean=-0.1 + 0.07 * math.sin(i * 0.9), tail_wag=0.8)
            yield
        r.set(crouch=0.0, lean=0.0, tail_wag=0.15, tail_up=0.75)

    def salute(self):
        a, r = self.actor, self.rig
        if a.mode != "ground":
            return
        yield from a.face(-1 if a.x > sum(self.area()[0:3:2]) / 2 else 1)
        r.expr = "happy"
        r.set(sit=1.0, tilt=-8)
        yield from self.wait(0.3)
        self.sfx.play("mew_short", 0.5)
        r.set(wave=1.0)  # paw up beside his cheek: bye-bye wave
        for i in range(int(1.0 * FPS)):
            r.set(tilt=-8 + 6 * math.sin(i / FPS * 9))
            yield
        r.set(wave=0.0, tilt=0.0)
        r.expr = "neutral"
        yield from self.wait(0.25)
        r.set(sit=0.0)
        yield from self.wait(0.15)

    def s_leave(self):
        r = self.rig
        self._calm()
        self._purr("watch", False)
        yield from self.actor.leave()

    def leave(self, salute=True):
        if salute:
            yield from self.salute()
        yield from self.s_leave()

    def offstage(self):
        return not self.actor.visible

    # ------------------------------------------------------------------ the main act: catch
    def s_catch(self, seen):
        """Peek up, stare, tease, run there (jumping/climbing over windows), paw it shut, salute, leave."""
        label = " - ".join(seen.title.split(" - ")[:-1])[:30] if seen.is_browser else seen.proc
        self.stats.catch(label or seen.proc)
        a, r = self.actor, self.rig
        hwnd = seen.hwnd
        rc = seen.rect or (0, 0, 800, 600)
        L, T, R, B = self.area()
        if not a.visible:
            yield from a.peek_in(clamp(rc[0] + rc[2] / 2, L + 80, R - 80), B)
            r.set(head_rot=-8)
            yield from self.wait(0.6)
            r.set(head_rot=8)
            yield from self.wait(0.8)
            r.set(head_rot=0)
            yield from self.wait(0.5)
            yield from a.hop_out_of_peek()
        elif a.mode == "air":
            yield from self.wait(1.2)
        # he hesitates: a judging stare, then the please-stop eyes... then the smug tease
        yield from self.r_judge(1.6)
        yield from self.r_plea(1.6)
        r.set(sit=0.0)
        r.expr = "tease"
        self.sfx.play("mew_short")
        r.fx_on = {"note": 1.5}
        yield from self.wiggle(0.7)
        r.fx_on = {}
        yield from self.wait(0.3)
        r.expr = "neutral"
        rc = self.world.rect_of(hwnd) or win32.rect(hwnd) or rc
        if seen.is_browser:
            tx, ty = rc[0] + min(260, rc[2] * 0.3), rc[1] + 18  # the tab strip
        else:
            tx, ty = rc[0] + rc[2] - 24, rc[1] + 14  # the X button
        self.world.refresh(force=True)
        plat = self.world.find(hwnd, tx) if hwnd is not None else None
        done = False
        if plat is not None and plat.has(tx, 10):
            # stand on the window's top edge right above it and swipe down
            side = 1 if tx > a.x else -1
            sx = clamp(tx - side * 30 * self.k, plat.l + 15, plat.r - 15)
            ok = yield from a.go_to(lambda p: p.hwnd == hwnd and p.has(sx, 5), sx, speed=RUN)
            if ok:
                yield from a.face(1 if tx >= a.x else -1)
                r.set(crouch=0.6, look_down=1.0, lean=0.15)
                r.expr = "hunt"
                yield from self.wait(0.25)
                r.set(paw=1.0, paw_x=30, paw_y=-62, sq=0.06)  # wind-up...
                yield from self.wait(0.2)
                r.set(paw=1.0, paw_x=44, paw_y=12, sq=-0.12)  # ...SWIPE
                yield from self.wait(0.12)
                r.set(sq=0.0)
                r.expr = "smug"
                self.close_it(hwnd, seen)
                done = True
                yield from self.wait(0.3)
                r.set(paw=0.0, look_down=0.0, crouch=0.0, lean=0.0)
                yield from self.wait(0.2)
        if not done:
            yield from self.wall_swipe(tx, ty, lambda: self.close_it(hwnd, seen))
        if random.random() < float(self.cfg["notepad_chance"]):
            yield from self.s_notepad()
        yield from a.to_ground()
        yield from self.leave(salute=True)

    def close_it(self, hwnd, seen):
        self.sfx.play("step")
        if win32.is_window(hwnd):
            if seen.is_browser:
                win32.ctrl_w(hwnd)
            else:
                win32.close_window(hwnd)
        self.last_catch = time.time()

    def wall_swipe(self, tx, ty, action):
        """Target with no ledge above it (maximized window): climb the nearest screen side,
        leap at the target, swipe it in mid-air, fall and land on his feet."""
        a, r = self.actor, self.rig
        L, T, R, B = self.area()
        yield from a.to_ground(speed=RUN)
        left = tx < (L + R) / 2
        wall = L + 2 if left else R - 2
        stand = wall + (40 if left else -40)
        yield from a.walk_to(stand, RUN)
        side = -1 if left else 1
        yield from a.face(side)
        yield from self.wait(0.2)
        top = clamp(ty + 70 * self.k, T + 40, B - 60)
        yield from a.climb(wall, side, top, onto=None)
        # leap off the wall at the target
        r.rot = 0.0
        r.turn(-side)
        a.x = wall - side * 30  # push off the wall
        dx = tx - a.x
        h = max(30.0, a.y - (ty - 10))
        vy = -math.sqrt(2 * G * h)
        t_apex = -vy / G
        a.vx, a.vy = dx / max(0.15, t_apex), vy
        a.mode = "air"
        a.plat = None
        self.sfx.play("jump")
        r.set(paw=1.0, paw_x=48, paw_y=-40)
        hit = False
        n = 0
        while a.mode == "air" and n < 4 * FPS:
            n += 1
            if not hit and (a.vy >= 0 or abs(a.x - tx) < 30):
                hit = True
                action()
                a.vx *= 0.2
                r.set(paw=0.0)
            yield
        if not hit:
            action()
        r.set(paw=0.0)
        yield from self.wait(0.3)

    # ------------------------------------------------------------------ notepad treat
    def s_notepad(self):
        """The 1-in-100 treat: he writes you a note."""
        note = brain.notepad_note(self.name, self.stats.today()["catches"])
        done = threading.Event()

        def work():
            try:
                subprocess.Popen(["notepad.exe"])
                h = win32.newest_notepad(8)
                time.sleep(1.0)
                if h and win32.force_foreground(h):
                    win32.type_text(note, 0.07)
            finally:
                done.set()

        threading.Thread(target=work, daemon=True).start()
        a, r = self.actor, self.rig
        L, T, R, B = self.area()
        yield from a.to_ground()
        yield from a.walk_to((L + R) / 2, TROT)
        r.set(sit=1.0)
        r.expr = "tease"
        i = 0
        while not done.is_set() and i < 60 * FPS:
            # "typing": alternating paw taps
            if i % 16 == 0:
                up = (i // 16) % 2 == 0
                r.set(paw=0.8 if up else 0.0, paw_x=34, paw_y=-14)
                if not up:
                    self.sfx.play("step", 0.5)
            i += 1
            yield
        r.set(paw=0.0, sit=0.0)
        r.expr = "neutral"
        yield from self.wait(0.5)

    # ------------------------------------------------------------------ watching together
    def s_watch(self, seen, cat):
        """Sit at the bottom-middle and look up at it, or dangle from its top edge (small, by the
        corner, on calls). Rides along / follows when the window moves. Quiet purr."""
        a, r = self.actor, self.rig
        hwnd = seen.hwnd
        rc = seen.rect
        cx = rc[0] + rc[2] / 2
        yield from self.arrive(cx)
        hang = cat == "call" or random.random() < 0.5
        hung = False
        if hang:
            gx = rc[0] + rc[2] - 60 * self.k if cat == "call" else cx
            self.world.refresh(force=True)
            plat = self.world.find(hwnd, gx)
            if plat is not None:
                gx = clamp(gx, plat.l + 30, plat.r - 30)
                ok = yield from a.go_to(lambda p: p.hwnd == hwnd and p.has(gx, 5), gx, speed=TROT)
                if ok:
                    # slide over the edge and dangle by the front paws
                    yield from a.face(1 if gx < rc[0] + rc[2] / 2 else -1)
                    r.set(crouch=0.7)
                    yield from self.wait(0.25)
                    if cat == "call":
                        r.scale = self.k * 0.75
                    hung = True
        if not hung:
            ok = yield from a.go_to(lambda p: p.ground, cx, speed=TROT)
            yield from a.face(1 if cx >= a.x else -1)
            r.set(sit=1.0, head_rot=-14, tail_wag=0.25)
        self._purr("watch", True)
        end = time.time() + self.cfg["watch_max_minutes"] * 60
        i = 0
        while time.time() < end:
            if (win32.IS_WIN and win32.foreground() != hwnd) or not self.world.rect_of(hwnd) \
                    or win32.is_minimized(hwnd):
                break
            if not win32.IS_WIN and i > 8 * FPS:  # test runs
                break
            nr = self.world.rect_of(hwnd)
            if hung:
                hang_pose(a, clamp(gx + (nr[0] - rc[0]), nr[0] + 20, nr[0] + nr[2] - 20), nr[1], i / FPS, 9.0)
            else:
                ncx = nr[0] + nr[2] / 2
                if abs(ncx - a.x) > 60 * self.k and a.mode == "ground":
                    r.set(sit=0.0)
                    yield from a.walk_to(ncx, TROT)
                    r.set(sit=1.0)
                if i % (FPS * 7) == FPS * 6:
                    r.set(head_rot=random.choice([-18, -10, -14]))
            i += 1
            yield
        self._purr("watch", False)
        if hung:
            yield from let_go(a)
            r.scale = self.k
            a.rig.place_feet()
        r.set(sit=0.0, head_rot=0.0)
        yield from self.leave(salute=True)

    # ------------------------------------------------------------------ reactions
    def s_landed(self, resume):
        """After a fling or wriggling free: dizzy if it was a big throw, otherwise a pouty glare and a
        dignified groom; then (if he was catching) straight back to it."""
        a, r = self.actor, self.rig
        if self.fling_speed > 1300:
            yield from self.r_dizzy(2.0)
        r.expr = "pout"
        r.fx_on = {"vein": 1.2}
        yield from a.face(-r.facing)
        for k in range(4):
            r.set(head_rot=(-10 if k % 2 else 10))
            yield from self.wait(0.08)
        r.set(head_rot=0, tail_wag=0.9)
        yield from self.wait(0.6)
        r.fx_on = {}
        r.set(tail_wag=0.15)
        r.expr = "neutral"
        if resume == "catch":
            seen = brain.look(self.my_pid)
            if brain.is_doomscroll(seen, self.cfg):
                yield from self.s_catch(seen)
                return
        if random.random() < 0.5:
            yield from self.r_groom(1.6)
        yield from self.leave(salute=False)

    def s_sulk_away(self):
        if self.offstage():
            return
        a, r = self.actor, self.rig
        if a.mode == "ground":
            yield from self.r_pout(0.9)
        r.expr = "tease"
        r.set(tail_wag=1.0, tail_up=0.4)
        yield from self.wait(0.4)
        r.set(tail_wag=0.15, tail_up=0.75)
        yield from self.s_leave()

    def s_summon(self):
        a, r = self.actor, self.rig
        c = QCursor.pos()
        yield from self.arrive(c.x(), "side")
        L, T, R, B = self.area()
        self.world.refresh(force=True)
        target = self.world.landing(c.x(), c.y(), B + 1) or self.world.ground
        yield from a.go_to(lambda p: p.hwnd == target.hwnd and p.has(c.x(), 5), c.x(), speed=RUN)
        yield from a.face(1 if c.x() >= a.x else -1)
        r.set(sit=1.0)
        self.sfx.play("meow")
        r.expr = "happy"
        yield from self.wait(1.0)
        r.expr = "neutral"
        yield from self.wait(5)
        r.set(sit=0.0)
        yield from self.leave()

    def s_praise(self):
        a, r = self.actor, self.rig
        yield from self.arrive(QCursor.pos().x())
        r.expr = "happy"
        self._purr("praise", True)
        yield from a.hop(220, flips=1.0)
        yield from self.r_dance(2.0)
        r.expr = "blush"
        r.set(sit=1.0, tail_wag=0.5, hide=1.0)
        yield from self.wait(1.2)
        r.set(hide=0.0)
        self._purr("praise", False)
        r.expr = "neutral"
        yield from self.leave(salute=False)

    def s_scolded(self):
        a, r = self.actor, self.rig
        yield from self.arrive(QCursor.pos().x())
        r.expr = "surprised"
        r.set(crouch=0.8, tail_up=0.0, tail_wag=0.9)
        yield from self.wait(0.6)
        r.set(crouch=0.0)
        yield from self.r_cry(1.6)
        yield from self.r_pout(1.2)
        r.expr = "sulky"
        r.set(tail_up=0.4)
        a.speed = WALK
        yield from a.leave(WALK)

    def s_startle(self, resume):
        if self.offstage():
            return
        a, r = self.actor, self.rig
        if a.mode != "ground":
            yield from self._settle()
        yield from self.r_startle()
        if random.random() < 0.5:
            yield from self.r_curious(1.6)
        yield from a.leave(RUN)

    def s_curious_peek(self):
        a = self.actor
        L, T, R, B = self.area()
        yield from a.peek_in(random.uniform(L + 120, R - 120), B)
        self.rig.expr = "curious"
        self.rig.emit("q")
        for h in (-14, 14, -14, 0):
            self.rig.set(tilt=h)
            yield from self.wait(0.35)
        self.rig.expr = "neutral"
        yield from a.peek_out(0.4)

    # ------------------------------------------------------------------ cartoon reactions
    # Each r_* is a self-contained beat that starts and ends standing on the ground (or where it
    # says), so scripts (and the showcase video) can chain them.
    def _calm(self):
        r = self.rig
        r.set(sit=0.0, lie=0.0, stretch=0.0, beg=0.0, knead=0.0, tilt=0.0, ears_down=0.0, aura=0.0, glow=1.0,
              paw=0.0, crouch=0.0, lean=0.0, puff=0.0, arch=0.0, sleep=0.0, look_down=0.0, head_rot=0.0, sq=0.0,
              pupil=0.0, lash=0.0, tail_up=0.75, tail_wag=0.15, lean_in=0.0, head_dy=0.0, dance=0.0, hug=0.0,
              stand=0.0, melt=0.0, kick=0.0, wave=0.0, cheeks=0.0, hide=0.0, roll=0.0)
        r.rot = 0.0 if self.actor.mode == "ground" else r.rot
        r.fx_on = {}
        r.hold_blink = False
        r.expr = "neutral"

    def r_plea(self, sec=3.0, sit=True):
        """'Please?' - sits, head tilt, ears down, huge wet sparkly eyes with a pulsing cyan aura,
        paws together kneading, tiny hopeful mew."""
        r = self.rig
        r.set(sit=1.0 if sit else 0.0, tail_up=0.35, tail_wag=0.35)
        yield from self.wait(0.25)
        r.expr = "plead"
        r.set(tilt=-14, ears_down=1.0, aura=1.0, glow=1.6, beg=1.0 if sit else 0.0, knead=0.6 if sit else 0.0,
              head_dy=2.0)
        r.fx_on = {"sparkle": 2.2}
        self.sfx.play("mew_short", 0.7)
        n = int(sec * FPS)
        for i in range(n):
            if i == n // 2:
                self.sfx.play("mew_short", 0.5)
            r.set(tilt=-14 + 5 * math.sin(i / FPS * 1.6))
            yield
        r.set(beg=0.0, knead=0.0, aura=0.0, glow=1.0, tilt=0.0, ears_down=0.0, head_dy=0.0)
        r.fx_on = {}
        r.expr = "neutral"
        yield from self.wait(0.2)

    def r_curious(self, sec=2.4):
        r = self.rig
        r.expr = "curious"
        r.emit("q")
        self.rig.ear = [1.0, 1.0]
        for i in range(int(sec * FPS)):
            t = i / FPS
            r.set(tilt=18 if (t % 1.6) < 0.8 else -16, head_dy=-1)
            if i == int(1.2 * FPS):
                r.emit("q")
            yield
        r.set(tilt=0, head_dy=0)
        r.expr = "neutral"

    def r_startle(self):
        """Loud noise: wide eyes, '!', straight up in the air, lands arched with puffed fur, hisses."""
        a, r = self.actor, self.rig
        r.expr = "shocked"
        r.emit("excl")
        r.set(puff=1.0, tail_up=1.0, ears_down=0.8, pupil=-0.3, sq=0.14)
        self.sfx.play("hiss", 0.8)
        yield from a.hop(150, wind=0.04)
        r.set(sq=0.0)
        r.set(arch=1.0, crouch=0.0)
        r.fx_on = {"sweat": 1.5}
        for i in range(int(1.3 * FPS)):
            r.set(lash=0.6)
            yield
        r.set(arch=0.0, puff=0.0, ears_down=0.0, lash=0.0, pupil=0.0, tail_up=0.75)
        r.fx_on = {}
        r.expr = "neutral"
        yield from self.wait(0.3)

    def r_dizzy(self, sec=2.4):
        a, r = self.actor, self.rig
        r.expr = "dizzy"
        r.fx_on = {"star": 2.5}
        for k in range(3):
            r.emit("star", rot=k * 2.1)
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.set(head_rot=10 * math.sin(t * 5), lean=0.06 * math.sin(t * 3.3), tilt=8 * math.sin(t * 2.6),
                  ears_down=0.5)
            if i == n // 3 and a.mode == "ground":
                a.goal_x = a.x - 14 * self.k * r.facing  # wobbly stumble back
                a.speed = WALK * 0.5
            yield
        r.fx_on = {}
        r.set(head_rot=0, lean=0, tilt=0, ears_down=0)
        for k in range(3):  # shake it off
            r.set(head_rot=12 if k % 2 else -12)
            yield from self.wait(0.07)
        r.set(head_rot=0)
        r.expr = "neutral"

    def r_pounce(self, tx, ty=None):
        """Hunt the cursor: low crouch, saucer pupils, butt wiggle... POUNCE."""
        a, r = self.actor, self.rig
        ty = a.y if ty is None else ty
        yield from a.face(1 if tx > a.x else -1)
        r.expr = "hunt"
        r.set(crouch=1.0, look_down=0.0, tail_up=0.15, ears_down=0.3, sq=-0.06)
        yield from self.wait(0.35)
        for i in range(int(0.9 * FPS)):
            t = i / FPS
            r.set(lean=-0.1 + 0.08 * math.sin(t * 22), sq=-0.06 + 0.03 * math.sin(t * 22), lash=0.5)
            yield
        r.set(lean=0.0, lash=0.0, sq=-0.14)
        yield from self.wait(0.08)
        r.set(sq=0.0)
        r.expr = "meow"
        yield from a.jump_to(tx, ty)
        r.set(crouch=0.6, paw=1.0, paw_x=34, paw_y=-2)  # paws pinning it
        yield from self.wait(0.35)
        r.set(paw=0.0, crouch=0.0, ears_down=0.0)
        r.expr = "love"
        r.fx_on = {"heart": 2.5}
        yield from self.wait(0.9)
        r.fx_on = {}
        r.expr = "neutral"

    def r_stretch_yawn(self):
        a, r = self.actor, self.rig
        r.set(stretch=1.0, tail_up=1.0, sq=0.05)
        yield from self.wait(0.7)
        r.expr = "yawn"  # big yawn, eyes squeezed
        r.set(head_rot=-10, ears_down=0.5)
        self.sfx.play("mew_short", 0.35)
        yield from self.wait(1.1)
        r.expr = "neutral"
        r.set(stretch=0.0, sit=0.0, head_rot=0, ears_down=0, sq=0.0)
        yield from self.wait(0.35)
        r.ear = [1.0, 1.0]
        for k in range(4):  # little full-body shake
            r.set(head_rot=10 if k % 2 else -10, tilt=6 if k % 2 else -6)
            yield from self.wait(0.06)
        r.set(head_rot=0, tilt=0)

    def r_groom(self, sec=2.6):
        """Sits and licks a paw, then wipes it over his face."""
        r = self.rig
        r.set(sit=1.0)
        yield from self.wait(0.3)
        r.expr = "tease"  # tongue out, eyes half shut
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            lick = 0.5 + 0.5 * math.sin(t * 9)
            if t < sec * 0.55:
                r.set(paw=1.0, paw_x=46 + 2 * lick, paw_y=-80 + 3 * lick, look_down=0.35 + 0.15 * lick, tilt=-6)
            else:  # wipe over the face
                r.set(paw=1.0, paw_x=50 + 8 * math.sin(t * 6), paw_y=-90 + 7 * math.cos(t * 6), look_down=0.2,
                      tilt=8 * math.sin(t * 6))
            yield
        r.set(paw=0.0, look_down=0.0, tilt=0.0)
        r.expr = "neutral"
        yield from self.wait(0.25)

    def r_sneeze(self):
        a, r = self.actor, self.rig
        r.expr = "meow"
        for k in range(2):  # ah... ah...
            r.set(head_rot=-10 - 6 * k, tilt=-4, sq=0.04 + 0.02 * k, ears_down=0.2)
            r.hold_blink = k == 1
            yield from self.wait(0.38)
            r.set(head_rot=-4)
            yield from self.wait(0.12)
        r.hold_blink = True
        r.set(head_rot=-22, sq=0.08)
        yield from self.wait(0.22)
        # CHOO
        r.set(head_rot=20, crouch=0.6, sq=-0.16, ears_down=0.9)
        self.sfx.play("mew_short", 1.0)
        hx, hy, hs = r.head_w
        for k in range(5):
            r.emit("puff", hx + r.facing * hs * 0.55, hy + hs * 0.2, r.facing * random.uniform(80, 200),
                   random.uniform(-60, 30), 0.6, random.uniform(0.5, 0.9))
        a.vx = -r.facing * 80
        yield from self.wait(0.3)
        r.hold_blink = False
        r.expr = "shocked"
        r.set(head_rot=0, crouch=0.0, sq=0.0, ears_down=0.0)
        yield from self.wait(0.4)
        for k in range(4):
            r.set(head_rot=10 if k % 2 else -10)
            yield from self.wait(0.06)
        r.set(head_rot=0)
        r.expr = "neutral"

    def r_tail_chase(self, spins=8):
        a, r = self.actor, self.rig
        r.expr = "hunt"
        r.set(crouch=0.45, lash=1.0, ears_down=0.3)
        for i in range(spins):
            yield from a.face(-r.facing)
            r.set(head_rot=-25, sq=-0.05 if i % 2 else 0.03)
            r.emit("puff", a.x, a.y - 4, random.uniform(-60, 60), -20, 0.35, 0.6)
            yield from self.wait(0.07)
        r.set(crouch=0.0, lash=0.0, head_rot=0, sq=0.0, ears_down=0.0)
        yield from self.r_dizzy(1.8)

    def r_sleep(self, sec=3.0):
        r = self.rig
        r.set(sit=0.0, lie=1.0, sleep=1.0, tail_up=0.0, look_down=0.55, head_dy=7, ears_down=0.4)
        yield from self.wait(0.5)
        r.expr = "sleepy"
        r.fx_on = {"zzz": 0.9}
        self._purr("sleep", True)
        yield from self.wait(sec)
        r.fx_on = {}
        self._purr("sleep", False)
        r.expr = "neutral"
        r.ear = [1.0, 1.0]
        r.set(lie=0.0, sleep=0.0, look_down=0.0, head_dy=0, ears_down=0.0, tail_up=0.75)
        yield from self.wait(0.3)

    def r_happy_hops(self, n=3):
        a, r = self.actor, self.rig
        r.expr = "love"
        r.fx_on = {"heart": 3.0}
        r.set(tail_up=1.0, tail_wag=0.6)
        self.sfx.play("mew_short", 0.6)
        for i in range(n):
            yield from a.hop(48 + 14 * (i % 2), wind=0.1)
            yield from self.wait(0.08)
        r.fx_on = {}
        r.set(tail_wag=0.15, tail_up=0.75)
        r.expr = "neutral"

    def r_judge(self, sec=3.0):
        """Sit-and-stare while you doomscroll: flat brows, half-lidded, slow blinks, one tail flick."""
        r = self.rig
        r.set(sit=1.0, tail_wag=0.05, head_rot=-6)
        yield from self.wait(0.3)
        r.expr = "judge"
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.hold_blink = (t % 2.2) > 1.75  # slow judging blink
            r.set(lash=0.35 if (t % 2.2) < 0.4 else 0.0, tilt=3 * math.sin(t * 0.8))
            yield
        r.hold_blink = False
        r.set(lash=0.0, head_rot=0, tilt=0)
        r.expr = "neutral"

    def r_smug(self, sec=1.6):
        r = self.rig
        r.expr = "tease"
        r.set(tilt=10, tail_wag=0.9, tail_up=1.0)
        r.fx_on = {"note": 1.5}
        self.sfx.play("mew_short", 0.6)
        yield from self.wait(sec)
        r.fx_on = {}
        r.set(tilt=0, tail_wag=0.15, tail_up=0.75)
        r.expr = "neutral"

    def r_tug(self, gx, gy, pull_fn=None, sec=2.4, side=None):
        """Grabs (gx, gy) and tugs: leans way back, paws braced and slipping, straining face, sweat...
        then it gives - POP - and he tumbles onto his bottom."""
        a, r = self.actor, self.rig
        side = side or (1 if gx > a.x else -1)
        yield from a.face(side)
        r.expr = "strain"
        r.set(crouch=0.55, lean=-0.22, paw=1.0, paw_x=46, paw_y=-22 if gy < a.y - 10 else -8,
              tail_up=0.9, lash=0.4, ears_down=0.6, sq=-0.04)
        r.fx_on = {"sweat": 2.0}
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            heave = max(0.0, math.sin(t * 7.0))
            r.set(lean=-0.2 - 0.1 * heave, sq=-0.03 - 0.05 * heave)
            if i % 18 == 9:  # paws slip forward a little each heave
                a.x += side * 3 * self.k
                r.move_feet(side * 3 * self.k)
                self.sfx.play("step", 0.6)
            if pull_fn and heave > 0.9 and i % 9 == 0:
                pull_fn(-side * 10)
            yield
        # POP
        r.fx_on = {}
        r.expr = "shocked"
        r.emit("excl")
        if pull_fn:
            pull_fn(None)
        r.set(paw=0.0, lean=0.0, crouch=0.0, sq=0.0, lash=0.0)
        a.vx = -side * 260
        yield from a.hop(40, vx=-side * 260, wind=0.02)
        r.set(sit=1.0, ears_down=0.0)
        r.expr = "dizzy"
        yield from self.wait(0.7)
        r.expr = "neutral"
        r.set(sit=0.0)

    def r_wave(self):
        yield from self.salute()

    # ------------------------------------------------------------------ v3 mochi reactions
    def _pop(self, **peak):
        """Snap a pose past its target for a beat (cartoon overshoot), caller sets the settle value."""
        self.rig.set(**peak)
        yield from self.wait(0.1)

    def r_dance(self, sec=3.0):
        """Happy wiggle dance: rocks side to side on the beat, arms bopping up by his cheeks."""
        r = self.rig
        r.expr = "happy"
        r.set(sit=0.7, dance=1.0, tail_up=1.0, tail_wag=1.0)
        r.fx_on = {"note": 1.8}
        self.sfx.play("mew_short", 0.6)
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.set(tilt=13 * math.sin(t * math.pi * 1.1))
            if i % int(0.9 * FPS) == 0:
                r.ear = [1.0, 1.0]
            if i == n // 2:
                r.expr = "laugh"
            yield
        r.set(dance=0.0, sit=0.0, tilt=0.0, tail_wag=0.15, tail_up=0.75)
        r.fx_on = {}
        r.expr = "neutral"
        yield from self.wait(0.2)

    def r_cute_tilt(self, sec=1.8):
        """Head tilt (overshoots, settles) with sparkly eyes and sparkles popping around him."""
        r = self.rig
        r.set(sit=1.0)
        yield from self.wait(0.2)
        r.expr = "sparkle"
        r.ear = [1.0, 0.0]
        yield from self._pop(tilt=26)
        r.set(tilt=18)
        r.fx_on = {"sparkle": 4.0}
        yield from self.wait(sec * 0.5)
        yield from self._pop(tilt=-24)
        r.set(tilt=-16)
        yield from self.wait(sec * 0.5)
        r.fx_on = {}
        r.set(tilt=0.0, sit=0.0)
        r.expr = "neutral"

    def r_love(self, sec=2.4):
        r = self.rig
        r.set(sit=1.0, tail_up=1.0, tail_wag=0.6)
        r.expr = "love"
        r.fx_on = {"heart": 3.5}
        self._purr("love", True)
        n = int(sec * FPS)
        for i in range(n):
            r.set(tilt=9 * math.sin(i / FPS * 3.0), sq=0.03 * math.sin(i / FPS * 6.0))
            yield
        self._purr("love", False)
        r.fx_on = {}
        r.set(tilt=0.0, sq=0.0, sit=0.0, tail_wag=0.15, tail_up=0.75)
        r.expr = "neutral"

    def r_pout(self, sec=1.8):
        """Hmph! Sits, turns his head away, cheeks puffed, little angry puffs and a lashing tail."""
        a, r = self.actor, self.rig
        r.set(sit=1.0, lash=0.5, tail_up=0.5)
        r.expr = "pout"
        yield from self._pop(head_rot=-22, cheeks=1.3, sq=-0.06)
        r.set(head_rot=-14, sq=0.0)
        r.fx_on = {"vein": 1.0}
        n = int(sec * FPS)
        for i in range(n):
            if i % int(0.6 * FPS) == 0:
                r.set(cheeks=1.35)
                hx, hy, hs = r.head_w
                r.emit("puff", hx + r.facing * hs * 0.5, hy + hs * 0.15, r.facing * 70, -10, 0.55, 0.7)
            elif i % int(0.6 * FPS) == 8:
                r.set(cheeks=1.0)
            yield
        r.fx_on = {}
        r.set(head_rot=0.0, cheeks=0.0, lash=0.0, sit=0.0, tail_up=0.75)
        r.expr = "neutral"

    def r_cry(self, sec=2.2):
        """Waaah: eyes squeezed, waterfalls of tears, wailing mouth, shoulders shaking - then a sniffle."""
        r = self.rig
        r.set(sit=1.0, ears_down=1.0, tail_up=0.1)
        r.expr = "cry"
        r.fx_on = {"tears": 7.0}
        self.sfx.play("meow", 0.6)
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.set(sq=-0.04 * abs(math.sin(t * 13)), head_rot=-4 + 3 * math.sin(t * 13))
            yield
        r.fx_on = {}
        r.expr = "sulky"
        r.set(sq=0.0, head_rot=0.0, hide=1.0)  # wipes his eyes
        yield from self.wait(0.45)
        r.set(hide=0.0, ears_down=0.3)
        yield from self.wait(0.25)
        r.set(sit=0.0, ears_down=0.0, tail_up=0.75)
        r.expr = "neutral"

    def r_laugh(self, sec=2.4):
        """Laughing so hard he falls over: rolls side to side on the floor, little legs kicking."""
        a, r = self.actor, self.rig
        r.expr = "laugh"
        self.sfx.play("mew_short", 0.8)
        yield from self._pop(sq=0.08)
        r.set(sq=0.0, lie=1.0, kick=1.0, tail_wag=1.0)
        r.fx_on = {"sparkle": 2.0}
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.set(roll=-172 + 24 * math.sin(t * 7.0))  # flipped onto his back, rocking
            if i == n // 2:
                self.sfx.play("mew_short", 0.6)
            yield
        r.fx_on = {}
        r.set(lie=0.0, kick=0.0, tail_wag=0.15, roll=0.0)
        r.jig_v -= 2.0
        r.expr = "happy"
        yield from self.wait(0.4)
        r.expr = "neutral"

    def r_blush(self, sec=1.8):
        """Shy: paws to his cheeks, blushing hard, swaying, a couple of tiny hearts."""
        r = self.rig
        r.set(sit=1.0, hide=1.0, tail_wag=0.5)
        r.expr = "blush"
        r.fx_on = {"heart": 1.2}
        n = int(sec * FPS)
        for i in range(n):
            r.set(tilt=10 * math.sin(i / FPS * 4.0))
            yield
        r.fx_on = {}
        r.set(hide=0.0, tilt=0.0, sit=0.0, tail_wag=0.15)
        r.expr = "neutral"

    def r_hug(self, cx, cy, sec=2.6):
        """Hugs the cursor: stands up on his hind legs, wraps his arms round it and rubs his cheek on it."""
        a, r = self.actor, self.rig
        yield from a.face(1 if cx >= a.x else -1)
        r.expr = "content"
        r.set(stand=1.0, hug=1.0, tail_up=1.0, tail_wag=0.7)
        r.fx_on = {"heart": 2.2}
        self._purr("hug", True)
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            r.set(tilt=-10 + 7 * math.sin(t * 5.0), lean_in=1.0 + 0.4 * math.sin(t * 5.0))
            if i == n // 2:
                r.expr = "blush"
            yield
        self._purr("hug", False)
        r.fx_on = {}
        r.set(stand=0.0, hug=0.0, tilt=0.0, lean_in=0.0, tail_wag=0.15, tail_up=0.75)
        r.expr = "neutral"
        yield from self.wait(0.2)

    def r_melt(self, sec=2.2):
        """Flops down and melts into a puddle of mochi... then wobbles back into shape."""
        r = self.rig
        yield from self._pop(sq=0.08)
        r.set(sq=0.0, lie=1.0, melt=1.0, ears_down=0.7, tail_up=0.0)
        r.expr = "sleepy"
        hx, hy, hs = r.head_w
        r.emit("puff", hx + r.facing * hs * 0.5, hy + hs * 0.2, r.facing * 40, -10, 0.6, 0.6)
        yield from self.wait(sec)
        r.expr = "neutral"
        r.set(melt=0.0, lie=0.0, ears_down=0.0, tail_up=0.75)
        r.jig_v += 3.0
        yield from self.wait(0.35)

    def r_knead(self, sec=2.4):
        r = self.rig
        r.set(sit=1.0, knead=1.0, beg=0.0)
        r.expr = "content"
        r.fx_on = {"purr": 1.5}
        self._purr("knead", True)
        yield from self.wait(sec)
        self._purr("knead", False)
        r.fx_on = {}
        r.set(knead=0.0, sit=0.0)
        r.expr = "neutral"

    def r_tail_wag(self, sec=2.0):
        r = self.rig
        r.set(sit=1.0, tail_up=1.0, tail_wag=1.2)
        r.expr = "content"
        yield from self.wait(sec * 0.5)
        r.set(head_rot=-14, look_down=0.3)  # glances back at his own tail
        r.expr = "neutral"
        yield from self.wait(sec * 0.5)
        r.set(sit=0.0, tail_wag=0.15, tail_up=0.75, head_rot=0.0, look_down=0.0)

    # ------------------------------------------------------------------ v3 stunts
    def s_dance(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_dance(3.5)
        yield from self.r_cute_tilt(1.6)
        yield from self.leave(True)

    def s_cuddle(self):
        a = self.actor
        c = QCursor.pos()
        yield from self.arrive(c.x(), "side")
        yield from a.to_ground(c.x())
        yield from a.walk_to(c.x() - 70 * self.k, TROT)
        yield from self.r_hug(c.x(), c.y())
        yield from self.r_blush(1.4)
        yield from self.leave(True)

    def s_melt(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_melt(2.4)
        yield from self.r_knead(2.0)
        yield from self.leave(True)

    def s_tantrum(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_pout(1.6)
        yield from self.r_cry(1.8)
        yield from self.r_love(1.4)
        yield from self.leave(True)

    def s_giggle(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_laugh(2.4)
        yield from self.r_tail_wag(1.6)
        yield from self.leave(True)

    # ------------------------------------------------------------------ new stunts / moods
    def s_plea(self):
        """Wants attention: comes to the cursor and asks with the Eyes. Pet him and he purrs."""
        a, r = self.actor, self.rig
        c = QCursor.pos()
        yield from self.arrive(c.x(), "side")
        yield from a.to_ground(c.x())
        yield from a.walk_to(c.x() - 90 * self.k, TROT)
        yield from a.face(1)
        self.mission = "plea"
        yield from self.r_plea(3.5)
        for i in range(int(4 * FPS)):  # wait to be petted
            yield
        self.mission = "stunt"
        yield from self.leave(True)

    def s_pounce(self):
        a = self.actor
        c = QCursor.pos()
        yield from self.arrive(c.x() - 300 * self.k, "side")
        yield from a.to_ground()
        yield from self.r_pounce(QCursor.pos().x())
        yield from self.leave(True)

    def s_sneeze_groom(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_sneeze()
        yield from self.r_groom(2.4)
        yield from self.leave(True)

    def s_nap(self):
        L, T, R, B = self.area()
        yield from self.arrive(random.uniform(L + 200, R - 200))
        yield from self.actor.to_ground()
        yield from self.r_stretch_yawn()
        yield from self.r_sleep(6.0)
        yield from self.r_stretch_yawn()
        yield from self.leave(True)

    def s_happy_hops(self):
        yield from self.arrive(QCursor.pos().x())
        yield from self.actor.to_ground()
        yield from self.r_happy_hops(4)
        yield from self.leave(True)

    def s_tug_window(self):
        """Tug-of-war with the active window's top edge (drags it a little), then pops off it."""
        h = win32.foreground()
        rc = self.world.rect_of(h) if h else None
        a = self.actor
        if not rc or win32.is_maximized(h) or brain.look(self.my_pid).mine:
            yield from self.s_happy_hops()
            return
        yield from self.arrive(rc[0] + rc[2] / 2)
        self.world.refresh(force=True)
        plat = self.world.find(h, rc[0] + rc[2] / 2)
        if plat is None:
            yield from self.s_happy_hops()
            return
        gx = plat.l + 70 * self.k
        ok = yield from a.go_to(lambda p: p.hwnd == h and p.has(gx, 5), gx, speed=TROT)
        if ok:
            yield from a.face(-1)

            def pull(dx):
                if dx:
                    win32.move_window_by(h, dx, 0)
            yield from self.r_tug(a.x - 40 * self.k, a.y + 6, pull, 2.4, side=1)
        yield from a.to_ground()
        yield from self.leave(True)

    def s_slide_down(self):
        """Climbs a screen side, loses grip and slides down it, claws out, sweating."""
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        left = random.random() < 0.5
        yield from self.arrive(L + 150 if left else R - 150, "side")
        yield from a.to_ground()
        wall = L + 2 if left else R - 2
        yield from a.walk_to(wall + (40 if left else -40), TROT)
        side = -1 if left else 1
        yield from a.climb(wall, side, B - 330 * self.k, onto=None)
        yield from self.slide_down_wall(B)
        yield from self.leave(True)

    def slide_down_wall(self, floor_y, hold=0.5):
        """From climbing (mode climb): hang on, slip, slide down with paws up, land."""
        a, r = self.actor, self.rig
        a.vy = 0.0
        r.expr = "plead"
        r.set(ears_down=1.0)
        yield from self.wait(hold)
        r.expr = "shocked"
        r.emit("excl")
        r.set(slide=1.0, upright=0.85)
        r.fx_on = {"sweat": 3.0}
        n = 0
        while a.y < floor_y - 2 and n < 6 * FPS:
            a.vy = min(a.vy + 900 * DT, 700)
            if n % 10 == 0:
                self.sfx.play("step", 0.5)
            n += 1
            yield
        r.fx_on = {}
        side = -1 if r.rot > 0 else 1  # climbing rot is -90 * side
        r.set(slide=0.0, upright=0.0, ears_down=0.0)
        r.rot = 0.0
        a.put(a.x - side * 34 * self.k)
        r.turn(-side)
        r.land(900)
        self.sfx.play("land", 0.6)
        r.expr = "dizzy"
        yield from self.wait(0.6)
        r.expr = "neutral"

    def hang_struggle(self, gx, gy, sec=3.0):
        """Dangling from an edge, hind legs scrabbling, trying (and failing) to pull himself up."""
        a, r = self.actor, self.rig
        r.expr = "strain"
        r.set(paddle=1.0)
        r.fx_on = {"sweat": 2.2}
        n = int(sec * FPS)
        for i in range(n):
            t = i / FPS
            up = max(0.0, math.sin(t * 2.6)) ** 2  # pull-up attempts
            hang_pose(a, gx, gy + 14 * self.k * (1 - up) - 10 * self.k * up, t, 5.0)
            yield
        r.fx_on = {}
        r.set(paddle=0.0)

    # ------------------------------------------------------------------ stunts (break time)
    STUNTS = ["backflip", "cartwheel", "zoomies", "bounce_party", "window_surf", "tornado",
              "peekaboo", "giant_face", "hang_swing", "moonwalk", "stretch", "rocket",
              "pounce", "sneeze_groom", "nap", "happy_hops", "tug_window", "slide_down", "plea",
              "dance", "cuddle", "melt", "tantrum", "giggle"]

    def do_stunt(self, is_break):
        pool = [s for s in self.STUNTS if s not in self.recent_stunts]
        name = random.choice(pool)
        self.recent_stunts = (self.recent_stunts + [name])[-5:]
        self.stats.stunt(name, is_break)
        self.start("stunt", getattr(self, "s_" + name)())

    def s_backflip(self):
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        yield from self.arrive(random.uniform(L + 200, R - 200), "peek")
        yield from a.to_ground()
        yield from self.wiggle(0.5)
        for _ in range(2):
            yield from a.hop(300, flips=-1.0, wind=0.2)
            yield from self.wait(0.35)
        yield from self.leave(True)

    def s_cartwheel(self):
        """Gallops in and somersaults across the screen."""
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        if not a.visible:
            yield from a.enter_side(L + 220, side=-1, speed=RUN)
        yield from a.to_ground()
        yield from a.face(1)
        for i in range(3):
            yield from a.walk_to(a.x + 140, RUN)
            yield from a.hop(110, flips=1.0, vx=260, wind=0.05)
        yield from a.leave(RUN)

    def s_zoomies(self):
        L, T, R, B = self.area()
        a = self.actor
        if not a.visible:
            yield from a.enter_side(R - 200, side=1, speed=RUN)
        yield from a.to_ground()
        yield from self.r_zoomies(4)
        yield from self.leave(True)

    def r_zoomies(self, laps=4, lo=None, hi=None):
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        lo = L + 120 if lo is None else lo
        hi = R - 120 if hi is None else hi
        r.expr = "hunt"
        r.set(ears_down=0.8, tail_up=0.9)
        r.fx_on = {"dust": 9.0, "motion": 14.0}
        for lap in range(laps):
            tx = lo if (lap % 2 == 0) == (a.x > (lo + hi) / 2) else hi
            yield from a.walk_to(tx, RUN * 1.25)
            r.set(crouch=0.6, sq=-0.08)
            yield from self.wait(0.12)
            r.set(crouch=0.0, sq=0.0)
        r.fx_on = {}
        r.set(ears_down=0.0, tail_up=0.75)
        r.expr = "happy"
        yield from self.wait(0.5)
        r.expr = "neutral"

    def s_bounce_party(self):
        """Parkour: hops from window top to window top (or along the ground if there are none)."""
        L, T, R, B = self.area()
        a = self.actor
        yield from self.arrive(L + 200, "side")
        self.world.refresh(force=True)
        ledges = [p for p in self.world.platforms if not p.ground]
        random.shuffle(ledges)
        hops = 0
        for p in ledges[:5]:
            gx = (p.l + p.r) / 2
            ok = yield from a.go_to(lambda q, h=p.hwnd, x=gx: q.hwnd == h and q.has(x, 5), gx, speed=RUN)
            if ok:
                hops += 1
                self.rig.expr = "happy"
                yield from self.wait(0.3)
                self.rig.expr = "neutral"
        if hops == 0:
            yield from a.to_ground()
            for i in range(6):
                d = 1 if a.x < (L + R) / 2 else -1
                yield from a.face(d)
                yield from a.hop(90 + 60 * (i % 2), vx=d * 300, wind=0.08)
        yield from a.to_ground()
        yield from self.leave(True)

    def s_window_surf(self):
        h = win32.foreground()
        rc = self.world.rect_of(h) if h else None
        if not rc or win32.is_maximized(h) or brain.look(self.my_pid).mine or rc[2] < 400:
            yield from self.s_rocket()
            return
        a, r = self.actor, self.rig
        yield from self.arrive(rc[0] + rc[2] / 2)
        self.world.refresh(force=True)
        plat = self.world.find(h, rc[0] + rc[2] / 2)
        if plat is None:
            yield from self.s_rocket()
            return
        gx = plat.l + 60
        ok = yield from a.go_to(lambda p: p.hwnd == h and p.has(gx, 5), gx, speed=RUN)
        if ok:
            r.expr = "tease"
            r.set(crouch=0.4, tail_up=1.0, lean=-0.05)
            # surfs: pushes the window side to side and rides it
            for k in range(3):
                for i in range(int(0.6 * FPS)):
                    win32.move_window_by(h, 6 if k % 2 == 0 else -6, 0)
                    yield
            r.set(crouch=0.0, lean=0.0)
            r.expr = "neutral"
        yield from a.to_ground()
        yield from self.leave(True)

    def s_tornado(self):
        """Chases his own tail round and round, gets dizzy."""
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        yield from self.arrive((L + R) / 2)
        yield from a.to_ground()
        yield from self.r_tail_chase(10)
        yield from self.leave(False)

    def s_peekaboo(self):
        L, T, R, B = self.area()
        a = self.actor
        if a.visible:
            yield from self.s_leave()
        spots = [(L, (T + B) / 2, 90), ((L + R) / 2, T, 180), (R, (T + B) / 2, -90), ((L + R) / 3, B, 0)]
        random.shuffle(spots)
        for x, y, ang in spots:
            yield from a.peek_in(x, y, rot=ang, dur=0.35)
            self.sfx.play("mew_short", 0.6)
            yield from self.wait(0.7)
            yield from a.peek_out(0.3)
            yield from self.wait(0.3)

    def s_giant_face(self):
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        if a.visible:
            yield from self.s_leave()
        r.zoom = 2.6
        try:
            yield from a.peek_in((L + R) / 2, B, dur=1.0)
            yield from self.wait(0.6)
            for _ in range(2):  # slow blink
                r.hold_blink = True
                yield from self.wait(0.25)
                r.hold_blink = False
                yield from self.wait(0.5)
            yield from a.peek_out(0.8)
        finally:
            r.zoom = 1.0
            r.hold_blink = False

    def s_hang_swing(self):
        """Climbs the side of the screen, hangs from the top edge, swings, lets go, lands."""
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        left = random.random() < 0.5
        yield from self.arrive(L + 150 if left else R - 150, "side")
        yield from a.to_ground()
        wall = L + 2 if left else R - 2
        yield from a.walk_to(wall + (40 if left else -40), TROT)
        side = -1 if left else 1
        yield from a.climb(wall, side, T + 120 * self.k, onto=None)
        r.rot = 0.0
        r.turn(-side)
        gx0 = wall - side * 30
        for i in range(int(1.2 * FPS)):  # shimmy along the top edge
            hang_pose(a, gx0 - side * 160 * self.k * (i / (1.2 * FPS)), T + 2, i / FPS, 4.0)
            yield
        gx = a.x
        yield from self.hang_struggle(gx0 - side * 160 * self.k, T + 2, 2.6)
        r.expr = "plead"
        r.set(ears_down=1.0, aura=1.0)
        self.sfx.play("mew_short", 0.6)
        yield from hang_at(a, gx0 - side * 160 * self.k, T + 2, 1.6, 10.0)
        r.set(ears_down=0.0, aura=0.0)
        r.expr = "neutral"
        yield from hang_at(a, gx0 - side * 160 * self.k, T + 2, 1.0, 22.0)
        yield from let_go(a)
        yield from self.leave(True)

    def s_moonwalk(self):
        """Backwards across the screen, facing the other way."""
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        if a.visible:
            yield from self.s_leave()
        a.allow_offscreen = True
        a.put(R + 120)
        r.facing = 1
        r.place_feet()
        r.reset_pose()
        r.snap()
        r.expr = "tease"
        yield from a.walk_to(L - 140, WALK * 1.2, face=False, timeout=40)
        a.allow_offscreen = False
        a.hide()

    def s_stretch(self):
        a, r = self.actor, self.rig
        yield from self.arrive(QCursor.pos().x())
        yield from a.to_ground()
        yield from self.r_stretch_yawn()
        yield from self.r_groom(1.8)
        yield from self.leave(True)

    def s_rocket(self):
        L, T, R, B = self.area()
        a, r = self.actor, self.rig
        yield from self.arrive(random.uniform(L + 200, R - 200))
        yield from a.to_ground()
        yield from self.wiggle(1.1)
        a.allow_offscreen = True
        height = (a.y - T) + 350
        yield from a.hop(height, wind=0.2)
        a.allow_offscreen = False
        r.expr = "surprised"
        yield from self.wait(0.4)
        r.expr = "neutral"
        yield from self.leave(True)

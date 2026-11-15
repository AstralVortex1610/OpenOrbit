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
from .motion import Actor, WALK, TROT, RUN, G, hang_pose, hang_at, let_go
from .rig import clamp
from .sfx import Sfx
from .world import World

FPS = 60
DT = 1.0 / FPS


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

        self.k = win32.system_scale() * float(cfg.get("size", 1.0))
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
            self.dragging = True
            if self.script is not None and self.resume_after_landing is None:
                self.resume_after_landing = self.mission
            self.script, self.mission = None, None
            a = self.actor
            a.mode = "held"
            a.plat = None
            self.rig.view = "side"
            self.rig.clip = None
            self.rig.expr = "surprised"
            self.sfx.play("meow")
            self.drag_samples = [(time.time(), QCursor.pos())]

    def mouseMoveEvent(self, e):
        if self.dragging:
            self.drag_samples.append((time.time(), QCursor.pos()))
            self.drag_samples = self.drag_samples[-6:]

    def mouseReleaseEvent(self, e):
        if not self.dragging:
            return
        self.dragging = False
        (t0, p0), (t1, p1) = self.drag_samples[0], self.drag_samples[-1]
        dt = max(0.016, t1 - t0)
        vx = max(-3000, min(3000, (p1.x() - p0.x()) / dt))
        vy = max(-3000, min(3000, (p1.y() - p0.y()) / dt))
        self.launch(vx, vy)

    def mouseDoubleClickEvent(self, e):
        self.start("shoo", self.s_sulk_away())

    def launch(self, vx, vy):
        a = self.actor
        a.mode = "air"
        a.plat = None
        a.vx, a.vy = vx, vy
        a.spin = None  # auto-righting: twists to land on his feet
        self.fling = True

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
        if self.dragging:
            c = QCursor.pos()
            a.x += (c.x() - a.x) * 0.5
            a.y += (c.y() + 70 * self.k - a.y) * 0.5  # held by the scruff
            r.rot = math.sin(time.time() * 9) * 10  # wriggles, legs dangle
            r.set(reach=1.0, tuck=0.0, tail_up=0.0)
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
        """Hover the cursor over him while he rests: happy face and a quiet purr."""
        a = self.actor
        if not a.visible or self.geo is None or a.mode not in ("ground",) or abs(a.vx) > 5 \
                or self.mission in ("catch",):
            self.pet_time = 0.0
            self._purr("pet", False)
            return
        c = QCursor.pos()
        if not self.items:
            return
        x0, y0, x1, y1 = self.rig.bounds(self.items, pad=0)
        if x0 < c.x() < x1 and y0 < c.y() < y1:
            self.pet_time += DT
            if self.pet_time > 0.6:
                self.rig.expr = "happy"
                self._purr("pet", True)
        elif self.pet_time > 0:
            self.pet_time = 0.0
            if self.rig.expr == "happy":
                self.rig.expr = "neutral"
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
                self.start("stunt", random.choice([self.s_zoomies, self.s_bounce_party])())
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
        r.expr = "neutral"
        r.set(sit=1.0)
        yield from self.wait(0.3)
        r.set(paw=1.0, paw_x=46, paw_y=-104)
        yield from self.wait(0.7)
        r.set(paw=0.0)
        yield from self.wait(0.25)
        r.set(sit=0.0)
        yield from self.wait(0.15)

    def s_leave(self):
        r = self.rig
        r.set(sit=0, lie=0, stretch=0, paw=0, crouch=0, look_down=0, head_rot=0)
        r.expr = "neutral"
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
        # tease
        r.expr = "tease"
        self.sfx.play("mew_short")
        yield from self.wiggle(0.7)
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
                yield from self.wait(0.25)
                r.set(paw=1.0, paw_x=40, paw_y=12)
                yield from self.wait(0.12)
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
        """After a fling: shake it off, glare, and (if he was catching) go straight back to it."""
        a, r = self.actor, self.rig
        r.expr = "tease"
        for k in range(4):
            r.set(head_rot=(-10 if k % 2 else 10))
            yield from self.wait(0.08)
        r.set(head_rot=0)
        yield from a.face(-r.facing)
        yield from self.wait(0.3)
        r.expr = "neutral"
        if resume == "catch":
            seen = brain.look(self.my_pid)
            if brain.is_doomscroll(seen, self.cfg):
                yield from self.s_catch(seen)
                return
        yield from self.leave(salute=False)

    def s_sulk_away(self):
        if self.offstage():
            return
        a, r = self.actor, self.rig
        r.expr = "tease"
        r.set(tail_wag=1.0, tail_up=0.4)
        yield from self.wait(0.5)
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
        r.set(sit=1.0, tail_wag=0.5)
        yield from self.wait(1.8)
        self._purr("praise", False)
        r.expr = "neutral"
        yield from self.leave(salute=False)

    def s_scolded(self):
        a, r = self.actor, self.rig
        yield from self.arrive(QCursor.pos().x())
        r.expr = "surprised"
        r.set(crouch=0.8, tail_up=0.0, tail_wag=0.9)
        yield from self.wait(0.6)
        r.expr = "sleepy"  # sulky eyes-shut
        yield from self.wait(0.6)
        r.expr = "neutral"
        r.set(crouch=0.0, tail_up=0.4)
        a.speed = WALK
        yield from a.leave(WALK)

    def s_startle(self, resume):
        if self.offstage():
            return
        a, r = self.actor, self.rig
        if a.mode != "ground":
            yield from self._settle()
        r.expr = "surprised"
        r.set(puff=1.0, tail_up=1.0)
        self.sfx.play("hiss")
        yield from a.hop(140)
        yield from self.wait(0.4)
        r.set(puff=0.0)
        r.expr = "neutral"
        yield from a.leave(RUN)

    def s_curious_peek(self):
        a = self.actor
        L, T, R, B = self.area()
        yield from a.peek_in(random.uniform(L + 120, R - 120), B)
        for h in (-12, 12, -12, 0):
            self.rig.set(head_rot=h)
            yield from self.wait(0.3)
        yield from a.peek_out(0.4)

    # ------------------------------------------------------------------ stunts (break time)
    STUNTS = ["backflip", "cartwheel", "zoomies", "bounce_party", "window_surf", "tornado",
              "peekaboo", "giant_face", "hang_swing", "moonwalk", "stretch", "rocket"]

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
        for lap in range(4):
            tx = L + 120 if lap % 2 == 0 else R - 120
            yield from a.walk_to(tx, RUN * 1.2)
            self.rig.set(crouch=0.5)
            yield from self.wait(0.12)
            self.rig.set(crouch=0.0)
        yield from self.leave(True)

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
        r.set(tail_wag=1.0, crouch=0.4)
        r.expr = "tease"
        for i in range(10):
            yield from a.face(-r.facing)
            yield from self.wait(0.05)
        r.expr = "sleepy"
        r.set(crouch=0.0, tail_wag=0.15)
        for k in range(6):
            r.set(head_rot=10 * math.sin(k))
            yield from self.wait(0.15)
        r.set(head_rot=0)
        r.expr = "neutral"
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
        yield from hang_at(a, gx0 - side * 160 * self.k, T + 2, 3.0, 22.0)
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
        r.set(stretch=1.0, tail_up=1.0)
        yield from self.wait(0.6)
        r.expr = "happy"  # big yawn
        yield from self.wait(1.0)
        r.expr = "neutral"
        r.set(stretch=0.0, sit=1.0)
        yield from self.wait(0.6)
        r.set(sit=0.0)
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

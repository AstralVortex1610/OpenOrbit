"""The kitten: a transparent always-on-top sprite window driven by generator scripts at 60 fps."""
import math
import os
import queue
import random
import subprocess
import threading
import time

from PySide6.QtCore import Qt, QTimer, QPointF, QRect
from PySide6.QtGui import QPainter, QPixmap, QTransform, QCursor, QGuiApplication
from PySide6.QtWidgets import QWidget, QInputDialog, QLineEdit, QApplication

from . import win32, brain
from .ears import resource

FPS = 60
DT = 1.0 / FPS
GRAVITY = 2600.0


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return 3 * t * t - 2 * t * t * t


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

        k = win32.system_scale() * float(cfg.get("size", 1.0))
        self.sprites = {}
        targets = {"peek": 250, "tease": 170, "tap": 165, "dash": 165, "salute": 175}  # target height px
        for n, h in targets.items():
            pm = QPixmap(resource("assets", f"{n}.png"))
            self.sprites[n] = pm.scaledToHeight(int(h * k * (0.85 if n == "peek" else 1)), Qt.SmoothTransformation)

        # pose
        self.x = self.y = -1000.0
        self.vx = self.vy = 0.0
        self.angle, self.sx, self.sy, self.flipx, self.flipy, self.opacity = 0.0, 1.0, 1.0, False, False, 1.0
        self.sprite = "peek"
        self.clip_bottom = None  # y below which the sprite is hidden (peeking over an edge)

        self.script = None
        self.mission = None
        self.flying = False
        self.dragging = False
        self.drag_samples = []
        self.resume_after_landing = None

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

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(int(1000 / FPS))
        self.slow = QTimer(self)
        self.slow.timeout.connect(self.think)
        self.slow.start(1000)
        self.hide()

    # ------------------------------------------------------------------ geometry
    def work_area(self):
        scr = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
        g = scr.availableGeometry()
        return g.left(), g.top(), g.right(), g.bottom()

    def half(self):
        pm = self.sprites[self.sprite]
        return pm.width() / 2 * abs(self.sx), pm.height() / 2 * abs(self.sy)

    # ------------------------------------------------------------------ render
    def tick(self):
        try:
            self.step()
        except Exception:
            self.script = None
            self.mission = None
        self.place()

    def place(self):
        if self.script is None and not self.flying and not self.dragging:
            if self.isVisible():
                self.hide()
            return
        pm = self.sprites[self.sprite]
        r = math.hypot(pm.width() * abs(self.sx), pm.height() * abs(self.sy)) / 2 + 4
        size = int(2 * r)
        geo = QRect(int(self.x - r), int(self.y - r), size, size)
        if self.geometry() != geo:
            self.setGeometry(geo)
        if not self.isVisible():
            self.show()
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        p.setRenderHint(QPainter.Antialiasing)
        p.setOpacity(max(0.0, min(1.0, self.opacity)))
        if self.clip_bottom is not None:
            p.setClipRect(0, 0, self.width(), int(self.clip_bottom - self.geometry().top()))
        pm = self.sprites[self.sprite]
        t = QTransform()
        t.translate(self.width() / 2, self.height() / 2)
        t.rotate(self.angle)
        t.scale(self.sx * (-1 if self.flipx else 1), self.sy * (-1 if self.flipy else 1))
        p.setTransform(t)
        p.drawPixmap(QPointF(-pm.width() / 2, -pm.height() / 2), pm)
        p.end()

    def reset_pose(self, sprite="peek"):
        self.angle, self.sx, self.sy, self.flipx, self.flipy, self.opacity = 0.0, 1.0, 1.0, False, False, 1.0
        self.sprite, self.clip_bottom = sprite, None

    # ------------------------------------------------------------------ mouse: grab & fling
    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.dragging, self.flying = True, False
            if self.script is not None and self.resume_after_landing is None:
                self.resume_after_landing = self.mission
            self.script = None
            self.sprite, self.clip_bottom = "dash", None
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
        self.vx = max(-4000, min(4000, (p1.x() - p0.x()) / dt))
        self.vy = max(-4000, min(4000, (p1.y() - p0.y()) / dt))
        self.flying = True

    def mouseDoubleClickEvent(self, e):
        self.start("shoo", self.s_sulk_away())

    def knock(self, vx, vy):
        if self.script is not None and self.resume_after_landing is None:
            self.resume_after_landing = self.mission
        self.script = None
        self.vx, self.vy = vx, vy
        self.sprite, self.clip_bottom = "dash", None
        self.flying = True

    # ------------------------------------------------------------------ frame step
    def step(self):
        while not self.events.empty():
            self.on_event(*self.events.get_nowait())

        if self.dragging:
            c = QCursor.pos()
            self.x += (c.x() - self.x) * 0.5
            self.y += (c.y() + 20 - self.y) * 0.5
            self.angle = math.sin(time.time() * 18) * 12  # wriggles
            return

        if self.flying:
            self.physics()
            return

        self.window_bumps()

        if self.script is not None:
            try:
                next(self.script)
            except StopIteration:
                self.script, self.mission = None, None
                self.reset_pose()
                self.x = self.y = -1000

    def physics(self):
        L, T, R, B = self.work_area()
        hw, hh = self.half()
        self.vy += GRAVITY * DT
        self.x += self.vx * DT
        self.y += self.vy * DT
        self.angle += self.vx * DT * 0.6
        if self.x < L + hw:
            self.x, self.vx = L + hw, abs(self.vx) * 0.6
        if self.x > R - hw:
            self.x, self.vx = R - hw, -abs(self.vx) * 0.6
        if self.y < T + hh:
            self.y, self.vy = T + hh, abs(self.vy) * 0.5
        if self.y > B - hh:
            self.y = B - hh
            if abs(self.vy) > 350:
                self.vy = -abs(self.vy) * 0.45
                self.vx *= 0.8
            else:
                self.flying = False
                self.vx = self.vy = 0
                self.angle = 0
                again = self.resume_after_landing
                self.resume_after_landing = None
                self.start("landed", self.s_landed(again))

    def window_bumps(self):
        """Drag a window into him and he gets knocked away."""
        h = win32.foreground()
        r = win32.rect(h) if h else None
        if h and r and h == self.prev_fg and self.prev_fg_rect and r != self.prev_fg_rect \
                and r[2] == self.prev_fg_rect[2] and r[3] == self.prev_fg_rect[3] and self.script is not None \
                and self.mission not in ("watch",):
            dx, dy = r[0] - self.prev_fg_rect[0], r[1] - self.prev_fg_rect[1]
            hw, hh = self.half()
            hit = (r[0] - hw < self.x < r[0] + r[2] + hw) and (r[1] - hh < self.y < r[1] + r[3] + hh)
            if hit and abs(dx) + abs(dy) > 6:
                self.knock(dx * FPS * 1.4, dy * FPS * 1.4 - 600)
        self.prev_fg, self.prev_fg_rect = h, r

    # ------------------------------------------------------------------ the 1-second brain
    def think(self):
        try:
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
            if self.mission == "catch":
                return  # nice try
            if val == "summon":
                self.start("summon", self.s_summon())
            elif val == "break":
                self.do_stunt(is_break=True)
            elif val == "shoo":
                if self.script is not None:
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
        self.mission, self.script = mission, gen

    def wait(self, sec):
        for _ in range(int(sec * FPS)):
            yield

    def tween(self, dur, ease=ease_in_out, **to):
        start = {k: getattr(self, k) for k in to}
        n = max(1, int(dur * FPS))
        for i in range(1, n + 1):
            t = ease(i / n)
            for k, v in to.items():
                setattr(self, k, start[k] + (v - start[k]) * t)
            yield

    def arc(self, tx, ty, height, dur, spin=0.0):
        x0, y0, a0 = self.x, self.y, self.angle
        n = max(1, int(dur * FPS))
        for i in range(1, n + 1):
            t = i / n
            self.x = x0 + (tx - x0) * t
            self.y = y0 + (ty - y0) * t - height * 4 * t * (1 - t)
            self.angle = a0 + spin * t
            yield
        self.angle = a0 + spin

    def run_to(self, tx, ty, speed=900, sprite="dash"):
        self.sprite = sprite
        self.flipx = tx < self.x
        dist = math.hypot(tx - self.x, ty - self.y)
        n = max(1, int(dist / speed * FPS))
        x0, y0 = self.x, self.y
        for i in range(1, n + 1):
            t = i / n
            self.x = x0 + (tx - x0) * t
            self.y = y0 + (ty - y0) * t + abs(math.sin(t * math.pi * max(1, dist / 120))) * -14
            self.angle = math.sin(i * 0.6) * 4
            yield
        self.angle = 0

    def squash(self, times=1, amt=0.18, dur=0.12):
        for _ in range(times):
            yield from self.tween(dur, sx=1 + amt, sy=1 - amt)
            yield from self.tween(dur, sx=1.0, sy=1.0)

    def offstage(self):
        L, T, R, B = self.work_area()
        return not (L - 200 < self.x < R + 200 and T - 200 < self.y < B + 200)

    def bottom_y(self):
        return self.work_area()[3] - self.half()[1]

    def enter_from_bottom(self, x):
        L, T, R, B = self.work_area()
        self.reset_pose("peek")
        hw, hh = self.half()
        self.x = max(L + hw, min(R - hw, x))
        self.clip_bottom = B
        self.y = B + hh
        yield from self.tween(0.7, ease_out, y=B - hh * 0.55)

    def leave(self, salute=True):
        L, T, R, B = self.work_area()
        if salute:
            self.clip_bottom = None
            self.sprite = "salute"
            self.flipx = False
            yield from self.squash(1, 0.08)
            yield from self.wait(0.6)
        self.sprite = "salute"
        go_right = self.x > (L + R) / 2
        self.flipx = not go_right
        target = R + 300 if go_right else L - 300
        for i in range(int(abs(target - self.x) / 380 * FPS)):
            self.x += (380 if go_right else -380) * DT
            self.y = min(self.y + 600 * DT, self.bottom_y()) - abs(math.sin(i * 0.25)) * 6
            self.angle = math.sin(i * 0.25) * 6
            yield

    # ------------------------------------------------------------------ scripts: the main act
    def s_catch(self, seen):
        """Peek, watch, tease, dash, close it, salute, leave."""
        label = " - ".join(seen.title.split(" - ")[:-1])[:30] if seen.is_browser else seen.proc
        self.stats.catch(label or seen.proc)
        hwnd = seen.hwnd
        r = seen.rect or (0, 0, 800, 600)
        yield from self.enter_from_bottom(r[0] + r[2] / 2)
        # watching you... slow head tilt
        yield from self.tween(0.6, angle=-8)
        yield from self.tween(0.8, angle=8)
        yield from self.tween(0.5, angle=0)
        yield from self.wait(0.6)
        # pops up and teases
        B = self.work_area()[3]
        self.clip_bottom = None
        self.sprite = "tease"
        yield from self.arc(self.x, B - self.half()[1], 120, 0.45)
        for _ in range(3):
            yield from self.tween(0.14, angle=-10, sx=1.06)
            yield from self.tween(0.14, angle=10, sx=0.96)
        self.angle, self.sx = 0, 1
        yield from self.wait(0.7)
        # make sure the window is still where it was
        r = win32.rect(hwnd) or r
        if seen.is_browser:
            tx, ty = r[0] + min(260, r[2] * 0.3), r[1] + 18  # the tab strip
        else:
            tx, ty = r[0] + r[2] - 24, r[1] + 14  # the X button
        hw, hh = self.half()
        yield from self.run_to(tx - hw * 0.4, B - self.half()[1], speed=1300)
        self.sprite = "dash"
        yield from self.arc(tx - hw * 0.6, ty + hh * 0.55, 160, 0.5)
        self.sprite = "tap"
        self.flipx = False
        yield from self.squash(1, 0.15, 0.08)
        if win32.is_window(hwnd):
            if seen.is_browser:
                win32.ctrl_w(hwnd)
            else:
                win32.close_window(hwnd)
        self.last_catch = time.time()
        yield from self.squash(1, 0.1, 0.08)
        yield from self.wait(0.35)
        # hop down
        self.sprite = "dash"
        yield from self.arc(self.x + 80, self.bottom_y(), 120, 0.55, spin=360)
        self.angle = 0
        if random.random() < float(self.cfg["notepad_chance"]):
            yield from self.s_notepad()
        yield from self.leave()

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
        L, T, R, B = self.work_area()
        yield from self.run_to((L + R) / 2, self.bottom_y(), 900)
        self.sprite = "tap"
        i = 0
        while not done.is_set() and i < 60 * FPS:
            self.sy = 1 + 0.06 * math.sin(i * 0.9)
            self.flipx = (i // 8) % 2 == 0
            i += 1
            yield
        self.sy, self.flipx = 1, False
        yield from self.wait(0.5)

    def s_watch(self, seen, cat):
        """Tap it, then settle in: sit at the bottom middle, or hang upside down from the top."""
        hwnd = seen.hwnd
        r = seen.rect
        yield from self.enter_from_bottom(r[0] + r[2] / 2)
        self.clip_bottom = None
        yield from self.wait(0.5)
        cx, cy = r[0] + r[2] / 2, r[1] + r[3] / 2
        self.sprite = "dash"
        yield from self.arc(cx, cy, 200, 0.6)
        self.sprite = "tap"
        yield from self.squash(2, 0.12, 0.08)
        hang = cat == "call" or random.random() < 0.5
        self.reset_pose("peek")
        self.sx = self.sy = 0.75 if cat == "call" else 0.9
        hw, hh = self.half()
        if hang:
            self.flipy = True
            ax = r[0] + r[2] - hw - 30 if cat == "call" else cx
            yield from self.arc(ax, r[1] + hh * 0.75, 120, 0.5)
        else:
            yield from self.arc(cx, r[1] + r[3] - hh * 0.55, 80, 0.5)
            self.clip_bottom = r[1] + r[3]
        offx = self.x - r[0]
        offy = self.y - r[1]
        end = time.time() + self.cfg["watch_max_minutes"] * 60
        i = 0
        while time.time() < end:
            if win32.foreground() != hwnd or not win32.is_window(hwnd) or win32.is_minimized(hwnd):
                break
            nr = win32.rect(hwnd)
            if nr:
                self.x, self.y = nr[0] + offx, nr[1] + offy  # rides along when the window moves
                if self.clip_bottom is not None:
                    self.clip_bottom = nr[1] + nr[3]
            if hang:
                self.angle = math.sin(i / FPS * 1.6) * 7
            else:
                self.sy = (0.9 if cat != "call" else 0.75) * (1 + 0.015 * math.sin(i / FPS * 2.2))  # breathing
            if i % (FPS * 9) == FPS * 8:  # blink-ish
                yield from self.tween(0.08, sy=self.sy * 0.85)
                yield from self.tween(0.08, sy=self.sy / 0.85)
            i += 1
            yield
        self.reset_pose("dash")
        yield from self.arc(self.x + 60, self.bottom_y(), 100, 0.5)
        yield from self.leave(salute=True)

    def s_landed(self, resume):
        self.sprite = "tease"
        yield from self.squash(2, 0.2, 0.08)
        self.flipx = not self.flipx
        yield from self.wait(0.3)
        if resume == "catch":
            # stubborn: he goes straight back to it
            seen = brain.look(self.my_pid)
            if brain.is_doomscroll(seen, self.cfg):
                yield from self.s_catch(seen)
                return
        yield from self.leave()

    def s_sulk_away(self):
        if self.offstage():
            return
        self.clip_bottom = None
        self.sprite = "tease"
        yield from self.tween(0.2, angle=-6)
        yield from self.wait(0.5)
        self.angle = 0
        yield from self.leave(salute=False)

    def s_summon(self):
        c = QCursor.pos()
        if self.offstage():
            yield from self.enter_from_bottom(c.x())
            self.clip_bottom = None
        self.sprite = "dash"
        yield from self.arc(c.x(), self.bottom_y(), 220, 0.6)
        self.sprite = "tease"
        yield from self.squash(3, 0.15, 0.1)
        yield from self.wait(6)
        yield from self.leave()

    def s_praise(self):
        if self.offstage():
            yield from self.enter_from_bottom(QCursor.pos().x())
        self.clip_bottom = None
        self.sprite = "salute"
        yield from self.arc(self.x, self.bottom_y(), 260, 0.8, spin=720)
        self.angle = 0
        yield from self.squash(2)
        yield from self.wait(1.5)
        yield from self.leave(salute=False)

    def s_scolded(self):
        if self.offstage():
            yield from self.enter_from_bottom(QCursor.pos().x())
        self.clip_bottom = None
        self.sprite = "tease"
        for _ in range(4):
            yield from self.tween(0.1, angle=-12)
            yield from self.tween(0.1, angle=12)
        self.angle = 0
        yield from self.leave(salute=False)

    def s_startle(self, resume):
        if self.offstage():
            return
        self.clip_bottom = None
        self.sprite = "dash"
        y0 = self.y
        yield from self.arc(self.x, y0, 180, 0.4)
        for _ in range(6):
            self.x += random.choice([-6, 6])
            yield
        yield from self.wait(0.4)
        yield from self.leave()

    def s_curious_peek(self):
        yield from self.enter_from_bottom(random.uniform(*self.work_area()[0:3:2]))
        for a in (-12, 12, -12, 0):
            yield from self.tween(0.25, angle=a)
        L, T, R, B = self.work_area()
        yield from self.tween(0.5, y=B + self.half()[1] + 10)

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
        yield from self.enter_from_bottom(random.uniform(self.work_area()[0] + 200, self.work_area()[2] - 200))
        self.clip_bottom = None
        self.sprite = "tease"
        yield from self.arc(self.x, self.bottom_y(), 60, 0.3)
        self.sprite = "dash"
        yield from self.squash(1, 0.25, 0.1)
        yield from self.arc(self.x, self.bottom_y(), 420, 1.0, spin=-360)
        yield from self.arc(self.x, self.bottom_y(), 420, 1.0, spin=-360)
        self.sprite = "salute"
        yield from self.squash(1, 0.2)
        yield from self.wait(1)
        yield from self.leave(False)

    def s_cartwheel(self):
        L, T, R, B = self.work_area()
        self.reset_pose("dash")
        self.x, self.y = L - 150, self.bottom_y()
        n = int(2.6 * FPS)
        for i in range(n):
            t = i / n
            self.x = L - 150 + (R - L + 300) * t
            self.angle = 360 * 4 * t
            self.y = self.bottom_y() - abs(math.sin(t * math.pi * 4)) * 60
            yield

    def s_zoomies(self):
        L, T, R, B = self.work_area()
        self.reset_pose("dash")
        self.x, self.y = R + 150, self.bottom_y()
        for lap in range(4):
            tx = L + 120 if lap % 2 == 0 else R - 120
            yield from self.run_to(tx, self.bottom_y(), 2200)
            self.flipx = not self.flipx
            yield from self.squash(1, 0.3, 0.06)
        yield from self.leave(True)

    def s_bounce_party(self):
        L, T, R, B = self.work_area()
        self.reset_pose("tease")
        self.x, self.y = L + 100, self.bottom_y()
        self.clip_bottom = None
        for i in range(7):
            tx = L + 100 + (R - L - 200) * (i + 1) / 7
            self.sprite = ["tease", "salute", "tap"][i % 3]
            self.flipx = not self.flipx
            yield from self.arc(tx, self.bottom_y(), 160 + 90 * (i % 2), 0.45)
            yield from self.squash(1, 0.22, 0.06)
        yield from self.leave(True)

    def s_window_surf(self):
        h = win32.foreground()
        r = win32.rect(h)
        if not r or win32.is_maximized(h) or brain.look(self.my_pid).mine or r[2] < 400:
            yield from self.s_rocket()
            return
        yield from self.enter_from_bottom(r[0] + r[2] / 2)
        self.clip_bottom = None
        self.reset_pose("dash")
        hw, hh = self.half()
        yield from self.arc(r[0] + 80, r[1] - hh + 10, 300, 0.7)
        self.sprite = "tease"
        # rides the top edge, pushing the window side to side
        for k in range(3):
            for i in range(int(0.6 * FPS)):
                d = 6 if k % 2 == 0 else -6
                win32.move_window_by(h, d, 0)
                nr = win32.rect(h) or r
                self.x = min(nr[0] + nr[2] - hw, self.x + 6)
                self.y = nr[1] - hh + 10
                self.angle = math.sin(i * 0.4) * 8
                yield
        self.sprite = "dash"
        yield from self.arc(self.x + 150, self.bottom_y(), 200, 0.6, spin=360)
        yield from self.leave(True)

    def s_tornado(self):
        yield from self.enter_from_bottom((self.work_area()[0] + self.work_area()[2]) / 2)
        self.clip_bottom = None
        self.sprite = "dash"
        y0 = self.bottom_y()
        n = int(2.2 * FPS)
        for i in range(n):
            t = i / n
            self.angle += 10 + 40 * t
            s = 1 + 0.6 * math.sin(t * math.pi)
            self.sx = self.sy = s
            self.y = y0 - 200 * math.sin(t * math.pi)
            yield
        self.sx = self.sy = 1
        self.angle = 0
        self.sprite = "salute"
        yield from self.squash(2)
        yield from self.leave(False)

    def s_peekaboo(self):
        L, T, R, B = self.work_area()
        self.reset_pose("peek")
        hw, hh = self.half()
        spots = [("left", L - hh * 0.4, (T + B) / 2, 90), ("top", (L + R) / 2, T + hh * 0.4, 180),
                 ("right", R + hh * 0.4, (T + B) / 2, -90), ("bottom", (L + R) / 3, B - hh * 0.45, 0)]
        random.shuffle(spots)
        for name, x, y, ang in spots:
            self.angle = ang
            ox, oy = x + (-1 if name == "left" else 1 if name == "right" else 0) * hh, \
                y + (-1 if name == "top" else 1 if name == "bottom" else 0) * hh
            self.x, self.y = ox, oy
            yield from self.tween(0.35, ease_out, x=x, y=y)
            yield from self.wait(0.7)
            yield from self.tween(0.3, x=ox, y=oy)
            yield from self.wait(0.3)

    def s_giant_face(self):
        L, T, R, B = self.work_area()
        yield from self.enter_from_bottom((L + R) / 2)
        yield from self.tween(1.0, ease_out, sx=2.6, sy=2.6, y=B - self.sprites["peek"].height() * 2.6 * 0.4)
        yield from self.wait(0.6)
        for _ in range(2):  # slow blink
            yield from self.tween(0.1, sy=2.6 * 0.88)
            yield from self.tween(0.1, sy=2.6)
            yield from self.wait(0.5)
        yield from self.tween(0.8, sx=1, sy=1, y=B + self.sprites["peek"].height())

    def s_hang_swing(self):
        L, T, R, B = self.work_area()
        self.reset_pose("peek")
        self.flipy = True
        hw, hh = self.half()
        x = random.uniform(L + 200, R - 200)
        self.x, self.y = x, T - hh
        yield from self.tween(0.6, ease_out, y=T + hh * 0.7)
        n = int(4 * FPS)
        for i in range(n):
            self.angle = math.sin(i / FPS * 3) * 22 * (1 - i / n * 0.5)
            yield
        self.angle = 0
        # lets go and lands
        self.reset_pose("dash")
        yield from self.arc(x + 40, self.bottom_y(), -40, 0.7, spin=180)
        self.angle = 0
        yield from self.squash(1, 0.3)
        yield from self.leave(True)

    def s_moonwalk(self):
        L, T, R, B = self.work_area()
        self.reset_pose("salute")
        self.flipx = False
        self.x, self.y = L - 150, self.bottom_y()
        n = int(4 * FPS)
        for i in range(n):
            self.x += (R - L + 300) / n
            self.y = self.bottom_y() + (math.sin(i * 0.35) * 4)
            self.angle = -6 + math.sin(i * 0.35) * 3
            yield

    def s_stretch(self):
        yield from self.enter_from_bottom(QCursor.pos().x())
        self.clip_bottom = None
        self.sprite = "tease"
        yield from self.tween(0.4, y=self.bottom_y())
        for _ in range(2):
            yield from self.tween(0.7, sx=0.75, sy=1.4)
            yield from self.wait(0.4)
            yield from self.tween(0.7, sx=1.4, sy=0.75)
            yield from self.wait(0.3)
        yield from self.tween(0.3, sx=1, sy=1)
        yield from self.leave(True)

    def s_rocket(self):
        L, T, R, B = self.work_area()
        yield from self.enter_from_bottom(random.uniform(L + 200, R - 200))
        self.clip_bottom = None
        self.sprite = "tap"
        for i in range(int(0.8 * FPS)):  # charging, shaking
            self.x += random.choice([-3, 3])
            yield
        self.sprite = "dash"
        self.angle = -90
        yield from self.tween(0.6, ease_in_out, y=T - 300)
        yield from self.wait(1.0)
        self.angle = 90
        self.flipx = False
        self.y = T - 300
        yield from self.tween(0.5, y=self.bottom_y())
        self.angle = 0
        yield from self.squash(1, 0.35, 0.08)
        self.sprite = "salute"
        yield from self.wait(0.8)
        yield from self.leave(False)

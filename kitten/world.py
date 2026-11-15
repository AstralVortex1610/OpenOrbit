"""The kitten's world: walkable surfaces (taskbar/screen bottom + visible top edges of windows)
and a route planner over them (walk, jump, drop, climb a window side). Pure python."""
import time

from . import win32

MAX_RISE = 300.0   # highest jump onto a ledge (px); higher ledges need a climb
MAX_DX = 520.0     # longest horizontal jump
HEADROOM = 160.0   # a ledge closer than this to the top of the screen is not standable


class Platform:
    __slots__ = ("hwnd", "l", "r", "y", "rect")

    def __init__(self, hwnd, l, r, y, rect=None):
        self.hwnd, self.l, self.r, self.y, self.rect = hwnd, float(l), float(r), float(y), rect

    @property
    def ground(self):
        return self.hwnd is None

    def has(self, x, margin=0.0):
        return self.l - margin <= x <= self.r + margin

    def __repr__(self):
        return f"Plat({self.hwnd},{self.l:.0f}-{self.r:.0f}@{self.y:.0f})"


def _subtract(segs, a, b):
    out = []
    for l, r in segs:
        if b <= l or a >= r:
            out.append((l, r))
            continue
        if a > l:
            out.append((l, a))
        if b < r:
            out.append((b, r))
    return out


class World:
    def __init__(self, area_fn, my_pid=0):
        self.area_fn = area_fn
        self.my_pid = my_pid
        self.extra = {}          # test/preview windows: hwnd -> rect, treated as front-most
        self.platforms = []
        self.windows = []
        self.t = 0.0
        self.refresh(force=True)

    def area(self):
        return self.area_fn()

    def rect_of(self, hwnd):
        if hwnd in self.extra:
            return self.extra[hwnd]
        if not win32.is_window(hwnd) or win32.is_minimized(hwnd):
            return None
        return win32.rect(hwnd)

    def refresh(self, force=False):
        now = time.time()
        if not force and now - self.t < 0.15:
            return
        self.t = now
        L, T, R, B = self.area()
        wins = list(self.extra.items())
        try:
            wins += [w for w in win32.top_windows(self.my_pid) if w[0] not in self.extra]
        except Exception:
            pass
        self.windows = wins
        plats = [Platform(None, L - 400, R + 400, B)]
        for i, (h, r) in enumerate(wins):
            x, y, w, hh = r
            if y < T + HEADROOM or y > B - 30 or w >= (R - L) - 4 and y <= T + 2:
                continue
            segs = [(max(x, L), min(x + w, R))]
            for h2, r2 in wins[:i]:
                if r2[1] - 2 <= y <= r2[1] + r2[3]:
                    segs = _subtract(segs, r2[0] - 2, r2[0] + r2[2] + 2)
            for l, rr in segs:
                if rr - l >= 70:
                    plats.append(Platform(h, l, rr, y, r))
        self.platforms = plats

    @property
    def ground(self):
        return self.platforms[0]

    def find(self, hwnd, x=None):
        best, bd = None, 1e18
        for p in self.platforms:
            if p.hwnd != hwnd:
                continue
            d = 0 if x is None or p.has(x) else min(abs(x - p.l), abs(x - p.r))
            if d < bd:
                best, bd = p, d
        return best

    def same(self, plat, x):
        """The fresh version of plat under x (None if it vanished / got covered)."""
        if plat is None or plat.ground:
            return self.ground
        for p in self.platforms:
            if p.hwnd == plat.hwnd and p.has(x, 6) and abs(p.y - plat.y) < 40:
                return p
        return None

    def landing(self, x, y0, y1, ignore=None):
        """Highest surface crossed going down from y0 to y1 at x."""
        best = None
        for p in self.platforms:
            if p is ignore or not p.has(x):
                continue
            if y0 - 1 <= p.y <= y1 and (best is None or p.y < best.y):
                best = p
        return best

    # ------------------------------------------------------------------ route planning
    def edge(self, P, Q, fx):
        rise = P.y - Q.y
        if Q.ground:
            if P.ground:
                return None
            if fx - P.l < P.r - fx:
                return [("walk", P.l + 10), ("jump", Q, P.l - 50)]
            return [("walk", P.r - 10), ("jump", Q, P.r + 50)]
        if rise > 8:
            if rise <= MAX_RISE:
                cands = []
                for tx, lx in ((Q.l - 45, Q.l + 30), (Q.r + 45, Q.r - 30)):
                    if P.l + 5 <= tx <= P.r - 5:
                        cands.append((tx, lx))
                ol, orr = max(P.l, Q.l) + 30, min(P.r, Q.r) - 30
                if not cands and ol < orr:
                    tx = min(max(fx, ol), orr)
                    cands.append((tx, tx))
                if not cands:
                    return None
                tx, lx = min(cands, key=lambda c: abs(c[0] - fx))
                return [("walk", tx), ("jump", Q, lx)]
            if Q.rect is None:
                return None
            x, y, w, h = Q.rect
            cands = []
            for wall, side, stand in ((x, 1, x - 14), (x + w, -1, x + w + 14)):
                if P.has(stand, -4) and Q.has(wall, 3) and y + h >= P.y - 80:
                    cands.append((stand, wall, side))
            if not cands:
                return None
            stand, wall, side = min(cands, key=lambda c: abs(c[0] - fx))
            return [("walk", stand), ("climb", Q, wall, side)]
        cands = []
        for ex, d in ((P.l, -1), (P.r, 1)):
            exposed = (d < 0 and Q.l < P.l - 20) or (d > 0 and Q.r > P.r + 20) or abs(rise) <= 8
            if not exposed or P.ground:
                continue
            land = min(max(ex + d * 60, Q.l + 25), Q.r - 25)
            if abs(land - ex) <= MAX_DX:
                cands.append((ex - d * 10, land))
        if not cands:
            return None
        tx, land = min(cands, key=lambda c: abs(c[0] - fx))
        return [("walk", tx), ("jump", Q, land)]

    def plan(self, start, x, goal_fn):
        """BFS over surfaces. Returns the action list of the first hop ([] if already there,
        None if unreachable)."""
        if goal_fn(start):
            return []
        plats = self.platforms
        seen = {id(start)}
        frontier = [(start, x, None)]
        for _ in range(6):
            nxt = []
            for P, px, first in frontier:
                for Q in plats:
                    if id(Q) in seen or Q is P:
                        continue
                    acts = self.edge(P, Q, px)
                    if not acts:
                        continue
                    lx = acts[-1][2] if acts[-1][0] == "jump" else (Q.l + 30 if acts[-1][3] > 0 else Q.r - 30)
                    f = first or acts
                    if goal_fn(Q):
                        return f
                    seen.add(id(Q))
                    nxt.append((Q, lx, f))
            frontier = nxt
            if not frontier:
                break
        return None

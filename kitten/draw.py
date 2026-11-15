"""Paints a Rig draw list with QPainter. Used by the live pet AND the offline preview, so the
preview shows exactly what Windows will draw."""
import json
import os

from PySide6.QtCore import Qt, QPointF, QRectF
from PySide6.QtGui import (QPainter, QPixmap, QColor, QPen, QBrush, QLinearGradient,
                           QRadialGradient, QTransform, QPainterPath, QPolygonF)

OUTLINE = QColor(62, 36, 38)
SHADE = QColor(196, 184, 200)
FAR_TOP, FAR_BOT = QColor(226, 220, 231), QColor(196, 188, 204)
BODY_TOP, BODY_BOT = QColor(255, 255, 255), QColor(226, 219, 230)
NAVY = QColor(31, 42, 77)
NAVY_LINE = QColor(88, 104, 150)


class HeadArt:
    def __init__(self, base_dir):
        self.dir = base_dir
        with open(os.path.join(base_dir, "heads.json"), "r", encoding="utf-8") as f:
            self.meta = json.load(f)
        self.cache = {}

    def pm(self, name):
        p = self.cache.get(name)
        if p is None:
            path = os.path.join(self.dir, name + ".png")
            p = QPixmap(path) if os.path.exists(path) else None
            self.cache[name] = p
        return p


def _blob(p, circles, top, bot, ow):
    if not circles:
        return
    ys = [c[2] for c in circles]
    y0, y1 = min(ys) - 20, max(ys) + 20
    p.setPen(Qt.NoPen)
    p.setBrush(OUTLINE)
    for c in circles:
        _shape(p, c, ow)
    g = QLinearGradient(0, y0, 0, y1)
    g.setColorAt(0.0, top)
    g.setColorAt(0.55, top)
    g.setColorAt(1.0, bot)
    p.setBrush(QBrush(g))
    for c in circles:
        _shape(p, c, 0)


def _shape(p, c, grow):
    if c[0] == "c":
        r = c[3] + grow
        p.drawEllipse(QPointF(c[1], c[2]), r, r)
    else:
        p.save()
        p.translate(c[1], c[2])
        p.rotate(c[5])
        p.drawEllipse(QPointF(0, 0), c[3] + grow, c[4] + grow)
        p.restore()


def _head(p, art, it):
    _, view, expr, x, y, rot, width, mirror, blink, ears, glow, sx = it
    meta = art.meta["views"][view].get(expr) or art.meta["views"][view]["neutral"]
    key = f"head_{view}_{expr}"
    base = art.pm(key)
    if base is None:
        return
    k = width / art.meta["width"]
    ax, ay = meta["anchor"]
    p.save()
    p.translate(x, y)
    p.rotate(rot)
    p.scale(k * sx * (-1 if mirror else 1), k)
    p.translate(-ax, -ay)
    p.drawPixmap(0, 0, base)
    for i, ear in enumerate(meta["ears"]):
        epm = art.pm(f"{key}_ear{i}")
        if epm is None:
            continue
        a = ears[i % len(ears)] if ears else 0.0
        ang = 14.0 * ear["dir"] * (a * (1 - a) * 4)  # quick flick out and back
        p.save()
        px, py = ear["pivot"]
        p.translate(px, py)
        p.rotate(ang)
        p.translate(-px, -py)
        p.drawPixmap(ear["x"], ear["y"], epm)
        p.restore()
    if meta["blink"] and blink:
        lid = art.pm(f"{key}_lid{blink}")
        if lid is not None:
            p.drawPixmap(0, 0, lid)
    if meta["eyes"] and glow > 0.01 and not blink:
        p.setPen(Qt.NoPen)
        for ex, ey, er in meta["eyes"]:
            g = QRadialGradient(QPointF(ex, ey), er * 1.3)
            g.setColorAt(0.6, QColor(90, 255, 240, int(38 * glow)))
            g.setColorAt(1.0, QColor(90, 255, 240, 0))
            p.setBrush(QBrush(g))
            p.drawEllipse(QPointF(ex, ey), er * 1.3, er * 1.3)
    p.restore()


def paint(p, items, art, scale=1.0, clip=None):
    """items in world coords; caller has already translated the painter to the widget origin."""
    p.setRenderHint(QPainter.Antialiasing)
    p.setRenderHint(QPainter.SmoothPixmapTransform)
    if clip is not None:
        path = QPainterPath()
        path.addPolygon(QPolygonF([QPointF(a, b) for a, b in clip]))
        p.setClipPath(path)
    ow = 2.3 * scale
    for it in items:
        kind = it[0]
        if kind == "blob":
            if it[1] == "far":
                _blob(p, it[2], FAR_TOP, FAR_BOT, ow)
            else:
                _blob(p, it[2], BODY_TOP, BODY_BOT, ow)
        elif kind == "lines":
            col = {"shade": SHADE, "bandana_line": NAVY_LINE}.get(it[1], OUTLINE)
            pen = QPen(col, it[3])
            pen.setCapStyle(Qt.RoundCap)
            pen.setJoinStyle(Qt.RoundJoin)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            for pts in it[2]:
                if len(pts) >= 2:
                    path = QPainterPath(QPointF(*pts[0]))
                    for q in pts[1:]:
                        path.lineTo(QPointF(*q))
                    p.drawPath(path)
        elif kind == "poly":
            pen = QPen(OUTLINE, ow * 0.9)
            pen.setJoinStyle(Qt.RoundJoin)
            p.setPen(pen)
            p.setBrush(NAVY)
            p.drawPolygon(QPolygonF([QPointF(a, b) for a, b in it[2]]))
        elif kind == "head":
            _head(p, art, it)

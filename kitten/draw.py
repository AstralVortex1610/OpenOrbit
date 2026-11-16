"""Paints a Rig draw list with QPainter. Used by the live pet AND the offline preview, so the
preview shows exactly what Windows will draw.

v3: the whole cat is procedural (mochi style) - soft white fills with a warm shade, a thick soft
dark outline, pink inner ears, tiny dot eyes, ':3' mouth and pink blush. No sprites."""
import math
import os

from PySide6.QtCore import Qt, QPointF, QRectF
from PySide6.QtGui import (QPainter, QColor, QPen, QBrush, QLinearGradient, QRadialGradient, QTransform,
                           QPainterPath, QPolygonF, QFont)

OUTLINE = QColor(74, 58, 60)
EYE = QColor(52, 36, 38)
FILL_HI = QColor(255, 255, 255)
FILL_MID = QColor(255, 252, 250)
FILL_LO = QColor(246, 226, 223)
FAR_FILL = QColor(238, 226, 226)
EAR_IN = QColor(255, 178, 186)
MOUTH_IN = QColor(170, 62, 76)
TONGUE = QColor(255, 140, 156)
BLUSH = (255, 150, 166)
CYAN = (90, 240, 245)
OW = 2.7          # outline width at scale 1


class HeadArt:
    """Kept for API compatibility (v3 draws the head procedurally, no sprites are loaded)."""
    def __init__(self, base_dir=None):
        self.dir = base_dir
        self.meta = {}
        self.cache = {}

    def pm(self, name):
        return None


def _smooth_path(pts, closed=True):
    path = QPainterPath()
    n = len(pts)
    if n < 3:
        if n:
            path.moveTo(QPointF(*pts[0]))
            for q in pts[1:]:
                path.lineTo(QPointF(*q))
        return path
    if closed:
        m0 = ((pts[-1][0] + pts[0][0]) / 2, (pts[-1][1] + pts[0][1]) / 2)
        path.moveTo(QPointF(*m0))
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            path.quadTo(QPointF(*a), QPointF((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
        path.closeSubpath()
    else:
        path.moveTo(QPointF(*pts[0]))
        for i in range(1, n - 1):
            a, b = pts[i], pts[i + 1]
            path.quadTo(QPointF(*a), QPointF((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
        path.lineTo(QPointF(*pts[-1]))
    return path


def _pen(col, w):
    pen = QPen(col, w)
    pen.setCapStyle(Qt.RoundCap)
    pen.setJoinStyle(Qt.RoundJoin)
    return pen


def _fill_grad(light):
    gx, gy, gr = light
    g = QRadialGradient(QPointF(gx, gy), max(gr, 1.0))
    g.setColorAt(0.0, FILL_HI)
    g.setColorAt(0.6, FILL_MID)
    g.setColorAt(1.0, FILL_LO)
    return QBrush(g)


def paint(p, items, art=None, scale=1.0, clip=None):
    """items in world coords; caller has already translated the painter to the widget origin."""
    p.setRenderHint(QPainter.Antialiasing)
    if clip is not None:
        path = QPainterPath()
        path.addPolygon(QPolygonF([QPointF(a, b) for a, b in clip]))
        p.setClipPath(path)
    ow = OW * scale
    for it in items:
        kind = it[0]
        if kind == "shape":
            role = it[1]
            if role == "ear_in":
                p.setPen(Qt.NoPen)
                p.setBrush(EAR_IN)
                for tri in it[2]:
                    p.drawPath(_smooth_path(tri))
                continue
            path = _smooth_path(it[2])
            p.setPen(_pen(OUTLINE, ow))
            p.setBrush(_fill_grad(it[3]) if it[3] else QBrush(FILL_HI))
            p.drawPath(path)
        elif kind == "leg":
            _leg(p, it, ow)
        elif kind == "tube":
            pts, w = it[1], it[2]
            if len(pts) < 2:
                continue
            path = _smooth_path(pts, closed=False)
            p.setBrush(Qt.NoBrush)
            p.setPen(_pen(OUTLINE, w + 2 * ow))
            p.drawPath(path)
            p.setPen(_pen(FILL_MID, w))
            p.drawPath(path)
        elif kind == "face":
            p.save()
            m = it[1]
            p.setTransform(QTransform(m[0], m[1], m[2], m[3], m[4], m[5]), True)
            _face(p, it[2])
            p.restore()
        elif kind == "aura":
            p.save()
            m = it[1]
            p.setTransform(QTransform(m[0], m[1], m[2], m[3], m[4], m[5]), True)
            _aura(p, it[2])
            p.restore()
        elif kind == "lines":
            pen = _pen(OUTLINE, it[3])
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            for pts in it[2]:
                if len(pts) >= 2:
                    path = QPainterPath(QPointF(*pts[0]))
                    for q in pts[1:]:
                        path.lineTo(QPointF(*q))
                    p.drawPath(path)
        elif kind == "fx":
            _fx(p, it[1], scale)


def _leg(p, it, ow):
    _, pts, w, paw, tint, toes = it
    px, py, rx, ry, rot = paw
    path = _smooth_path(pts, closed=False)
    fill = FAR_FILL if tint == "far" else FILL_MID
    p.setBrush(Qt.NoBrush)
    p.setPen(_pen(OUTLINE, w + 2 * ow))
    p.drawPath(path)
    p.save()
    p.translate(px, py)
    p.rotate(rot)
    p.setPen(_pen(OUTLINE, ow))
    p.setBrush(fill)
    p.drawEllipse(QPointF(0, 0), rx, ry)
    p.restore()
    p.setBrush(Qt.NoBrush)
    p.setPen(_pen(fill, w))
    p.drawPath(path)
    # paw fill again (covers the tube's inner outline at the joint)
    p.save()
    p.translate(px, py)
    p.rotate(rot)
    p.setPen(Qt.NoPen)
    p.setBrush(fill)
    p.drawEllipse(QPointF(0, 0), max(rx - ow * 0.5, 1), max(ry - ow * 0.5, 1))
    p.restore()
    if toes:
        p.setPen(_pen(QColor(74, 58, 60, 170), ow * 0.55))
        for a, b in toes:
            p.drawLine(QPointF(*a), QPointF(*b))


# ---------------------------------------------------------------------------- the face (head-local units)
def _eye_uv(view):
    if view == "front":
        return [(-20.0, 4.0), (20.0, 4.0)]
    return [(-2.0, 4.0), (34.0, 3.0)]


def _mouth_uv(view):
    return (0.0, 10.0) if view == "front" else (16.0, 9.5)


def _blush_uv(view):
    if view == "front":
        return [(-33.0, 15.0), (33.0, 15.0)]
    return [(-18.0, 15.0), (45.0, 14.0)]


def _aura(p, face):
    a = face["aura"] * (0.75 + 0.25 * math.sin(face.get("time", 0) * 4.0))
    p.setPen(Qt.NoPen)
    g = QRadialGradient(QPointF(8, 0), 95)
    g.setColorAt(0.0, QColor(150, 255, 250, int(150 * a)))
    g.setColorAt(0.5, QColor(90, 235, 255, int(70 * a)))
    g.setColorAt(1.0, QColor(90, 235, 255, 0))
    p.setBrush(QBrush(g))
    p.drawEllipse(QPointF(8, 0), 95, 85)


def _heart_path(cx, cy, s):
    path = QPainterPath()
    path.moveTo(cx, cy + s * 0.9)
    path.cubicTo(cx - s * 1.25, cy + s * 0.05, cx - s * 0.95, cy - s * 1.0, cx, cy - s * 0.38)
    path.cubicTo(cx + s * 0.95, cy - s * 1.0, cx + s * 1.25, cy + s * 0.05, cx, cy + s * 0.9)
    return path


def _star_path(cx, cy, r, inner=0.38, n=4, rot=0.0):
    path = QPainterPath()
    for i in range(n * 2):
        a = rot + i * math.pi / n - math.pi / 2
        rr = r if i % 2 == 0 else r * inner
        q = QPointF(cx + math.cos(a) * rr, cy + math.sin(a) * rr)
        if i == 0:
            path.moveTo(q)
        else:
            path.lineTo(q)
    path.closeSubpath()
    return path


def _drop_path(x, y, s):
    path = QPainterPath()
    path.moveTo(x, y - s * 1.6)
    path.cubicTo(x + s * 1.1, y - s * 0.2, x + s, y + s, x, y + s)
    path.cubicTo(x - s, y + s, x - s * 1.1, y - s * 0.2, x, y - s * 1.6)
    return path


def _arc(p, pts, w=2.2, col=EYE):
    p.setPen(_pen(col, w))
    p.setBrush(Qt.NoBrush)
    path = QPainterPath(QPointF(*pts[0]))
    if len(pts) == 3:
        path.quadTo(QPointF(*pts[1]), QPointF(*pts[2]))
    else:
        for q in pts[1:]:
            path.lineTo(QPointF(*q))
    p.drawPath(path)


def _dot(p, u, v, rx, ry, shine=1.0):
    p.setPen(Qt.NoPen)
    p.setBrush(EYE)
    p.drawEllipse(QPointF(u, v), rx, ry)
    p.setBrush(QColor(255, 255, 255, 235))
    p.drawEllipse(QPointF(u + rx * 0.3, v - ry * 0.38), rx * 0.34 * shine, ry * 0.3 * shine)


def _eye(p, i, u, v, face):
    kind = face["eyes"]
    lid = face["lid"]
    t = face["time"]
    s_in = 1 if i == 0 else -1          # direction toward the other eye
    side = face["view"] == "side"
    sx = 0.88 if (side and i == 1) else 1.0   # far-side eye a touch narrower in 3/4 view
    lx, ly = face["look"]
    pu, pv = u + lx * 1.6, v + ly * 1.4
    blinkable = kind in ("dot", "round", "big", "half", "angry", "smug", "flat", "wide", "heart")
    if blinkable and lid > 0.5:
        _arc(p, [(u - 5 * sx, v), (u, v + 3.2), (u + 5 * sx, v)], 2.3)
        return
    if kind == "dot":
        k = 0.85 + 0.35 * face["pupil"]
        _dot(p, pu, pv, 4.3 * k * sx, 5.2 * k)
    elif kind == "round":
        k = 0.9 + 0.4 * face["pupil"]
        _dot(p, pu, pv, 5.4 * k * sx, 6.3 * k, 1.1)
        p.setBrush(QColor(255, 255, 255, 220))
        p.drawEllipse(QPointF(pu - 2.0 * sx, pv + 2.4), 1.1, 1.0)
    elif kind == "wide":
        p.setPen(_pen(EYE, 1.9))
        p.setBrush(QColor(255, 255, 255))
        p.drawEllipse(QPointF(u, v - 1), 7.6 * sx, 8.4)
        p.setPen(Qt.NoPen)
        p.setBrush(EYE)
        p.drawEllipse(QPointF(pu + lx * 1.5, pv - 1 + ly * 1.5), 2.4, 2.7)
    elif kind == "big":
        cy_ = face["cyan"]
        rx, ry = 8.4 * sx, 9.6
        if cy_ > 0.01:  # soft cyan glow around the pleading eyes
            g = QRadialGradient(QPointF(u, v), 15)
            g.setColorAt(0.45, QColor(*CYAN, int(150 * cy_)))
            g.setColorAt(1.0, QColor(*CYAN, 0))
            p.setPen(Qt.NoPen)
            p.setBrush(QBrush(g))
            p.drawEllipse(QPointF(u, v), 15, 15)
        g = QRadialGradient(QPointF(u, v + ry * 0.45), ry * 1.1)
        g.setColorAt(0.0, QColor(40 + int(60 * cy_), 120 + int(110 * cy_), 140 + int(100 * cy_)))
        g.setColorAt(0.55, QColor(40, 50 + int(70 * cy_), 70 + int(70 * cy_)))
        g.setColorAt(1.0, EYE)
        p.setPen(_pen(EYE, 1.3))
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(u, v), rx, ry)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(255, 255, 255, 245))
        tw = 0.85 + 0.15 * math.sin(t * 7 + i)
        p.drawEllipse(QPointF(u + rx * 0.28, v - ry * 0.4), rx * 0.42 * tw, ry * 0.36 * tw)
        p.drawEllipse(QPointF(u - rx * 0.35, v + ry * 0.35), rx * 0.18, ry * 0.15)
        p.drawPath(_star_path(u - rx * 0.32, v - ry * 0.18, 2.3 * tw, 0.3))
        # wobbling tear welling along the bottom lid
        tear = face["tear"]
        if tear > 0.01:
            wob = math.sin(t * 9 + i * 1.7) * 0.8
            path = QPainterPath()
            path.moveTo(u - rx * 1.05, v + ry * 0.45 + wob * 0.3)
            path.quadTo(u, v + ry * (1.25 + 0.06 * wob), u + rx * 1.05, v + ry * 0.45 - wob * 0.3)
            path.quadTo(u, v + ry * 0.75, u - rx * 1.05, v + ry * 0.45 + wob * 0.3)
            p.setBrush(QColor(205, 245, 255, int(210 * tear)))
            p.setPen(_pen(QColor(110, 190, 225, int(200 * tear)), 0.9))
            p.drawPath(path)
            if tear > 0.6:  # a fat drop clinging to the outer corner, trembling
                dk = (tear - 0.6) / 0.4
                dx = u - s_in * rx * 0.9
                dy = v + ry * 1.0 + 1.2 * (0.5 + 0.5 * math.sin(t * 2.3 + i))
                p.setPen(_pen(QColor(110, 190, 225, int(220 * dk)), 0.9))
                p.setBrush(QColor(210, 246, 255, int(235 * dk)))
                p.drawPath(_drop_path(dx, dy, 2.2))
    elif kind == "happy":
        _arc(p, [(u - 5.2 * sx, v + 2.2), (u, v - 4.5), (u + 5.2 * sx, v + 2.2)], 2.4)
    elif kind == "closed":
        _arc(p, [(u - 5.2 * sx, v), (u, v + 3.4), (u + 5.2 * sx, v)], 2.3)
    elif kind in ("half", "flat", "smug"):
        cut = {"half": -0.5, "flat": 1.0, "smug": 0.2}[kind]
        shift = 1.6 if kind == "smug" else 0.0
        p.save()
        clip = QPainterPath()
        clip.addRect(QRectF(u - 9, v + cut, 18, 12))
        p.setClipPath(clip, Qt.IntersectClip)
        _dot(p, pu + shift, pv + 0.6, 4.5 * sx, 5.0, 0.0)
        p.restore()
        tilt = 0.9 if kind == "smug" else 0.0
        _arc(p, [(u - 6.2 * sx, v + cut - tilt), (u + 6.2 * sx, v + cut + tilt)], 2.2)
    elif kind == "angry":
        p.save()
        clip = QPainterPath()
        clip.moveTo(u - 9, v + 12)
        clip.lineTo(u - 9, v - 3 - 2.5 * s_in)
        clip.lineTo(u + 9, v - 3 + 2.5 * s_in)
        clip.lineTo(u + 9, v + 12)
        clip.closeSubpath()
        p.setClipPath(clip, Qt.IntersectClip)
        _dot(p, pu, pv + 0.5, 4.4 * sx, 5.0)
        p.restore()
        _arc(p, [(u - 6.5 * sx, v - 5.2 - 2.6 * s_in), (u + 6.5 * sx, v - 5.2 + 2.6 * s_in)], 2.2)
    elif kind == "squeeze":
        d = s_in
        _arc(p, [(u - d * 4.2, v - 4.2), (u + d * 3.4, v), (u - d * 4.2, v + 4.2)], 2.4)
    elif kind == "spiral":
        p.setPen(_pen(EYE, 1.6))
        p.setBrush(Qt.NoBrush)
        path = QPainterPath()
        for j in range(40):
            a = j * 0.42 + t * 8 * (1 if i else -1)
            rr = 6.5 * j / 40
            q = QPointF(u + math.cos(a) * rr, v + math.sin(a) * rr)
            path.moveTo(q) if j == 0 else path.lineTo(q)
        p.drawPath(path)
    elif kind == "heart":
        hs = 5.6 * (1.0 + 0.12 * (int(t * 6) % 2))
        p.setPen(_pen(QColor(150, 30, 70), 1.2))
        p.setBrush(QColor(255, 78, 128))
        p.drawPath(_heart_path(u, v, hs))
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(255, 210, 225))
        p.drawEllipse(QPointF(u - hs * 0.4, v - hs * 0.35), hs * 0.2, hs * 0.16)
    elif kind == "cry":
        _arc(p, [(u - 5.4 * sx, v + 1.8), (u, v - 3.6), (u + 5.4 * sx, v + 1.8)], 2.4)
    # brows
    br = face.get("brows")
    if br == "worried" and kind not in ("angry",):
        _arc(p, [(u - s_in * 5.0 * sx, v - 9.5), (u + s_in * 3.6 * sx, v - 13.0)], 1.9)


def _streams(p, face):
    """Crying: two wobbly waterfalls of tears from the eyes down the cheeks."""
    t = face["time"]
    seed = face["seed"]
    for i, (u, v) in enumerate(_eye_uv(face["view"])):
        wob = math.sin(seed * 1.7 + i) * 1.2
        path = QPainterPath()
        path.moveTo(u - 3.2, v + 2)
        path.cubicTo(u - 4.5 + wob, v + 12, u - 6 - wob, v + 22, u - 5.5, v + 31)
        path.quadTo(u, v + 34, u + 5.5, v + 31)
        path.cubicTo(u + 6 + wob, v + 22, u + 4.5 - wob, v + 12, u + 3.2, v + 2)
        path.closeSubpath()
        p.setPen(_pen(QColor(90, 170, 215, 220), 1.1))
        p.setBrush(QColor(190, 236, 255, 225))
        p.drawPath(path)
        p.setPen(_pen(QColor(255, 255, 255, 220), 1.2))
        p.drawLine(QPointF(u - 1.5, v + 8 + (seed % 3)), QPointF(u - 2.2, v + 16 + (seed % 3)))


def _mouth(p, face):
    mu, mv = _mouth_uv(face["view"])
    lx, ly = face["look"]
    mu += lx * 1.2
    mv += ly * 0.8
    kind = face["mouth"]
    t = face["time"]
    w = 1.9
    if kind == "w":
        path = QPainterPath(QPointF(mu - 6, mv - 1.2))
        path.quadTo(QPointF(mu - 3, mv + 3.6), QPointF(mu, mv - 0.2))
        path.quadTo(QPointF(mu + 3, mv + 3.6), QPointF(mu + 6, mv - 1.2))
        p.setPen(_pen(EYE, w))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
    elif kind in ("open", "grin", "meow", "yawn", "wail", "o"):
        path = QPainterPath()
        if kind == "open":
            path.moveTo(mu - 4.6, mv - 0.6)
            path.quadTo(mu - 4.2, mv + 7.5, mu, mv + 7.8)
            path.quadTo(mu + 4.2, mv + 7.5, mu + 4.6, mv - 0.6)
            path.quadTo(mu, mv + 1.4, mu - 4.6, mv - 0.6)
        elif kind == "grin":
            path.moveTo(mu - 8, mv - 1.5)
            path.quadTo(mu, mv + 1.0, mu + 8, mv - 1.5)
            path.quadTo(mu + 7, mv + 12, mu, mv + 12.5)
            path.quadTo(mu - 7, mv + 12, mu - 8, mv - 1.5)
        elif kind == "wail":
            o = 1.0 + 0.12 * ((face["seed"]) % 2)
            path.moveTo(mu - 5.5, mv + 1)
            path.quadTo(mu, mv - 2.5, mu + 5.5, mv + 1)
            path.quadTo(mu + 8 * o, mv + 11 * o, mu, mv + 11.5 * o)
            path.quadTo(mu - 8 * o, mv + 11 * o, mu - 5.5, mv + 1)
        elif kind == "o":
            path.addEllipse(QPointF(mu, mv + 2.6), 3.0, 3.6)
        elif kind == "meow":
            h = 4.0 + 2.6 * face["mouth_open"]
            path.addEllipse(QPointF(mu, mv + h * 0.55), 4.4, h)
        else:  # yawn
            path.addEllipse(QPointF(mu, mv + 6), 6.2, 8.2)
        p.setPen(_pen(EYE, 1.8))
        p.setBrush(MOUTH_IN)
        p.drawPath(path)
        if kind != "o":
            p.save()
            p.setClipPath(path, Qt.IntersectClip)
            p.setPen(Qt.NoPen)
            p.setBrush(TONGUE)
            br = path.boundingRect()
            p.drawEllipse(QPointF(br.center().x(), br.bottom()), br.width() * 0.36, br.height() * 0.4)
            p.restore()
    elif kind == "pout":
        path = QPainterPath(QPointF(mu - 5.5, mv + 2.6))
        path.quadTo(QPointF(mu - 2.8, mv - 1.6), QPointF(mu, mv + 1.0))
        path.quadTo(QPointF(mu + 2.8, mv - 1.6), QPointF(mu + 5.5, mv + 2.6))
        p.setPen(_pen(EYE, w))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
    elif kind == "flat":
        _arc(p, [(mu - 4.2, mv + 1.2), (mu + 4.2, mv + 1.2)], w)
    elif kind in ("wobble", "strain"):
        amp = 1.5 if kind == "wobble" else 2.2
        path = QPainterPath(QPointF(mu - 6, mv + 1.5))
        for j in range(1, 7):
            jit = math.sin(t * 20 + j) * 0.5 if kind == "wobble" else 0
            path.lineTo(QPointF(mu - 6 + j * 2, mv + 1.5 + (amp if j % 2 else -amp) * 0.8 + jit))
        p.setPen(_pen(EYE, w))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
    elif kind == "tongue":
        path = QPainterPath(QPointF(mu - 6, mv - 1.2))
        path.quadTo(QPointF(mu - 3, mv + 3.6), QPointF(mu, mv - 0.2))
        path.quadTo(QPointF(mu + 3, mv + 3.6), QPointF(mu + 6, mv - 1.2))
        tg = QPainterPath()
        tg.moveTo(mu + 0.6, mv + 1.2)
        tg.quadTo(mu + 1.2, mv + 7.8, mu + 3.6, mv + 7.6)
        tg.quadTo(mu + 6.2, mv + 7.2, mu + 5.2, mv + 1.3)
        p.setPen(_pen(EYE, 1.5))
        p.setBrush(TONGUE)
        p.drawPath(tg)
        p.setPen(_pen(EYE, w))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
    elif kind == "smirk":
        path = QPainterPath(QPointF(mu - 5.5, mv + 0.5))
        path.quadTo(QPointF(mu + 0.5, mv + 3.5), QPointF(mu + 5.5, mv - 2.4))
        p.setPen(_pen(EYE, w))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)


def _blush(p, face):
    amt = face["blush"]
    big = 1.0 + 0.35 * face.get("cheeks", 0.0)
    p.setPen(Qt.NoPen)
    for (u, v) in _blush_uv(face["view"]):
        rx, ry = 7.6 * big, 4.6 * big
        g = QRadialGradient(QPointF(u, v), rx)
        a = min(1.0, amt)
        g.setColorAt(0.0, QColor(*BLUSH, int(170 * a)))
        g.setColorAt(0.65, QColor(*BLUSH, int(120 * a)))
        g.setColorAt(1.0, QColor(*BLUSH, 0))
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(u, v), rx, ry)
        if face.get("lines", 0) > 0.01:
            p.setPen(_pen(QColor(225, 90, 110, int(220 * min(1, face["lines"]))), 1.2))
            for j in (-1, 0, 1):
                p.drawLine(QPointF(u + j * 3.2 - 1.2, v + 1.8), QPointF(u + j * 3.2 + 1.2, v - 1.8))
            p.setPen(Qt.NoPen)


def _face(p, face):
    lx, ly = face["look"]
    p.save()
    p.translate(lx * 3.2, ly * 2.4)   # the whole face turns a little toward what he looks at
    if face["blush"] > 0.01:
        _blush(p, face)
    for i, (u, v) in enumerate(_eye_uv(face["view"])):
        _eye(p, i, u, v, face)
    _mouth(p, face)
    if face.get("stream", 0) > 0.01:
        _streams(p, face)
    p.restore()


# ---------------------------------------------------------------------------- particles
def _fx(p, parts, scale):
    for kind, x, y, s, a, rot in parts:
        if a <= 0.01:
            continue
        p.save()
        p.translate(x, y)
        p.setOpacity(max(0.0, min(1.0, a)))
        if kind == "heart":
            p.setPen(_pen(OUTLINE, 1.8 * s))
            p.setBrush(QColor(255, 120, 150))
            p.drawPath(_heart_path(0, 0, 10 * s))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 215, 228))
            p.drawEllipse(QPointF(-4 * s, -4 * s), 2.2 * s, 1.8 * s)
        elif kind == "sparkle":
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 236, 150))
            p.drawPath(_star_path(0, 0, 11 * s, 0.28))
            p.setBrush(QColor(255, 255, 255))
            p.drawPath(_star_path(0, 0, 5.5 * s, 0.3))
        elif kind == "star":
            p.setPen(_pen(OUTLINE, 1.5 * s))
            p.setBrush(QColor(255, 220, 90))
            p.drawPath(_star_path(0, 0, 10 * s, 0.45, 5, rot))
        elif kind in ("sweat", "tear"):
            p.setPen(_pen(QColor(80, 150, 205), 1.6 * s))
            p.setBrush(QColor(196, 238, 255))
            p.rotate(-20 if kind == "sweat" else 0)
            p.drawPath(_drop_path(0, 0, (6 if kind == "sweat" else 4.2) * s))
        elif kind in ("zzz", "note", "q", "excl"):
            txt = {"zzz": "z", "note": "\u266a", "q": "?", "excl": "!"}[kind]
            f = QFont("Arial", 1)
            f.setPixelSize(max(6, int((24 if kind != "zzz" else 19) * s)))
            f.setBold(True)
            p.setFont(f)
            col = {"zzz": QColor(120, 140, 210), "note": QColor(110, 130, 210), "q": QColor(90, 110, 190),
                   "excl": QColor(235, 80, 80)}[kind]
            path = QPainterPath()
            path.addText(QPointF(-6 * s, 8 * s), f, txt)
            p.setPen(_pen(QColor(255, 255, 255), 4.5 * s))
            p.setBrush(Qt.NoBrush)
            p.drawPath(path)
            p.setPen(_pen(OUTLINE, 1.4 * s))
            p.setBrush(col)
            p.drawPath(path)
        elif kind == "vein":
            pen = _pen(QColor(235, 60, 70), 3 * s)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            for k in range(4):
                p.rotate(90)
                path = QPainterPath(QPointF(3 * s, -9 * s))
                path.quadTo(QPointF(3 * s, -3 * s), QPointF(9 * s, -3 * s))
                p.drawPath(path)
        elif kind == "puff":
            p.setPen(_pen(QColor(170, 160, 168), 1.5 * s))
            p.setBrush(QColor(252, 250, 250))
            for dx, dy, r in ((-6, 0, 7), (5, -2, 8), (0, -7, 6)):
                p.drawEllipse(QPointF(dx * s, dy * s), r * s, r * s)
        elif kind == "purr":
            p.setPen(_pen(QColor(255, 140, 170), 2.4 * s))
            p.setBrush(Qt.NoBrush)
            path = QPainterPath(QPointF(-9 * s, 0))
            path.cubicTo(QPointF(-4 * s, -6 * s), QPointF(0, 6 * s), QPointF(5 * s, 0))
            path.cubicTo(QPointF(8 * s, -4 * s), QPointF(10 * s, 2 * s), QPointF(12 * s, -1 * s))
            p.drawPath(path)
        elif kind == "speed":
            p.setPen(_pen(QColor(120, 120, 150, 170), 2.5 * s))
            p.drawLine(QPointF(-20 * s, 0), QPointF(20 * s, 0))
        p.restore()

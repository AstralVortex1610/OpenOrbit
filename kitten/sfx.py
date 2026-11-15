"""Tiny quiet sound-effect mixer on sounddevice (already used for the ears). Never speech.

The output stream opens only while something is playing and closes after ~2 s of silence,
so the kitten never keeps an audio stream (and the PC) awake."""
import os
import random
import threading
import time
import wave

from .ears import resource

SR = 22050


class Sfx:
    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.voices = []  # [array, pos, gain, loop_name or None]
        self.loops = set()
        self.sounds = {}
        self.stream = None
        self.last_sound = 0.0
        self.ok = True
        self.last_step = 0.0
        try:
            import numpy as np  # noqa
            self.np = np
        except Exception:
            self.ok = False
        d = resource("assets", "sfx")
        if self.ok and os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.endswith(".wav"):
                    try:
                        with wave.open(os.path.join(d, fn), "rb") as w:
                            data = w.readframes(w.getnframes())
                        a = self.np.frombuffer(data, dtype="<i2").astype(self.np.float32) / 32768.0
                        self.sounds[fn[:-4]] = a
                    except Exception:
                        pass

    @property
    def volume(self):
        if self.cfg.get("sound_muted", False):
            return 0.0
        try:
            return max(0.0, min(1.0, float(self.cfg.get("sound_volume", 0.35))))
        except Exception:
            return 0.35

    def _pick(self, name):
        if name in self.sounds:
            return self.sounds[name]
        vs = [k for k in self.sounds if k.startswith(name + "_")]
        return self.sounds[random.choice(vs)] if vs else None

    def play(self, name, gain=1.0):
        if not self.ok or self.volume <= 0:
            return
        if name == "step":  # pats are subtle and never machine-gun
            now = time.time()
            if now - self.last_step < 0.07:
                return
            self.last_step = now
            gain *= 0.35
        a = self._pick(name)
        if a is None:
            return
        with self.lock:
            if len(self.voices) > 8:
                self.voices.pop(0)
            self.voices.append([a, 0, gain, None])
        self._ensure()

    def loop(self, name, on=True, gain=0.5):
        if not self.ok:
            return
        with self.lock:
            if on and name not in self.loops and name in self.sounds:
                self.loops.add(name)
                self.voices.append([self.sounds[name], 0, gain, name])
            elif not on and name in self.loops:
                self.loops.discard(name)
                self.voices = [v for v in self.voices if v[3] != name]
        if on:
            self._ensure()

    def _callback(self, out, frames, t, status):
        np = self.np
        buf = np.zeros(frames, dtype=np.float32)
        vol = self.volume
        with self.lock:
            keep = []
            for v in self.voices:
                a, pos, g, lp = v
                n = min(frames, len(a) - pos)
                buf[:n] += a[pos:pos + n] * g
                pos += n
                if lp and pos >= len(a):
                    r = frames - n
                    buf[n:n + r] += a[:r] * g
                    pos = r
                v[1] = pos
                if lp or pos < len(a):
                    keep.append(v)
            self.voices = keep
            if keep:
                self.last_sound = time.time()
        out[:, 0] = np.clip(buf * vol, -1, 1)

    def _ensure(self):
        self.last_sound = time.time()
        if self.stream is not None:
            return
        try:
            import sounddevice as sd
            self.stream = sd.OutputStream(samplerate=SR, channels=1, dtype="float32", blocksize=512,
                                          callback=self._callback)
            self.stream.start()
        except Exception:
            self.stream = None
            self.ok = False

    def tick(self):
        """Call ~1/s: closes the stream after a short silence."""
        if self.stream is not None and not self.voices and time.time() - self.last_sound > 2.0:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None

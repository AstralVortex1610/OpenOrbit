"""Offline ears: Vosk small English model with a tiny fixed vocabulary, plus a loudness meter.
Runs on its own thread and only ever emits events; the kitten answers with actions."""
import os
import sys
import json
import time
import threading
import queue

COMMANDS = {
    "summon": ["hey kitty", "kitty", "come here", "hey cat", "here kitty"],
    "break": ["i need a break", "break time", "take a break", "kitty break"],
    "shoo": ["go away", "shoo", "leave me alone", "bye kitty", "go away kitty"],
    "praise": ["good boy", "good kitty", "good job", "i love you"],
    "scold": ["bad cat", "bad kitty", "no kitty", "stop it kitty"],
    "dance": ["kitty dance", "dance kitty", "party time"],
    "flip": ["do a flip", "backflip", "kitty jump", "kitty flip"],
}
PHRASES = sorted({p for v in COMMANDS.values() for p in v})


def resource(*parts):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, *parts)


class Ears(threading.Thread):
    def __init__(self, events: queue.Queue, loud_reacts=True):
        super().__init__(daemon=True)
        self.events = events
        self.loud_reacts = loud_reacts
        self.ok = False

    def run(self):
        try:
            import numpy as np
            import sounddevice as sd
            from vosk import Model, KaldiRecognizer, SetLogLevel
            SetLogLevel(-1)
            model_dir = resource("assets", "vosk-model")
            if not os.path.isdir(model_dir):
                return
            model = Model(model_dir)
            rec = KaldiRecognizer(model, 16000, json.dumps(PHRASES + ["[unk]"]))
        except Exception:
            return
        audio = queue.Queue(maxsize=50)

        def cb(indata, frames, t, status):
            try:
                audio.put_nowait(bytes(indata))
            except queue.Full:
                pass

        baseline, last_loud = 400.0, 0.0
        while True:
            try:
                with sd.RawInputStream(samplerate=16000, blocksize=4000, dtype="int16", channels=1, callback=cb):
                    self.ok = True
                    while True:
                        data = audio.get()
                        a = np.frombuffer(data, dtype=np.int16).astype(np.float32)
                        rms = float(np.sqrt(np.mean(a * a))) if a.size else 0.0
                        baseline = baseline * 0.98 + min(rms, baseline * 3) * 0.02
                        if self.loud_reacts and rms > max(6000, baseline * 8) and time.time() - last_loud > 8:
                            last_loud = time.time()
                            self.events.put(("loud", rms))
                        if rec.AcceptWaveform(data):
                            text = json.loads(rec.Result()).get("text", "").strip()
                            if text and text != "[unk]":
                                self.events.put(("heard", self.intent(text)))
            except Exception:
                self.ok = False
                time.sleep(10)  # mic busy or unplugged: try again later

    @staticmethod
    def intent(text):
        best, blen = None, 0
        for name, phrases in COMMANDS.items():
            for p in phrases:
                if p in text and len(p) > blen:
                    best, blen = name, len(p)
        return best

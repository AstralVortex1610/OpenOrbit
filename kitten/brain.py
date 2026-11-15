"""What the kitten knows: config, what's on screen, stats, and the Orbit link."""
import json
import os
import re
import random
import datetime as dt

from . import win32

APP_DIR = win32.appdata("KittenWatcher")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
STATS_PATH = os.path.join(APP_DIR, "stats.json")
QUIT_FLAG = os.path.join(APP_DIR, "quit.flag")

DEFAULTS = {
    "passphrase": "kitty let me go",
    "doomscroll_grace_seconds": 15,
    "break_every_minutes": 45,
    "watch_after_seconds": 90,
    "watch_chance": 0.4,
    "watch_max_minutes": 6,
    "notepad_chance": 0.01,
    "size": 1.0,
    "voice": True,
    "loud_noise_reacts": True,
    "doomscroll_title_keywords": [
        "instagram", "tiktok", "reels", "#shorts", "- youtube shorts", "reddit", "facebook",
        "snapchat", "9gag", "/ x", "on x:", "twitter", "threads", "moj", "josh"
    ],
    "doomscroll_processes": ["instagram.exe", "tiktok.exe", "facebook.exe", "snapchat.exe"],
    "never_touch_processes": ["code.exe", "orbit.exe", "devenv.exe", "windowsterminal.exe"],
}

BROWSERS = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "opera_gx.exe",
            "vivaldi.exe", "arc.exe", "zen.exe", "librewolf.exe"}

WATCH_RULES = [
    # (category, process names, title regex)
    ("call", {"zoom.exe", "ms-teams.exe", "teams.exe", "discord.exe", "whatsapp.exe", "skype.exe"},
     r"(google meet|meet -|zoom meeting|microsoft teams|call|huddle)"),
    ("video", {"vlc.exe", "mpv.exe", "potplayermini64.exe", "wmplayer.exe", "video.ui.exe", "netflix.exe"},
     r"(- youtube$|- youtube -|netflix|prime video|hotstar|jiocinema|twitch|crunchyroll|vimeo|\.mp4|\.mkv)"),
    ("picture", {"photos.exe", "microsoft.photos.exe", "photoshop.exe"},
     r"(\.(png|jpe?g|gif|webp)\b|pinterest|unsplash|dribbble|behance|photos)"),
    ("reading", {"acrord32.exe", "sumatrapdf.exe", "kindle.exe"},
     r"(\.pdf|wikipedia|medium|substack|arxiv|kindle|docs|notion|wattpad)"),
]


def load_config():
    os.makedirs(APP_DIR, exist_ok=True)
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass
    return cfg


_proc_cache = {}


def process_name(pid):
    if not pid:
        return ""
    if pid in _proc_cache:
        return _proc_cache[pid]
    name = ""
    try:
        import psutil
        name = psutil.Process(pid).name().lower()
    except Exception:
        pass
    if len(_proc_cache) > 500:
        _proc_cache.clear()
    _proc_cache[pid] = name
    return name


class Seen:
    """A snapshot of the window in front."""

    def __init__(self, hwnd, title, proc, rect, my_pid):
        self.hwnd, self.title, self.proc, self.rect = hwnd, title, proc, rect
        self.mine = win32.pid_of(hwnd) == my_pid if hwnd else False

    @property
    def is_browser(self):
        return self.proc in BROWSERS


def look(my_pid):
    h = win32.foreground()
    t = win32.title(h)
    p = process_name(win32.pid_of(h))
    if p == "applicationframehost.exe":  # Store apps (Instagram, Photos...) live inside this host
        p = (t.split(" - ")[-1].strip().lower().replace(" ", "") + ".exe") if t else p
    return Seen(h, t, p, win32.rect(h), my_pid)


def is_doomscroll(seen, cfg):
    if not seen.hwnd or seen.mine or seen.proc in cfg["never_touch_processes"]:
        return False
    if seen.proc in cfg["doomscroll_processes"]:
        return True
    t = seen.title.lower()
    return any(k in t for k in cfg["doomscroll_title_keywords"])


def watch_category(seen):
    if not seen.hwnd or seen.mine:
        return None
    t = seen.title.lower()
    for cat, procs, rx in WATCH_RULES:
        if seen.proc in procs:
            return cat
        if re.search(rx, t) and (seen.is_browser or cat in ("call", "picture", "reading")):
            return cat
    return None


# ---------------- stats ----------------
class Stats:
    def __init__(self):
        self.data = {}
        try:
            with open(STATS_PATH, "r", encoding="utf-8") as f:
                self.data = json.load(f)
        except Exception:
            pass

    def today(self):
        d = dt.date.today().isoformat()
        day = self.data.setdefault(d, {"catches": 0, "caught": {}, "breaks": 0, "stunts": [],
                                       "watched": [], "voice": 0})
        # keep two weeks
        for k in sorted(self.data)[:-14]:
            self.data.pop(k, None)
        return day

    def catch(self, what):
        day = self.today()
        day["catches"] += 1
        day["caught"][what] = day["caught"].get(what, 0) + 1
        self.save()

    def stunt(self, name, is_break):
        day = self.today()
        if is_break:
            day["breaks"] += 1
        day["stunts"].append(name)
        day["stunts"] = day["stunts"][-30:]
        self.save()

    def watched(self, cat, title):
        day = self.today()
        day["watched"].append(f"{cat}: {title[:70]}")
        day["watched"] = day["watched"][-15:]
        self.save()

    def save(self):
        try:
            with open(STATS_PATH, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=1)
        except Exception:
            pass
        orbit.write_memory(self.data)


# ---------------- Orbit link (personalisation only) ----------------
class OrbitLink:
    """Reads Orbit's name + memory headings; writes one memory file Orbit can read.
    Never touches Orbit's settings, keys or other files."""

    def __init__(self):
        self.dir = None
        for name in ("Orbit", "orbit"):
            d = win32.appdata(name)
            if os.path.isdir(os.path.join(d, "memory")):
                self.dir = d
                break

    @property
    def connected(self):
        return self.dir is not None

    def user_name(self, fallback="Affan"):
        if not self.dir:
            return fallback
        try:
            with open(os.path.join(self.dir, "settings.json"), "r", encoding="utf-8") as f:
                n = (json.load(f).get("userName") or "").strip()
                return n.split()[0] if n else fallback
        except Exception:
            return fallback

    def interests(self):
        """Short topic names from Orbit's memory headings, for the kitten's rare notes."""
        if not self.dir:
            return []
        out = []
        mem = os.path.join(self.dir, "memory")
        for root, _, files in os.walk(mem):
            for fn in files:
                if not fn.endswith(".md") or fn.startswith("kitten-"):
                    continue
                try:
                    with open(os.path.join(root, fn), "r", encoding="utf-8") as f:
                        for line in f.read(4000).splitlines():
                            m = re.match(r"^#{1,2}\s+(.{3,40})$", line.strip())
                            if m and not re.search(r"memory|notes|about|profile|todo", m.group(1), re.I):
                                out.append(m.group(1).strip())
                except Exception:
                    pass
        return out[:30]

    def write_memory(self, data):
        if not self.dir:
            return
        lines = ["# Kitten companion (written by Kitten Watcher)",
                 "What Affan's desktop kitten saw. Use it to personalise, never to nag.", ""]
        for d in sorted(data)[-7:]:
            day = data[d]
            caught = ", ".join(f"{k} x{v}" for k, v in day.get("caught", {}).items()) or "none"
            lines.append(f"## {d}")
            lines.append(f"- Doomscroll catches: {day.get('catches', 0)} ({caught})")
            lines.append(f"- Breaks taken with the kitten: {day.get('breaks', 0)}")
            if day.get("watched"):
                lines.append("- Watched together: " + "; ".join(day["watched"][-5:]))
            lines.append("")
        try:
            with open(os.path.join(self.dir, "memory", "kitten-companion.md"), "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
        except Exception:
            pass


orbit = OrbitLink()


def notepad_note(name, catches_today):
    topics = orbit.interests()
    t = random.choice(topics) if topics else None
    notes = [
        f"dear {name},\nthat was scroll number {catches_today} today.\ni ate it. you're welcome.\n- kitty",
        f"{name}.\ni have paws and even i could build something in the time you spent scrolling.\n- kitty",
        f"note to self (the human):\ndrink water. stretch. stop feeding the algorithm.\nfeed me instead.\n- kitty",
        f"hi {name}\ni closed it because i love you.\nalso because i was bored.\n- kitty",
        f"rating your scroll session: 2/10\nnot enough cats.\n- kitty",
    ]
    if t:
        notes += [
            f"{name}, remember {t}?\nyeah. that. go do that.\ni'll watch.\n- kitty",
            f"psst {name}...\n{t} > reels\nthat's just math.\n- kitty",
        ]
    return random.choice(notes)

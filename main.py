"""Kitten Watcher entry point.

KittenWatcher.exe              -> the kitten (also installs itself, autostarts, spawns its watchdog)
KittenWatcher.exe --watchdog N -> tiny guardian that relaunches the kitten if pid N dies
"""
import os
import sys
import time
import shutil
import subprocess

FROZEN = getattr(sys, "frozen", False)
EXE = sys.executable if FROZEN else os.path.abspath(__file__)
DETACHED = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW


def appdir():
    return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~/.config"), "KittenWatcher")


def quit_flag():
    return os.path.join(appdir(), "quit.flag")


def launch(*args):
    cmd = [EXE, *args] if FROZEN else [sys.executable, EXE, *args]
    kw = {"creationflags": DETACHED} if sys.platform == "win32" else {}
    return subprocess.Popen(cmd, close_fds=True, **kw)


def alive(pid):
    try:
        import psutil
        return psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except Exception:
        return False


def watchdog(parent):
    """Stays tiny: no Qt import. Relaunches the kitten when it is killed."""
    while True:
        time.sleep(2)
        if os.path.exists(quit_flag()):
            return
        if not alive(parent):
            time.sleep(1)
            if os.path.exists(quit_flag()):
                return
            launch()
            return  # the new kitten spawns a fresh watchdog


def install():
    """Copy to %LOCALAPPDATA%\\KittenWatcher and start with Windows from there."""
    global EXE
    if not FROZEN or sys.platform != "win32":
        return
    from kitten import win32
    home = os.path.join(os.environ.get("LOCALAPPDATA", appdir()), "KittenWatcher")
    target = os.path.join(home, "KittenWatcher.exe")
    try:
        if os.path.normcase(EXE) != os.path.normcase(target):
            os.makedirs(home, exist_ok=True)
            if not os.path.exists(target) or os.path.getmtime(EXE) > os.path.getmtime(target) + 1:
                shutil.copy2(EXE, target)
        win32.set_autostart(target)
    except Exception:
        win32.set_autostart(EXE)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--watchdog":
        watchdog(int(sys.argv[2]))
        return

    os.environ["QT_ENABLE_HIGHDPI_SCALING"] = "0"  # work in physical pixels, same as Win32
    from kitten import win32
    win32.set_dpi_aware()
    if not win32.single_instance("Local\\KittenWatcherSingleton"):
        return
    os.makedirs(appdir(), exist_ok=True)
    try:
        os.remove(quit_flag())
    except OSError:
        pass
    install()

    from PySide6.QtWidgets import QApplication
    from PySide6.QtCore import QTimer
    from kitten import brain
    from kitten.pet import Pet
    from kitten.ears import Ears

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    cfg = brain.load_config()
    pet = Pet(cfg)
    if cfg.get("voice", True):
        Ears(pet.events, cfg.get("loud_noise_reacts", True)).start()

    guard = {"proc": None}

    def keep_guard():
        if os.path.exists(quit_flag()):
            return
        p = guard["proc"]
        if p is None or p.poll() is not None:
            guard["proc"] = launch("--watchdog", str(os.getpid()))

    keep_guard()
    t = QTimer()
    t.timeout.connect(keep_guard)
    t.start(4000)

    # hello on first launch of the session
    QTimer.singleShot(2500, lambda: pet.start("hello", pet.s_summon()))
    app.exec()


if __name__ == "__main__":
    main()

"""Thin Win32 layer via ctypes. Every function degrades to a harmless no-op off Windows,
so the animation code can be smoke-tested on Linux."""
import os
import sys
import time
import ctypes

IS_WIN = sys.platform == "win32"

if IS_WIN:
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi")

    HWND = wintypes.HWND
    user32.GetForegroundWindow.restype = HWND
    user32.GetWindowTextLengthW.argtypes = [HWND]
    user32.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.PostMessageW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SetForegroundWindow.argtypes = [HWND]
    user32.BringWindowToTop.argtypes = [HWND]
    user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
    user32.IsZoomed.argtypes = [HWND]
    user32.IsIconic.argtypes = [HWND]
    user32.IsWindowVisible.argtypes = [HWND]
    user32.IsWindow.argtypes = [HWND]
    user32.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.SetWindowPos.argtypes = [HWND, HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = ctypes.c_short
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = HWND
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM), wintypes.LPARAM]
    dwmapi.DwmGetWindowAttribute.argtypes = [HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

    # ---- SendInput structures
    ULONG_PTR = ctypes.c_size_t

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class _INPUTunion(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTunion)]

    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_CONTROL, VK_SHIFT, VK_MENU, VK_RETURN = 0x11, 0x10, 0x12, 0x0D
WM_CLOSE = 0x0010
SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE = 0x0001, 0x0004, 0x0010


def system_scale():
    if not IS_WIN:
        return 1.0
    try:
        return user32.GetDpiForSystem() / 96.0
    except Exception:
        return 1.0


def set_dpi_aware():
    if IS_WIN:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                user32.SetProcessDPIAware()
            except Exception:
                pass


def foreground():
    return user32.GetForegroundWindow() if IS_WIN else None


def title(hwnd):
    if not IS_WIN or not hwnd:
        return ""
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def class_name(hwnd):
    if not IS_WIN or not hwnd:
        return ""
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def pid_of(hwnd):
    if not IS_WIN or not hwnd:
        return 0
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def rect(hwnd):
    """Visible frame (x, y, w, h) in physical pixels, without the invisible resize border."""
    if not IS_WIN or not hwnd:
        return None
    r = wintypes.RECT()
    ok = dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) == 0  # DWMWA_EXTENDED_FRAME_BOUNDS
    if not ok and not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def raw_rect(hwnd):
    if not IS_WIN or not hwnd:
        return None
    r = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def is_maximized(hwnd):
    return bool(IS_WIN and hwnd and user32.IsZoomed(hwnd))


def is_minimized(hwnd):
    return bool(IS_WIN and hwnd and user32.IsIconic(hwnd))


def is_window(hwnd):
    return bool(IS_WIN and hwnd and user32.IsWindow(hwnd))


def idle_seconds():
    if not IS_WIN:
        return 0.0
    li = LASTINPUTINFO()
    li.cbSize = ctypes.sizeof(li)
    user32.GetLastInputInfo(ctypes.byref(li))
    return max(0, (kernel32.GetTickCount() - li.dwTime)) / 1000.0


def close_window(hwnd):
    if IS_WIN and hwnd:
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)


def move_window_by(hwnd, dx, dy):
    if not IS_WIN or not hwnd or is_maximized(hwnd):
        return
    r = raw_rect(hwnd)
    if r:
        user32.SetWindowPos(hwnd, None, r[0] + int(dx), r[1] + int(dy), 0, 0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)


def _key(vk, up=False):
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP if up else 0, 0, 0)
    return i


def _send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def force_foreground(hwnd):
    if not IS_WIN or not hwnd:
        return False
    if user32.GetForegroundWindow() == hwnd:
        return True
    # A tap of Alt lifts the foreground lock Windows puts on background processes.
    _send(_key(VK_MENU), _key(VK_MENU, True))
    fg = user32.GetForegroundWindow()
    t_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    t_me = kernel32.GetCurrentThreadId()
    if t_fg and t_fg != t_me:
        user32.AttachThreadInput(t_me, t_fg, True)
    if is_minimized(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    if t_fg and t_fg != t_me:
        user32.AttachThreadInput(t_me, t_fg, False)
    time.sleep(0.05)
    return user32.GetForegroundWindow() == hwnd


def ctrl_w(hwnd):
    """Close the active browser tab, only if that browser window really is in front."""
    if not IS_WIN or not force_foreground(hwnd):
        return False
    _send(_key(VK_CONTROL), _key(0x57), _key(0x57, True), _key(VK_CONTROL, True))
    return True


def type_text(text, delay=0.045):
    if not IS_WIN:
        return
    for ch in text:
        if ch == "\n":
            _send(_key(VK_RETURN), _key(VK_RETURN, True))
        else:
            down = INPUT(type=1)
            down.u.ki = KEYBDINPUT(0, ord(ch), KEYEVENTF_UNICODE, 0, 0)
            up = INPUT(type=1)
            up.u.ki = KEYBDINPUT(0, ord(ch), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
            _send(down, up)
        time.sleep(delay)


def keys_down(*vks):
    if not IS_WIN:
        return False
    return all(user32.GetAsyncKeyState(v) & 0x8000 for v in vks)


def find_window_of_pid(pid, timeout=6.0):
    """First visible top-level window belonging to pid (used for Notepad)."""
    if not IS_WIN:
        return None
    end = time.time() + timeout
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM)
    def cb(h, _):
        if user32.IsWindowVisible(h) and pid_of(h) == pid and title(h):
            found.append(h)
            return False
        return True

    while time.time() < end:
        found.clear()
        user32.EnumWindows(cb, 0)
        if found:
            return found[0]
        time.sleep(0.2)
    return None


def newest_notepad(timeout=6.0):
    """Win11 Notepad is a Store app whose window may not belong to the pid we launched."""
    if not IS_WIN:
        return None
    end = time.time() + timeout
    while time.time() < end:
        h = user32.FindWindowW("Notepad", None)
        if h:
            return h
        time.sleep(0.2)
    return None


# ---- single instance
_mutex = None


def single_instance(name):
    global _mutex
    if not IS_WIN:
        return True
    _mutex = kernel32.CreateMutexW(None, False, name)
    return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS


def set_autostart(exe_path, name="KittenWatcher"):
    if not IS_WIN:
        return
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                           winreg.KEY_SET_VALUE)
        winreg.SetValueEx(k, name, 0, winreg.REG_SZ, f'"{exe_path}"')
        winreg.CloseKey(k)
    except Exception:
        pass


def remove_autostart(name="KittenWatcher"):
    if not IS_WIN:
        return
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                           winreg.KEY_SET_VALUE)
        winreg.DeleteValue(k, name)
        winreg.CloseKey(k)
    except Exception:
        pass


def appdata(*parts):
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    return os.path.join(base, *parts)

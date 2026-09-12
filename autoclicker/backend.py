"""How a click actually reaches the operating system.

On Windows the clicks go out through SendInput -- the same path a real mouse
driver uses -- which is what lets games and other applications see them. No
third-party package is involved there. Everything else falls back to pynput.
"""

from __future__ import annotations

import ctypes
import sys
import threading
import time
from typing import Callable

BUTTONS = ("Left", "Right", "Middle")

# Function keys plus the panic key, watched globally for hotkeys.
HOTKEYS = tuple(f"F{n}" for n in range(1, 13))
PANIC_KEY = "ESC"


class InputBlocked(RuntimeError):
    """Windows refused to inject the click (usually a privilege mismatch)."""


def precise_sleep(seconds: float) -> None:
    """Sleep accurately enough for millisecond button holds."""
    if seconds <= 0:
        return
    end = time.perf_counter() + seconds
    if seconds > 0.003:
        time.sleep(seconds - 0.002)
    while time.perf_counter() < end:
        pass


def high_resolution_timer(enable: bool) -> None:
    """Ask Windows for 1 ms timer granularity; elsewhere sleep is already fine."""
    if sys.platform != "win32":
        return
    try:
        winmm = ctypes.WinDLL("winmm")
        (winmm.timeBeginPeriod if enable else winmm.timeEndPeriod)(1)
    except OSError:
        pass


# --------------------------------------------------------------------- Windows

if sys.platform == "win32":
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32", use_last_error=True)

    INPUT_MOUSE = 0
    MOUSEEVENTF = {
        "Left": (0x0002, 0x0004),
        "Right": (0x0008, 0x0010),
        "Middle": (0x0020, 0x0040),
    }
    ERROR_ACCESS_DENIED = 5

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", wintypes.WPARAM),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", wintypes.WPARAM),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]

    _user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
    _user32.SendInput.restype = wintypes.UINT
    _user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
    _user32.GetCursorPos.restype = wintypes.BOOL
    _user32.SetCursorPos.argtypes = (ctypes.c_int, ctypes.c_int)
    _user32.SetCursorPos.restype = wintypes.BOOL
    _user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)
    _user32.GetAsyncKeyState.restype = wintypes.SHORT

    def _mouse_event(flag: int) -> INPUT:
        event = INPUT(type=INPUT_MOUSE)
        event.mi = MOUSEINPUT(0, 0, 0, flag, 0, 0)
        return event

    class WindowsBackend:
        """Injects clicks with SendInput, the way a physical mouse would."""

        name = "Windows SendInput"

        def _send(self, events: list[INPUT]) -> None:
            array = (INPUT * len(events))(*events)
            sent = _user32.SendInput(len(events), array, ctypes.sizeof(INPUT))
            if sent != len(events):
                code = ctypes.get_last_error()
                if code == ERROR_ACCESS_DENIED:
                    raise InputBlocked(
                        "Windows blocked the click. The game is probably running "
                        "as administrator — start Auto Clicker with "
                        "run-as-admin.bat and try again."
                    )
                raise InputBlocked(f"Windows rejected the click (error {code}).")

        def click(self, button: str, hold: float = 0.0) -> None:
            down, up = MOUSEEVENTF[button]
            if hold > 0:
                # A press the game can actually sample between two frames.
                self._send([_mouse_event(down)])
                precise_sleep(hold)
                self._send([_mouse_event(up)])
            else:
                self._send([_mouse_event(down), _mouse_event(up)])

        def position(self) -> tuple[int, int]:
            point = wintypes.POINT()
            _user32.GetCursorPos(ctypes.byref(point))
            return point.x, point.y

        def move(self, x: int, y: int) -> None:
            _user32.SetCursorPos(int(x), int(y))

    class WindowsHotkeys:
        """Polls key state globally, so it works over a fullscreen game."""

        VK = {PANIC_KEY: 0x1B, **{f"F{n}": 0x6F + n for n in range(1, 13)}}

        def __init__(self, on_key: Callable[[str], None]) -> None:
            self._on_key = on_key
            self._thread: threading.Thread | None = None
            self._running = False

        def start(self) -> None:
            self._running = True
            self._thread = threading.Thread(target=self._poll, daemon=True)
            self._thread.start()

        def _poll(self) -> None:
            was_down = {name: False for name in self.VK}
            while self._running:
                for name, vk in self.VK.items():
                    down = bool(_user32.GetAsyncKeyState(vk) & 0x8000)
                    if down and not was_down[name]:
                        try:
                            self._on_key(name)
                        except Exception:
                            pass
                    was_down[name] = down
                time.sleep(0.015)

        def stop(self) -> None:
            self._running = False


# ---------------------------------------------------------------------- pynput


class PynputBackend:
    """Fallback for macOS and Linux."""

    name = "pynput"

    def __init__(self) -> None:
        from pynput import mouse

        self._mouse_mod = mouse
        self._controller = mouse.Controller()
        self._buttons = {
            "Left": mouse.Button.left,
            "Right": mouse.Button.right,
            "Middle": mouse.Button.middle,
        }

    def click(self, button: str, hold: float = 0.0) -> None:
        target = self._buttons[button]
        if hold > 0:
            self._controller.press(target)
            precise_sleep(hold)
            self._controller.release(target)
        else:
            self._controller.click(target)

    def position(self) -> tuple[int, int]:
        x, y = self._controller.position
        return int(x), int(y)

    def move(self, x: int, y: int) -> None:
        self._controller.position = (int(x), int(y))


class PynputHotkeys:
    def __init__(self, on_key: Callable[[str], None]) -> None:
        from pynput import keyboard

        self._keyboard = keyboard
        self._on_key = on_key
        self._listener = None

    def start(self) -> None:
        def on_press(key):
            name = getattr(key, "name", "")
            if name:
                self._on_key(name.upper())

        self._listener = self._keyboard.Listener(on_press=on_press)
        self._listener.daemon = True
        self._listener.start()

    def stop(self) -> None:
        if self._listener is not None:
            self._listener.stop()


# ---------------------------------------------------------------------- choose


def create() -> tuple[object, type]:
    """Return (input backend, hotkey watcher class) for this machine."""
    if sys.platform == "win32":
        return WindowsBackend(), WindowsHotkeys
    try:
        return PynputBackend(), PynputHotkeys
    except ImportError as exc:  # pragma: no cover - startup guard
        raise SystemExit(
            "On macOS and Linux, Auto Clicker needs the 'pynput' package:\n"
            "    pip install pynput\n"
            f"({exc})"
        )

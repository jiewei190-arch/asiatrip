"""Auto Clicker - a configurable desktop auto-clicker.

Clicks the real system mouse at whatever rate you set, in games and any other
application. Speed can be given either as an interval (h / m / s / ms) or
directly in clicks per second; the two stay in sync as you type.

Run it with run.bat on Windows, or `python autoclicker.py` anywhere.
"""

from __future__ import annotations

import ctypes
import json
import queue
import random
import sys
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import ttk

import backend

SETTINGS_PATH = Path.home() / ".autoclicker.json"

# Below this the OS input queue, not Python, becomes the bottleneck, and the
# machine gets hard to reclaim with the mouse. The hotkey still stops it.
MIN_INTERVAL = 0.0005  # 2000 clicks/second
FAST_WARNING_CPS = 200.0
INTERVAL_DIGITS = 10


@dataclass
class ClickConfig:
    interval: float
    button: str
    clicks_per_event: int
    hold: float             # seconds to keep the button down per click
    jitter: float           # 0.0 - 0.9, fraction the interval may vary by
    repeat_limit: int | None  # None = until stopped
    fixed_position: tuple[int, int] | None


class ClickEngine:
    """Runs the click loop on a worker thread with drift-free pacing."""

    def __init__(self, input_backend, on_finished) -> None:
        self._backend = input_backend
        self._on_finished = on_finished
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._clicks = 0
        self._started_at = 0.0
        self._ended_at = 0.0
        self._error: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def error(self) -> str | None:
        with self._lock:
            return self._error

    def stats(self) -> tuple[int, float, float]:
        with self._lock:
            clicks, started, ended = self._clicks, self._started_at, self._ended_at
        if not started:
            return 0, 0.0, 0.0
        elapsed = (ended or time.perf_counter()) - started
        return clicks, elapsed, (clicks / elapsed if elapsed > 0 else 0.0)

    def start(self, config: ClickConfig) -> None:
        if self.running:
            return
        self._stop.clear()
        with self._lock:
            self._clicks = 0
            self._ended_at = 0.0
            self._error = None
            self._started_at = time.perf_counter()
        self._thread = threading.Thread(target=self._run, args=(config,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self, config: ClickConfig) -> None:
        backend.high_resolution_timer(True)
        try:
            self._loop(config)
        except Exception as exc:  # a blocked injection must not kill the app
            with self._lock:
                self._error = str(exc)
        finally:
            with self._lock:
                self._ended_at = time.perf_counter()
            backend.high_resolution_timer(False)
            self._on_finished()

    def _loop(self, config: ClickConfig) -> None:
        due = time.perf_counter()
        done = 0
        while not self._stop.is_set():
            if config.fixed_position is not None:
                self._backend.move(*config.fixed_position)
            for _ in range(config.clicks_per_event):
                self._backend.click(config.button, config.hold)

            done += 1
            with self._lock:
                self._clicks = done
            if config.repeat_limit is not None and done >= config.repeat_limit:
                return

            gap = config.interval
            if config.jitter:
                gap *= random.uniform(1.0 - config.jitter, 1.0 + config.jitter)
            due += max(gap, 0.0)

            now = time.perf_counter()
            if due < now:
                # A slow click (or a busy machine) put us behind; don't try to
                # win the time back in a burst.
                due = now
            if not self._sleep_until(due):
                return

    def _sleep_until(self, target: float) -> bool:
        """Wait until `target`. Returns False if asked to stop first."""
        while True:
            remaining = target - time.perf_counter()
            if remaining <= 0:
                return not self._stop.is_set()
            if remaining > 0.003:
                # Interruptible, so Stop is felt immediately even on long gaps.
                if self._stop.wait(remaining - 0.002):
                    return False
            else:
                if self._stop.is_set():
                    return False
                time.sleep(0)  # spin out the last couple of milliseconds


def fmt_number(value: float, digits: int = 6) -> str:
    """Trim a float for display without losing small values like 0.000268."""
    text = f"{value:.{digits}g}"
    if "e" in text or "E" in text:
        return text
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


class AutoClickerApp:
    def __init__(self, root: tk.Tk, input_backend=None, hotkeys_class=None) -> None:
        self.root = root
        if input_backend is None or hotkeys_class is None:
            input_backend, hotkeys_class = backend.create()
        self.backend = input_backend
        self._hotkeys_class = hotkeys_class

        # Tk is not thread-safe: the click thread and the hotkey watcher signal
        # the UI through these instead of touching widgets themselves.
        self._engine_done = threading.Event()
        self._requests: queue.Queue[str] = queue.Queue()
        self.engine = ClickEngine(self.backend, on_finished=self._engine_done.set)
        self.hotkeys = None
        self._syncing = False
        self._picking = False
        self._closing = False
        self._tick_id: str | None = None

        root.title("Auto Clicker")
        root.resizable(False, False)

        self.hours = tk.StringVar(value="0")
        self.minutes = tk.StringVar(value="0")
        self.seconds = tk.StringVar(value="0")
        self.millis = tk.StringVar(value="100")
        self.cps = tk.StringVar(value="10")
        self.button_name = tk.StringVar(value="Left")
        self.click_type = tk.StringVar(value="Single")
        self.hold_ms = tk.StringVar(value="0")
        self.jitter_pct = tk.StringVar(value="0")
        self.repeat_mode = tk.StringVar(value="forever")
        self.repeat_count = tk.StringVar(value="100")
        self.position_mode = tk.StringVar(value="current")
        self.pos_x = tk.StringVar(value="0")
        self.pos_y = tk.StringVar(value="0")
        self.hotkey = tk.StringVar(value="F6")
        self.status = tk.StringVar(value=f"Ready — clicks go out through {self.backend.name}")

        self._load_settings()
        # A plain copy of the hotkey, readable from the watcher thread.
        self._hotkey_name = self.hotkey.get()
        self._build_ui()
        self._wire_sync()
        self._start_hotkeys()

        root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._tick()

    # ------------------------------------------------------------------ UI

    def _build_ui(self) -> None:
        pad = {"padx": 6, "pady": 3}
        frame = ttk.Frame(self.root, padding=10)
        frame.grid(sticky="nsew")

        speed = ttk.LabelFrame(frame, text="Speed", padding=8)
        speed.grid(row=0, column=0, sticky="ew", pady=(0, 8))

        row = ttk.Frame(speed)
        row.grid(row=0, column=0, sticky="w")
        for col, (label, var) in enumerate(
            (("hours", self.hours), ("mins", self.minutes),
             ("secs", self.seconds), ("ms", self.millis))
        ):
            ttk.Entry(row, width=7, textvariable=var).grid(row=0, column=col * 2, **pad)
            ttk.Label(row, text=label).grid(row=0, column=col * 2 + 1, sticky="w")

        cps_row = ttk.Frame(speed)
        cps_row.grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Label(cps_row, text="or").grid(row=0, column=0, padx=(6, 4))
        ttk.Entry(cps_row, width=9, textvariable=self.cps).grid(row=0, column=1)
        ttk.Label(cps_row, text="clicks per second").grid(row=0, column=2, padx=4)

        presets = ttk.Frame(speed)
        presets.grid(row=2, column=0, sticky="w", pady=(6, 0))
        ttk.Label(presets, text="Presets:").grid(row=0, column=0, padx=(6, 4))
        for col, value in enumerate((1, 5, 10, 25, 50, 100), start=1):
            ttk.Button(
                presets, text=str(value), width=4,
                command=lambda v=value: self._apply_preset(v),
            ).grid(row=0, column=col, padx=2)

        options = ttk.LabelFrame(frame, text="Click", padding=8)
        options.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(options, text="Button").grid(row=0, column=0, sticky="w", **pad)
        ttk.Combobox(
            options, textvariable=self.button_name, values=list(backend.BUTTONS),
            state="readonly", width=8,
        ).grid(row=0, column=1, **pad)
        ttk.Label(options, text="Type").grid(row=0, column=2, sticky="w", **pad)
        ttk.Combobox(
            options, textvariable=self.click_type, values=["Single", "Double"],
            state="readonly", width=8,
        ).grid(row=0, column=3, **pad)

        ttk.Label(options, text="Hold").grid(row=1, column=0, sticky="w", **pad)
        ttk.Spinbox(
            options, from_=0, to=200, increment=5, width=6, textvariable=self.hold_ms,
        ).grid(row=1, column=1, sticky="w", **pad)
        ttk.Label(options, text="ms down — raise if a game misses clicks").grid(
            row=1, column=2, columnspan=2, sticky="w", **pad
        )

        ttk.Label(options, text="Randomness").grid(row=2, column=0, sticky="w", **pad)
        ttk.Spinbox(
            options, from_=0, to=90, increment=5, width=6, textvariable=self.jitter_pct,
        ).grid(row=2, column=1, sticky="w", **pad)
        ttk.Label(options, text="% variation in the gap").grid(
            row=2, column=2, columnspan=2, sticky="w", **pad
        )

        repeat = ttk.LabelFrame(frame, text="Repeat", padding=8)
        repeat.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        ttk.Radiobutton(
            repeat, text="Until I stop it", value="forever", variable=self.repeat_mode,
        ).grid(row=0, column=0, columnspan=3, sticky="w", **pad)
        ttk.Radiobutton(
            repeat, text="Stop after", value="count", variable=self.repeat_mode,
        ).grid(row=1, column=0, sticky="w", **pad)
        ttk.Entry(repeat, width=9, textvariable=self.repeat_count).grid(
            row=1, column=1, sticky="w", **pad
        )
        ttk.Label(repeat, text="clicks").grid(row=1, column=2, sticky="w", **pad)

        place = ttk.LabelFrame(frame, text="Where to click", padding=8)
        place.grid(row=3, column=0, sticky="ew", pady=(0, 8))
        ttk.Radiobutton(
            place, text="Wherever the cursor is (best for games)", value="current",
            variable=self.position_mode,
        ).grid(row=0, column=0, columnspan=4, sticky="w", **pad)
        ttk.Radiobutton(
            place, text="Fixed point", value="fixed", variable=self.position_mode,
        ).grid(row=1, column=0, sticky="w", **pad)
        ttk.Entry(place, width=6, textvariable=self.pos_x).grid(row=1, column=1, **pad)
        ttk.Entry(place, width=6, textvariable=self.pos_y).grid(row=1, column=2, **pad)
        self.pick_button = ttk.Button(
            place, text="Pick (3s)", command=self._pick_position
        )
        self.pick_button.grid(row=1, column=3, **pad)

        keys = ttk.LabelFrame(frame, text="Hotkey", padding=8)
        keys.grid(row=4, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(keys, text="Start / stop").grid(row=0, column=0, sticky="w", **pad)
        ttk.Combobox(
            keys, textvariable=self.hotkey, values=list(backend.HOTKEYS),
            state="readonly", width=6,
        ).grid(row=0, column=1, **pad)
        ttk.Label(keys, text="Works inside a game. Esc always stops.").grid(
            row=0, column=2, sticky="w", **pad
        )

        controls = ttk.Frame(frame)
        controls.grid(row=5, column=0, sticky="ew")
        self.start_button = ttk.Button(controls, text="Start", command=self.start)
        self.start_button.grid(row=0, column=0, padx=(0, 6))
        self.stop_button = ttk.Button(
            controls, text="Stop", command=self.stop, state="disabled"
        )
        self.stop_button.grid(row=0, column=1)

        ttk.Label(frame, textvariable=self.status, foreground="#444", wraplength=430,
                  justify="left").grid(row=6, column=0, sticky="w", pady=(10, 0))

    def _wire_sync(self) -> None:
        for var in (self.hours, self.minutes, self.seconds, self.millis):
            var.trace_add("write", lambda *_: self._sync_from_interval())
        self.cps.trace_add("write", lambda *_: self._sync_from_cps())
        self.hotkey.trace_add(
            "write", lambda *_: setattr(self, "_hotkey_name", self.hotkey.get())
        )

    # -------------------------------------------------------------- parsing

    @staticmethod
    def _number(var: tk.StringVar, default: float = 0.0) -> float:
        text = var.get().strip()
        if not text:
            return default
        try:
            return float(text)
        except ValueError:
            return default

    def _interval_seconds(self) -> float:
        return (
            self._number(self.hours) * 3600
            + self._number(self.minutes) * 60
            + self._number(self.seconds)
            + self._number(self.millis) / 1000
        )

    def _sync_from_interval(self) -> None:
        if self._syncing:
            return
        interval = self._interval_seconds()
        self._syncing = True
        try:
            self.cps.set(fmt_number(1 / interval) if interval > 0 else "")
        finally:
            self._syncing = False

    def _sync_from_cps(self) -> None:
        if self._syncing:
            return
        rate = self._number(self.cps)
        if rate <= 0:
            return
        self._syncing = True
        try:
            self._write_interval(1 / rate)
        finally:
            self._syncing = False

    def _write_interval(self, interval: float) -> None:
        total_ms = interval * 1000
        hours, total_ms = divmod(total_ms, 3_600_000)
        minutes, total_ms = divmod(total_ms, 60_000)
        secs, millis = divmod(total_ms, 1000)
        # The interval carries more precision than the clicks-per-second box
        # shows, so a rate like 7/s survives a round trip through these fields.
        self.hours.set(fmt_number(hours, INTERVAL_DIGITS))
        self.minutes.set(fmt_number(minutes, INTERVAL_DIGITS))
        self.seconds.set(fmt_number(secs, INTERVAL_DIGITS))
        self.millis.set(fmt_number(millis, INTERVAL_DIGITS))

    def _apply_preset(self, clicks_per_second: int) -> None:
        self.cps.set(str(clicks_per_second))

    def _build_config(self) -> ClickConfig | None:
        interval = self._interval_seconds()
        if interval <= 0:
            rate = self._number(self.cps)
            interval = 1 / rate if rate > 0 else 0.0
        if interval <= 0:
            self.status.set("Set a speed first — an interval or a clicks-per-second.")
            return None
        if interval < MIN_INTERVAL:
            interval = MIN_INTERVAL
            self._syncing = True
            try:
                self._write_interval(interval)
                self.cps.set(fmt_number(1 / interval))
            finally:
                self._syncing = False

        limit: int | None = None
        if self.repeat_mode.get() == "count":
            limit = int(self._number(self.repeat_count))
            if limit <= 0:
                self.status.set("Repeat count must be 1 or more.")
                return None

        position = None
        if self.position_mode.get() == "fixed":
            position = (int(self._number(self.pos_x)), int(self._number(self.pos_y)))

        clicks_per_event = 2 if self.click_type.get() == "Double" else 1
        hold = max(self._number(self.hold_ms), 0.0) / 1000
        # The press has to fit inside the gap, or the clicks run into each other.
        hold = min(hold, interval * 0.5 / clicks_per_event)
        jitter = min(max(self._number(self.jitter_pct) / 100, 0.0), 0.9)

        return ClickConfig(
            interval=interval,
            button=self.button_name.get(),
            clicks_per_event=clicks_per_event,
            hold=hold,
            jitter=jitter,
            repeat_limit=limit,
            fixed_position=position,
        )

    # ------------------------------------------------------------- actions

    def start(self) -> None:
        if self.engine.running or self._picking:
            return
        config = self._build_config()
        if config is None:
            return
        self.engine.start(config)
        self.start_button.state(["disabled"])
        self.stop_button.state(["!disabled"])
        rate = 1 / config.interval
        note = f"  ({self._hotkey_name} or Esc to stop)"
        self.status.set(f"Running at ~{fmt_number(round(rate, 2))} clicks/s{note}")

    def stop(self) -> None:
        self.engine.stop()

    def _restore_idle(self) -> None:
        self.start_button.state(["!disabled"])
        self.stop_button.state(["disabled"])
        clicks, elapsed, rate = self.engine.stats()
        error = self.engine.error
        if error:
            self.status.set(f"Stopped after {clicks:,} clicks — {error}")
        else:
            self.status.set(
                f"Stopped — {clicks:,} clicks in {elapsed:.1f}s "
                f"({fmt_number(round(rate, 2))}/s)"
            )

    def _tick(self) -> None:
        """The one place worker-thread news is turned into widget changes."""
        if self._closing:
            return
        while True:
            try:
                request = self._requests.get_nowait()
            except queue.Empty:
                break
            if request == "start":
                self.start()

        if self._engine_done.is_set():
            self._engine_done.clear()
            self._restore_idle()
        elif self.engine.running:
            clicks, elapsed, rate = self.engine.stats()
            self.status.set(
                f"Running — {clicks:,} clicks in {elapsed:.1f}s "
                f"({fmt_number(round(rate, 2))}/s)   "
                f"[{self._hotkey_name} or Esc to stop]"
            )
        self._tick_id = self.root.after(60, self._tick)

    def _pick_position(self) -> None:
        if self.engine.running or self._picking:
            return
        self._picking = True
        self.pick_button.state(["disabled"])
        self.position_mode.set("fixed")
        self._countdown(3)

    def _countdown(self, remaining: int) -> None:
        if remaining > 0:
            self.status.set(
                f"Move the mouse where you want it — capturing in {remaining}…"
            )
            self.root.after(1000, self._countdown, remaining - 1)
            return
        x, y = self.backend.position()
        self.pos_x.set(str(x))
        self.pos_y.set(str(y))
        self.status.set(f"Captured {x}, {y}")
        self.pick_button.state(["!disabled"])
        self._picking = False

    # ------------------------------------------------------------ hotkeys

    def _start_hotkeys(self) -> None:
        def on_key(name: str) -> None:
            # Runs on the watcher's own thread. Stopping is safe to do right
            # here (it only sets an Event), so the panic key is instant;
            # starting has to read the widgets, so the UI thread does it.
            if name == backend.PANIC_KEY:
                self.engine.stop()
            elif name == self._hotkey_name:
                if self.engine.running:
                    self.engine.stop()
                else:
                    self._requests.put("start")

        self.hotkeys = self._hotkeys_class(on_key)
        self.hotkeys.start()

    # ----------------------------------------------------------- settings

    def _settings_vars(self) -> dict[str, tk.StringVar]:
        return {
            "hours": self.hours, "minutes": self.minutes, "seconds": self.seconds,
            "millis": self.millis, "cps": self.cps, "button": self.button_name,
            "click_type": self.click_type, "hold_ms": self.hold_ms,
            "jitter": self.jitter_pct, "repeat_mode": self.repeat_mode,
            "repeat_count": self.repeat_count, "position_mode": self.position_mode,
            "pos_x": self.pos_x, "pos_y": self.pos_y, "hotkey": self.hotkey,
        }

    def _load_settings(self) -> None:
        try:
            saved = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(saved, dict):
            return
        for name, var in self._settings_vars().items():
            value = saved.get(name)
            if isinstance(value, (str, int, float)):
                var.set(str(value))

    def _save_settings(self) -> None:
        data = {name: var.get() for name, var in self._settings_vars().items()}
        try:
            SETTINGS_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _on_close(self) -> None:
        self._closing = True
        if self._tick_id is not None:
            self.root.after_cancel(self._tick_id)
        self.engine.stop()
        if self.hotkeys is not None:
            self.hotkeys.stop()
        self._save_settings()
        self.root.destroy()


def main() -> None:
    if sys.platform == "win32":
        try:  # crisp text on scaled displays
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista" if sys.platform == "win32" else "clam")
    except tk.TclError:
        pass
    AutoClickerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()

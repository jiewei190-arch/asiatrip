# Auto Clicker

A desktop auto-clicker for Windows. It drives the real mouse through the Win32
`SendInput` API — the same path a physical mouse driver uses — so games and
every other application receive the clicks normally.

Set the speed however you think about it: an interval in hours/minutes/seconds/
milliseconds, or straight in clicks per second. The two boxes stay in sync.

## Running it

Double-click **`run.bat`**.

There is nothing to install: it uses only Python's standard library, including
the built-in tkinter interface. You just need Python itself — if the launcher
says it can't find it, get it from [python.org](https://www.python.org/downloads/)
and tick **"Add python.exe to PATH"** during setup.

If your game runs as administrator, use **`run-as-admin.bat`** instead. Windows
blocks a normal program from sending input to an elevated window, and the app
will tell you so in the status line if that happens.

## If nothing happens when you run it

Open PowerShell **in this folder** (shift + right-click the folder → "Open
PowerShell window here") and type:

```
py -3 autoclicker.py
```

If that says `py` is not recognised, try `python autoclicker.py`. Any error
will be printed right there instead of vanishing.

Or just double-click **`run-debug.bat`** — it checks everything (files, Python,
tkinter), starts the app with errors visible, and waits so you can read the
output.

The two usual causes:

- **Python isn't installed**, or Windows is pointing at the Microsoft Store
  placeholder rather than a real install. Get Python from
  [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to
  PATH"** during setup.
- **Python has no tkinter** — the built-in library that draws the window.
  Microsoft Store Python is usually the one missing it; the python.org
  installer includes it.

One thing that will never work: typing the speed into a PowerShell or Command
Prompt window. Those just echo what you type. The number goes into the Auto
Clicker window itself, which appears once the app starts.

## Using it

1. Set the speed — type a clicks-per-second value, or fill in the interval
   boxes, or hit one of the presets (1, 5, 10, 25, 50, 100).
2. Pick the button (left/right/middle) and single or double click.
3. Choose whether it clicks **wherever the cursor is** (what you want in a game)
   or at a **fixed point** on screen. "Pick (3s)" captures a point: press it,
   move the mouse where you want it, and wait for the countdown.
4. Press **F6** to start, F6 again to stop. **Esc always stops it**, from any
   window, including a fullscreen game.

The hotkey is global — it works while the game has focus, so you never have to
alt-tab back to the clicker. You can remap it to any F-key.

Settings are remembered between launches in `%USERPROFILE%\.autoclicker.json`.

## The other options

**Hold (ms)** — how long the button stays down on each click. Zero means an
instant press-and-release, which is fastest and works in most games. Some games
only sample the mouse once per rendered frame and will miss a press that short;
if your clicks aren't registering, set this to around 20 ms. The app caps it
automatically so a press can never overlap the next click.

**Randomness (%)** — varies the gap between clicks by up to that percentage, so
the timing isn't metronome-perfect. 20% turns a steady 10/s into a gap wandering
between 80 ms and 120 ms. The average rate stays the same.

**Stop after N clicks** — ends the run on its own instead of going until you
stop it.

## Speed, honestly

The click loop corrects for drift rather than sleeping a fixed amount, and asks
Windows for 1 ms timer granularity while it runs, so the rate you ask for is the
rate you get. Measured here against a stubbed input layer: 1000 clicks requested
at 2000/s landed within 1 ms of the ideal time; 5/s, 20/s, 100/s and 500/s were
all within a millisecond too.

Above roughly 200 clicks/second the limit stops being this program and becomes
how fast the target application drains its input queue — the clicks are sent
regardless, but a game may not process all of them. The interval is capped at
2000 clicks/second, because past that the machine gets genuinely hard to
reclaim with the mouse. The hotkey and Esc still stop it at any speed.

## If a game isn't seeing the clicks

- **Run `run-as-admin.bat`.** This is by far the most common cause: an elevated
  game silently ignores input from a non-elevated program.
- **Raise the Hold value** to ~20 ms, as above.
- **Try borderless/windowed mode.** A few exclusive-fullscreen games take input
  on a path that doesn't accept injected clicks at all.
- **Use "wherever the cursor is"** rather than a fixed point. Games with mouse
  look fight anything that moves the cursor for them.
- **Anti-cheat.** Competitive online games actively detect synthetic input.
  Beyond not working, using an auto-clicker in one may well be against its terms
  of service and get the account banned — worth knowing before you point this at
  a multiplayer game. Single-player and idle games are where it earns its keep.

## Files

| File | What it is |
| --- | --- |
| `autoclicker.py` | The interface and the click loop |
| `backend.py` | How clicks reach the OS: `SendInput` on Windows, pynput elsewhere |
| `run.bat` | Launcher |
| `run-as-admin.bat` | Launcher, elevated, for games that run as administrator |
| `run-debug.bat` | Launcher that shows what went wrong if the app won't start |

## macOS and Linux

It runs there too, via pynput: `pip install -r requirements.txt`, then
`python3 autoclicker.py`. macOS additionally requires granting Accessibility
permission to your terminal or Python under System Settings → Privacy &
Security → Accessibility.

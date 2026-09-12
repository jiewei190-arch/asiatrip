# Auto Clicker - needs nothing installed.
#
# Windows already ships PowerShell and .NET, so this file compiles its own
# click engine on the fly and draws its own window. There is no Python and
# nothing to download.
#
# Start it with Run-AutoClicker.bat.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- the engine
# Timing, clicking and the global hotkey all live in C#. PowerShell only pushes
# settings in and reads counters out, so nothing time-critical depends on it.

$engineSource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace AutoClickerApp
{
    public class Engine
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // Only mouse events are sent, and MOUSEINPUT is the largest member of
        // the real INPUT union, so this layout has the right size on x86 and
        // x64 alike.
        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public MOUSEINPUT mi;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("winmm.dll")]
        private static extern uint timeBeginPeriod(uint uPeriod);

        [DllImport("winmm.dll")]
        private static extern uint timeEndPeriod(uint uPeriod);

        private const uint INPUT_MOUSE = 0;
        private const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
        private const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
        private const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
        private const int VK_ESCAPE = 0x1B;
        private const int ERROR_ACCESS_DENIED = 5;

        // Settings. All int or bool, because C# does not allow volatile on
        // double, and these are written by the UI thread while the click
        // thread reads them.
        public volatile int IntervalMicros = 100000;
        public volatile int HoldMicros = 0;
        public volatile int JitterPercent = 0;
        public volatile int ButtonIndex = 0;      // 0 left, 1 right, 2 middle
        public volatile int ClicksPerEvent = 1;   // 2 for a double click
        public volatile int Limit = 0;            // 0 means until stopped
        public volatile int HotkeyVk = 0x75;      // F6

        // Readouts.
        public volatile int Clicks = 0;
        public volatile bool Running = false;
        public volatile string Error = null;

        private volatile bool _stop = false;
        private volatile bool _watching = false;
        private Thread _clickThread;
        private Thread _watchThread;
        private Stopwatch _runWatch;
        private readonly object _sync = new object();

        public double ElapsedSeconds
        {
            get
            {
                Stopwatch w = _runWatch;
                return (w == null) ? 0.0 : w.Elapsed.TotalSeconds;
            }
        }

        public void Start()
        {
            lock (_sync)
            {
                if (Running) return;
                _stop = false;
                Error = null;
                Clicks = 0;
                _runWatch = Stopwatch.StartNew();
                Running = true;
                _clickThread = new Thread(new ThreadStart(Loop));
                _clickThread.IsBackground = true;
                _clickThread.Start();
            }
        }

        public void Stop()
        {
            _stop = true;
        }

        public void Toggle()
        {
            if (Running) Stop(); else Start();
        }

        private void Loop()
        {
            timeBeginPeriod(1);
            try
            {
                Random rnd = new Random();
                double due = 0.0;
                int done = 0;
                while (!_stop)
                {
                    if (!DoClick()) break;
                    done++;
                    Clicks = done;

                    int limit = Limit;
                    if (limit > 0 && done >= limit) break;

                    double gap = IntervalMicros / 1000000.0;
                    int jitter = JitterPercent;
                    if (jitter > 0)
                    {
                        double spread = ((rnd.NextDouble() * 2.0) - 1.0) * (jitter / 100.0);
                        gap = gap * (1.0 + spread);
                    }
                    if (gap < 0.0) gap = 0.0;
                    due += gap;

                    double now = _runWatch.Elapsed.TotalSeconds;
                    if (due < now) due = now;   // fell behind; do not burst to catch up
                    if (!SleepUntil(due)) break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                timeEndPeriod(1);
                Running = false;
            }
        }

        private bool SleepUntil(double target)
        {
            while (true)
            {
                if (_stop) return false;
                double remaining = target - _runWatch.Elapsed.TotalSeconds;
                if (remaining <= 0.0) return true;
                if (remaining > 0.003)
                {
                    // Wake often so Stop is felt even on a long interval.
                    int ms = (int)((remaining - 0.002) * 1000.0);
                    if (ms > 50) ms = 50;
                    if (ms > 0) Thread.Sleep(ms);
                }
                else
                {
                    Thread.SpinWait(100);
                }
            }
        }

        private static void SpinMicros(int micros)
        {
            if (micros <= 0) return;
            Stopwatch sw = Stopwatch.StartNew();
            if (micros > 3000) Thread.Sleep((micros - 1000) / 1000);
            double target = micros / 1000000.0;
            while (sw.Elapsed.TotalSeconds < target) Thread.SpinWait(50);
        }

        private bool DoClick()
        {
            uint down, up;
            switch (ButtonIndex)
            {
                case 1: down = RIGHTDOWN; up = RIGHTUP; break;
                case 2: down = MIDDLEDOWN; up = MIDDLEUP; break;
                default: down = LEFTDOWN; up = LEFTUP; break;
            }

            int repeats = ClicksPerEvent;
            if (repeats < 1) repeats = 1;
            int hold = HoldMicros;

            for (int i = 0; i < repeats; i++)
            {
                if (hold > 0)
                {
                    if (!Send(down)) return false;
                    SpinMicros(hold);
                    if (!Send(up)) return false;
                }
                else
                {
                    if (!SendPair(down, up)) return false;
                }
            }
            return true;
        }

        private bool Send(uint flag)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi.dwFlags = flag;
            if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1) return true;
            RecordBlocked();
            return false;
        }

        private bool SendPair(uint downFlag, uint upFlag)
        {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi.dwFlags = downFlag;
            inputs[1].type = INPUT_MOUSE;
            inputs[1].mi.dwFlags = upFlag;
            if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2) return true;
            RecordBlocked();
            return false;
        }

        private void RecordBlocked()
        {
            int err = Marshal.GetLastWin32Error();
            if (err == ERROR_ACCESS_DENIED)
            {
                Error = "Windows blocked the click. The game is probably running as "
                      + "administrator - start this with Run-AutoClicker-AsAdmin.bat.";
            }
            else
            {
                Error = "Windows rejected the click (error " + err + ").";
            }
            _stop = true;
        }

        // ------------------------------------------------------------ hotkeys
        // Polling GetAsyncKeyState works while a fullscreen game holds focus,
        // and needs no window of its own.

        public void StartWatching()
        {
            if (_watching) return;
            _watching = true;
            _watchThread = new Thread(new ThreadStart(Watch));
            _watchThread.IsBackground = true;
            _watchThread.Start();
        }

        public void StopWatching()
        {
            _watching = false;
        }

        private void Watch()
        {
            bool hotWasDown = false;
            bool escWasDown = false;
            while (_watching)
            {
                bool hot = (GetAsyncKeyState(HotkeyVk) & 0x8000) != 0;
                if (hot && !hotWasDown) Toggle();
                hotWasDown = hot;

                bool esc = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
                if (esc && !escWasDown) Stop();
                escWasDown = esc;

                Thread.Sleep(15);
            }
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $engineSource -Language CSharp
}
catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Auto Clicker could not build its click engine.`r`n`r`n$($_.Exception.Message)",
        "Auto Clicker", 'OK', 'Error') | Out-Null
    exit 1
}

$script:engine = New-Object AutoClickerApp.Engine

# -------------------------------------------------------------------- the UI

$form = New-Object System.Windows.Forms.Form
$form.Text = "Auto Clicker"
$form.ClientSize = New-Object System.Drawing.Size(430, 340)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'

function New-Label($text, $x, $y, $w) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, 20)
    $form.Controls.Add($l)
    return $l
}

function New-Box($text, $x, $y, $w) {
    $b = New-Object System.Windows.Forms.TextBox
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 22)
    $form.Controls.Add($b)
    return $b
}

function New-Combo($items, $index, $x, $y, $w) {
    $c = New-Object System.Windows.Forms.ComboBox
    $c.DropDownStyle = 'DropDownList'
    foreach ($i in $items) { [void]$c.Items.Add($i) }
    $c.SelectedIndex = $index
    $c.Location = New-Object System.Drawing.Point($x, $y)
    $c.Size = New-Object System.Drawing.Size($w, 22)
    $form.Controls.Add($c)
    return $c
}

[void](New-Label "Clicks per second" 12 15 120)
$script:cpsBox = New-Box "10" 140 12 80

[void](New-Label "Presets" 12 45 120)
$presetX = 140
foreach ($preset in @(1, 5, 10, 25, 50, 100)) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = "$preset"
    $btn.Location = New-Object System.Drawing.Point($presetX, 42)
    $btn.Size = New-Object System.Drawing.Size(44, 24)
    $btn.Tag = $preset
    $btn.Add_Click({ $script:cpsBox.Text = "$($this.Tag)" })
    $form.Controls.Add($btn)
    $presetX += 47
}

[void](New-Label "Mouse button" 12 80 120)
$script:buttonCombo = New-Combo @('Left', 'Right', 'Middle') 0 140 77 90

[void](New-Label "Click type" 240 80 70)
$script:typeCombo = New-Combo @('Single', 'Double') 0 310 77 90

[void](New-Label "Hold (ms)" 12 112 120)
$script:holdBox = New-Box "0" 140 109 60
[void](New-Label "raise to ~20 if a game misses clicks" 210 112 210)

[void](New-Label "Randomness (%)" 12 144 120)
$script:jitterBox = New-Box "0" 140 141 60
[void](New-Label "varies the gap between clicks" 210 144 210)

$script:limitCheck = New-Object System.Windows.Forms.CheckBox
$script:limitCheck.Text = "Stop after"
$script:limitCheck.Location = New-Object System.Drawing.Point(12, 175)
$script:limitCheck.Size = New-Object System.Drawing.Size(90, 22)
$form.Controls.Add($script:limitCheck)
$script:limitBox = New-Box "100" 140 173 60
[void](New-Label "clicks" 210 176 60)

[void](New-Label "Start / stop key" 12 207 120)
$fkeys = @('F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12')
$script:hotkeyCombo = New-Combo $fkeys 5 140 204 60
[void](New-Label "works inside a game - Esc always stops" 210 207 210)

$script:startButton = New-Object System.Windows.Forms.Button
$script:startButton.Text = "Start"
$script:startButton.Location = New-Object System.Drawing.Point(12, 240)
$script:startButton.Size = New-Object System.Drawing.Size(100, 30)
$form.Controls.Add($script:startButton)

$script:stopButton = New-Object System.Windows.Forms.Button
$script:stopButton.Text = "Stop"
$script:stopButton.Location = New-Object System.Drawing.Point(120, 240)
$script:stopButton.Size = New-Object System.Drawing.Size(100, 30)
$script:stopButton.Enabled = $false
$form.Controls.Add($script:stopButton)

$script:statusLabel = New-Object System.Windows.Forms.Label
$script:statusLabel.Text = "Ready."
$script:statusLabel.Location = New-Object System.Drawing.Point(12, 280)
$script:statusLabel.Size = New-Object System.Drawing.Size(406, 46)
$form.Controls.Add($script:statusLabel)

# ------------------------------------------------------------------ plumbing

function Read-Number($box, $fallback) {
    $value = 0.0
    if ([double]::TryParse($box.Text.Trim(), [ref]$value)) { return $value }
    return $fallback
}

function Push-Settings {
    # The engine is told the current settings continuously, so the hotkey can
    # start a run from its own thread without ever reading a widget.
    $cps = Read-Number $script:cpsBox 0.0
    if ($cps -gt 0) {
        $micros = [int][math]::Round(1000000.0 / $cps)
        if ($micros -lt 500) { $micros = 500 }           # 2000 clicks/second ceiling
        if ($micros -gt 1800000000) { $micros = 1800000000 }
        $script:engine.IntervalMicros = $micros
    }

    $script:engine.ButtonIndex = $script:buttonCombo.SelectedIndex
    $script:engine.ClicksPerEvent = if ($script:typeCombo.SelectedIndex -eq 1) { 2 } else { 1 }

    $hold = [int][math]::Round((Read-Number $script:holdBox 0.0) * 1000.0)
    if ($hold -lt 0) { $hold = 0 }
    # A press must fit inside the gap or clicks run into each other.
    $ceiling = [int]($script:engine.IntervalMicros / (2 * $script:engine.ClicksPerEvent))
    if ($hold -gt $ceiling) { $hold = $ceiling }
    $script:engine.HoldMicros = $hold

    $jitter = [int][math]::Round((Read-Number $script:jitterBox 0.0))
    if ($jitter -lt 0) { $jitter = 0 }
    if ($jitter -gt 90) { $jitter = 90 }
    $script:engine.JitterPercent = $jitter

    if ($script:limitCheck.Checked) {
        $limit = [int][math]::Round((Read-Number $script:limitBox 0.0))
        if ($limit -lt 1) { $limit = 1 }
        $script:engine.Limit = $limit
    }
    else {
        $script:engine.Limit = 0
    }

    $script:engine.HotkeyVk = 0x70 + $script:hotkeyCombo.SelectedIndex
}

function Start-Clicking {
    $cps = Read-Number $script:cpsBox 0.0
    if ($cps -le 0) {
        $script:statusLabel.Text = "Type a clicks-per-second value first."
        return
    }
    Push-Settings
    $script:engine.Start()
}

$script:startButton.Add_Click({ Start-Clicking })
$script:stopButton.Add_Click({ $script:engine.Stop() })

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 100
$script:timer.Add_Tick({
    Push-Settings

    $running = $script:engine.Running
    $script:startButton.Enabled = -not $running
    $script:stopButton.Enabled = $running

    $clicks = $script:engine.Clicks
    $elapsed = $script:engine.ElapsedSeconds
    $rate = 0.0
    if ($elapsed -gt 0) { $rate = $clicks / $elapsed }
    $key = $script:hotkeyCombo.SelectedItem

    $err = $script:engine.Error
    if ($err) {
        $script:statusLabel.Text = "Stopped after $clicks clicks - $err"
    }
    elseif ($running) {
        $script:statusLabel.Text = ("Running - {0} clicks in {1:N1}s ({2:N1}/s)   [{3} or Esc to stop]" -f $clicks, $elapsed, $rate, $key)
    }
    elseif ($clicks -gt 0) {
        $script:statusLabel.Text = ("Stopped - {0} clicks in {1:N1}s ({2:N1}/s)" -f $clicks, $elapsed, $rate)
    }
    else {
        $script:statusLabel.Text = "Ready. Press $key to start, $key or Esc to stop."
    }
})
$script:timer.Start()

$form.Add_FormClosing({
    $script:engine.Stop()
    $script:engine.StopWatching()
    $script:timer.Stop()
})

$script:engine.StartWatching()
[void]$form.ShowDialog()

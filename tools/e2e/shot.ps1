param([int]$ProcessId, [string]$Out, [switch]$Quiet)
# Captures one window of the test instance with PrintWindow (only its own pixels, even cloaked or behind other windows;
# nothing on screen changes), saved at half size. -Quiet instead reports whether the test window is hidden and not the
# foreground window (the user must never notice a test).
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CxShot {
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
 public struct RECT { public int L, T, R, B; } }
"@
[CxShot]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId -ErrorAction Stop
$h = $p.MainWindowHandle
if ($Quiet) {
    $fg = 0; [CxShot]::GetWindowThreadProcessId([CxShot]::GetForegroundWindow(), [ref]$fg) | Out-Null
    $cloaked = 0; [CxShot]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) | Out-Null
    if ($fg -eq $ProcessId) { "LOUD foreground" } elseif ($cloaked -eq 0) { "LOUD visible" } else { "QUIET $((Get-Process -Id $fg -ErrorAction SilentlyContinue).ProcessName)" }
    exit 0
}
$r = New-Object CxShot+RECT; [CxShot]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
[CxShot]::PrintWindow($h, $hdc, 2) | Out-Null   # PW_RENDERFULLCONTENT: XAML's composition content too
$g.ReleaseHdc($hdc); $g.Dispose()
$small = New-Object System.Drawing.Bitmap ([int]($bmp.Width / 2)), ([int]($bmp.Height / 2))
$s = [System.Drawing.Graphics]::FromImage($small); $s.InterpolationMode = 'HighQualityBicubic'
$s.DrawImage($bmp, 0, 0, $small.Width, $small.Height); $small.Save($Out); $s.Dispose(); $small.Dispose(); $bmp.Dispose()
"saved $Out"

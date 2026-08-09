# iPhone-style phone mirror: black letterbox, dark title bar, rounded corners.
# Move: drag the dark title bar. Resize: drag any edge/corner (keeps phone aspect by default).
$scrcpyDir = "C:\Users\troyh\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1"
$adb = Join-Path $scrcpyDir "adb.exe"
$scrcpy = Join-Path $scrcpyDir "scrcpy.exe"
Get-Process -Name "scrcpy" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
& $adb start-server 2>$null
if ((& $adb devices | Out-String) -notmatch "\tdevice") { Write-Error "Phone not connected (USB debugging)."; exit 1 }
$p = Start-Process -FilePath $scrcpy -WorkingDirectory $scrcpyDir -ArgumentList @(
  "--window-title=Troy-Phone",
  "--background-color=#000000",
  "--stay-awake",
  "--max-size=1000",
  "--window-width=400",
  "--window-height=860",
  "--window-x=120",
  "--window-y=40"
) -PassThru
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 200
  $pr = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if (-not $pr) { break }
  $pr.Refresh()
  if ($pr.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $pr.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class IPhoneLookL {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr i, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
}
"@ -ErrorAction SilentlyContinue
$style = [IPhoneLookL]::GetWindowLong($hwnd, -16)
$style = $style -bor 0x00040000 -bor 0x00C00000 -bor 0x00080000 -bor 0x00020000
[void][IPhoneLookL]::SetWindowLong($hwnd, -16, $style)
[void][IPhoneLookL]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0027)
$one=1; $round=2; $black=0; $white=0x00FFFFFF
[void][IPhoneLookL]::DwmSetWindowAttribute($hwnd, 20, [ref]$one, 4)
[void][IPhoneLookL]::DwmSetWindowAttribute($hwnd, 33, [ref]$round, 4)
[void][IPhoneLookL]::DwmSetWindowAttribute($hwnd, 34, [ref]$black, 4)
[void][IPhoneLookL]::DwmSetWindowAttribute($hwnd, 35, [ref]$black, 4)
[void][IPhoneLookL]::DwmSetWindowAttribute($hwnd, 36, [ref]$white, 4)
[void][IPhoneLookL]::ShowWindow($hwnd, 5)
[void][IPhoneLookL]::SetForegroundWindow($hwnd)
Write-Host "Troy-Phone ready: move title bar, resize edges, black screen (no white bars)."

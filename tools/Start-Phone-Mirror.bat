@echo off
setlocal
set PATH=C:\Users\troyh\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1;%PATH%
echo Starting phone mirror (scrcpy)...
echo If it says unauthorized: unlock phone, tap Allow USB debugging.
cd /d "C:\Users\troyh\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1"
scrcpy.exe --stay-awake --window-title "Troy Phone (scrcpy)" --max-size 1280 --video-bit-rate 8M

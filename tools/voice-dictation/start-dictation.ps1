<#
.SYNOPSIS
    Start Helmion Voice Dictation in the background.

.DESCRIPTION
    The executable is a WinExe, so there is no console window to hide — this
    script exists so there is one obvious command to run, and so a missing build
    produces a sentence rather than a "file not found" stack.

    Running it twice is safe: the second copy sees the first through a named
    mutex, writes a line to the log and exits.
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $PSScriptRoot "Helmion.VoiceDictation\bin\$Configuration\net10.0-windows\Helmion Voice Dictation.exe"

if (-not (Test-Path $exe)) {
    Write-Host "Not built yet. Run this first:" -ForegroundColor Yellow
    Write-Host "  dotnet build `"$PSScriptRoot\Helmion.VoiceDictation\Helmion.VoiceDictation.csproj`" -c $Configuration"
    exit 1
}

$already = Get-Process -Name 'Helmion Voice Dictation' -ErrorAction SilentlyContinue
if ($already) {
    Write-Host "Already running (pid $($already.Id -join ', '))." -ForegroundColor Yellow
    exit 0
}

Start-Process -FilePath $exe | Out-Null
Start-Sleep -Milliseconds 700

$proc = Get-Process -Name 'Helmion Voice Dictation' -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "It did not stay running. The log will say why:" -ForegroundColor Red
    Write-Host "  $env:LOCALAPPDATA\Helmion\voice-dictation.log"
    exit 1
}

Write-Host "Dictation running (pid $($proc.Id))." -ForegroundColor Green
Write-Host "  Ctrl+Alt+Space  start talking; press again to send the text to whatever window has focus"
Write-Host "  Ctrl+Alt+X      throw the current recording away"
Write-Host "  Tray icon       grey idle, red recording, amber transcribing"
Write-Host "  Stop it with    $PSScriptRoot\stop-dictation.ps1"

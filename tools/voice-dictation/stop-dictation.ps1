<#
.SYNOPSIS
    Stop Helmion Voice Dictation.

.DESCRIPTION
    Signals the running instance through a named event so it unregisters its
    hotkey, releases the microphone and removes its tray icon before exiting.
    Falls back to Stop-Process only if the signal is not acknowledged — killing
    it outright can leave the tray icon on screen until the next mouse-over.
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$proc = Get-Process -Name 'Helmion Voice Dictation' -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "Not running." -ForegroundColor Yellow
    exit 0
}

$exe = Join-Path $PSScriptRoot "Helmion.VoiceDictation\bin\$Configuration\net10.0-windows\Helmion Voice Dictation.exe"
if (Test-Path $exe) {
    Start-Process -FilePath $exe -ArgumentList '--stop' | Out-Null
    Start-Sleep -Milliseconds 900
}

$still = Get-Process -Name 'Helmion Voice Dictation' -ErrorAction SilentlyContinue
if ($still) {
    Write-Host "Clean shutdown did not take; stopping the process." -ForegroundColor Yellow
    $still | Stop-Process -Force
    Start-Sleep -Milliseconds 300
}

Write-Host "Dictation stopped." -ForegroundColor Green

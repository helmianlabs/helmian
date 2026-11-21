#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Write-Host ""
Write-Host "=== Helmian Demo Desk ===" -ForegroundColor Cyan
Write-Host "Phone mirror + Desktop + Local Service + team env"
Write-Host ""

$envFile = Join-Path $env:LOCALAPPDATA "Helmion\team-connectors\local-service.team.env"
$pack = "E:\Helmion\artifacts\Helmion-Pilot-win-x64-self-contained-team-20260802"
$scrcpyDir = "C:\Users\troyh\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1"

if (-not (Test-Path $pack)) { throw "Missing pilot pack: $pack" }
if (-not (Test-Path "$scrcpyDir\scrcpy.exe")) { throw "Missing scrcpy at $scrcpyDir" }

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"'), "Process")
    }
  }
  Write-Host "[ok] Loaded team env" -ForegroundColor Green
} else {
  Write-Host "[!] No team env at $envFile" -ForegroundColor Yellow
}

$gh = [bool]$env:HELMION_GITHUB_TOKEN
$dc = [bool]$env:HELMION_DISCORD_CLIENT_ID
$sk = [bool]$env:HELMION_SLACK_CLIENT_ID
Write-Host ("  GitHub token:  " + $(if ($gh) { "READY" } else { "missing" }))
Write-Host ("  Discord app:   " + $(if ($dc) { "READY" } else { "needs Developer Portal (login required)" }))
Write-Host ("  Slack app:     " + $(if ($sk) { "READY" } else { "skipped (no Slack account)" }))

Get-Process -Name "Helmian","Helmion Local Service","scrcpy" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Start-Process -FilePath (Join-Path $pack "Helmion Local Service.exe") -WorkingDirectory $pack
Start-Sleep -Seconds 2
Start-Process -FilePath (Join-Path $pack "Helmian.exe") -WorkingDirectory $pack
Start-Process -FilePath (Join-Path $scrcpyDir "scrcpy.exe") -WorkingDirectory $scrcpyDir -ArgumentList @(
  "--stay-awake",
  "--window-title", "Troy Phone (demo)",
  "--max-size", "1080",
  "--video-bit-rate", "8M"
)

Write-Host ""
Write-Host "[ok] Started Local Service + Helmian + phone window" -ForegroundColor Green
Write-Host ""
Write-Host "Demo clicks:" -ForegroundColor Cyan
Write-Host "  1. In Helmian: Integrations / Team -> Connect GitHub"
Write-Host "  2. Phone window shows Samsung screen for video"
Write-Host "  3. Discord: after you create the app, paste secrets into:"
Write-Host "     $envFile"
Write-Host "     then re-run this script and Connect Discord"
Write-Host ""
Write-Host "Discord redirect URL to paste in Discord portal:"
Write-Host "  https://helmian.cloud/api/team-oauth/discord/callback" -ForegroundColor Yellow
Write-Host ""
pause

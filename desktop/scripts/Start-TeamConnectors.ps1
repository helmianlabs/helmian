# Start Helmian Local Service + Desktop with Team connector env from %LOCALAPPDATA%\Helmion\team-connectors\local-service.team.env
$ErrorActionPreference = "Stop"
$envFile = Join-Path $env:LOCALAPPDATA "Helmion\team-connectors\local-service.team.env"
# Prefer newest team pack; fall back to known good folders.
$pack = Get-ChildItem "E:\Helmion\artifacts" -Directory -Filter "Helmion-Pilot-win-x64-self-contained-team-*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $pack -or -not (Test-Path (Join-Path $pack "Helmian.exe"))) {
  $pack = "E:\Helmion\artifacts\Helmion-Pilot-win-x64-self-contained-team-20260802u"
}
if (-not (Test-Path $pack)) {
  $pack = "E:\Helmion\artifacts\Helmion-Pilot-win-x64-self-contained-herald-return-20260801"
}
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]; $val = $Matches[2].Trim().Trim('"')
      [Environment]::SetEnvironmentVariable($name, $val, "Process")
    }
  }
  Write-Host "Loaded team connector env from $envFile"
} else {
  Write-Host "No team env at $envFile — Connect Slack/Discord/GitHub will show setup-needed until you fill it."
}
Get-Process -Name "Helmian","Helmion Local Service" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process -FilePath (Join-Path $pack "Helmion Local Service.exe") -WorkingDirectory $pack
Start-Sleep -Seconds 2
Start-Process -FilePath (Join-Path $pack "Helmian.exe") -WorkingDirectory $pack
Write-Host "Started from $pack"

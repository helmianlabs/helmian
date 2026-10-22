# Stops and removes the optional Helmian PC Bridge service and its consent record. Run as administrator.
$ErrorActionPreference = 'Continue'
Stop-Service HelmianBridge -ErrorAction SilentlyContinue
sc.exe delete HelmianBridge | Out-Null
Remove-Item -Force (Join-Path $env:ProgramData 'Helmian\bridge-consent.json') -ErrorAction SilentlyContinue
Write-Host 'Helmian PC Bridge removed. Your Helmian app and cloud account are unchanged.'

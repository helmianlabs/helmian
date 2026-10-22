# Removes the optional Helmian PC Bridge (sign-in task and/or service) and its consent record.
# The sign-in task needs no admin rights; removing a service does.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'HelmianInstall.Common.ps1')
if (Get-ScheduledTask -TaskName $script:HelmianTaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $script:HelmianTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $script:HelmianTaskName -Confirm:$false
  Write-Host 'Removed the sign-in task.'
}
if (Get-Service -Name HelmianBridge -ErrorAction SilentlyContinue) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Service HelmianBridge -ErrorAction SilentlyContinue
    sc.exe delete HelmianBridge | Out-Null
    Write-Host 'Removed the HelmianBridge service.'
  } else { Write-Warning 'A HelmianBridge service is installed. Run this again from PowerShell opened with "Run as administrator" to remove it.' }
}
Get-Process -Name 'Helmian Bridge Service' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $env:ProgramData 'Helmian\bridge-consent.json') -ErrorAction SilentlyContinue
Write-Host 'Helmian PC Bridge removed. Your Helmian app and cloud account are unchanged. The program folder can be deleted by hand.'

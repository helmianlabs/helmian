<#
  Installs the OPTIONAL Helmian PC Bridge as a Windows service (starts on boot, no window).
  Helmian works fine without it as a cloud-only assistant. Run from an elevated PowerShell.
  Nothing is installed unless you type I AGREE after reading the disclosure.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\Helmian\Bridge",
  [string]$HelmianRoot = ""
)
$ErrorActionPreference = 'Stop'

$disclosure = @"
HELMIAN PC BRIDGE - OPTIONAL. PLEASE READ.

What it does
  - Runs in the background on this PC from boot, with no window.
  - Connects OUT to helmian.cloud (no ports are opened on this PC) and picks up
    messages you or your team send to Helmian, then answers them using AI on this PC.
  - Depending on the tool mode you choose (read-only by default), it can read files
    in your workspace folder. Any action that changes something is held for your
    approval first (Executive Guard).

What it does not do
  - It never sends your AI provider keys to the cloud. Keys stay in a vault on this PC.
  - It is not required. Helmian works as a cloud-only assistant without it.

How to turn it off
  - Run Uninstall-HelmianBridge.ps1, or stop the "HelmianBridge" service in services.msc.

Type I AGREE to install, or anything else to cancel.
"@
Write-Host $disclosure
$answer = Read-Host 'Your answer'
if ($answer -cne 'I AGREE') { Write-Host 'Cancelled. Nothing was installed.'; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Please run this from PowerShell opened with "Run as administrator".'
}

$source = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $InstallDir -Recurse -Force -Exclude 'scripts'

# The bridge reads its device token and vault from YOUR profile, so the service
# runs as you (Windows asks for your password once; it is stored by Windows, not Helmian).
$credential = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the account the bridge should run as'
$exe = Join-Path $InstallDir 'Helmian Bridge Service.exe'
if (Get-Service -Name HelmianBridge -ErrorAction SilentlyContinue) { Stop-Service HelmianBridge -ErrorAction SilentlyContinue; sc.exe delete HelmianBridge | Out-Null; Start-Sleep 2 }
New-Service -Name HelmianBridge -DisplayName 'Helmian PC Bridge (optional)' -BinaryPathName "`"$exe`"" `
  -Description 'Optional. Connects this PC to helmian.cloud so Helmian can use local AI and files. Outbound only.' `
  -StartupType Automatic -Credential $credential | Out-Null
sc.exe failure HelmianBridge reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
if ($HelmianRoot) { [Environment]::SetEnvironmentVariable('HELMIAN_ROOT', $HelmianRoot, 'Machine') }

$consentDir = Join-Path $env:ProgramData 'Helmian'
New-Item -ItemType Directory -Force -Path $consentDir | Out-Null
@{ version = 1; agreedBy = "$env:USERDOMAIN\$env:USERNAME"; agreedAt = (Get-Date).ToString('o'); disclosure = 'pc-bridge-v1' } |
  ConvertTo-Json | Set-Content -Path (Join-Path $consentDir 'bridge-consent.json') -Encoding UTF8

Start-Service HelmianBridge
Write-Host 'Installed and started. Check status with: Get-Service HelmianBridge'

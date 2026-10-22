<#
  Installs the OPTIONAL Helmian PC Bridge. Helmian works fine without it as a cloud-only assistant.
  Nothing is installed unless you type I AGREE after reading the disclosure.

  Default (-Mode Task): starts hidden when you sign in to Windows, as you. No Windows password needed,
  and no "Run as administrator" needed unless you install under Program Files.
  Optional (-Mode Service): a Windows service that starts at boot. Needs an elevated PowerShell and
  your Windows password.
#>
[CmdletBinding()]
param(
  [ValidateSet('Task', 'Service')][string]$Mode = 'Task',
  [string]$InstallDir = '',
  [string]$HelmianRoot = '',
  [switch]$Yes   # accept a suggested drive without asking (the I AGREE step is never skipped)
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HelmianInstall.Common.ps1')

$startsWhen = if ($Mode -eq 'Task') { 'when you sign in to Windows' } else { 'from boot' }
$turnOff = if ($Mode -eq 'Task') { "or turn off ""$script:HelmianTaskName"" in Task Scheduler" } else { 'or stop the "HelmianBridge" service in services.msc' }
$disclosure = @"
HELMIAN PC BRIDGE - OPTIONAL. PLEASE READ.

What it does
  - Runs in the background on this PC $startsWhen, with no window.
  - Connects OUT to helmian.cloud (no ports are opened on this PC) and picks up
    messages you or your team send to Helmian, then answers them using AI on this PC.
  - Depending on the tool mode you choose (read-only by default), it can read files
    in your workspace folder. Any action that changes something is held for your
    approval first (Executive Guard).
  - If you paired this PC's "hands" (hands-spoke), it also keeps that running in the
    background, so Helmian can ask this PC to do things. Every request still goes
    through Executive Guard. If you never paired it, nothing extra runs.

What it does not do
  - It never sends your AI provider keys to the cloud. Keys stay in a vault on this PC.
  - It never asks for or stores your Windows password (unless you pick -Mode Service).
  - It is not required. Helmian works as a cloud-only assistant without it.

How to turn it off
  - Run Uninstall-HelmianBridge.ps1, $turnOff.

Type I AGREE to install, or anything else to cancel.
"@
Write-Host $disclosure
$answer = Read-Host 'Your answer'
if ($answer -cne 'I AGREE') { Write-Host 'Cancelled. Nothing was installed.'; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Mode -eq 'Service' -and -not $isAdmin) { throw 'Service mode needs PowerShell opened with "Run as administrator". The default mode (no -Mode) does not.' }

$source = Split-Path -Parent $PSScriptRoot
$exeName = 'Helmian Bridge Service.exe'
if (-not (Test-Path -LiteralPath (Join-Path $source $exeName))) { throw "$exeName was not found next to this script ($source). Run the script from the publish folder." }

# Where to put it: the requested folder if its drive has room, else offer the drive with the most space.
$explicitDir = [bool]$InstallDir
if (-not $InstallDir) {
  $InstallDir = if ($Mode -eq 'Service') { Join-Path $env:ProgramFiles 'Helmian\Bridge' } else { Join-Path $env:LOCALAPPDATA 'Programs\Helmian\Bridge' }
}
$payload = (Get-ChildItem -LiteralPath $source -Recurse -File | Measure-Object -Property Length -Sum).Sum
$needed = [long]$payload + 200MB   # room for logs and updates
$drives = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } |
  ForEach-Object { [pscustomobject]@{ Root = $_.RootDirectory.FullName.ToUpperInvariant(); Free = $_.AvailableFreeSpace } }
$pick = Select-HelmianInstallDir -Requested $InstallDir -Drives @($drives) -NeededBytes $needed
if ($pick.Moved) {
  Write-Host $pick.Reason
  $ok = $Yes -or ((Read-Host "Install to $($pick.Path) instead? [Y/n]") -notmatch '^(n|no)$')
  if (-not $ok) { throw "Cancelled. Re-run with -InstallDir <folder on a drive with space>." }
  $InstallDir = $pick.Path
}
$underProgramFiles = $InstallDir.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or
  (${env:ProgramFiles(x86)} -and $InstallDir.StartsWith(${env:ProgramFiles(x86)}, [StringComparison]::OrdinalIgnoreCase))
if ($underProgramFiles -and -not $isAdmin) { throw "Installing under Program Files needs ""Run as administrator"". Or leave out -InstallDir to install just for you." }

# Stop anything already running from an earlier install so files can be replaced.
if (Get-ScheduledTask -TaskName $script:HelmianTaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $script:HelmianTaskName -ErrorAction SilentlyContinue
}
$svc = Get-Service -Name HelmianBridge -ErrorAction SilentlyContinue
if ($svc) {
  if ($isAdmin) { Stop-Service HelmianBridge -ErrorAction SilentlyContinue; sc.exe delete HelmianBridge | Out-Null; Start-Sleep 2 }
  elseif ($Mode -eq 'Task') { Write-Warning 'An older HelmianBridge service is installed. Only one copy runs at a time; remove it later from an elevated PowerShell with Uninstall-HelmianBridge.ps1.' }
}
Get-Process -Name 'Helmian Bridge Service' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $InstallDir -Recurse -Force -Exclude 'scripts'
$exe = Join-Path $InstallDir $exeName

if ($HelmianRoot) {
  if (-not (Test-Path -LiteralPath (Join-Path $HelmianRoot 'bin\pc-bridge.mjs'))) { Write-Warning "bin\pc-bridge.mjs was not found under $HelmianRoot. Check the folder." }
  # The exe reads this file, so it works right away in either mode (no reboot, no machine-wide variable).
  New-HelmianInstallConfigJson $HelmianRoot | Set-Content -LiteralPath (Join-Path $InstallDir 'helmian-bridge.json') -Encoding UTF8
  [Environment]::SetEnvironmentVariable('HELMIAN_ROOT', $HelmianRoot, 'User')
}

$consentDir = Join-Path $env:ProgramData 'Helmian'
New-Item -ItemType Directory -Force -Path $consentDir | Out-Null
@{ version = 1; agreedBy = "$env:USERDOMAIN\$env:USERNAME"; agreedAt = (Get-Date).ToString('o'); disclosure = 'pc-bridge-v1'; mode = $Mode.ToLowerInvariant() } |
  ConvertTo-Json | Set-Content -Path (Join-Path $consentDir 'bridge-consent.json') -Encoding UTF8

# Event Viewer logging needs an elevated install once. Without it, logs go to the file below.
if ($isAdmin) {
  try { if (-not [Diagnostics.EventLog]::SourceExists('Helmian Bridge')) { [Diagnostics.EventLog]::CreateEventSource('Helmian Bridge', 'Application') } } catch { Write-Warning "Event Viewer logging not set up: $($_.Exception.Message)" }
}
$logFile = Join-Path $env:LOCALAPPDATA 'Helmian\logs\bridge-service.log'

if ($Mode -eq 'Task') {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $spec = New-HelmianTaskSpec -InstallDir $InstallDir -UserId $user
  $action = New-ScheduledTaskAction -Execute $spec.Execute -WorkingDirectory $spec.WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $spec.UserId
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $spec.UserId -LogonType $spec.LogonType -RunLevel $spec.RunLevel
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances $spec.MultipleInstances -RestartCount $spec.RestartCount -RestartInterval $spec.RestartInterval -ExecutionTimeLimit $spec.ExecutionTimeLimit
  Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings `
    -Description 'Optional. Connects this PC to helmian.cloud so Helmian can use local AI and files. Outbound only. Starts hidden when you sign in.' -Force | Out-Null
  Start-ScheduledTask -TaskName $spec.TaskName
  Start-Sleep 3
  $running = Get-Process -Name 'Helmian Bridge Service' -ErrorAction SilentlyContinue
  Write-Host ("Installed to $InstallDir. " + $(if ($running) { 'Running now, and it will start hidden each time you sign in.' } else { 'Registered; it will start hidden when you sign in. To start it now: Start-ScheduledTask -TaskName ''Helmian PC Bridge''' }))
  Write-Host "Check it: Get-ScheduledTask -TaskName 'Helmian PC Bridge' | Get-ScheduledTaskInfo"
  Write-Host "Log: $logFile"
  exit 0
}

# -Mode Service: runs as you from boot. Windows needs your password once to do that (stored by Windows, not Helmian).
$credential = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the account the bridge should run as'

# Windows only lets an account run a service if it holds "Log on as a service".
# New-Service does not grant it (services.msc does), so grant it here for the chosen account.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class HelmianLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  public static void GrantServiceLogon(string account) {
    var sid = (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
    var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
    var attrs = new LSA_OBJECT_ATTRIBUTES(); IntPtr policy;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000800 | 0x00000010, out policy); // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
    if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    const string right = "SeServiceLogonRight";
    var s = new LSA_UNICODE_STRING { Buffer = Marshal.StringToHGlobalUni(right), Length = (ushort)(right.Length * 2), MaximumLength = (ushort)((right.Length + 1) * 2) };
    try {
      st = LsaAddAccountRights(policy, bytes, new[] { s }, 1);
      if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    } finally { Marshal.FreeHGlobal(s.Buffer); LsaClose(policy); }
  }
}
'@
[HelmianLsa]::GrantServiceLogon($credential.UserName)
# One copy at a time: the service replaces the sign-in task.
if (Get-ScheduledTask -TaskName $script:HelmianTaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $script:HelmianTaskName -Confirm:$false }
New-Service -Name HelmianBridge -DisplayName 'Helmian PC Bridge (optional)' -BinaryPathName "`"$exe`"" `
  -Description 'Optional. Connects this PC to helmian.cloud so Helmian can use local AI and files. Outbound only.' `
  -StartupType Automatic -Credential $credential | Out-Null
sc.exe failure HelmianBridge reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
if ($HelmianRoot) {
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\HelmianBridge' -Name Environment `
    -PropertyType MultiString -Value @("HELMIAN_ROOT=$HelmianRoot") -Force | Out-Null
}
Start-Service HelmianBridge
Write-Host "Installed to $InstallDir and started. Check status with: Get-Service HelmianBridge"
Write-Host "Logs: $logFile (and Event Viewer > Windows Logs > Application, source ""Helmian Bridge"")."

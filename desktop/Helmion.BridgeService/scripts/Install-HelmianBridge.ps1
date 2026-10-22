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
  - If you paired this PC's "hands" (hands-spoke), it also keeps that running in the
    background, so Helmian can ask this PC to do things. Every request still goes
    through Executive Guard. If you never paired it, nothing extra runs.

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
if (-not (Test-Path -LiteralPath $exe)) { throw "Helmian Bridge Service.exe was not found next to this script ($source). Run the script from the publish folder." }

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
if (Get-Service -Name HelmianBridge -ErrorAction SilentlyContinue) { Stop-Service HelmianBridge -ErrorAction SilentlyContinue; sc.exe delete HelmianBridge | Out-Null; Start-Sleep 2 }
New-Service -Name HelmianBridge -DisplayName 'Helmian PC Bridge (optional)' -BinaryPathName "`"$exe`"" `
  -Description 'Optional. Connects this PC to helmian.cloud so Helmian can use local AI and files. Outbound only.' `
  -StartupType Automatic -Credential $credential | Out-Null
sc.exe failure HelmianBridge reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
if ($HelmianRoot) {
  if (-not (Test-Path -LiteralPath (Join-Path $HelmianRoot 'bin\pc-bridge.mjs'))) { Write-Warning "bin\pc-bridge.mjs was not found under $HelmianRoot. Check the folder." }
  [Environment]::SetEnvironmentVariable('HELMIAN_ROOT', $HelmianRoot, 'Machine')
  # Services only see machine variables after a reboot, so also give this service its own copy now.
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\HelmianBridge' -Name Environment `
    -PropertyType MultiString -Value @("HELMIAN_ROOT=$HelmianRoot") -Force | Out-Null
}

$consentDir = Join-Path $env:ProgramData 'Helmian'
New-Item -ItemType Directory -Force -Path $consentDir | Out-Null
@{ version = 1; agreedBy = "$env:USERDOMAIN\$env:USERNAME"; agreedAt = (Get-Date).ToString('o'); disclosure = 'pc-bridge-v1' } |
  ConvertTo-Json | Set-Content -Path (Join-Path $consentDir 'bridge-consent.json') -Encoding UTF8

# The service runs as you, and a normal account cannot create an event log source, so register it here.
if (-not [Diagnostics.EventLog]::SourceExists('Helmian Bridge')) { [Diagnostics.EventLog]::CreateEventSource('Helmian Bridge', 'Application') }

Start-Service HelmianBridge
Write-Host 'Installed and started. Check status with: Get-Service HelmianBridge'
Write-Host 'Logs: Event Viewer > Windows Logs > Application, source "Helmian Bridge".'

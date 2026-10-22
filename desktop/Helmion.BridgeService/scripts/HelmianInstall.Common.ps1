# Shared, side-effect-free helpers for the Helmian PC Bridge installer. Tested on any OS by
# desktop/Helmion.BridgeService.Tests/Installer.Tests.ps1 (pwsh). Do not add I/O here.

$script:HelmianTaskName = 'Helmian PC Bridge'

function Format-HelmianSize([long]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
  return ('{0:N0} MB' -f ($Bytes / 1MB))
}

function Get-HelmianDriveRoot([string]$Path) {
  if ($Path -match '^([A-Za-z]):') { return ($Matches[1].ToUpperInvariant() + ':\') }
  return $null
}

<#
  Picks where to install. Keeps the requested folder when its drive has room; otherwise suggests the
  fixed drive with the most free space (<drive>\HelmianService). $Drives: objects with Root ('E:\') and Free (bytes).
  Returns @{ Path; Moved; Reason }. Throws only when no drive has room.
#>
function Select-HelmianInstallDir {
  param([Parameter(Mandatory)][string]$Requested, [Parameter(Mandatory)][object[]]$Drives, [Parameter(Mandatory)][long]$NeededBytes)
  $root = Get-HelmianDriveRoot $Requested
  $here = $Drives | Where-Object { $_.Root -eq $root } | Select-Object -First 1
  if ($null -eq $root -or ($here -and [long]$here.Free -ge $NeededBytes)) {
    return @{ Path = $Requested; Moved = $false; Reason = $null }
  }
  $best = $Drives | Where-Object { [long]$_.Free -ge $NeededBytes } | Sort-Object { [long]$_.Free } -Descending | Select-Object -First 1
  $have = if ($here) { Format-HelmianSize ([long]$here.Free) } else { 'no' }
  if (-not $best) {
    throw "Not enough free space. Helmian needs about $(Format-HelmianSize $NeededBytes); $root has $have free and no other drive has enough. Free up some space and run this again."
  }
  return @{
    Path   = ($best.Root.TrimEnd('\') + '\HelmianService')
    Moved  = $true
    Reason = "$root has only $have free (Helmian needs about $(Format-HelmianSize $NeededBytes)). $($best.Root) has $(Format-HelmianSize ([long]$best.Free)) free."
  }
}

<#
  What the default no-password mode registers: a task that starts the exe directly (it is a windowless
  app) when YOU sign in, runs as you with normal rights, and never asks for or stores a password.
#>
function New-HelmianTaskSpec {
  param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$UserId)
  @{
    TaskName         = $script:HelmianTaskName
    Execute          = ($InstallDir.TrimEnd('\') + '\Helmian Bridge Service.exe')
    WorkingDirectory = $InstallDir
    UserId           = $UserId
    LogonType        = 'Interactive'   # runs only while you are signed in; no stored password
    RunLevel         = 'Limited'       # normal rights, not elevated
    Hidden           = $true
    TriggerAtLogOn   = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount     = 3
    RestartInterval  = [TimeSpan]::FromMinutes(1)
    ExecutionTimeLimit = [TimeSpan]::Zero  # no time limit
  }
}

function New-HelmianInstallConfigJson([string]$HelmianRoot) {
  @{ helmianRoot = $HelmianRoot } | ConvertTo-Json -Compress
}

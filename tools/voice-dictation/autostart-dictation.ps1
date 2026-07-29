<#
.SYNOPSIS
    Turn logon auto-start for Helmion Voice Dictation on or off.

.DESCRIPTION
    AUTO-START IS OFF UNTIL YOU RUN THIS. Nothing in the build or in
    start-dictation.ps1 registers anything at logon; this script is the only
    thing that writes to the registry, and it only touches HKCU (current user,
    no admin rights, nothing machine-wide).

.EXAMPLE
    .\autostart-dictation.ps1 -Enable
    .\autostart-dictation.ps1 -Disable
    .\autostart-dictation.ps1 -Status
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Enable')]
    [switch] $Enable,

    [Parameter(ParameterSetName = 'Disable')]
    [switch] $Disable,

    [Parameter(ParameterSetName = 'Status')]
    [switch] $Status,

    [ValidateSet('Release', 'Debug')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'HelmionVoiceDictation'
$exe = Join-Path $PSScriptRoot "Helmion.VoiceDictation\bin\$Configuration\net10.0-windows\Helmion Voice Dictation.exe"

function Get-Current {
    try { (Get-ItemProperty -Path $runKey -Name $valueName -ErrorAction Stop).$valueName }
    catch { $null }
}

if ($Enable) {
    if (-not (Test-Path $exe)) {
        Write-Host "Build it first — nothing to auto-start:" -ForegroundColor Red
        Write-Host "  dotnet build `"$PSScriptRoot\Helmion.VoiceDictation\Helmion.VoiceDictation.csproj`" -c $Configuration"
        exit 1
    }

    Set-ItemProperty -Path $runKey -Name $valueName -Value "`"$exe`""
    Write-Host "Auto-start ENABLED. It will run at your next logon." -ForegroundColor Green
    Write-Host "  registry : $runKey\$valueName"
    Write-Host "  turn off : .\autostart-dictation.ps1 -Disable"
    exit 0
}

if ($Disable) {
    if ($null -eq (Get-Current)) {
        Write-Host "Auto-start was already off." -ForegroundColor Yellow
        exit 0
    }

    Remove-ItemProperty -Path $runKey -Name $valueName
    Write-Host "Auto-start DISABLED." -ForegroundColor Green
    exit 0
}

$current = Get-Current
if ($null -eq $current) {
    Write-Host "Auto-start is OFF (the default)." -ForegroundColor Yellow
    Write-Host "  turn on : .\autostart-dictation.ps1 -Enable"
} else {
    Write-Host "Auto-start is ON." -ForegroundColor Green
    Write-Host "  $current"
    Write-Host "  turn off : .\autostart-dictation.ps1 -Disable"
}

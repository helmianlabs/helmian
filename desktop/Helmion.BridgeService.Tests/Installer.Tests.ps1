# Installer checks that run on any OS with pwsh 7: parse every script, then test the pure helpers.
# Run: pwsh -NoProfile -File desktop/Helmion.BridgeService.Tests/Installer.Tests.ps1
$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot '..\Helmion.BridgeService\scripts' | Resolve-Path
$failures = 0
function Check([string]$Name, [bool]$Ok) { Write-Host ("{0} - {1}" -f $(if ($Ok) { 'ok' } else { 'FAIL' }), $Name); if (-not $Ok) { $script:failures++ } }

foreach ($f in Get-ChildItem -LiteralPath $scripts -Filter *.ps1) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  Check "parses: $($f.Name)" ($errors.Count -eq 0)
}

. (Join-Path $scripts 'HelmianInstall.Common.ps1')
$GB = 1GB; $MB = 1MB
$need = 300MB

# Troy's PC: C: full, E: has room.
$drives = @([pscustomobject]@{ Root = 'C:\'; Free = 40MB }, [pscustomobject]@{ Root = 'D:\'; Free = 2GB }, [pscustomobject]@{ Root = 'E:\'; Free = 120GB })
$p = Select-HelmianInstallDir -Requested 'C:\Users\troy\AppData\Local\Programs\Helmian\Bridge' -Drives $drives -NeededBytes $need
Check 'space: full C: moves to the drive with the most room' ($p.Moved -and $p.Path -eq 'E:\HelmianService')
Check 'space: the reason names both drives in plain words' ($p.Reason -match 'C:\\ has only 40 MB free' -and $p.Reason -match 'E:\\ has 120.0 GB free')

$p = Select-HelmianInstallDir -Requested 'E:\HelmianService' -Drives $drives -NeededBytes $need
Check 'space: a folder on a drive with room is kept' (-not $p.Moved -and $p.Path -eq 'E:\HelmianService')

$p = Select-HelmianInstallDir -Requested 'C:\Program Files\Helmian\Bridge' -Drives @([pscustomobject]@{ Root = 'C:\'; Free = 50GB }) -NeededBytes $need
Check 'space: enough room on C: changes nothing' (-not $p.Moved)

$threw = $false
try { Select-HelmianInstallDir -Requested 'C:\x' -Drives @([pscustomobject]@{ Root = 'C:\'; Free = 10MB }, [pscustomobject]@{ Root = 'D:\'; Free = 20MB }) -NeededBytes $need | Out-Null } catch { $threw = $_.Exception.Message -match 'Not enough free space' }
Check 'space: no drive with room stops with a plain message' $threw

$p = Select-HelmianInstallDir -Requested 'F:\Helmian' -Drives $drives -NeededBytes $need
Check 'space: an unknown or removed drive falls back to one with room' ($p.Moved -and $p.Path -eq 'E:\HelmianService')

# Default no-password mode
$t = New-HelmianTaskSpec -InstallDir 'E:\HelmianService' -UserId 'PC\troy'
Check 'task: starts the exe directly (no conhost, no console)' ($t.Execute -match 'Helmian Bridge Service\.exe$' -and $t.Execute -notmatch 'conhost')
Check 'task: on sign-in, hidden, as the current user' ($t.TriggerAtLogOn -and $t.Hidden -and $t.UserId -eq 'PC\troy')
Check 'task: interactive logon means no stored password' ($t.LogonType -eq 'Interactive' -and -not $t.ContainsKey('Password'))
Check 'task: normal rights, one copy, no time limit' ($t.RunLevel -eq 'Limited' -and $t.MultipleInstances -eq 'IgnoreNew' -and $t.ExecutionTimeLimit -eq [TimeSpan]::Zero)

$installer = Get-Content -Raw (Join-Path $scripts 'Install-HelmianBridge.ps1')
$defaultMode = [regex]::Match($installer, "\[string\]\`$Mode = '(\w+)'").Groups[1].Value
Check 'installer: default mode is the sign-in task' ($defaultMode -eq 'Task')
$beforeService = $installer.Substring(0, $installer.IndexOf('# -Mode Service'))
Check 'installer: no password prompt before the service branch' ($beforeService -notmatch 'Get-Credential')
Check 'installer: I AGREE still required' ($installer -match "-cne 'I AGREE'")
$uninstaller = Get-Content -Raw (Join-Path $scripts 'Uninstall-HelmianBridge.ps1')
Check 'uninstall: removes the sign-in task too' ($uninstaller -match 'Unregister-ScheduledTask')

$j = New-HelmianInstallConfigJson 'E:\Helmion' | ConvertFrom-Json
Check 'config: helmian-bridge.json carries the Helmian folder' ($j.helmianRoot -eq 'E:\Helmion')

Write-Host $(if ($failures -eq 0) { 'all installer checks passed' } else { "$failures installer check(s) failed" })
exit $failures

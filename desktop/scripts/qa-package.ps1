#Requires -Version 5.1
<#
.SYNOPSIS
  Helmian QA package: syntax check + unit tests + desktop smoke + optional publish pack.
  Writes a dated report under artifacts/qa-packages/ for Troy's pilot verification.

.EXAMPLE
  pwsh -File desktop/scripts/qa-package.ps1
  pwsh -File desktop/scripts/qa-package.ps1 -PublishPack
#>
[CmdletBinding()]
param(
  [switch]$PublishPack,
  [switch]$SkipDesktopSmoke
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $repoRoot "artifacts\qa-packages\qa-$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$report = [System.Collections.Generic.List[string]]::new()
function Log([string]$line) {
  $report.Add($line)
  Write-Host $line
}

function Invoke-Step {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  Log "--- $Name ---"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $Action
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
      throw "exit code $LASTEXITCODE"
    }
    Log "OK  $Name ($([int]$sw.Elapsed.TotalSeconds)s)"
    return $true
  }
  catch {
    Log "FAIL $Name — $($_.Exception.Message)"
    return $false
  }
}

Push-Location $repoRoot
try {
  Log "Helmian QA package  $stamp"
  Log "Repo: $repoRoot"
  Log ""

  $okCheck = Invoke-Step 'npm run check' { npm run check 2>&1 | Tee-Object -FilePath (Join-Path $outDir 'check.log') | Out-Null }
  $okTest  = Invoke-Step 'npm test' { npm test 2>&1 | Tee-Object -FilePath (Join-Path $outDir 'test.log') | Out-Null }

  $okDesktop = $true
  if (-not $SkipDesktopSmoke) {
    $okDesktop = Invoke-Step 'desktop smoke (Release)' {
      dotnet build (Join-Path $repoRoot 'desktop\Helmion.Desktop.SmokeTests\Helmion.Desktop.SmokeTests.csproj') -c Release --nologo 2>&1 |
        Tee-Object -FilePath (Join-Path $outDir 'desktop-build.log') | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "desktop smoke build failed: $LASTEXITCODE" }
      # Smoke may exit non-zero on unrelated path probes; capture full log.
      dotnet run --project (Join-Path $repoRoot 'desktop\Helmion.Desktop.SmokeTests\Helmion.Desktop.SmokeTests.csproj') -c Release --no-build 2>&1 |
        Tee-Object -FilePath (Join-Path $outDir 'desktop-smoke.log') | Out-Null
      $log = Get-Content (Join-Path $outDir 'desktop-smoke.log') -Raw
      if ($log -notmatch 'desktop smoke tests passed') {
        throw 'desktop smoke did not print pass line'
      }
    }
  }

  $okPub = $true
  if ($PublishPack) {
    $okPub = Invoke-Step 'publish pilot pack' {
      $pack = Join-Path $repoRoot "artifacts\Helmion-Pilot-win-x64-self-contained-qa-$stamp"
      $stage = Join-Path $env:TEMP "helmion-qa-pub-$stamp"
      New-Item -ItemType Directory -Force -Path $stage | Out-Null
      dotnet publish (Join-Path $repoRoot 'desktop\Helmion.Desktop\Helmion.Desktop.csproj') `
        -c Release -r win-x64 --self-contained true -o $stage --nologo `
        -p:PublishSingleFile=true -p:DebugType=None 2>&1 |
        Tee-Object -FilePath (Join-Path $outDir 'publish.log') | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "publish exit $LASTEXITCODE" }
      if (Test-Path $pack) { Remove-Item $pack -Recurse -Force }
      Copy-Item $stage $pack -Recurse
      Log "Pack: $pack"
    }
  }

  $allOk = $okCheck -and $okTest -and $okDesktop -and $okPub
  Log ""
  Log "RESULT: $(if ($allOk) { 'PASS' } else { 'FAIL' })"
  Log "Report dir: $outDir"
  $reportPath = Join-Path $outDir 'QA_REPORT.txt'
  $report | Set-Content -Path $reportPath -Encoding utf8
  if (-not $allOk) { exit 1 }
}
finally {
  Pop-Location
}

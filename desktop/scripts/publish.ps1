[CmdletBinding()]
param(
  [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$desktopProject = Join-Path $repositoryRoot 'desktop\Helmion.Desktop\Helmion.Desktop.csproj'
$serviceProject = Join-Path $repositoryRoot 'desktop\Helmion.LocalService\Helmion.LocalService.csproj'
$artifactsRoot = Join-Path $repositoryRoot 'artifacts'
$flavor = if ($FrameworkDependent) { 'framework-dependent' } else { 'self-contained' }
$outputDirectory = Join-Path $repositoryRoot "artifacts\Helmion-Pilot-win-x64-$flavor"
$stagingDirectory = Join-Path $artifactsRoot ".helmion-publish-$([guid]::NewGuid().ToString('N'))"
$selfContained = if ($FrameworkDependent) { 'false' } else { 'true' }

function Publish-HelmionProject {
  param([Parameter(Mandatory)][string]$Project)

  $arguments = @(
    'publish',
    $Project,
    '--configuration', 'Release',
    '--runtime', 'win-x64',
    "--self-contained=$selfContained",
    '--output', $stagingDirectory,
    '--nologo',
    '-p:PublishSingleFile=true',
    '-p:DebugType=None',
    '-p:DebugSymbols=false'
  )

  if (-not $FrameworkDependent) {
    $arguments += @(
      '-p:IncludeNativeLibrariesForSelfExtract=true',
      '-p:EnableCompressionInSingleFile=true'
    )
  }

  & dotnet @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed for $Project with exit code $LASTEXITCODE"
  }
}

function Invoke-PackagedSmoke {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Argument
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.Arguments = $Argument
  $smokeProcess = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $smokeProcess) {
    throw "Packaged smoke test could not start: $Executable"
  }
  $smokeProcess.WaitForExit()
  if ($smokeProcess.ExitCode -ne 0) {
    throw "Packaged smoke test failed for $Executable $Argument with exit code $($smokeProcess.ExitCode)"
  }
}

function Get-ArtifactDetails {
  param([Parameter(Mandatory)][string]$Path)

  $file = Get-Item -LiteralPath $Path
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
  return [ordered]@{
    executable = $file.FullName
    size_bytes = $file.Length
    sha256 = $hash
  }
}

New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
try {
  Publish-HelmionProject -Project $desktopProject
  Publish-HelmionProject -Project $serviceProject

  $desktopExecutable = Join-Path $stagingDirectory 'Helmion Pilot.exe'
  $serviceExecutable = Join-Path $stagingDirectory 'Helmion Local Service.exe'
  foreach ($executable in @($desktopExecutable, $serviceExecutable)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
      throw "Published executable was not found: $executable"
    }
  }

  Invoke-PackagedSmoke -Executable $desktopExecutable -Argument '--smoke-test'
  Invoke-PackagedSmoke -Executable $serviceExecutable -Argument '--smoke-test'
  Invoke-PackagedSmoke -Executable $desktopExecutable -Argument '--service-smoke-test'

  $resolvedArtifactsRoot = [System.IO.Path]::GetFullPath($artifactsRoot).TrimEnd('\') + '\'
  $resolvedOutput = [System.IO.Path]::GetFullPath($outputDirectory)
  if (-not $resolvedOutput.StartsWith($resolvedArtifactsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Package output escaped the artifacts directory: $resolvedOutput"
  }
  if (Test-Path -LiteralPath $outputDirectory) {
    Remove-Item -LiteralPath $outputDirectory -Recurse -Force
  }
  Move-Item -LiteralPath $stagingDirectory -Destination $outputDirectory

  # Voice-stack assets. Single-file bundling hides native DLLs from Whisper.net's
  # on-disk probe ("Native Library not found in default paths", seen live 2026-07-28),
  # and KokoroSharp needs voices/ + espeak/ beside the exe. Models are looked up in
  # models\ next to the executable (VoiceModelPaths). Mirror the proven dev layout.
  $releaseOutput = Join-Path $repositoryRoot 'desktop\Helmion.Desktop\bin\Release\net10.0-windows\win-x64'
  foreach ($asset in @('runtimes', 'voices', 'espeak')) {
    $source = Join-Path $releaseOutput $asset
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $outputDirectory $asset) -Recurse -Force
    } else {
      Write-Warning "Voice asset folder missing from build output: $source"
    }
  }
  foreach ($dll in @('onnxruntime.dll', 'onnxruntime_providers_shared.dll')) {
    $source = Join-Path $releaseOutput $dll
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $outputDirectory -Force
    } else {
      Write-Warning "Voice native DLL missing from build output: $source"
    }
  }
  $modelsSource = Join-Path $repositoryRoot 'desktop\models'
  if (Test-Path -LiteralPath $modelsSource) {
    Copy-Item -LiteralPath $modelsSource -Destination (Join-Path $outputDirectory 'models') -Recurse -Force
  } else {
    Write-Warning "Voice models not downloaded (desktop\models missing) - packaged app will run voice-degraded. Run desktop/scripts/get-voice-models.ps1 first."
  }

  $desktopExecutable = Join-Path $outputDirectory 'Helmion Pilot.exe'
  $serviceExecutable = Join-Path $outputDirectory 'Helmion Local Service.exe'
  [pscustomobject]@{
    status = 'published'
    flavor = $flavor
    desktop = Get-ArtifactDetails -Path $desktopExecutable
    local_service = Get-ArtifactDetails -Path $serviceExecutable
    smoke_tests = @('desktop-ui', 'service-binary', 'packaged-ipc')
    ipc_mode = 'Windows CurrentUserOnly named pipe - read-only'
    signed = $false
    production_ready = $false
  } | ConvertTo-Json -Depth 4
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    $resolvedStaging = [System.IO.Path]::GetFullPath($stagingDirectory)
    $resolvedArtifactsRoot = [System.IO.Path]::GetFullPath($artifactsRoot).TrimEnd('\') + '\'
    if ($resolvedStaging.StartsWith($resolvedArtifactsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
  }
}

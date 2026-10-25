[CmdletBinding()]
param(
  [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$desktopProject = Join-Path $repositoryRoot 'desktop\Helmion.Desktop\Helmion.Desktop.csproj'
$serviceProject = Join-Path $repositoryRoot 'desktop\Helmion.LocalService\Helmion.LocalService.csproj'
$bridgeProject = Join-Path $repositoryRoot 'desktop\Helmion.BridgeService\Helmion.BridgeService.csproj'
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

function Stage-BridgeApp {
  # The PC bridge is a Node app: bin/pc-bridge.mjs runs the agent loop and
  # bin/hands-spoke.mjs runs the hands spoke, both importing from src/ and
  # hands-mcp/. Helmion.BridgeService (Launchers.cs) looks for bin\pc-bridge.mjs
  # and bin\hands-spoke.mjs in its own folder, so the app tree is staged beside
  # the exes, together with a bundled node.exe copied from this build machine
  # (the service probes for node.exe next to its own exe first). An installed
  # PC therefore runs agent work with no pre-installed Node.js.
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw 'Node.js 20+ is required on the build machine to bundle the PC bridge runtime (node.exe) into the package.'
  }
  Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $stagingDirectory 'node.exe') -Force

  # The app's runtime tree: exactly the root package's published file set,
  # plus hands-mcp (imported by the spoke). Never stage local env files.
  foreach ($folder in @('bin', 'src', 'hands-mcp', 'docs', 'hooks', 'sql', 'templates')) {
    $source = Join-Path $repositoryRoot $folder
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $stagingDirectory $folder) -Recurse -Force -Exclude '.env', '.env.*'
    }
  }
  foreach ($file in @('package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $file) -Destination (Join-Path $stagingDirectory $file) -Force
  }

  # Runtime dependencies of the bridge app (root package.json: ably, pg).
  # hands-mcp's own server dependencies (express, MCP SDK, zod) are deliberately
  # not installed: nothing in the bridge or spoke loads them — the spoke imports
  # only hands-mcp/src/shared/protocol.mjs, which uses node: builtins only.
  & npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $stagingDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed for the PC bridge app with exit code $LASTEXITCODE"
  }
  foreach ($script in @('bin\pc-bridge.mjs', 'bin\hands-spoke.mjs', 'bin\helmion.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stagingDirectory $script) -PathType Leaf)) {
      throw "PC bridge app file was not staged: $script"
    }
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
  Publish-HelmionProject -Project $bridgeProject

  $desktopExecutable = Join-Path $stagingDirectory 'Helmian.exe'
  $serviceExecutable = Join-Path $stagingDirectory 'Helmion Local Service.exe'
  $bridgeExecutable = Join-Path $stagingDirectory 'Helmian Bridge Service.exe'
  foreach ($executable in @($desktopExecutable, $serviceExecutable, $bridgeExecutable)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
      throw "Published executable was not found: $executable"
    }
  }

  Invoke-PackagedSmoke -Executable $desktopExecutable -Argument '--smoke-test'
  Invoke-PackagedSmoke -Executable $serviceExecutable -Argument '--smoke-test'
  Invoke-PackagedSmoke -Executable $desktopExecutable -Argument '--service-smoke-test'
  # "A fresh empty workspace must produce zero red banners." Exits 3 if a first-run
  # empty state has regressed into being reported as a failure.
  Invoke-PackagedSmoke -Executable $desktopExecutable -Argument '--empty-workspace-audit'
  # The bridge service gets no packaged smoke run: its Program.cs starts the
  # supervisor host and has no smoke mode. Its exe presence is verified above;
  # its first supervised launch is proven at the first-run sitting.
  Stage-BridgeApp

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

  $desktopExecutable = Join-Path $outputDirectory 'Helmian.exe'
  $serviceExecutable = Join-Path $outputDirectory 'Helmion Local Service.exe'
  $bridgeExecutable = Join-Path $outputDirectory 'Helmian Bridge Service.exe'
  [pscustomobject]@{
    status = 'published'
    flavor = $flavor
    desktop = Get-ArtifactDetails -Path $desktopExecutable
    local_service = Get-ArtifactDetails -Path $serviceExecutable
    bridge_service = Get-ArtifactDetails -Path $bridgeExecutable
    bridge_app = 'Node app staged beside the exes (bin/, src/, hands-mcp/, node_modules/) with a bundled node.exe; BridgeService supervises bin\pc-bridge.mjs and bin\hands-spoke.mjs from the install folder.'
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

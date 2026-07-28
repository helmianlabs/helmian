<#
.SYNOPSIS
    Downloads the local voice models (Whisper STT + Kokoro TTS) into desktop/models/.

.DESCRIPTION
    Helmion's voice stack runs fully local: whisper.cpp (via Whisper.net) for
    speech-to-text and Kokoro v1.0 82M (via KokoroSharp / ONNX Runtime) for
    text-to-speech. Neither model ships in the repo — together they are ~470 MB —
    so this script fetches them on demand.

    Voices (.npy) and the espeak-ng phonemizer are NOT downloaded here: they are
    bundled inside the KokoroSharp NuGet package and copied to the build output
    by its buildTransitive/KokoroSharp.targets.

    Re-running is safe. A file whose size already matches the expected byte count
    is left alone; anything else is re-downloaded.

.PARAMETER WhisperModel
    Which ggml Whisper model to fetch. base.en is the default (~148 MB, fast on
    CPU); small.en is more accurate but ~3x larger and noticeably slower.

.PARAMETER Force
    Re-download even when the local file already has the expected size.

.EXAMPLE
    ./get-voice-models.ps1
    ./get-voice-models.ps1 -WhisperModel small.en -Force
#>
[CmdletBinding()]
param(
    [ValidateSet('base.en', 'small.en')]
    [string]$WhisperModel = 'base.en',

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# desktop/scripts/get-voice-models.ps1 -> desktop/models
$modelsDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'models'

# Expected sizes are recorded so a truncated or half-written download is detected
# on the next run instead of failing later inside native model loading.
$downloads = @(
    @{
        Name = "ggml-$WhisperModel.bin"
        Url  = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WhisperModel.bin"
        Size = @{ 'base.en' = 147964211L; 'small.en' = 487614201L }[$WhisperModel]
        What = 'Whisper STT model (whisper.cpp ggml)'
    },
    @{
        Name = 'kokoro.onnx'
        Url  = 'https://github.com/Lyrcaxis/KokoroSharpBinaries/releases/download/v2.0.0/kokoro.onnx'
        Size = 325508342L
        What = 'Kokoro v1.0 82M TTS model (ONNX, fp32)'
    }
)

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir | Out-Null
    Write-Host "Created $modelsDir"
}

foreach ($d in $downloads) {
    $dest = Join-Path $modelsDir $d.Name

    if ((-not $Force) -and (Test-Path $dest)) {
        $actual = (Get-Item $dest).Length
        if ($actual -eq $d.Size) {
            Write-Host "OK       $($d.Name) — already present ($('{0:N0}' -f $actual) bytes)"
            continue
        }
        Write-Warning "$($d.Name) is $('{0:N0}' -f $actual) bytes, expected $('{0:N0}' -f $d.Size). Re-downloading."
    }

    Write-Host "DOWNLOAD $($d.Name) — $($d.What)"
    Write-Host "         $($d.Url)"

    # Download to a temp name so an interrupted transfer never leaves a
    # plausible-looking but truncated model in place.
    $tmp = "$dest.partial"
    if (Test-Path $tmp) { Remove-Item $tmp -Force }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # Invoke-WebRequest streams to -OutFile; the progress bar costs real time
        # on large files, so it is suppressed for the duration of the transfer.
        $prevProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $d.Url -OutFile $tmp -MaximumRedirection 10 -UseBasicParsing
        }
        finally {
            $ProgressPreference = $prevProgress
        }
    }
    catch {
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        throw "Failed to download $($d.Name) from $($d.Url): $($_.Exception.Message)"
    }
    $sw.Stop()

    $got = (Get-Item $tmp).Length
    if ($got -ne $d.Size) {
        Remove-Item $tmp -Force
        throw "$($d.Name) downloaded $('{0:N0}' -f $got) bytes but expected $('{0:N0}' -f $d.Size). Nothing was written."
    }

    Move-Item -Path $tmp -Destination $dest -Force
    Write-Host ("DONE     {0} — {1:N0} bytes in {2:N1}s" -f $d.Name, $got, $sw.Elapsed.TotalSeconds)
}

Write-Host ''
Write-Host "Models ready in $modelsDir"
Get-ChildItem $modelsDir -File | ForEach-Object {
    Write-Host ("  {0,-24} {1,15:N0} bytes" -f $_.Name, $_.Length)
}

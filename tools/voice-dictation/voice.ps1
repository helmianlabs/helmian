<#
.SYNOPSIS
    The whole local voice stack, in one command.

.DESCRIPTION
    Two processes, both hidden, both local, no network and no API key:

      Helmion Voice Dictation  — you talk, it types into whatever window has focus
      Helmion Voice Speak      — anything writes text, it reads it aloud with Kokoro

    This script exists because there is one name to remember instead of four
    scripts. Everything it starts is a WinExe with no console window.

.EXAMPLE
    .\voice.ps1 -Start
    .\voice.ps1 -Status
    .\voice.ps1 -Say "the deploy finished"
    .\voice.ps1 -Stop
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Start')]  [switch] $Start,
    [Parameter(ParameterSetName = 'Stop')]   [switch] $Stop,
    [Parameter(ParameterSetName = 'Status')] [switch] $Status,
    [Parameter(ParameterSetName = 'Say', Mandatory = $true, Position = 0)] [string] $Say,

    [ValidateSet('Release', 'Debug')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$dictationExe = Join-Path $PSScriptRoot "Helmion.VoiceDictation\bin\$Configuration\net10.0-windows\Helmion Voice Dictation.exe"
$speakExe     = Join-Path $PSScriptRoot "Helmion.VoiceSpeak\bin\$Configuration\net10.0-windows\Helmion Voice Speak.exe"
$queueDir     = Join-Path $env:LOCALAPPDATA 'Helmion\speak-queue'
$dictationLog = Join-Path $env:LOCALAPPDATA 'Helmion\voice-dictation.log'
$speakLog     = Join-Path $env:LOCALAPPDATA 'Helmion\voice-speak.log'

function Get-Proc([string] $name) {
    Get-Process -Name $name -ErrorAction SilentlyContinue
}

function Assert-Built([string] $exe, [string] $project) {
    if (Test-Path $exe) { return $true }
    Write-Host "Not built yet:" -ForegroundColor Yellow
    Write-Host "  dotnet build `"$PSScriptRoot\$project`" -c $Configuration"
    return $false
}

function Start-Stack {
    $started = @()

    if (Assert-Built $dictationExe 'Helmion.VoiceDictation\Helmion.VoiceDictation.csproj') {
        if (Get-Proc 'Helmion Voice Dictation') {
            Write-Host "Dictation already running." -ForegroundColor DarkGray
        }
        else {
            Start-Process -FilePath $dictationExe | Out-Null
            $started += 'dictation'
        }
    }

    if (Assert-Built $speakExe 'Helmion.VoiceSpeak\Helmion.VoiceSpeak.csproj') {
        if (Get-Proc 'Helmion Voice Speak') {
            Write-Host "Speak watcher already running." -ForegroundColor DarkGray
        }
        else {
            # --watch keeps the 310 MB Kokoro model resident so speaking is
            # immediate rather than paying a model load per sentence.
            Start-Process -FilePath $speakExe -ArgumentList '--watch' | Out-Null
            $started += 'speak'
        }
    }

    if ($started.Count -gt 0) { Start-Sleep -Milliseconds 900 }
    Show-Status
}

function Stop-Stack {
    if (Test-Path $dictationExe) { Start-Process -FilePath $dictationExe -ArgumentList '--stop' | Out-Null }
    if (Test-Path $speakExe)     { Start-Process -FilePath $speakExe     -ArgumentList '--stop' | Out-Null }

    # Polled rather than a fixed sleep. Measured 2026-07-29: the signal reached
    # dictation in 0.3s but the process was still alive at 0.9s, so a fixed
    # 900 ms wait force-killed a shutdown that was already underway — which is
    # what leaves the tray icon on screen until the next mouse-over. Disposing a
    # 141 MB Whisper model and a 310 MB Kokoro model is simply not instant.
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Proc 'Helmion Voice Dictation') -and -not (Get-Proc 'Helmion Voice Speak')) { break }
        Start-Sleep -Milliseconds 150
    }

    # Only kill what genuinely ignored the signal.
    foreach ($name in 'Helmion Voice Dictation', 'Helmion Voice Speak') {
        $still = Get-Proc $name
        if ($still) {
            Write-Host "$name did not shut down in 6s; stopping it." -ForegroundColor Yellow
            $still | Stop-Process -Force
        }
    }

    Start-Sleep -Milliseconds 200
    Show-Status
}

function Send-Say([string] $text) {
    if ([string]::IsNullOrWhiteSpace($text)) {
        Write-Host "Nothing to say." -ForegroundColor Yellow
        return
    }

    if (-not (Assert-Built $speakExe 'Helmion.VoiceSpeak\Helmion.VoiceSpeak.csproj')) { return }

    if (-not (Get-Proc 'Helmion Voice Speak')) {
        Write-Host "Speak watcher was not running; starting it." -ForegroundColor DarkGray
        Start-Process -FilePath $speakExe -ArgumentList '--watch' | Out-Null
        Start-Sleep -Milliseconds 700
    }

    New-Item -ItemType Directory -Path $queueDir -Force | Out-Null
    $file = Join-Path $queueDir ("{0:yyyyMMdd-HHmmss-fff}-{1}.txt" -f (Get-Date), [guid]::NewGuid().ToString('N').Substring(0, 6))

    # The text goes in a FILE, never in an argument list. Passing a sentence as a
    # -ArgumentList element splits it on spaces, so only the first word survives:
    # measured 2026-07-29, an 85-character sentence arrived as 7 characters and
    # produced 1.45s of audio instead of 6.78s. A file has no such failure mode.
    # UTF-8 without a BOM, because a BOM would be read as a character and spoken.
    [System.IO.File]::WriteAllText($file, $text, [System.Text.UTF8Encoding]::new($false))

    Write-Host "Queued $($text.Length) chars." -ForegroundColor Green
}

function Show-Status {
    $dictation = Get-Proc 'Helmion Voice Dictation'
    $speak     = Get-Proc 'Helmion Voice Speak'
    $queued    = @(Get-ChildItem $queueDir -Filter *.txt -ErrorAction SilentlyContinue).Count

    $rows = @(
        [pscustomobject]@{
            Part   = 'Dictation (you talk)'
            State  = if ($dictation) { "running (pid $($dictation.Id -join ','))" } else { 'stopped' }
            How    = 'Ctrl+Alt+Space to talk, again to send'
        }
        [pscustomobject]@{
            Part   = 'Speak (it talks)'
            State  = if ($speak) { "running (pid $($speak.Id -join ','))" } else { 'stopped' }
            How    = ".\voice.ps1 -Say ""...""   ($queued queued)"
        }
    )

    $rows | Format-Table -AutoSize

    if (-not $dictation -and -not $speak) {
        Write-Host "Start both with:  .\voice.ps1 -Start" -ForegroundColor Cyan
    }

    Write-Host "Logs: $dictationLog"
    Write-Host "      $speakLog"
}

switch ($PSCmdlet.ParameterSetName) {
    'Start'  { Start-Stack }
    'Stop'   { Stop-Stack }
    'Say'    { Send-Say $Say }
    default  { Show-Status }
}

#Requires -Version 5.1
Set-StrictMode -Version Latest

<#
    Helmion.Voice — the local voice stack, from any PowerShell session.

    Whisper for speech to text, Kokoro for text to speech, both running offline
    against the two model files in desktop/models. This module is a thin driver
    over helmion-voice.exe (desktop/Helmion.Voice.Host); every model, every audio
    device and every keystroke is handled there.

    There is deliberately no edge-tts, no speak.ps1, no SAPI and no SoundPlayer
    anywhere in this path. Nothing here reaches the network.

    Background modes are started with CreateNoWindow, which means the process
    gets no console at all — not a hidden one, none — so it cannot put anything
    on screen. Their status goes to $env:TEMP\helmion-voice-host.log.
#>

$script:HostProcess = $null

# --------------------------------------------------------------------------
# Locating the host executable
# --------------------------------------------------------------------------

function Get-HelmionVoiceHostPath {
    <#
    .SYNOPSIS
        Full path to helmion-voice.exe, or throws with what was searched.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    if ($env:HELMION_VOICE_HOST -and (Test-Path -LiteralPath $env:HELMION_VOICE_HOST)) {
        return (Resolve-Path -LiteralPath $env:HELMION_VOICE_HOST).Path
    }

    $searched = [System.Collections.Generic.List[string]]::new()

    # Beside the module (how a copied/published module ships), then the build
    # output of the host project (how it looks in the repo).
    $candidates = @(
        (Join-Path $PSScriptRoot 'helmion-voice.exe')
        (Join-Path $PSScriptRoot '..\..\Helmion.Voice.Host\bin\Release\net10.0-windows\helmion-voice.exe')
        (Join-Path $PSScriptRoot '..\..\Helmion.Voice.Host\bin\Debug\net10.0-windows\helmion-voice.exe')
    )

    foreach ($candidate in $candidates) {
        $searched.Add($candidate)
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw ("helmion-voice.exe was not found. Build it with " +
           "`dotnet build desktop\Helmion.Desktop.slnx -c Release`, or set " +
           "`$env:HELMION_VOICE_HOST` to its full path. Searched:`n  " +
           ($searched -join "`n  "))
}

function Get-HelmionVoiceLogPath {
    <#
    .SYNOPSIS
        The file background dictation writes its status to.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return (Join-Path $env:TEMP 'helmion-voice-host.log')
}

function Start-HelmionVoiceHost {
    <#
    .SYNOPSIS
        Launch the host detached with no console window whatsoever.
    .DESCRIPTION
        CreateNoWindow with UseShellExecute disabled maps to CREATE_NO_WINDOW,
        so the child process is given no console. This is stronger than starting
        a console and hiding it: there is no window to flash, even for a frame.
    #>
    [CmdletBinding()]
    [OutputType([System.Diagnostics.Process])]
    param(
        [Parameter(Mandatory)][string[]] $ArgumentList
    )

    $exe = Get-HelmionVoiceHostPath

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = Split-Path -Parent $exe
    foreach ($argument in $ArgumentList) { $startInfo.ArgumentList.Add($argument) }

    return [System.Diagnostics.Process]::Start($startInfo)
}

# --------------------------------------------------------------------------
# Speaking
# --------------------------------------------------------------------------

function Invoke-HelmionSpeak {
    <#
    .SYNOPSIS
        Say something out loud through the local Kokoro model.
    .DESCRIPTION
        Blocks until playback finishes, so piping several strings speaks them in
        order rather than on top of each other.

        By default the text is cleaned for the ear — markdown, code fences and
        tool chrome are stripped, and the result is capped at 1200 characters so
        one reply cannot monologue. Use -Raw to speak the text exactly as given.

        This never touches the microphone. Audio goes out on the default render
        endpoint in WASAPI SHARED mode, so it cannot seize a device.
    .PARAMETER Text
        What to say. Accepts pipeline input.
    .PARAMETER Raw
        Speak the text verbatim, without cleaning or the length cap.
    .EXAMPLE
        Invoke-HelmionSpeak "The build is green."
    .EXAMPLE
        "first line", "second line" | Invoke-HelmionSpeak
    .EXAMPLE
        Get-Content .\reply.md -Raw | Invoke-HelmionSpeak
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline, ValueFromRemainingArguments)]
        [AllowEmptyString()]
        [string[]] $Text,

        [switch] $Raw
    )

    begin {
        $exe = Get-HelmionVoiceHostPath
    }

    process {
        foreach ($line in $Text) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            $arguments = @('speak', '--text', $line)
            if ($Raw) { $arguments += '--raw' }

            # Foreground and synchronous: this inherits the current console, so
            # it creates no window, and it returns only once the audio has
            # actually finished playing.
            & $exe @arguments
            if ($LASTEXITCODE -ne 0) {
                Write-Error "helmion-voice speak failed with exit code $LASTEXITCODE. Run Get-HelmionVoiceStatus."
            }
        }
    }
}

# --------------------------------------------------------------------------
# Dictation
# --------------------------------------------------------------------------

function Start-HelmionDictation {
    <#
    .SYNOPSIS
        Listen, and type what you say into whatever window has focus.
    .DESCRIPTION
        Runs in the background with no console window. Speak normally and the
        words appear at your cursor — in this terminal, in an editor, in a
        browser box, wherever the caret is.

        Typing and sending are separate. Dictated words are only ever TYPED.
        The only thing that presses Enter is saying "send it".

        Spoken commands (each must be the whole utterance):
            "new line"       insert a line break (Shift+Enter)
            "scratch that"   erase the last thing dictated
            "send it"        press Enter
            "stop dictation" stop listening and exit

        Stop it with Stop-HelmionDictation.
    .PARAMETER NoSpace
        Do not append a space after each dictated chunk.
    .PARAMETER PassThru
        Return the host process object.
    .EXAMPLE
        Start-HelmionDictation
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([System.Diagnostics.Process])]
    param(
        [switch] $NoSpace,
        [switch] $PassThru
    )

    if (Test-HelmionDictationRunning) {
        Write-Error 'Dictation is already running. Stop it first with Stop-HelmionDictation.'
        return
    }

    if (-not $PSCmdlet.ShouldProcess('the default microphone', 'start dictation')) { return }

    $arguments = @('type', '--quiet', '--log', (Get-HelmionVoiceLogPath))
    if ($NoSpace) { $arguments += '--no-space' }

    $script:HostProcess = Start-HelmionVoiceHost -ArgumentList $arguments

    Write-Verbose "helmion-voice host started as pid $($script:HostProcess.Id)."
    Write-Host 'Dictation ON. Speak — the words are typed where your cursor is.'
    Write-Host 'Say "send it" to submit, "stop dictation" to finish, or run Stop-HelmionDictation.'

    if ($PassThru) { return $script:HostProcess }
}

function Stop-HelmionDictation {
    <#
    .SYNOPSIS
        Stop dictation and release the microphone.
    .DESCRIPTION
        Signals the running host through a named event so it can close the
        capture device cleanly. Falls back to ending the process only if the
        signal is not acknowledged.
    .PARAMETER TimeoutSeconds
        How long to wait for a clean stop before falling back. Default 5.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateRange(1, 60)]
        [int] $TimeoutSeconds = 5
    )

    if (-not $PSCmdlet.ShouldProcess('the helmion-voice host', 'stop dictation')) { return }

    $signalled = $false
    try {
        # Same name the host waits on: Local\Helmion.Voice.Host.Stop
        $stopEvent = [System.Threading.EventWaitHandle]::OpenExisting('Local\Helmion.Voice.Host.Stop')
        [void]$stopEvent.Set()
        $stopEvent.Dispose()
        $signalled = $true
    }
    catch [System.Threading.WaitHandleCannotBeOpenedException] {
        Write-Verbose 'No running helmion-voice host to signal.'
    }

    $process = Get-HelmionDictationProcess
    if ($null -eq $process) {
        if (-not $signalled) { Write-Host 'Dictation was not running.' }
        else { Write-Host 'Dictation OFF.' }
        $script:HostProcess = $null
        return
    }

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        Write-Warning "helmion-voice did not stop within $TimeoutSeconds s; ending pid $($process.Id)."
        try { $process.Kill($true) } catch { Write-Verbose "Kill failed: $_" }
    }

    $script:HostProcess = $null
    Write-Host 'Dictation OFF. The microphone is released.'
}

function Get-HelmionDictationProcess {
    <#
    .SYNOPSIS
        The running host process, or $null.
    #>
    [CmdletBinding()]
    param()

    if ($null -ne $script:HostProcess) {
        try {
            if (-not $script:HostProcess.HasExited) { return $script:HostProcess }
        }
        catch { }
    }

    # Started by a different session: the host records its pid.
    $pidFile = Join-Path $env:TEMP 'helmion-voice-host.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }

    $recorded = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue)
    if ([string]::IsNullOrWhiteSpace($recorded)) { return $null }

    try { return [System.Diagnostics.Process]::GetProcessById([int]$recorded.Trim()) }
    catch { return $null }
}

function Test-HelmionDictationRunning {
    <#
    .SYNOPSIS
        True when a helmion-voice host currently holds the microphone.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    return $null -ne (Get-HelmionDictationProcess)
}

# --------------------------------------------------------------------------
# Hotkey
# --------------------------------------------------------------------------

function Register-HelmionVoiceHotkey {
    <#
    .SYNOPSIS
        Arm a global hotkey that toggles dictation on and off.
    .DESCRIPTION
        The host sits in the background holding one system-wide key combination.
        Press it and dictation starts typing into whatever window has focus;
        press it again and it stops. The microphone stays CLOSED until the first
        press.

        The default is Ctrl+Shift+Alt+H. Ctrl+Shift+C was rejected on purpose:
        it has no global owner, so registering it would SUCCEED and quietly take
        copy away from Windows Terminal and the element picker away from Chrome
        DevTools. See docs/POWERSHELL_VOICE.md.

        A global registration is exclusive machine-wide. While this is armed, no
        other application can receive that combination.
    .PARAMETER Chord
        Combination to register, e.g. 'ctrl+shift+alt+h' or 'ctrl+alt+f12'.
    .EXAMPLE
        Register-HelmionVoiceHotkey
    .EXAMPLE
        Register-HelmionVoiceHotkey -Chord 'ctrl+alt+f12'
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string] $Chord = 'ctrl+shift+alt+h',
        [switch] $NoSpace
    )

    if (Test-HelmionDictationRunning) {
        Write-Error 'A helmion-voice host is already running. Stop it first with Stop-HelmionDictation.'
        return
    }

    if (-not $PSCmdlet.ShouldProcess($Chord, 'register a system-wide hotkey')) { return }

    $arguments = @('hotkey', '--chord', $Chord, '--quiet', '--log', (Get-HelmionVoiceLogPath))
    if ($NoSpace) { $arguments += '--no-space' }

    $process = Start-HelmionVoiceHost -ArgumentList $arguments

    # A bad chord or a combination another process owns makes the host exit
    # immediately. Catch that here rather than reporting a hotkey that is not armed.
    if ($process.WaitForExit(1500)) {
        $log = Get-HelmionVoiceLogPath
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 3) -join "`n" } else { '' }
        Write-Error "helmion-voice could not arm $Chord (exit code $($process.ExitCode)).`n$tail"
        return
    }

    $script:HostProcess = $process
    Write-Host "$Chord is armed. Press it to start dictating; press it again to stop."
    Write-Host 'The microphone stays closed until you press it. Unregister-HelmionVoiceHotkey releases the key.'
}

function Unregister-HelmionVoiceHotkey {
    <#
    .SYNOPSIS
        Release the global hotkey and stop the host.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param()

    if (-not $PSCmdlet.ShouldProcess('the helmion-voice hotkey', 'release')) { return }
    Stop-HelmionDictation -Confirm:$false
}

# --------------------------------------------------------------------------
# Continuous conversation
# --------------------------------------------------------------------------

function Start-HelmionConversation {
    <#
    .SYNOPSIS
        Press one key, then just talk back and forth.
    .DESCRIPTION
        Continuous conversation mode. Press the key once to start; every sentence
        you finish is typed where your cursor is and submitted by itself, with no
        "send it" needed. Press the key again to stop.

        THIS IS HALF-DUPLEX. YOU CANNOT INTERRUPT A REPLY WHILE IT IS PLAYING.
        While the speakers are live the microphone's audio is thrown away, and it
        stays closed for a short tail afterwards so the decay does not leak in.
        That is what stops the assistant transcribing its own voice, answering
        itself, and looping. Talking over a reply means those words are lost, not
        queued — wait for it to finish. True barge-in needs acoustic echo
        cancellation or a full-duplex model such as Moshi; neither is installed.

        The suppression works ACROSS PROCESSES, which is the part that was
        missing: Invoke-HelmionSpeak runs in its own process, so a dictation host
        had no way to know audio was playing. Both sides now share a machine-wide
        flag.

        Spoken commands still work and are never submitted as text:
            "new line"       break the line AND hold auto-send until you say
                             "send it" — this is how you dictate a multi-line
                             message when every sentence would otherwise submit
            "scratch that"   erase the last thing dictated
            "send it"        submit now (no longer required, still works)
            "stop dictation" end the conversation

        Runs in the background with no console window. Status goes to the log
        file; see Get-HelmionVoiceLogPath.
    .PARAMETER Chord
        The single key that starts and stops it. Defaults to the tilde/backtick
        key with no modifiers, which is what Troy asked for. A global hotkey is
        exclusive machine-wide: while this is armed, nothing else can receive it.
    .PARAMETER TailMs
        How long the microphone stays closed after a reply ends, in milliseconds.
        Default 250. Raise it if you still hear the assistant quoting itself —
        that is the number to turn, and it needs no rebuild.
    .PARAMETER NoAutoSend
        Type but never submit, exactly like Start-HelmionDictation. Echo
        suppression still applies.
    .PARAMETER NoSpace
        Do not append a space after each dictated chunk.
    .PARAMETER PassThru
        Return the host process object.
    .EXAMPLE
        Start-HelmionConversation
    .EXAMPLE
        Start-HelmionConversation -TailMs 400
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([System.Diagnostics.Process])]
    param(
        [string] $Chord = 'grave',

        [ValidateRange(0, 5000)]
        [int] $TailMs = 250,

        [switch] $NoAutoSend,
        [switch] $NoSpace,
        [switch] $PassThru
    )

    if (Test-HelmionDictationRunning) {
        Write-Error ('A helmion-voice host is already running. Stop it first with ' +
                     'Stop-HelmionConversation.')
        return
    }

    if (-not $PSCmdlet.ShouldProcess($Chord, 'start a continuous voice conversation')) { return }

    $arguments = @(
        'converse'
        '--chord', $Chord
        '--tail-ms', $TailMs.ToString()
        '--quiet'
        '--log', (Get-HelmionVoiceLogPath)
    )
    if ($NoAutoSend) { $arguments += '--no-auto-send' }
    if ($NoSpace) { $arguments += '--no-space' }

    $process = Start-HelmionVoiceHost -ArgumentList $arguments

    # A bad chord, or one another process already owns, makes the host exit at
    # once. Catch that here rather than reporting a key that is not armed.
    if ($process.WaitForExit(1500)) {
        $log = Get-HelmionVoiceLogPath
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 3) -join "`n" } else { '' }
        Write-Error "helmion-voice could not arm $Chord (exit code $($process.ExitCode)).`n$tail"
        return
    }

    $script:HostProcess = $process

    Write-Host "$Chord starts and stops the conversation. Press it once, then just talk."
    if ($NoAutoSend) {
        Write-Host 'Auto-send is OFF — say "send it" to submit.'
    }
    else {
        Write-Host 'Each finished sentence submits by itself. Say "new line" to compose a longer message.'
    }
    Write-Host "Half-duplex: you cannot interrupt a reply while it plays. Mic reopens ${TailMs} ms after it ends."
    Write-Host 'The microphone stays closed until you press the key. Stop-HelmionConversation ends it.'

    if ($PassThru) { return $process }
}

function Stop-HelmionConversation {
    <#
    .SYNOPSIS
        End the conversation and release both the hotkey and the microphone.
    .DESCRIPTION
        The same clean shutdown Stop-HelmionDictation performs — the host is
        signalled through its named event so it can close the capture device
        rather than being killed out from under it.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateRange(1, 60)]
        [int] $TimeoutSeconds = 5
    )

    if (-not $PSCmdlet.ShouldProcess('the helmion-voice conversation', 'stop')) { return }
    Stop-HelmionDictation -TimeoutSeconds $TimeoutSeconds -Confirm:$false
}

# --------------------------------------------------------------------------
# Status
# --------------------------------------------------------------------------

function Get-HelmionVoiceStatus {
    <#
    .SYNOPSIS
        Report what the voice stack can do right now. Makes no sound.
    .DESCRIPTION
        Prints the model paths, the audio endpoint counts, the microphone's name
        and mute flag, and the share mode both devices are opened in. Opens no
        capture device and plays nothing.
    #>
    [CmdletBinding()]
    param()

    $exe = Get-HelmionVoiceHostPath
    & $exe probe
}

function Test-HelmionVoice {
    <#
    .SYNOPSIS
        Prove the round trip: synthesize a sentence, transcribe it, compare.
    .DESCRIPTION
        Writes the audio to a temporary WAV rather than the speakers, so this is
        silent and safe to run at any time. Also fingerprints the microphone
        before and after and fails if anything about it changed.
    #>
    [CmdletBinding()]
    param()

    $exe = Get-HelmionVoiceHostPath

    # The host's report goes to the screen; only the verdict goes down the
    # pipeline, so `if (Test-HelmionVoice) { ... }` tests a boolean and not a
    # transcript that happens to be truthy.
    & $exe selftest | ForEach-Object { Write-Host $_ }
    return ($LASTEXITCODE -eq 0)
}

Export-ModuleMember -Function @(
    'Invoke-HelmionSpeak'
    'Start-HelmionDictation'
    'Stop-HelmionDictation'
    'Test-HelmionDictationRunning'
    'Get-HelmionDictationProcess'
    'Register-HelmionVoiceHotkey'
    'Unregister-HelmionVoiceHotkey'
    'Start-HelmionConversation'
    'Stop-HelmionConversation'
    'Get-HelmionVoiceStatus'
    'Get-HelmionVoiceHostPath'
    'Get-HelmionVoiceLogPath'
    'Test-HelmionVoice'
)

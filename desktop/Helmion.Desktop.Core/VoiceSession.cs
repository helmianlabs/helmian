namespace Helmion.Desktop.Core;

/// <summary>
/// Two-way voice for the Helmion console:
/// mic (local Whisper) → text → app chat → TTS reply (local Kokoro) → listen again.
/// Recognition is paused while speaking so the mic does not hear the speaker.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class VoiceSession : IDisposable
{
    private readonly ISpeechEngine _engine;
    private readonly object _gate = new();
    private bool _voiceMode;
    private bool _pausedForTts;
    private bool _disposed;
    private int _speakGeneration;
    /// <summary>Skip re-probing endpoints every Speak once we know TTS can run.</summary>
    private bool _ttsEndpointsKnownReady;

    public event EventHandler<string>? OnSpeechRecognized;
    public event EventHandler<string>? OnError;
    public event EventHandler<string>? OnStatus;

    /// <summary>Uses the default local engine (Whisper STT + Kokoro TTS).</summary>
    public VoiceSession()
        : this(new LocalVoiceEngine())
    {
    }

    /// <summary>
    /// Injects a specific engine. The turn-taking logic in this class is
    /// engine-agnostic — it only relies on <see cref="ISpeechEngine.Speak"/>
    /// blocking until playback finishes.
    /// </summary>
    public VoiceSession(ISpeechEngine engine)
    {
        _engine = engine;
        _engine.SpeechRecognized += Engine_SpeechRecognized;
        _engine.SpeechDetected += Engine_SpeechDetected;
        _engine.Error += Engine_Error;
        _engine.DictationStopped += Engine_DictationStopped;
    }

    /// <summary>Coarse health of the underlying engine, for a UI status pill.</summary>
    public VoiceState EngineState => _engine.State;

    /// <summary>User turned on continuous two-way voice (mic button).</summary>
    public bool IsVoiceModeActive
    {
        get { lock (_gate) return _voiceMode; }
    }

    public bool IsListening
    {
        get
        {
            lock (_gate)
            {
                return _voiceMode && !_pausedForTts && _engine.IsDictationRunning;
            }
        }
    }

    public bool IsSpeaking { get; private set; }

    public void StartVoiceMode()
    {
        if (_disposed)
        {
            return;
        }

        lock (_gate)
        {
            _voiceMode = true;
            _pausedForTts = false;
        }

        try
        {
            _engine.StartDictation();
        }
        catch (Exception ex)
        {
            lock (_gate)
            {
                _voiceMode = false;
            }

            OnError?.Invoke(this, $"Mic unavailable: {ex.Message}");
            return;
        }

        if (!_engine.IsDictationRunning)
        {
            // The engine already raised Error with a helpful message.
            lock (_gate)
            {
                _voiceMode = false;
            }

            return;
        }

        OnStatus?.Invoke(this, "Voice mode on — listening (two-way). Speak after the mic is amber.");
    }

    public void StopVoiceMode()
    {
        lock (_gate)
        {
            _voiceMode = false;
            _pausedForTts = false;
        }

        // Invalidate any in-flight SpeakAsync finally/resume work.
        Interlocked.Increment(ref _speakGeneration);
        StopSpeaking();
        _engine.StopDictation();
        OnStatus?.Invoke(this, "Voice mode off");
    }

    /// <summary>Legacy alias used by older call sites.</summary>
    public void StartListening() => StartVoiceMode();

    /// <summary>Legacy alias used by older call sites.</summary>
    public void StopListening() => StopVoiceMode();

    /// <summary>
    /// Pause the mic before model work / TTS so recognition does not capture
    /// ambient noise or the spoken reply.
    /// </summary>
    public void PauseListeningForTts()
    {
        lock (_gate)
        {
            if (!_voiceMode)
            {
                return;
            }

            _pausedForTts = true;
        }

        _engine.PauseDictation();
    }

    /// <summary>Resume mic after TTS / model work when voice mode is still on.</summary>
    public void ResumeListeningAfterTts()
    {
        if (_disposed)
        {
            return;
        }

        lock (_gate)
        {
            if (!_voiceMode)
            {
                return;
            }

            _pausedForTts = false;
        }

        // Always (re)start: PauseDictation marks the engine stopped, and a plain
        // early-return on "still listening" previously left the mic dead after TTS.
        try
        {
            _engine.StartDictation();
            if (_engine.IsDictationRunning)
            {
                OnStatus?.Invoke(this, "Listening…");
            }
        }
        catch (Exception ex)
        {
            OnError?.Invoke(this, $"Mic resume failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Speaks text (cleaned for TTS). Pauses recognition for the duration, then
    /// resumes if voice mode is still active.
    /// Enumerates audio endpoints first; device failures are logged to the console
    /// via <see cref="OnError"/> — never left as unhandled exceptions.
    /// </summary>
    public async Task SpeakAsync(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text) || _disposed)
        {
            return;
        }

        var spoken = CleanForSpeech(text);
        if (string.IsNullOrWhiteSpace(spoken))
        {
            return;
        }

        // Pre-flight once. Re-probing every reply (device enum + voice list) added
        // real lag on every turn; Speak() already handles device faults itself.
        if (!_ttsEndpointsKnownReady)
        {
            try
            {
                var endpoints = _engine.ProbeAudioEndpoints();
                if (!endpoints.IsReadyForTts)
                {
                    OnError?.Invoke(
                        this,
                        $"[Voice warning] {endpoints.Warning ?? "No audio output device for TTS."} "
                        + $"devices={endpoints.RenderDeviceCount}, voices={endpoints.VoiceCount}");
                    OnStatus?.Invoke(this, "TTS skipped — no audio output device");
                    return;
                }

                _ttsEndpointsKnownReady = true;
            }
            catch (Exception ex)
            {
                OnError?.Invoke(this, $"[Voice warning] Audio endpoint probe failed: {ex.Message}");
                // Continue — Speak() has its own recovery path.
            }
        }

        var generation = Interlocked.Increment(ref _speakGeneration);
        PauseListeningForTts();
        StopSpeaking();

        IsSpeaking = true;
        OnStatus?.Invoke(this, "Speaking…");
        try
        {
            await Task.Run(() =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                // Bail if voice mode was cancelled while queued.
                if (generation != Volatile.Read(ref _speakGeneration))
                {
                    return;
                }

                // Speak blocks until playback finishes and never throws for device
                // faults — it reports them via Error and drops to Degraded.
                _engine.Speak(spoken, cancellationToken);
            }, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { _engine.CancelSpeak(); } catch { /* ignore */ }
        }
        catch (InvalidOperationException ex)
        {
            OnError?.Invoke(this, $"[Voice warning] TTS InvalidOperationException: {ex.Message}");
        }
        catch (System.Runtime.InteropServices.COMException ex)
        {
            OnError?.Invoke(
                this,
                $"[Voice warning] TTS COM/audio error 0x{ex.HResult:X8}: {ex.Message}");
        }
        catch (Exception ex)
        {
            // Last-resort net — the engine should have already recovered + logged.
            OnError?.Invoke(this, $"[Voice warning] TTS error: {ex.Message}");
        }
        finally
        {
            IsSpeaking = false;

            // Only the latest speak turn may resume the mic.
            if (generation == Volatile.Read(ref _speakGeneration)
                && !_disposed
                && IsVoiceModeActive)
            {
                // Short pad so speaker tail is not re-captured as a new utterance.
                try { await Task.Delay(80, CancellationToken.None).ConfigureAwait(false); }
                catch { /* ignore */ }
                ResumeListeningAfterTts();
            }
        }
    }

    public void StopSpeaking()
    {
        try
        {
            _engine.CancelSpeak();
        }
        catch
        {
            // Ignore
        }

        IsSpeaking = false;
    }

    /// <summary>Strip tool markup and dense symbols so TTS sounds natural.</summary>
    public static string CleanForSpeech(string text) => SpeechTextCleaner.CleanForSpeech(text);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        lock (_gate)
        {
            _voiceMode = false;
            _pausedForTts = false;
        }

        Interlocked.Increment(ref _speakGeneration);
        StopSpeaking();

        _engine.SpeechRecognized -= Engine_SpeechRecognized;
        _engine.SpeechDetected -= Engine_SpeechDetected;
        _engine.Error -= Engine_Error;
        _engine.DictationStopped -= Engine_DictationStopped;
        _engine.Dispose();
    }

    private void Engine_SpeechRecognized(object? sender, string text)
    {
        lock (_gate)
        {
            if (!_voiceMode || _pausedForTts || _disposed)
            {
                return;
            }
        }

        if (IsSpeaking)
        {
            return;
        }

        OnStatus?.Invoke(this, $"Heard: {text}");
        OnSpeechRecognized?.Invoke(this, text);
    }

    private void Engine_SpeechDetected(object? sender, EventArgs e)
    {
        // Barge-in only applies if dictation is still live during playback.
        // Default path pauses dictation for TTS, so this is best-effort.
        if (IsSpeaking)
        {
            Interlocked.Increment(ref _speakGeneration);
            StopSpeaking();
        }
    }

    private void Engine_Error(object? sender, string message)
    {
        OnError?.Invoke(this, message);

        // Fatal mic init failure while starting voice mode is handled by StartVoiceMode.
        // Mid-session recognition errors should not silently leave the mode "on" forever
        // if the engine cannot run at all.
        if (!_engine.IsDictationRunning)
        {
            bool shouldAnnounce;
            lock (_gate)
            {
                shouldAnnounce = _voiceMode && !_pausedForTts;
            }

            if (shouldAnnounce)
            {
                OnStatus?.Invoke(this, "Mic error — click the mic to retry voice mode.");
            }
        }
    }

    private void Engine_DictationStopped(object? sender, EventArgs e)
    {
        // If we paused for TTS or stopped voice mode, do not auto-restart here.
        bool shouldRestart;
        lock (_gate)
        {
            shouldRestart = _voiceMode && !_pausedForTts && !_disposed && !IsSpeaking;
        }

        if (!shouldRestart)
        {
            return;
        }

        // Engine stopped unexpectedly — restart continuous listen while voice mode is on.
        try
        {
            _engine.StartDictation();
        }
        catch (Exception ex)
        {
            OnError?.Invoke(this, $"Recognition restart failed: {ex.Message}");
        }
    }
}

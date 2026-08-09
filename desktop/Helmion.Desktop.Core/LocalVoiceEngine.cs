namespace Helmion.Desktop.Core;

/// <summary>
/// Helmion's default voice engine: fully local, no network, no provider keys.
/// Whisper (whisper.cpp) for speech-to-text, Kokoro v1.0 (82M ONNX) for
/// text-to-speech, both on CPU.
/// </summary>
/// <remarks>
/// This replaces the previous System.Speech/SAPI engine. The SAPI
/// "audio device 0x2" recovery ladder — probe, recreate the synthesizer, retry,
/// recreate again — is gone rather than ported: it existed because
/// System.Speech.Synthesis latched into a faulted state that only a new
/// synthesizer could clear. NAudio has no such state, so a device fault here is
/// handled once: dispose the transport, report it, drop to
/// <see cref="VoiceState.Degraded"/>, and keep the app running text-only.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class LocalVoiceEngine : ISpeechEngine
{
    private readonly WhisperSpeechRecognizer? _recognizer;
    private readonly KokoroSpeechSynthesizer? _synthesizer;
    private readonly object _gate = new();
    private readonly string? _unavailableReason;

    private VoiceState _state = VoiceState.Idle;
    private bool _disposed;

    /// <summary>
    /// Builds the engine from the models found on disk. When a model is missing
    /// the engine still constructs and every call stays safe — it simply reports
    /// <see cref="VoiceState.Degraded"/> and explains what to run.
    /// </summary>
    public LocalVoiceEngine()
        : this(VoiceModelPaths.WhisperModelPath, VoiceModelPaths.KokoroModelPath)
    {
    }

    public LocalVoiceEngine(string? whisperModelPath, string? kokoroModelPath)
    {
        _unavailableReason = VoiceModelPaths.DescribeMissingAssets();

        if (whisperModelPath is not null)
        {
            _recognizer = new WhisperSpeechRecognizer(whisperModelPath);
            _recognizer.SpeechRecognized += OnRecognizerSpeechRecognized;
            _recognizer.SpeechDetected += OnRecognizerSpeechDetected;
            _recognizer.Error += OnComponentError;
            _recognizer.Stopped += OnRecognizerStopped;

            // ggml load is multi-second on first Start(). Warm in background so
            // "Voice" / "Dictate" do not feel frozen on the first utterance.
            _ = Task.Run(() =>
            {
                try { _recognizer.Warmup(); }
                catch { /* Error event already reports load failures */ }
            });
        }

        if (kokoroModelPath is not null)
        {
            _synthesizer = new KokoroSpeechSynthesizer(kokoroModelPath);
            _synthesizer.Error += OnComponentError;

            // The ONNX model takes roughly a second to load. Pay it in the
            // background so the first spoken reply is not delayed.
            _ = Task.Run(() => _synthesizer.Warmup());
        }

        if (_unavailableReason is not null)
        {
            SetState(VoiceState.Degraded);
        }
    }

    public event EventHandler<string>? SpeechRecognized;

    public event EventHandler? SpeechDetected;

    public event EventHandler<string>? Error;

    public event EventHandler? DictationStopped;

    public event EventHandler<VoiceState>? StateChanged;

    public VoiceState State
    {
        get { lock (_gate) return _state; }
    }

    public bool IsDictationRunning => _recognizer?.IsRunning ?? false;

    public bool IsSpeaking => _synthesizer?.IsSpeaking ?? false;

    public void StartDictation()
    {
        if (_disposed)
        {
            return;
        }

        if (_recognizer is null)
        {
            ReportUnavailable("Speech recognition");
            return;
        }

        _recognizer.Start();
        SetState(_recognizer.IsRunning ? VoiceState.Listening : VoiceState.Degraded);
    }

    public void StopDictation()
    {
        _recognizer?.Stop();
        if (State != VoiceState.Degraded)
        {
            SetState(IsSpeaking ? VoiceState.Speaking : VoiceState.Idle);
        }
    }

    public void PauseDictation()
    {
        _recognizer?.Pause();
        if (State == VoiceState.Listening)
        {
            SetState(VoiceState.Idle);
        }
    }

    public void Speak(string text, CancellationToken cancellationToken = default)
    {
        if (_disposed || string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        if (_synthesizer is null)
        {
            ReportUnavailable("Speech synthesis");
            return;
        }

        var previous = State;
        SetState(VoiceState.Speaking);
        try
        {
            _synthesizer.Speak(text, cancellationToken);
        }
        finally
        {
            if (State == VoiceState.Speaking)
            {
                SetState(previous == VoiceState.Speaking ? VoiceState.Idle : previous);
            }
        }
    }

    public void CancelSpeak() => _synthesizer?.CancelSpeak();

    public AudioEndpointStatus ProbeAudioEndpoints()
    {
        if (_synthesizer is null)
        {
            return new AudioEndpointStatus(
                HasOutputDevice: false,
                RenderDeviceCount: -1,
                VoiceCount: 0,
                PreferredVoiceName: null,
                IsReadyForTts: false,
                Warning: _unavailableReason ?? "Speech synthesis is unavailable.");
        }

        return _synthesizer.Probe();
    }

    /// <summary>
    /// Transcribe a WAV file through the live STT path. Exists so the recognizer
    /// can be proven end to end without a human at a microphone.
    /// </summary>
    public string TranscribeWavFile(string wavPath) =>
        _recognizer?.TranscribeWavFile(wavPath) ?? string.Empty;

    /// <summary>
    /// Synthesize to a WAV file instead of the speakers. Used by the headless
    /// proof and by anything that wants audio without a playback device.
    /// </summary>
    public bool SynthesizeToWavFile(string text, string wavPath)
    {
        if (_synthesizer is null || string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return _synthesizer.SynthesizeToWavFile(text, wavPath);
    }

    /// <summary>Strip tool markup and dense symbols so TTS sounds natural.</summary>
    public static string CleanForSpeech(string text) => SpeechTextCleaner.CleanForSpeech(text);

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        if (_recognizer is not null)
        {
            _recognizer.SpeechRecognized -= OnRecognizerSpeechRecognized;
            _recognizer.SpeechDetected -= OnRecognizerSpeechDetected;
            _recognizer.Error -= OnComponentError;
            _recognizer.Stopped -= OnRecognizerStopped;
            _recognizer.Dispose();
        }

        if (_synthesizer is not null)
        {
            _synthesizer.Error -= OnComponentError;
            _synthesizer.Dispose();
        }
    }

    private void ReportUnavailable(string what)
    {
        SetState(VoiceState.Degraded);
        Error?.Invoke(
            this,
            $"[Voice warning] {what} is unavailable. "
            + (_unavailableReason ?? "The local voice models could not be loaded."));
    }

    private void SetState(VoiceState next)
    {
        bool changed;
        lock (_gate)
        {
            changed = _state != next;
            _state = next;
        }

        if (changed)
        {
            StateChanged?.Invoke(this, next);
        }
    }

    private void OnRecognizerSpeechRecognized(object? sender, string text) =>
        SpeechRecognized?.Invoke(this, text);

    private void OnRecognizerSpeechDetected(object? sender, EventArgs e) =>
        SpeechDetected?.Invoke(this, EventArgs.Empty);

    private void OnRecognizerStopped(object? sender, EventArgs e) =>
        DictationStopped?.Invoke(this, EventArgs.Empty);

    private void OnComponentError(object? sender, string message)
    {
        // Every component error is already handled where it happened; reaching
        // here means voice is impaired but the app must keep running.
        SetState(VoiceState.Degraded);
        Error?.Invoke(this, message);
    }
}

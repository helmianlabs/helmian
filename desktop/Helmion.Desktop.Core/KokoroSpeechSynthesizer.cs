using KokoroSharp;
using KokoroSharp.Core;
using KokoroSharp.Processing;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace Helmion.Desktop.Core;

/// <summary>
/// Local neural text-to-speech: Kokoro v1.0 (82M ONNX, CPU) → 24 kHz PCM →
/// NAudio playback.
/// </summary>
/// <remarks>
/// <see cref="Speak"/> BLOCKS until the audio has finished playing. That is a
/// contract, not an implementation detail: <see cref="VoiceSession"/> resumes the
/// microphone the moment it returns, so returning early makes the app transcribe
/// its own voice.
///
/// Long text is tokenized then split into segments, and each segment is
/// synthesized and played before the next is synthesized. That keeps time-to-first-
/// audio short and gives cancellation a natural seam between segments.
///
/// A device watchdog listens for default-render-device changes and rebuilds the
/// output transport on the next utterance, so plugging in headphones mid-session
/// does not leave the app permanently mute.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class KokoroSpeechSynthesizer : IDisposable
{
    private const string DefaultVoiceName = "af_heart";
    private const int PlaybackLatencyMs = 150;

    private readonly object _gate = new();
    private readonly object _loadGate = new();
    private readonly string _modelPath;
    private readonly string _voiceName;

    private KokoroModel? _model;
    private KokoroVoice? _voice;
    private bool _assetsPrepared;
    private bool _modelFailed;

    private IWavePlayer? _output;
    private BufferedWaveProvider? _buffer;
    private volatile bool _transportStale;
    private volatile bool _cancelRequested;

    private MMDeviceEnumerator? _deviceEnumerator;
    private DeviceChangeWatcher? _deviceWatcher;

    private bool _disposed;

    public KokoroSpeechSynthesizer(string modelPath, string voiceName = DefaultVoiceName)
    {
        _modelPath = modelPath;
        _voiceName = voiceName;
        StartDeviceWatchdog();
    }

    public event EventHandler<string>? Error;

    public bool IsSpeaking { get; private set; }

    /// <summary>Voice that synthesis will use, once assets are loaded.</summary>
    public string? LoadedVoiceName => _voice?.Name;

    /// <summary>
    /// Load the ONNX model and speaker embeddings ahead of the first utterance.
    /// Safe to call from a background thread; the first Speak pays the cost
    /// otherwise (roughly 1.2 s on this hardware).
    /// </summary>
    public void Warmup()
    {
        try
        {
            EnsureModelLoaded();
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"[Voice warning] TTS warmup failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Report whether speech output can run. Never produces sound.
    /// </summary>
    public AudioEndpointStatus Probe()
    {
        var renderCount = SafeRenderDeviceCount();

        var missing = VoiceModelPaths.DescribeMissingAssets();
        if (missing is not null)
        {
            return new AudioEndpointStatus(
                HasOutputDevice: renderCount != 0,
                RenderDeviceCount: renderCount,
                VoiceCount: 0,
                PreferredVoiceName: null,
                IsReadyForTts: false,
                Warning: missing);
        }

        if (_modelFailed)
        {
            return new AudioEndpointStatus(
                HasOutputDevice: renderCount != 0,
                RenderDeviceCount: renderCount,
                VoiceCount: 0,
                PreferredVoiceName: null,
                IsReadyForTts: false,
                Warning: "Kokoro TTS model failed to load — voice output is unavailable.");
        }

        var voiceCount = 0;
        try
        {
            PrepareAssets();
            voiceCount = KokoroVoiceManager.Voices.Count;
        }
        catch (Exception ex)
        {
            return new AudioEndpointStatus(
                HasOutputDevice: renderCount != 0,
                RenderDeviceCount: renderCount,
                VoiceCount: 0,
                PreferredVoiceName: null,
                IsReadyForTts: false,
                Warning: $"Kokoro voice assets unavailable: {ex.Message}");
        }

        // Only a positively-known zero blocks playback. An inconclusive probe
        // still attempts output rather than falsely reporting "no speakers".
        var deviceKnownAbsent = renderCount == 0;
        var ready = voiceCount > 0 && !deviceKnownAbsent;

        string? warning = null;
        if (deviceKnownAbsent)
        {
            warning = "No audio output device is active. "
                + "Plug in speakers or headphones, or set a default playback device in Windows Sound settings.";
        }
        else if (voiceCount <= 0)
        {
            warning = "No Kokoro voices were found next to the executable (voices/*.npy).";
        }
        else if (renderCount < 0)
        {
            warning = "Audio device probe inconclusive — attempting playback with the default device anyway.";
        }

        return new AudioEndpointStatus(
            HasOutputDevice: renderCount != 0,
            RenderDeviceCount: renderCount,
            VoiceCount: voiceCount,
            PreferredVoiceName: _voice?.Name ?? _voiceName,
            IsReadyForTts: ready,
            Warning: warning);
    }

    /// <summary>
    /// Synthesize and play <paramref name="text"/>, returning only once playback
    /// has finished. Device and model faults raise <see cref="Error"/> and return
    /// quietly; they never throw.
    /// </summary>
    public void Speak(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text) || _disposed)
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        _cancelRequested = false;

        KokoroModel model;
        KokoroVoice voice;
        try
        {
            if (!EnsureModelLoaded())
            {
                return;
            }

            model = _model!;
            voice = _voice!;
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"[Voice warning] TTS unavailable: {ex.Message}");
            return;
        }

        int[][] segments;
        try
        {
            var language = KokoroLangCodeHelper.GetLangCode(voice);
            var tokens = Tokenizer.Tokenize(text, language, true);
            if (tokens.Length == 0)
            {
                return;
            }

            segments = SegmentationSystem
                .SplitToSegments(tokens, new DefaultSegmentationConfig())
                .ToArray();
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"[Voice warning] Could not phonemize text: {ex.Message}");
            return;
        }

        IsSpeaking = true;
        try
        {
            foreach (var segment in segments)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_cancelRequested || segment.Length == 0)
                {
                    break;
                }

                float[] samples;
                try
                {
                    samples = model.Infer(segment, voice.Features, 1.0f);
                }
                catch (Exception ex)
                {
                    Error?.Invoke(this, $"[Voice warning] Speech synthesis failed: {ex.Message}");
                    break;
                }

                if (!PlayBlocking(samples, cancellationToken))
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            CancelSpeak();
            throw;
        }
        finally
        {
            IsSpeaking = false;
        }
    }

    /// <summary>
    /// Synthesize <paramref name="text"/> to a 24 kHz mono WAV file instead of
    /// playing it. No audio device is touched, so this works headlessly and is
    /// how the TTS path is proven without a human listening.
    /// </summary>
    public bool SynthesizeToWavFile(string text, string wavPath)
    {
        var samples = Synthesize(text);
        if (samples is null || samples.Length == 0)
        {
            return false;
        }

        try
        {
            VoiceAudio.WriteWav(wavPath, samples, VoiceAudio.KokoroSampleRate);
            return true;
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"[Voice warning] Could not write {wavPath}: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Run the full text → phonemes → tokens → model path and return the raw
    /// 24 kHz samples, or null when synthesis could not run.
    /// </summary>
    public float[]? Synthesize(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || _disposed || !EnsureModelLoaded())
        {
            return null;
        }

        var model = _model!;
        var voice = _voice!;

        try
        {
            var language = KokoroLangCodeHelper.GetLangCode(voice);
            var tokens = Tokenizer.Tokenize(text, language, true);
            if (tokens.Length == 0)
            {
                return null;
            }

            var samples = new List<float>();
            foreach (var segment in SegmentationSystem.SplitToSegments(
                tokens, new DefaultSegmentationConfig()))
            {
                if (segment.Length > 0)
                {
                    samples.AddRange(model.Infer(segment, voice.Features, 1.0f));
                }
            }

            return samples.ToArray();
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"[Voice warning] Speech synthesis failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>Stop playback immediately and drop anything still queued.</summary>
    public void CancelSpeak()
    {
        _cancelRequested = true;

        lock (_gate)
        {
            try { _buffer?.ClearBuffer(); } catch { /* ignore */ }
            try { _output?.Stop(); } catch { /* ignore */ }
        }

        IsSpeaking = false;
    }

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

        CancelSpeak();
        StopDeviceWatchdog();
        DisposeTransport();

        lock (_gate)
        {
            try { _model?.Dispose(); } catch { /* ignore */ }
            _model = null;
        }
    }

    /// <summary>
    /// Push one segment's samples to the output device and block until the device
    /// has actually played them. Returns false when playback could not run.
    /// </summary>
    private bool PlayBlocking(float[] samples, CancellationToken cancellationToken)
    {
        if (samples.Length == 0)
        {
            return true;
        }

        BufferedWaveProvider buffer;
        try
        {
            if (!EnsureTransport())
            {
                return false;
            }

            lock (_gate)
            {
                buffer = _buffer!;
                buffer.AddSamples(VoiceAudio.FloatToPcm16(samples), 0, samples.Length * 2);
                _output!.Play();
            }
        }
        catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
        {
            HandleDeviceFault(ex);
            return false;
        }

        // Drain: the provider empties as the device consumes it, then the driver
        // still holds up to one latency window of already-queued audio.
        while (true)
        {
            if (cancellationToken.IsCancellationRequested || _cancelRequested || _disposed)
            {
                return false;
            }

            int buffered;
            try
            {
                buffered = buffer.BufferedBytes;
            }
            catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
            {
                HandleDeviceFault(ex);
                return false;
            }

            if (buffered <= 0)
            {
                break;
            }

            Thread.Sleep(20);
        }

        if (!cancellationToken.IsCancellationRequested && !_cancelRequested)
        {
            Thread.Sleep(PlaybackLatencyMs);
        }

        return true;
    }

    private bool EnsureTransport()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return false;
            }

            if (_output is not null && _buffer is not null && !_transportStale)
            {
                return true;
            }
        }

        // Rebuild outside the lock: disposing a wave device can block.
        if (_transportStale)
        {
            DisposeTransport();
            _transportStale = false;
        }

        try
        {
            var buffer = new BufferedWaveProvider(
                new WaveFormat(VoiceAudio.KokoroSampleRate, 16, 1))
            {
                // 60 s of headroom; long replies stream in segment by segment.
                BufferDuration = TimeSpan.FromSeconds(60),
                DiscardOnBufferOverflow = true,
                ReadFully = true,
            };

            var output = CreateOutputDevice();

            output.Init(buffer);

            lock (_gate)
            {
                _buffer = buffer;
                _output = output;
            }

            return true;
        }
        catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
        {
            HandleDeviceFault(ex);
            return false;
        }
    }

    /// <summary>
    /// WASAPI shared mode on the default render endpoint first. The legacy waveOut
    /// device table is exactly what is broken on some machines — a pinned device
    /// index produced "BadDeviceId calling waveOutOpen" live on 2026-07-28 while
    /// the default WASAPI endpoint on the same box played fine. The fallback uses
    /// waveOut WAVE_MAPPER (-1) so Windows picks any working device, never index 0.
    /// </summary>
    private IWavePlayer CreateOutputDevice()
    {
        try
        {
            return new WasapiOut(AudioClientShareMode.Shared, PlaybackLatencyMs);
        }
        catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
        {
            Error?.Invoke(
                this,
                $"[Voice warning] WASAPI output unavailable ({ex.Message}); trying waveOut mapper.");
            return new WaveOutEvent
            {
                DeviceNumber = -1,
                DesiredLatency = PlaybackLatencyMs,
                NumberOfBuffers = 3,
            };
        }
    }

    private void DisposeTransport()
    {
        IWavePlayer? output;
        lock (_gate)
        {
            output = _output;
            _output = null;
            _buffer = null;
        }

        if (output is null)
        {
            return;
        }

        try { output.Stop(); } catch { /* device may already be gone */ }
        try { output.Dispose(); } catch { /* ignore */ }
    }

    private void HandleDeviceFault(Exception ex)
    {
        _transportStale = true;
        DisposeTransport();
        Error?.Invoke(
            this,
            $"[Voice warning] Audio output device error: {ex.Message}. "
            + "Continuing without speech; the device will be re-acquired automatically.");
    }

    private bool EnsureModelLoaded()
    {
        lock (_gate)
        {
            if (_model is not null && _voice is not null)
            {
                return true;
            }

            if (_modelFailed)
            {
                return false;
            }
        }

        // Held for the whole load, not just the check. Warmup() runs on a
        // background thread while the first Speak may arrive on another; without
        // this, both would construct their own 325 MB model and one would leak.
        lock (_loadGate)
        {
            return LoadModelOnce();
        }
    }

    private bool LoadModelOnce()
    {
        lock (_gate)
        {
            if (_model is not null && _voice is not null)
            {
                return true;
            }

            if (_modelFailed)
            {
                return false;
            }
        }

        try
        {
            PrepareAssets();

            if (!File.Exists(_modelPath))
            {
                _modelFailed = true;
                Error?.Invoke(
                    this,
                    $"[Voice warning] Kokoro model not found at {_modelPath}. "
                    + "Run desktop/scripts/get-voice-models.ps1.");
                return false;
            }

            var voice = KokoroVoiceManager.GetVoice(_voiceName);
            var model = new KokoroModel(_modelPath, null!);

            lock (_gate)
            {
                _model = model;
                _voice = voice;
            }

            return true;
        }
        catch (Exception ex)
        {
            _modelFailed = true;
            Error?.Invoke(this, $"[Voice warning] Kokoro TTS failed to load: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Point KokoroSharp at the espeak-ng binaries and speaker embeddings its
    /// NuGet package copied beside the executable.
    /// </summary>
    private void PrepareAssets()
    {
        lock (_gate)
        {
            if (_assetsPrepared)
            {
                return;
            }

            var espeak = VoiceModelPaths.EspeakDirectory;
            if (espeak is not null)
            {
                Tokenizer.eSpeakNGPath = espeak;
            }

            var voices = VoiceModelPaths.VoicesDirectory;
            if (voices is not null)
            {
                KokoroVoiceManager.LoadVoicesFromPath(voices);
            }

            _assetsPrepared = true;
        }
    }

    private void StartDeviceWatchdog()
    {
        try
        {
            var enumerator = new MMDeviceEnumerator();
            var watcher = new DeviceChangeWatcher(() => _transportStale = true);
            enumerator.RegisterEndpointNotificationCallback(watcher);

            _deviceEnumerator = enumerator;
            _deviceWatcher = watcher;
        }
        catch (Exception ex) when (WhisperSpeechRecognizer.IsDeviceFault(ex))
        {
            // Watchdog is an optimization. Without it, a device change is still
            // recovered by the fault path on the next utterance.
            Error?.Invoke(
                this,
                $"[Voice warning] Audio device watchdog unavailable: {ex.Message}");
        }
    }

    private void StopDeviceWatchdog()
    {
        try
        {
            if (_deviceEnumerator is not null && _deviceWatcher is not null)
            {
                _deviceEnumerator.UnregisterEndpointNotificationCallback(_deviceWatcher);
            }
        }
        catch
        {
            // ignore
        }

        try { _deviceEnumerator?.Dispose(); } catch { /* ignore */ }
        _deviceEnumerator = null;
        _deviceWatcher = null;
    }

    private static int SafeRenderDeviceCount()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            return enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).Count;
        }
        catch
        {
            // -1 means "unknown", which must not be read as "no speakers".
            return -1;
        }
    }

    /// <summary>
    /// Flags the playback transport as stale when Windows changes or removes the
    /// default output device. The rebuild happens on the next utterance rather
    /// than on this callback, which runs on a COM notification thread.
    /// </summary>
    private sealed class DeviceChangeWatcher : IMMNotificationClient
    {
        private readonly Action _onChanged;

        public DeviceChangeWatcher(Action onChanged)
        {
            _onChanged = onChanged;
        }

        public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
        {
            if (flow is DataFlow.Render or DataFlow.All)
            {
                _onChanged();
            }
        }

        public void OnDeviceAdded(string pwstrDeviceId) => _onChanged();

        public void OnDeviceRemoved(string deviceId) => _onChanged();

        public void OnDeviceStateChanged(string deviceId, DeviceState newState) => _onChanged();

        public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key)
        {
            // Volume and format tweaks do not invalidate the transport.
        }
    }
}

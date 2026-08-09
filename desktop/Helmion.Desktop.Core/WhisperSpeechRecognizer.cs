using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using NAudio.Wave;
using Whisper.net;

namespace Helmion.Desktop.Core;

/// <summary>
/// Continuous local speech-to-text: NAudio microphone capture at 16 kHz →
/// energy-gated endpointing → whisper.cpp (via Whisper.net) → final transcript.
/// </summary>
/// <remarks>
/// The microphone is a persistent toggle. Capture starts on
/// <see cref="Start"/> and runs until <see cref="Stop"/>; nothing in here stops
/// it on a timer. The System.Speech stack this replaced ended recognition on its
/// own after an initial-silence timeout, which is why the mic used to go dead
/// when the user paused to think.
///
/// Endpointing is energy-based for Phase 1. A frame is "speech" when it sits far
/// enough above a slowly-adapting noise floor; an utterance closes after
/// <see cref="EndSilenceMs"/> of quiet, preserving the ~750 ms end-of-phrase feel
/// of the previous engine. Transcription runs on its own worker so a slow decode
/// never drops incoming audio.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class WhisperSpeechRecognizer : IDisposable
{
    /// <summary>
    /// Quiet time that closes an utterance. Lower = snappier end-of-phrase (less lag after you stop talking).
    /// Was 420 ms; 280 ms still avoids cutting most words while shaving ~140 ms off every turn.
    /// </summary>
    public const int EndSilenceMs = 280;

    private const int FrameMs = 20;
    private const int FrameSamples = VoiceAudio.WhisperSampleRate * FrameMs / 1000;
    private const int OnsetFrames = 2;                 // 40 ms above the floor before we believe it
    private const int EndSilenceFrames = EndSilenceMs / FrameMs;
    private const int PreRollFrames = 12;              // 240 ms kept so word onsets are not clipped
    private const int MinUtteranceMs = 200;            // shorter than this is a click or a cough
    private const int MaxUtteranceMs = 20_000;         // cap long monologues for faster decode
    private const double MinSpeechThresholdDb = -45d;  // never trust a floor quieter than this
    private const double SpeechMarginDb = 10d;         // speech sits ~10 dB over room tone

    private readonly object _gate = new();
    private readonly object _loadGate = new();
    private readonly List<float> _pending = new();     // raw capture, consumed frame by frame
    private readonly List<float> _utterance = new();
    private readonly Queue<float[]> _preRoll = new();
    private readonly BlockingCollection<float[]> _toTranscribe = new(new ConcurrentQueue<float[]>());

    /// <summary>
    /// Words Whisper is told to expect before it hears anything.
    ///
    /// <para>
    /// Whisper takes an "initial prompt" that biases decoding toward words it
    /// would otherwise never guess, because they are not English. Without it,
    /// 2026-07-30: Troy dictated for hours and got "Hellmian" for Helmion,
    /// "Krakora" for Kokoro, "boys" for voice and "Caroco" for Kokoro again.
    /// Upgrading the model from base.en to small.en did NOT fix those, which is
    /// what proved the model was never the problem. This recognizer had no prompt
    /// at all - the word "Helmion" did not appear anywhere in this file.
    /// </para>
    /// <para>
    /// A sibling tool (tools/voice-dictation) already had a vocabulary list, which
    /// is why this looked covered. It is a DIFFERENT PROGRAM and Troy does not run
    /// it. The list here is the one that reaches his microphone.
    /// </para>
    /// <para>
    /// Whisper only reads roughly the last 224 tokens of the prompt and weights
    /// later terms more heavily, so the words he says most often go LAST.
    /// </para>
    /// </summary>
    /// <remarks>
    /// MEASURED 2026-07-30, live, by the operator dictating into it: with this
    /// prompt "Helmion" came out correct first try, having been "Hellmian" without
    /// it. "Kokoro" landed once then came back as "Kokoroar", so it appears TWICE
    /// and in a full sentence — a bare comma list gives Whisper no grammar to
    /// settle a word ending into, and the tail of the prompt is what it weights
    /// most. The two words he says constantly are last on purpose.
    /// </remarks>
    public const string VocabularyPrompt =
        "Glanbia, Chobani, Lactalis, DFA, Caldmere, SiteVector, Vercel, Fly.io, "
        + "Neon, Clerk, Ollama, ONNX, WASAPI, MCP, LLM, Ably, Herald, Discord, Slack, "
        + "GitHub, Whisper, Qwen, Gemini, ChatGPT, Codex, Maestro, DairyForge, AimForge, "
        + "ThinkinBuddy, Claude, Grok, Cora, Brandon. "
        + "Helmian Room is local chat. Guard blocks destructive commands. "
        + "Helmion uses Kokoro for speech and Whisper for listening. "
        + "We are talking about Helmion and Kokoro.";

    private readonly string _modelPath;
    private WhisperFactory? _factory;
    private WhisperProcessor? _processor;

    private WaveInEvent? _capture;
    private Task? _transcriber;
    private CancellationTokenSource? _transcribeCts;

    private bool _running;      // capturing AND not suspended
    private bool _suspended;    // paused for TTS; device stays open
    private bool _disposed;
    private bool _modelFailed;  // load failed once; do not retry on every utterance

    private double _noiseFloorDb = -60d;
    private int _speechFrames;
    private int _silenceFrames;
    private bool _inUtterance;

    public WhisperSpeechRecognizer(string modelPath)
    {
        _modelPath = modelPath;
    }

    public event EventHandler<string>? SpeechRecognized;

    public event EventHandler? SpeechDetected;

    public event EventHandler<string>? Error;

    public event EventHandler? Stopped;

    /// <summary>True while the microphone is capturing and not suspended for TTS.</summary>
    public bool IsRunning
    {
        get { lock (_gate) return _running && !_suspended; }
    }

    /// <summary>
    /// Start or resume capture. Safe to call repeatedly — resuming after
    /// <see cref="Pause"/> reuses the open device rather than reopening it,
    /// which is where most device faults come from.
    /// </summary>
    public void Start()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            if (_capture is not null)
            {
                ResetVadLocked();
                _suspended = false;
                _running = true;
                return;
            }
        }

        if (!EnsureModelLoaded())
        {
            return;
        }

        try
        {
            var capture = new WaveInEvent
            {
                WaveFormat = new WaveFormat(VoiceAudio.WhisperSampleRate, 16, 1),
                BufferMilliseconds = 50,
                NumberOfBuffers = 3,
            };

            capture.DataAvailable += OnDataAvailable;
            capture.RecordingStopped += OnRecordingStopped;

            var cts = new CancellationTokenSource();
            var worker = Task.Run(() => TranscribeLoop(cts.Token));

            capture.StartRecording();

            lock (_gate)
            {
                _capture = capture;
                _transcribeCts = cts;
                _transcriber = worker;
                _suspended = false;
                _running = true;
                ResetVadLocked();
            }
        }
        catch (Exception ex) when (IsDeviceFault(ex))
        {
            lock (_gate)
            {
                _running = false;
            }

            SafeDisposeCapture();
            Error?.Invoke(
                this,
                $"Mic unavailable: {ex.Message}. "
                + "Windows Settings → Privacy → Microphone → allow desktop apps, "
                + "then set a default input device.");
        }
    }

    /// <summary>
    /// Suspend recognition while TTS plays. The device stays open so resuming is
    /// instant; audio captured meanwhile is discarded rather than transcribed.
    /// </summary>
    public void Pause()
    {
        lock (_gate)
        {
            _suspended = true;
            _running = false;
            ResetVadLocked();
        }
    }

    /// <summary>Stop capture and release the microphone.</summary>
    public void Stop()
    {
        lock (_gate)
        {
            _running = false;
            _suspended = false;
            ResetVadLocked();
        }

        SafeDisposeCapture();
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

        Stop();

        try
        {
            _transcribeCts?.Cancel();
            _toTranscribe.CompleteAdding();
        }
        catch
        {
            // Nothing actionable — we are tearing down.
        }

        try
        {
            _transcriber?.Wait(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // A stuck decode must not block app shutdown.
        }

        try { _processor?.Dispose(); } catch { /* ignore */ }
        try { _factory?.Dispose(); } catch { /* ignore */ }
        try { _transcribeCts?.Dispose(); } catch { /* ignore */ }
        try { _toTranscribe.Dispose(); } catch { /* ignore */ }
    }

    /// <summary>
    /// Load Whisper on a background path so the first spoken phrase is not stalled
    /// by model I/O. Safe to call repeatedly; failures set Degraded via Error.
    /// </summary>
    public void Warmup() => EnsureModelLoaded();

    /// <summary>
    /// Transcribe a WAV file through the same model and processor the microphone
    /// uses. This is the headless test entry point — it exists so the STT path can
    /// be proven without a human at a microphone.
    /// </summary>
    public string TranscribeWavFile(string wavPath)
    {
        if (!File.Exists(wavPath))
        {
            throw new FileNotFoundException("WAV file not found.", wavPath);
        }

        if (!EnsureModelLoaded())
        {
            return string.Empty;
        }

        var samples = VoiceAudio.ReadWavAsSamples(wavPath);
        return TranscribeSamples(samples);
    }

    /// <summary>Run 16 kHz mono float samples through Whisper and join the segments.</summary>
    public string TranscribeSamples(float[] samples)
    {
        if (samples.Length == 0 || !EnsureModelLoaded())
        {
            return string.Empty;
        }

        var processor = _processor;
        if (processor is null)
        {
            return string.Empty;
        }

        var text = new System.Text.StringBuilder();
        foreach (var segment in EnumerateSegments(processor, samples))
        {
            text.Append(segment);
        }

        return text.ToString().Trim();
    }

    private static IEnumerable<string> EnumerateSegments(WhisperProcessor processor, float[] samples)
    {
        // Whisper.net exposes only an async stream; this recognizer's callers are
        // synchronous, and the decode already runs on a dedicated worker.
        var results = new List<string>();
        var task = Task.Run(async () =>
        {
            await foreach (var segment in processor.ProcessAsync(samples).ConfigureAwait(false))
            {
                results.Add(segment.Text);
            }
        });

        task.GetAwaiter().GetResult();
        return results;
    }

    private bool EnsureModelLoaded()
    {
        lock (_gate)
        {
            if (_processor is not null)
            {
                return true;
            }
        }

        // Held for the whole load. Start() and the transcription worker can both
        // reach this; loading outside a lock would build two whisper contexts.
        lock (_loadGate)
        {
            return LoadModelOnce();
        }
    }

    private bool LoadModelOnce()
    {
        lock (_gate)
        {
            if (_processor is not null)
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
            if (!File.Exists(_modelPath))
            {
                lock (_gate)
                {
                    _modelFailed = true;
                }

                Error?.Invoke(
                    this,
                    $"Whisper model not found at {_modelPath}. "
                    + "Run desktop/scripts/get-voice-models.ps1.");
                return false;
            }

            var factory = WhisperFactory.FromPath(_modelPath);
            // Latency: English-only, no cross-utterance context, single segment.
            // Prompt stays — accuracy fix for Helmion/Kokoro names (2026-07-30).
            var processor = factory.CreateBuilder()
                .WithLanguage("en")
                .WithNoContext()
                .WithSingleSegment()
                .WithTemperature(0f)
                .WithPrompt(VocabularyPrompt)
                .Build();

            lock (_gate)
            {
                _factory = factory;
                _processor = processor;
            }

            return true;
        }
        catch (Exception ex)
        {
            lock (_gate)
            {
                _modelFailed = true;
            }

            Error?.Invoke(this, $"Whisper model failed to load: {ex.Message}");
            return false;
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        try
        {
            lock (_gate)
            {
                if (!_running || _suspended || _disposed)
                {
                    return;
                }

                VoiceAudio.Pcm16ToFloat(e.Buffer, e.BytesRecorded, _pending);
                DrainFramesLocked();
            }
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"Mic capture error: {ex.Message}");
        }
    }

    /// <summary>Consume whole frames out of the pending buffer and run the VAD over them.</summary>
    private void DrainFramesLocked()
    {
        var consumed = 0;
        while (_pending.Count - consumed >= FrameSamples)
        {
            var level = VoiceAudio.RmsDb(_pending, consumed, FrameSamples);
            var threshold = Math.Max(_noiseFloorDb + SpeechMarginDb, MinSpeechThresholdDb);
            var isSpeech = level > threshold;

            var frame = new float[FrameSamples];
            _pending.CopyTo(consumed, frame, 0, FrameSamples);
            consumed += FrameSamples;

            if (isSpeech)
            {
                _silenceFrames = 0;
                _speechFrames++;

                if (!_inUtterance)
                {
                    if (_speechFrames < OnsetFrames)
                    {
                        StashPreRollLocked(frame);
                        continue;
                    }

                    // Onset confirmed — open the utterance with the pre-roll so the
                    // first consonant is not sliced off.
                    _inUtterance = true;
                    while (_preRoll.Count > 0)
                    {
                        _utterance.AddRange(_preRoll.Dequeue());
                    }

                    SpeechDetected?.Invoke(this, EventArgs.Empty);
                }

                _utterance.AddRange(frame);

                if (_utterance.Count >= VoiceAudio.WhisperSampleRate * MaxUtteranceMs / 1000)
                {
                    CloseUtteranceLocked();
                }

                continue;
            }

            // Quiet frame. Adapt the noise floor only here, so a long sentence
            // never drags the threshold up over the speaker's own voice.
            _noiseFloorDb = (_noiseFloorDb * 0.995d) + (level * 0.005d);
            _speechFrames = 0;

            if (!_inUtterance)
            {
                StashPreRollLocked(frame);
                continue;
            }

            _utterance.AddRange(frame);
            _silenceFrames++;
            if (_silenceFrames >= EndSilenceFrames)
            {
                CloseUtteranceLocked();
            }
        }

        if (consumed > 0)
        {
            _pending.RemoveRange(0, consumed);
        }
    }

    private void StashPreRollLocked(float[] frame)
    {
        _preRoll.Enqueue(frame);
        while (_preRoll.Count > PreRollFrames)
        {
            _preRoll.Dequeue();
        }
    }

    private void CloseUtteranceLocked()
    {
        var minSamples = VoiceAudio.WhisperSampleRate * MinUtteranceMs / 1000;
        if (_utterance.Count >= minSamples)
        {
            try
            {
                _toTranscribe.Add(_utterance.ToArray());
            }
            catch (InvalidOperationException)
            {
                // Queue closed during shutdown.
            }
        }

        _utterance.Clear();
        _preRoll.Clear();
        _inUtterance = false;
        _speechFrames = 0;
        _silenceFrames = 0;
    }

    private void ResetVadLocked()
    {
        _pending.Clear();
        _utterance.Clear();
        _preRoll.Clear();
        _inUtterance = false;
        _speechFrames = 0;
        _silenceFrames = 0;
    }

    private void TranscribeLoop(CancellationToken cancellationToken)
    {
        try
        {
            foreach (var samples in _toTranscribe.GetConsumingEnumerable(cancellationToken))
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return;
                }

                string text;
                try
                {
                    text = TranscribeSamples(samples);
                }
                catch (Exception ex)
                {
                    Error?.Invoke(this, $"Transcription failed: {ex.Message}");
                    continue;
                }

                if (string.IsNullOrWhiteSpace(text) || text.Trim().Length < 2)
                {
                    continue;
                }

                // Whisper emits these for silence and background noise.
                var normalized = text.Trim();
                if (normalized.StartsWith('[') || normalized.StartsWith('('))
                {
                    continue;
                }

                lock (_gate)
                {
                    if (!_running || _suspended || _disposed)
                    {
                        continue;
                    }
                }

                SpeechRecognized?.Invoke(this, normalized);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown.
        }
        catch (Exception ex)
        {
            Error?.Invoke(this, $"Transcription worker stopped: {ex.Message}");
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is not null)
        {
            // An unexpected stop (device unplugged, driver reset, exclusive-mode
            // grab) leaves a dead WaveInEvent in _capture. Start() short-circuits
            // on `_capture is not null` (:99-105) and would flip _running back to
            // true without reopening anything — IsRunning then reports true over a
            // microphone that produces no audio, and the UI says "Listening".
            // Releasing it here is what makes the next Start() actually reopen the
            // device. Safe to call from this callback: SafeDisposeCapture nulls
            // _capture under the lock before touching the device, so a re-entrant
            // RecordingStopped finds nothing to dispose and returns.
            lock (_gate)
            {
                _running = false;
            }

            SafeDisposeCapture();
            Error?.Invoke(this, $"Microphone stopped: {e.Exception.Message}");
        }

        Stopped?.Invoke(this, EventArgs.Empty);
    }

    private void SafeDisposeCapture()
    {
        WaveInEvent? capture;
        lock (_gate)
        {
            capture = _capture;
            _capture = null;
        }

        if (capture is null)
        {
            return;
        }

        try { capture.StopRecording(); } catch { /* device may already be gone */ }

        try
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.RecordingStopped -= OnRecordingStopped;
        }
        catch
        {
            // ignore
        }

        try { capture.Dispose(); } catch { /* ignore */ }
    }

    /// <summary>
    /// Faults that mean "the audio device is missing or busy" rather than a bug.
    /// These degrade the voice stack; they never propagate to the UI thread.
    /// </summary>
    internal static bool IsDeviceFault(Exception ex) =>
        ex is COMException
        or InvalidOperationException
        or NAudio.MmException
        or UnauthorizedAccessException
        or DllNotFoundException;
}

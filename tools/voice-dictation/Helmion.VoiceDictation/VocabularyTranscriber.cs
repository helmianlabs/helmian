using System.Collections.Concurrent;
using System.Text;
using Whisper.net;

namespace Helmion.VoiceDictation;

/// <summary>
/// Whisper speech-to-text biased toward Troy's vocabulary.
/// </summary>
/// <remarks>
/// This is the reason the tool exists. Windows dictation turns "Helmion" into
/// "Helmand", "Moshi" into "Moshe" and "LLMs" into "LL Mississippi" because it
/// has no idea those words are in play. Whisper accepts an initial prompt that is
/// decoded as if it were the start of the transcript, which biases the decoder
/// toward the spellings it contains
/// (developers.openai.com/cookbook/examples/whisper_prompting_guide).
///
/// Three builder calls carry that:
///   WithPrompt(prompt)            — the vocabulary itself.
///   WithCarryInitialPrompt(true)  — re-applies it to EVERY 30 s decode window,
///                                   not just the first. Dictation runs long;
///                                   without this, everything Troy says after the
///                                   first half-minute loses the bias.
///   WithNoContext()               — drops carry-over from the PREVIOUS dictation
///                                   so an earlier mis-hear cannot compound. It
///                                   sets an independent option and does not
///                                   cancel WithPrompt.
///
/// WithSingleSegment is deliberately NOT used, unlike the Pilot's recogniser
/// (WhisperSpeechRecognizer.cs:336). It forces one segment out of one decode
/// window, which is right for a short conversational utterance and would silently
/// truncate a two-minute dictation to its first 30 seconds.
/// </remarks>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class VocabularyTranscriber : IDisposable
{
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, WhisperProcessor> _processors = new(StringComparer.Ordinal);
    private readonly string _modelPath;
    private readonly string _defaultPrompt;

    private WhisperFactory? _factory;
    private bool _loadFailed;
    private bool _disposed;

    public VocabularyTranscriber(string modelPath, string defaultPrompt)
    {
        _modelPath = modelPath;
        _defaultPrompt = defaultPrompt ?? string.Empty;
    }

    public string ModelPath => _modelPath;

    public string DefaultPrompt => _defaultPrompt;

    /// <summary>Set once a load has failed, so the failure is not retried per utterance.</summary>
    public bool LoadFailed
    {
        get { lock (_gate) { return _loadFailed; } }
    }

    /// <summary>
    /// Locate ggml-base.en.bin. Order: explicit config path, then the
    /// HELMION_VOICE_MODELS override the Pilot already honours
    /// (desktop/Helmion.Desktop.Core/VoiceModelPaths.cs:11), then models/ beside
    /// this executable, then a walk up the tree to desktop/models — which is how
    /// a build running out of bin/Debug finds the 141 MB file without a copy.
    /// </summary>
    public static string? ResolveModelPath(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        const string fileName = "ggml-base.en.bin";

        var env = Environment.GetEnvironmentVariable("HELMION_VOICE_MODELS");
        if (!string.IsNullOrWhiteSpace(env))
        {
            var fromEnv = Path.Combine(env, fileName);
            if (File.Exists(fromEnv))
            {
                return fromEnv;
            }
        }

        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; directory is not null && depth < 10; depth++, directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "models", fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            var desktopCandidate = Path.Combine(directory.FullName, "desktop", "models", fileName);
            if (File.Exists(desktopCandidate))
            {
                return desktopCandidate;
            }
        }

        return null;
    }

    /// <summary>
    /// Load the model ahead of the first hotkey press. Whisper's first decode
    /// otherwise pays the load cost while Troy is waiting for his words.
    /// </summary>
    public bool Warmup()
    {
        try
        {
            return GetProcessor(_defaultPrompt) is not null;
        }
        catch (Exception ex)
        {
            DictationLog.Error("Whisper warmup failed", ex);
            return false;
        }
    }

    /// <summary>Transcribe 16 kHz mono samples using the configured vocabulary prompt.</summary>
    public string Transcribe(float[] samples) => Transcribe(samples, _defaultPrompt);

    /// <summary>
    /// Transcribe with an explicit prompt. The self-test uses this to run the same
    /// audio with the vocabulary prompt and with an empty one, which is what makes
    /// the vocabulary claim measurable rather than asserted.
    /// </summary>
    public string Transcribe(float[] samples, string prompt)
    {
        if (samples.Length == 0)
        {
            return string.Empty;
        }

        WhisperProcessor? processor;
        try
        {
            processor = GetProcessor(prompt);
        }
        catch (Exception ex)
        {
            DictationLog.Error("Whisper processor unavailable", ex);
            return string.Empty;
        }

        if (processor is null)
        {
            return string.Empty;
        }

        try
        {
            var text = new StringBuilder();
            var task = Task.Run(async () =>
            {
                await foreach (var segment in processor.ProcessAsync(samples).ConfigureAwait(false))
                {
                    text.Append(segment.Text);
                }
            });

            // TROY-APPROVED 2026-08-08 — VERIFIED 2026-08-08: a real 193.80s
            // recording hung mid-decode past 76+ seconds with no error and no
            // way out except manually killing the process; the hotkey just
            // logged "ignored — still transcribing" forever. whisper.net's
            // ProcessAsync exposes no cancellation token this build can pass
            // in, so this cannot make the native decode actually stop — but it
            // guarantees THIS CALL returns, which frees _busy in DictationHost
            // so the next hotkey press works again instead of needing a kill.
            // Budget is generous (60s floor, or 3x the measured worst case of
            // ~1s decode per 20s audio) because a real long dictation must
            // still be allowed to finish normally.
            var budget = TimeSpan.FromSeconds(Math.Max(60, samples.Length / (double)MicRecorder.SampleRate * 3));
            var winner = Task.WhenAny(task, Task.Delay(budget)).GetAwaiter().GetResult();

            if (winner != task)
            {
                DictationLog.Error(
                    $"Transcription did not finish within {budget.TotalSeconds:F0}s "
                    + $"({samples.Length / (double)MicRecorder.SampleRate:F1}s of audio) — "
                    + "abandoning this decode so the app stays usable. The stuck native "
                    + "call keeps running in the background and its output is discarded.");
                return string.Empty;
            }

            return Clean(text.ToString());
        }
        catch (Exception ex)
        {
            DictationLog.Error("Transcription failed", ex);
            return string.Empty;
        }
    }

    /// <summary>Transcribe a WAV file. The headless entry point — no microphone involved.</summary>
    public string TranscribeWavFile(string wavPath, string? prompt = null)
    {
        if (!File.Exists(wavPath))
        {
            DictationLog.Error($"WAV not found: {wavPath}");
            return string.Empty;
        }

        return Transcribe(
            DictationAudio.ReadWavAsSamples(wavPath),
            prompt ?? _defaultPrompt);
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

        foreach (var processor in _processors.Values)
        {
            try { processor.Dispose(); } catch { /* ignore */ }
        }

        _processors.Clear();
        try { _factory?.Dispose(); } catch { /* ignore */ }
    }

    /// <summary>
    /// One processor per distinct prompt, cached. The prompt is baked in at build
    /// time, so switching prompts means a second processor — but both share the
    /// single 141 MB factory, so the model is loaded exactly once.
    /// </summary>
    private WhisperProcessor? GetProcessor(string prompt)
    {
        var key = prompt ?? string.Empty;

        if (_processors.TryGetValue(key, out var existing))
        {
            return existing;
        }

        lock (_gate)
        {
            if (_disposed || _loadFailed)
            {
                return null;
            }

            if (_processors.TryGetValue(key, out existing))
            {
                return existing;
            }

            if (_factory is null)
            {
                if (!File.Exists(_modelPath))
                {
                    _loadFailed = true;
                    DictationLog.Error(
                        $"Whisper model not found at {_modelPath}. "
                        + "Run desktop/scripts/get-voice-models.ps1.");
                    return null;
                }

                try
                {
                    _factory = WhisperFactory.FromPath(_modelPath);
                }
                catch (Exception ex)
                {
                    _loadFailed = true;
                    DictationLog.Error("Whisper model failed to load", ex);
                    return null;
                }
            }

            try
            {
                // Measured on this box (GTX 1660 Ti, 16 logical cores): whisper.cpp's
                // own default thread count (4) decoded a 14 s clip in 5.24 s; forcing
                // ProcessorCount (16) cut that to 3.11 s on the SAME clip. CUDA was
                // tried and rejected — Whisper.net.Runtime.Cuda's ggml-cuda-whisper.dll
                // hard-crashes at native init on this Turing card
                // (GGML_ASSERT(prev != ggml_uncaught_exception), ggml.cpp:22) even with
                // Ollama's own cudart64_12.dll/cublas64_12.dll made available — not a
                // safe path here. Threads is the real, measured win.
                var builder = _factory.CreateBuilder()
                    .WithLanguage("en")
                    .WithThreads(Environment.ProcessorCount)
                    .WithNoContext();

                if (!string.IsNullOrWhiteSpace(key))
                {
                    builder = builder
                        .WithPrompt(key)
                        .WithCarryInitialPrompt(true);
                }

                var processor = builder.Build();
                _processors[key] = processor;
                return processor;
            }
            catch (Exception ex)
            {
                _loadFailed = true;
                DictationLog.Error("Whisper processor could not be built", ex);
                return null;
            }
        }
    }

    /// <summary>
    /// Strip the bracketed non-speech tags Whisper emits for silence and noise
    /// ("[BLANK_AUDIO]", "(wind blowing)"), and collapse the leading space every
    /// segment carries. What is left is what gets typed into his terminal.
    /// </summary>
    private static string Clean(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(raw.Length);
        var depthSquare = 0;
        var depthRound = 0;

        foreach (var ch in raw)
        {
            switch (ch)
            {
                case '[': depthSquare++; continue;
                case ']': if (depthSquare > 0) { depthSquare--; } continue;
                case '(': depthRound++; continue;
                case ')': if (depthRound > 0) { depthRound--; } continue;
            }

            if (depthSquare == 0 && depthRound == 0)
            {
                builder.Append(ch);
            }
        }

        var collapsed = builder.ToString().Trim();
        while (collapsed.Contains("  ", StringComparison.Ordinal))
        {
            collapsed = collapsed.Replace("  ", " ", StringComparison.Ordinal);
        }

        return collapsed;
    }
}

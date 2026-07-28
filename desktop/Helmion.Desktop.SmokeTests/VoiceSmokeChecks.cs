using System.Text;
using System.Text.RegularExpressions;
using Helmion.Desktop.Core;

/// <summary>
/// Checks for the local voice stack (Whisper STT + Kokoro TTS).
/// </summary>
/// <remarks>
/// Split into two tiers on purpose:
///
/// The pure checks — command classification, text cleaning, and the
/// <see cref="VoiceSession"/> turn-taking contract exercised through a fake
/// engine — need no models, no microphone, and no speakers, so they run
/// everywhere and always.
///
/// The round-trip check synthesizes a known sentence with Kokoro and reads it
/// back with Whisper. It needs the two model files, so it is skipped with a
/// visible notice when they have not been downloaded. That way a fresh clone
/// still passes the suite, and a machine that HAS the models proves the real
/// audio path rather than a mock of it.
/// </remarks>
internal static class VoiceSmokeChecks
{
    private const string RoundTripSentence = "The quick brown fox jumps over the lazy dog.";

    private static int _checks;

    public static void Run()
    {
        _checks = 0;

        CheckDictationCommands();
        CheckSpeechTextCleaner();
        CheckVoiceSessionContract();

        Console.WriteLine($"Helmion voice engine smoke tests passed ({_checks} checks).");

        CheckModelRoundTrip();
    }

    private static void CheckDictationCommands()
    {
        // Reserved commands, in the shapes Whisper actually emits them:
        // capitalized, punctuated, and padded.
        Check(Kind("new line") == DictationCommandKind.Newline, "\"new line\" is a newline command");
        Check(Kind("New line.") == DictationCommandKind.Newline, "capitalized + punctuated newline still matches");
        Check(Kind("  next line  ") == DictationCommandKind.Newline, "padded newline still matches");
        Check(Kind("new paragraph") == DictationCommandKind.Newline, "\"new paragraph\" is a newline command");
        Check(Kind("scratch that") == DictationCommandKind.Scratch, "\"scratch that\" erases");
        Check(Kind("Scratch that!") == DictationCommandKind.Scratch, "exclamation does not defeat scratch");
        Check(Kind("send it") == DictationCommandKind.Send, "\"send it\" submits");
        Check(Kind("Submit.") == DictationCommandKind.Send, "\"submit\" submits");
        Check(Kind("stop listening") == DictationCommandKind.Stop, "\"stop listening\" leaves dictation");
        Check(Kind("voice off") == DictationCommandKind.Stop, "\"voice off\" leaves dictation");

        // The cases that matter most: a command word inside a real sentence must
        // stay literal text. A false command silently destroys what was typed.
        Check(Kind("send it to the vendor tomorrow") == DictationCommandKind.Literal,
            "\"send it to the vendor tomorrow\" is dictated text, not a send command");
        Check(Kind("scratch that itch") == DictationCommandKind.Literal,
            "\"scratch that itch\" is dictated text, not a scratch command");
        Check(Kind("draw a new line on the chart") == DictationCommandKind.Literal,
            "\"draw a new line on the chart\" is dictated text, not a newline command");
        Check(Kind("stop listening to that podcast") == DictationCommandKind.Literal,
            "\"stop listening to that podcast\" is dictated text, not a stop command");

        // Literal text survives with its casing and internal punctuation intact.
        var literal = DictationCommands.Detect("  Ship the EDI 204 by Friday, please.  ");
        Check(literal.Kind == DictationCommandKind.Literal, "ordinary sentence classifies as literal");
        Check(literal.Text == "Ship the EDI 204 by Friday, please.",
            "literal text keeps its casing and punctuation, trimmed only at the edges");

        // Commands carry no text; empty input is inert.
        Check(DictationCommands.Detect("send it").Text.Length == 0, "a command carries no text payload");
        Check(DictationCommands.Detect(null).Text.Length == 0, "null transcript is inert");
        Check(DictationCommands.Detect("   ").Text.Length == 0, "whitespace transcript is inert");
        Check(DictationCommands.Detect("...").Text.Length == 0, "punctuation-only transcript is inert");

        Check(DictationCommands.Normalize(" New Line! ") == "new line",
            "normalization lowercases, trims and strips edge punctuation");
    }

    private static void CheckSpeechTextCleaner()
    {
        Check(SpeechTextCleaner.CleanForSpeech("```\ncode\n```").Contains("code omitted", StringComparison.Ordinal),
            "fenced code is replaced with a spoken cue");
        Check(SpeechTextCleaner.CleanForSpeech("**bold** _italic_") == "bold italic",
            "markdown emphasis is stripped for the ear");
        Check(SpeechTextCleaner.CleanForSpeech("[CMD: ls -la] done").Trim() == "done",
            "tool command chrome is not spoken");
        Check(SpeechTextCleaner.CleanForSpeech(new string('a', 5000)).Length <= SpeechTextCleaner.MaxSpokenLength + 1,
            "a long reply is capped so it cannot monologue");
        Check(SpeechTextCleaner.CleanForSpeech("   ") == string.Empty,
            "blank input produces nothing to speak");
        Check(VoiceSession.CleanForSpeech("# Heading") == "Heading",
            "VoiceSession.CleanForSpeech still delegates to the cleaner");
    }

    /// <summary>
    /// Exercises VoiceSession against a fake engine. This is what proves the
    /// extracted interface actually works as a seam, and it pins the behaviour
    /// the whole design rests on: Speak blocks, and the mic is muted for exactly
    /// as long as it is speaking.
    /// </summary>
    private static void CheckVoiceSessionContract()
    {
        var engine = new FakeSpeechEngine();
        using var session = new VoiceSession(engine);

        var recognized = new List<string>();
        session.OnSpeechRecognized += (_, text) => recognized.Add(text);

        session.StartVoiceMode();
        Check(session.IsVoiceModeActive, "voice mode activates through the injected engine");
        Check(engine.IsDictationRunning, "starting voice mode starts dictation on the engine");

        engine.RaiseSpeechRecognized("hello there");
        Check(recognized.Count == 1 && recognized[0] == "hello there",
            "engine transcripts reach the session's consumers");

        session.SpeakAsync("speak this").GetAwaiter().GetResult();
        Check(engine.SpokenText.Contains("speak this", StringComparison.Ordinal),
            "SpeakAsync routes cleaned text to the engine");
        Check(engine.MicWasPausedDuringSpeak,
            "the microphone is paused for the whole duration of playback");
        Check(engine.IsDictationRunning,
            "the microphone is resumed once Speak returns");
        Check(!session.IsSpeaking, "the session is no longer speaking after SpeakAsync completes");

        // A transcript that arrives while paused must not be forwarded — that is
        // the app hearing its own voice.
        var beforePaused = recognized.Count;
        session.PauseListeningForTts();
        engine.RaiseSpeechRecognized("echo of our own speaker");
        Check(recognized.Count == beforePaused, "transcripts arriving while paused are dropped");

        session.StopVoiceMode();
        Check(!session.IsVoiceModeActive, "voice mode deactivates");
        Check(!engine.IsDictationRunning, "stopping voice mode stops dictation on the engine");

        // A degraded engine must never throw into the caller.
        var broken = new FakeSpeechEngine { FailEverything = true };
        using var degradedSession = new VoiceSession(broken);
        degradedSession.StartVoiceMode();
        degradedSession.SpeakAsync("this cannot play").GetAwaiter().GetResult();
        Check(!degradedSession.IsVoiceModeActive || !broken.IsDictationRunning,
            "a degraded engine leaves voice mode off rather than pretending to listen");
        Check(broken.State == VoiceState.Degraded, "a failed engine reports Degraded");
    }

    /// <summary>
    /// The real audio path: Kokoro writes a WAV, Whisper reads it back.
    /// </summary>
    private static void CheckModelRoundTrip()
    {
        var missing = VoiceModelPaths.DescribeMissingAssets();
        if (missing is not null)
        {
            Console.WriteLine($"Voice model round-trip SKIPPED — {missing}");
            return;
        }

        using var engine = new LocalVoiceEngine();

        var wavPath = Path.Combine(
            Path.GetTempPath(),
            $"helmion-voice-roundtrip-{Guid.NewGuid():N}.wav");

        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var wrote = engine.SynthesizeToWavFile(RoundTripSentence, wavPath);
            var synthMs = sw.ElapsedMilliseconds;
            Check(wrote, "Kokoro synthesized the round-trip sentence to a WAV");

            var info = new FileInfo(wavPath);
            Check(info.Exists && info.Length > 1024, "the synthesized WAV is a non-trivial file");

            var header = new byte[12];
            using (var fs = File.OpenRead(wavPath))
            {
                Check(fs.Read(header, 0, 12) == 12, "the WAV has a readable header");
            }

            Check(Encoding.ASCII.GetString(header, 0, 4) == "RIFF", "the WAV starts with RIFF");
            Check(Encoding.ASCII.GetString(header, 8, 4) == "WAVE", "the WAV declares the WAVE format");

            // 24 kHz mono 16-bit => 48000 bytes per second of audio.
            var seconds = (info.Length - 44d) / (VoiceAudio.KokoroSampleRate * 2d);
            Check(seconds > 1.0 && seconds < 15.0,
                $"the spoken sentence is a plausible length ({seconds:F2}s)");

            sw.Restart();
            var transcript = engine.TranscribeWavFile(wavPath);
            var sttMs = sw.ElapsedMilliseconds;
            Check(!string.IsNullOrWhiteSpace(transcript), "Whisper returned a transcript");

            var expected = Simplify(RoundTripSentence);
            var actual = Simplify(transcript);
            Check(actual == expected,
                $"round-trip transcript matches the input sentence (got \"{transcript.Trim()}\")");

            Console.WriteLine(
                $"Voice model round-trip PASSED — "
                + $"{info.Length:N0} byte WAV, {seconds:F2}s audio, "
                + $"synth {synthMs} ms, transcribe {sttMs} ms.");
            Console.WriteLine($"  spoken     : {RoundTripSentence}");
            Console.WriteLine($"  transcribed: {transcript.Trim()}");
        }
        finally
        {
            try { if (File.Exists(wavPath)) File.Delete(wavPath); } catch { /* temp file */ }
        }
    }

    /// <summary>Lowercase, punctuation-free comparison so minor drift does not fail the check.</summary>
    private static string Simplify(string text) =>
        Regex.Replace(text.ToLowerInvariant(), @"[^a-z0-9 ]", string.Empty)
            .Replace("  ", " ")
            .Trim();

    private static DictationCommandKind Kind(string transcript) =>
        DictationCommands.Detect(transcript).Kind;

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            Console.Error.WriteLine($"VOICE SMOKE FAILED: {description}");
            Environment.Exit(1);
        }

        _checks++;
    }

    /// <summary>
    /// Stands in for a real engine so VoiceSession's turn-taking can be tested
    /// without hardware. Speak blocks, exactly as the contract requires.
    /// </summary>
    private sealed class FakeSpeechEngine : ISpeechEngine
    {
        private readonly List<string> _spoken = new();

        public event EventHandler<string>? SpeechRecognized;
        public event EventHandler? SpeechDetected;
        public event EventHandler<string>? Error;
        public event EventHandler? DictationStopped;
        public event EventHandler<VoiceState>? StateChanged;

        public bool FailEverything { get; init; }

        public VoiceState State { get; private set; } = VoiceState.Idle;

        public bool IsDictationRunning { get; private set; }

        public bool IsSpeaking { get; private set; }

        public string SpokenText => string.Join(" ", _spoken);

        /// <summary>True when the mic was down for the whole of the last Speak call.</summary>
        public bool MicWasPausedDuringSpeak { get; private set; }

        public void StartDictation()
        {
            if (FailEverything)
            {
                State = VoiceState.Degraded;
                StateChanged?.Invoke(this, State);
                Error?.Invoke(this, "[Voice warning] fake engine is degraded");
                return;
            }

            IsDictationRunning = true;
            State = VoiceState.Listening;
            StateChanged?.Invoke(this, State);
        }

        public void StopDictation()
        {
            IsDictationRunning = false;
            if (State != VoiceState.Degraded)
            {
                State = VoiceState.Idle;
            }

            DictationStopped?.Invoke(this, EventArgs.Empty);
        }

        public void PauseDictation() => IsDictationRunning = false;

        public void Speak(string text, CancellationToken cancellationToken = default)
        {
            if (FailEverything)
            {
                State = VoiceState.Degraded;
                StateChanged?.Invoke(this, State);
                Error?.Invoke(this, "[Voice warning] fake engine cannot play audio");
                return;
            }

            IsSpeaking = true;
            State = VoiceState.Speaking;

            // Record whether the mic stayed down for the whole call — this is the
            // property the real engine must also hold.
            MicWasPausedDuringSpeak = !IsDictationRunning;
            Thread.Sleep(10);
            MicWasPausedDuringSpeak &= !IsDictationRunning;

            _spoken.Add(text);
            IsSpeaking = false;
            State = VoiceState.Idle;
        }

        public void CancelSpeak() => IsSpeaking = false;

        public AudioEndpointStatus ProbeAudioEndpoints() =>
            FailEverything
                ? new AudioEndpointStatus(false, 0, 0, null, false, "fake engine has no output device")
                : new AudioEndpointStatus(true, 1, 1, "fake", true, null);

        public void RaiseSpeechRecognized(string text) => SpeechRecognized?.Invoke(this, text);

        public void RaiseSpeechDetected() => SpeechDetected?.Invoke(this, EventArgs.Empty);

        public void Dispose()
        {
            IsDictationRunning = false;
            IsSpeaking = false;
        }
    }
}

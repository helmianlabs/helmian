namespace Helmion.Desktop.Core;

/// <summary>What a conversation-mode host should do with one dictated utterance.</summary>
public enum TurnOutcome
{
    /// <summary>Silence, noise, or an empty transcript. Do nothing.</summary>
    Ignore,

    /// <summary>The microphone heard our own speaker. Discard it without typing.</summary>
    DroppedAsEcho,

    /// <summary>Type the words and stop there.</summary>
    Type,

    /// <summary>Type the words, then submit — the continuous-mode default.</summary>
    TypeAndSend,

    /// <summary>Spoken "new line". Insert a break and never submit.</summary>
    Newline,

    /// <summary>Spoken "scratch that". Erase and never submit.</summary>
    Scratch,

    /// <summary>Spoken "send it". Submit what is already in the box.</summary>
    Send,

    /// <summary>Spoken "stop dictation". Leave the mode.</summary>
    Stop,
}

/// <summary>
/// One verdict. <see cref="Reason"/> is written for the host log so a dropped
/// utterance is explainable after the fact rather than silently missing.
/// </summary>
public readonly record struct ConversationTurn(TurnOutcome Outcome, string Text, string Reason);

/// <summary>
/// The decision layer for continuous ("converse") voice mode: which utterances
/// are real, which are the machine hearing itself, and which ones submit.
/// </summary>
/// <remarks>
/// THIS IS HALF-DUPLEX, AND THAT IS A DESIGN DECISION, NOT A LIMITATION WE
/// FORGOT TO FIX. While Kokoro is playing, the capture path is closed and its
/// frames are discarded. The user therefore CANNOT interrupt a reply mid-sentence
/// — barge-in does not work, and cannot be made to work this way. Real barge-in
/// needs either acoustic echo cancellation (a signal-processing project: adaptive
/// filter, double-talk detection, per-device calibration) or a full-duplex model
/// such as Moshi. Neither is present. What IS present is the same trade every
/// push-to-talk assistant makes, made honestly.
///
/// Two guards, and they catch different failures:
///
/// GUARD 1 — SUPPRESSION WINDOW (the host closes capture; this class says when).
/// Covers the speaker's output while it is playing, plus a tail after it stops.
/// It cannot cover audio that reaches the recognizer through some path other than
/// "captured right now", which is precisely why there is a second guard.
///
/// GUARD 2 — SPOKEN-TEXT NEAR-MATCH. A transcript arriving shortly after we spoke
/// is discarded when it is mostly made of the words we just said. This was chosen
/// over the other candidate (drop everything that arrives inside the window)
/// because that candidate is not actually independent — it is guard 1 with a
/// bigger number, driven by the same clock, and it fails in exactly the same way
/// guard 1 does. The near-match instead catches the leak guard 1 is structurally
/// blind to: a fragment that was captured legitimately-looking but is decoded
/// late, or that arrives after the tail expired. The cost is a false positive
/// when the user quotes the reply back verbatim, which is why the thresholds
/// below are deliberately timid — dropping the user's real sentence is worse than
/// letting one echo fragment through, because he can see and scratch the echo but
/// cannot see the sentence that never arrived.
///
/// Pure and clock-injected on purpose: every rule here is provable with fixtures
/// and no microphone, no speaker, and no model. That matters because the failure
/// this class exists to prevent — transcribing our own voice, answering it, and
/// looping — is not something a test is allowed to reproduce on Troy's machine
/// while he is using the audio devices to talk to someone.
/// </remarks>
public sealed class ConversationTurnPolicy
{
    /// <summary>
    /// Quiet time held after playback stops before capture is trusted again.
    /// </summary>
    /// <remarks>
    /// Derived, not guessed. Two measured contributions:
    ///
    ///   150 ms — the capture buffer. WhisperSpeechRecognizer opens WaveInEvent
    ///   with BufferMilliseconds = 50 and NumberOfBuffers = 3
    ///   (WhisperSpeechRecognizer.cs:118-119), so up to 150 ms of audio recorded
    ///   WHILE the speaker was playing can still be handed to OnDataAvailable
    ///   after capture resumes. That audio is echo no matter when it is delivered.
    ///
    ///     0 ms — the playback tail is already paid for. KokoroSpeechSynthesizer
    ///   drains its provider and then sleeps PlaybackLatencyMs = 150 ms
    ///   (KokoroSpeechSynthesizer.cs:32, :417-420) so the driver flushes before
    ///   Speak() returns. By the time this tail starts, the device is quiet.
    ///
    /// 250 leaves 100 ms over the measured 150 ms for room decay, which is the one
    /// term that cannot be read out of the source — it depends on Troy's speakers,
    /// their volume, and the room. If echo still leaks, this is the number to
    /// raise, and --tail-ms raises it without a rebuild.
    /// </remarks>
    public const int DefaultSuppressionTailMs = 250;

    /// <summary>
    /// How long after playback the near-match guard stays armed.
    /// </summary>
    /// <remarks>
    /// Echo is captured during or just after playback; the only thing that delays
    /// its arrival is Whisper's decode, which runs on one worker over a ≤25 s
    /// utterance (WhisperSpeechRecognizer.cs:37). 4 s covers a slow decode of a
    /// short fragment with room to spare. Past this the guard disarms, so the
    /// user's own words can never be silently eaten minutes later just because
    /// they happen to echo an old reply.
    /// </remarks>
    public const int EchoTextWindowMs = 4_000;

    /// <summary>
    /// Shortest transcript the near-match guard will judge.
    /// </summary>
    /// <remarks>
    /// Short replies are the ones a user actually says — "yes", "do it",
    /// "that's right" — and their words are very likely to appear somewhere in a
    /// reply we just gave. Judging them would drop real speech. Below this length
    /// the timing tail is the only guard, on purpose.
    /// </remarks>
    public const int EchoMinimumTokens = 5;

    /// <summary>
    /// Fraction of the transcript's words that must appear in what was just
    /// spoken before it is called echo. High on purpose — see the class remarks.
    /// </summary>
    public const double EchoContainmentThreshold = 0.80d;

    /// <summary>
    /// Longest a claimed speaking state is believed before it is treated as stale.
    /// </summary>
    /// <remarks>
    /// The speaking flag can be raised by a DIFFERENT process (the `speak` verb
    /// signalling that it holds the speakers). If that process is killed mid
    /// playback the flag can be left standing, and without a cap this host would
    /// stay deaf forever with no way for Troy to tell why. Five minutes is far
    /// past any real reply — SpeechTextCleaner caps an utterance at 1200
    /// characters (SpeechTextCleaner.cs:12), roughly 90 s of speech — and erring
    /// long is correct: resuming too early re-creates the echo this class exists
    /// to stop, while resuming too late costs one turn and says so in the log.
    /// </remarks>
    public const int MaxSpeakingHoldMs = 300_000;

    private readonly object _gate = new();
    private readonly int _tailMs;
    private readonly bool _autoSend;

    private bool _speaking;
    private long? _speakingStartedAtMs;
    private long? _speechEndedAtMs;
    private string _lastSpokenText = string.Empty;

    // Set by "new line". The user has declared they are composing something with
    // more than one line in it, so the next utterance must NOT submit by itself.
    private bool _composing;

    /// <param name="autoSend">
    /// False reproduces the old press-to-talk behaviour: every utterance is typed
    /// and only "send it" submits. True is continuous mode.
    /// </param>
    /// <param name="suppressionTailMs">
    /// Overrides <see cref="DefaultSuppressionTailMs"/>. Negative values are
    /// clamped to zero rather than rejected, because this arrives from a command
    /// line and a nonsensical number must not take the microphone down.
    /// </param>
    public ConversationTurnPolicy(bool autoSend = true, int suppressionTailMs = DefaultSuppressionTailMs)
    {
        _autoSend = autoSend;
        _tailMs = Math.Max(0, suppressionTailMs);
    }

    /// <summary>The tail actually in force, after clamping.</summary>
    public int SuppressionTailMs => _tailMs;

    /// <summary>True when this policy submits completed utterances by itself.</summary>
    public bool AutoSendEnabled => _autoSend;

    /// <summary>
    /// True while the user is part-way through a multi-line message, so auto-send
    /// is being held. Cleared by an explicit send or a stop.
    /// </summary>
    public bool IsComposing
    {
        get { lock (_gate) return _composing; }
    }

    /// <summary>
    /// Playback has begun. Call this BEFORE the first sample reaches the speakers
    /// — the window has to open ahead of the sound, not alongside it.
    /// </summary>
    public void NoteSpeechStarted(long nowMs)
    {
        lock (_gate)
        {
            _speaking = true;
            _speakingStartedAtMs = nowMs;
            _speechEndedAtMs = null;
        }
    }

    /// <summary>
    /// Playback has finished. <paramref name="spokenText"/> is what was said, and
    /// arms the near-match guard; passing null or empty leaves only the tail.
    /// </summary>
    public void NoteSpeechFinished(long nowMs, string? spokenText)
    {
        lock (_gate)
        {
            _speaking = false;
            _speakingStartedAtMs = null;
            _speechEndedAtMs = nowMs;
            _lastSpokenText = spokenText ?? string.Empty;
        }
    }

    /// <summary>
    /// True while captured audio must be discarded: playback is running, or the
    /// tail after it has not elapsed.
    /// </summary>
    public bool IsSuppressed(long nowMs)
    {
        lock (_gate)
        {
            return IsSuppressedLocked(nowMs);
        }
    }

    /// <summary>
    /// True when the speaking flag has been standing longer than
    /// <see cref="MaxSpeakingHoldMs"/> and is no longer believed. Exposed so the
    /// host can say so out loud instead of appearing to have a dead microphone.
    /// </summary>
    public bool IsSpeakingFlagStale(long nowMs)
    {
        lock (_gate)
        {
            return _speaking
                && _speakingStartedAtMs is { } started
                && nowMs - started > MaxSpeakingHoldMs;
        }
    }

    /// <summary>
    /// Classify one transcript and decide what the host should do with it.
    /// </summary>
    /// <remarks>
    /// Command detection is delegated to <see cref="DictationCommands.Detect"/>
    /// rather than repeated here, so this class and
    /// <see cref="DictationTypist"/> can never disagree about whether an
    /// utterance was a command — they ask the same pure function. A command is
    /// never auto-sent as text, which is the property that keeps "stop dictation"
    /// from being typed into a chat box and submitted.
    /// </remarks>
    public ConversationTurn Evaluate(string? transcript, long nowMs)
    {
        var command = DictationCommands.Detect(transcript);

        lock (_gate)
        {
            // Guard 1. Anything recognized while the window is open is our own
            // voice by construction, whatever the words turn out to be.
            if (IsSuppressedLocked(nowMs))
            {
                return new ConversationTurn(
                    TurnOutcome.DroppedAsEcho,
                    string.Empty,
                    "heard while the speaker was active — discarded as echo");
            }

            switch (command.Kind)
            {
                case DictationCommandKind.Newline:
                    _composing = true;
                    return new ConversationTurn(
                        TurnOutcome.Newline,
                        string.Empty,
                        "\"new line\" — auto-send held until you say \"send it\"");

                case DictationCommandKind.Scratch:
                    return new ConversationTurn(TurnOutcome.Scratch, string.Empty, "\"scratch that\"");

                case DictationCommandKind.Send:
                    _composing = false;
                    return new ConversationTurn(TurnOutcome.Send, string.Empty, "\"send it\"");

                case DictationCommandKind.Stop:
                    _composing = false;
                    return new ConversationTurn(TurnOutcome.Stop, string.Empty, "\"stop dictation\"");
            }

            if (command.Text.Length == 0)
            {
                return new ConversationTurn(TurnOutcome.Ignore, string.Empty, "empty transcript");
            }

            // Guard 2. Past the tail, but still close enough in time that our own
            // words could be arriving late.
            if (LooksLikeSpokenEchoLocked(command.Text, nowMs, out var containment))
            {
                return new ConversationTurn(
                    TurnOutcome.DroppedAsEcho,
                    string.Empty,
                    $"{containment:P0} of these words were in the reply just spoken — discarded as echo");
            }

            if (!_autoSend)
            {
                return new ConversationTurn(TurnOutcome.Type, command.Text, "auto-send is off");
            }

            if (_composing)
            {
                return new ConversationTurn(
                    TurnOutcome.Type,
                    command.Text,
                    "composing a multi-line message — say \"send it\" to submit");
            }

            return new ConversationTurn(TurnOutcome.TypeAndSend, command.Text, "end of utterance");
        }
    }

    private bool IsSuppressedLocked(long nowMs)
    {
        if (_speaking)
        {
            // A flag left standing by a process that died must not deafen us
            // permanently. Past the cap, stop believing it.
            return _speakingStartedAtMs is not { } started
                || nowMs - started <= MaxSpeakingHoldMs;
        }

        return _speechEndedAtMs is { } ended && nowMs - ended < _tailMs;
    }

    private bool LooksLikeSpokenEchoLocked(string transcript, long nowMs, out double containment)
    {
        containment = 0d;

        if (_lastSpokenText.Length == 0 || _speechEndedAtMs is not { } ended)
        {
            return false;
        }

        if (nowMs - ended > EchoTextWindowMs)
        {
            return false;
        }

        var heard = Tokenize(transcript);
        if (heard.Count < EchoMinimumTokens)
        {
            return false;
        }

        containment = Containment(heard, Tokenize(_lastSpokenText));
        return containment >= EchoContainmentThreshold;
    }

    /// <summary>
    /// Fraction of <paramref name="heard"/> that also appears in
    /// <paramref name="spoken"/>.
    /// </summary>
    /// <remarks>
    /// Deliberately asymmetric. Echo that leaks past the tail is a FRAGMENT of the
    /// end of a reply, not the whole thing, so measuring "how much of the reply
    /// did we hear" would score a genuine echo near zero and never fire. The
    /// question that discriminates is the other one: of the words we just heard,
    /// how many were already in our own mouth.
    /// </remarks>
    internal static double Containment(IReadOnlyCollection<string> heard, HashSet<string> spoken)
    {
        if (heard.Count == 0)
        {
            return 0d;
        }

        var matched = heard.Count(spoken.Contains);
        return (double)matched / heard.Count;
    }

    /// <summary>
    /// Distinct lowercase word tokens. Punctuation is dropped because Whisper
    /// infers it from prosody and Kokoro never sees it, so the same sentence
    /// spoken and heard rarely agrees on a comma.
    /// </summary>
    internal static HashSet<string> Tokenize(string? text)
    {
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(text))
        {
            return tokens;
        }

        var word = new System.Text.StringBuilder();
        foreach (var c in text)
        {
            if (char.IsLetterOrDigit(c))
            {
                word.Append(char.ToLowerInvariant(c));
                continue;
            }

            if (word.Length > 0)
            {
                tokens.Add(word.ToString());
                word.Clear();
            }
        }

        if (word.Length > 0)
        {
            tokens.Add(word.ToString());
        }

        return tokens;
    }
}

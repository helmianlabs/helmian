using Helmion.Desktop.Core;

/// <summary>
/// Checks for continuous conversation mode (helmion-voice converse): the echo
/// guard, and the rule that decides which utterances submit by themselves.
/// </summary>
/// <remarks>
/// EVERY CHECK HERE IS A PURE FUNCTION OVER FIXTURES. Nothing opens the
/// microphone, nothing plays a sound, nothing creates a window. That is not
/// squeamishness about test scope — it is the only way this suite can run at all.
/// The failure these checks exist to prevent is the assistant transcribing its
/// own voice, and reproducing that for real means seizing the speakers and the
/// microphone on the machine Troy is at that moment using to talk to someone.
/// A test is not allowed to cut him off mid-sentence to prove a point.
///
/// So the clock is injected and the audio is imaginary, exactly as
/// DictationTypist and HotkeyChord are tested. What CANNOT be proven this way is
/// stated plainly in the report rather than papered over: whether 250 ms is
/// enough tail for Troy's actual speakers in Troy's actual room is an acoustic
/// question, and no fixture answers it.
/// </remarks>
internal static class ConversationModeChecks
{
    private static int _checks;

    /// <summary>An arbitrary monotonic origin. Only differences matter.</summary>
    private const long T0 = 1_000_000L;

    /// <summary>
    /// The real defect, verbatim. On 2026-07-30 Troy's next dictated message came
    /// back carrying this sentence — which the assistant had just said through
    /// Kokoro, not something Troy typed. The microphone heard the speakers.
    /// </summary>
    private const string SpokenReply =
        "You hear me when I call the speak command. "
        + "From now on, I will speak a short version of every reply.";

    /// <summary>
    /// What leaks past a timing tail: not the whole reply, a fragment off the end
    /// of it, transcribed by Whisper with its own punctuation and casing.
    /// </summary>
    private const string EchoFragment =
        "from now on I will speak a short version of every reply";

    public static void Run()
    {
        _checks = 0;

        CheckSuppressionWindowDropsEcho();
        CheckSuppressionTailBoundary();
        CheckStaleSpeakingFlagCannotDeafenForever();
        CheckSpokenTextNearMatchDropsLateEcho();
        CheckNearMatchDoesNotEatRealSpeech();
        CheckAutoSendSubmitsSpeechAndNeverCommands();
        CheckNewLineHoldsAutoSend();
        CheckAutoSendCanBeTurnedOff();

        Console.WriteLine($"Helmion conversation mode smoke tests passed ({_checks} checks).");
    }

    // ---- guard 1: the suppression window -----------------------------------

    /// <summary>
    /// While a reply is playing, nothing the microphone produces is believed —
    /// including an utterance that would otherwise SUBMIT.
    /// </summary>
    private static void CheckSuppressionWindowDropsEcho()
    {
        var policy = new ConversationTurnPolicy();
        policy.NoteSpeechStarted(T0);

        var heard = policy.Evaluate(EchoFragment, T0 + 500);
        Check(heard.Outcome == TurnOutcome.DroppedAsEcho,
            $"speech heard while the speaker is active is discarded, saw {heard.Outcome}");
        Check(heard.Text.Length == 0,
            "a dropped echo carries no text a caller could type by accident");

        // NEGATIVE CONTROL — the whole check rests on this.
        //
        // A guard that rejects everything passes the assertion above, and so does
        // a fixture no implementation would ever have accepted. Neither proves
        // anything. So the IDENTICAL transcript at the IDENTICAL time goes through
        // a policy that was simply never told a reply was playing — the guard's
        // input removed, nothing else changed. It must come back ACCEPTED.
        //
        // If someone later deletes the suppression check, this pair collapses:
        // both sides accept, and the assertion below fails loudly instead of the
        // suite passing on broken code.
        var unguarded = new ConversationTurnPolicy();
        var wouldHaveBeenTyped = unguarded.Evaluate(EchoFragment, T0 + 500);
        Check(wouldHaveBeenTyped.Outcome == TurnOutcome.TypeAndSend,
            "NEGATIVE CONTROL: without the speaking flag this same echo is typed AND submitted "
            + $"— saw {wouldHaveBeenTyped.Outcome}, so the fixture is a real trap");

        // The nastiest case. An echo that happens to transcribe as a command must
        // not execute it: a spurious submit sends a half-finished message, and the
        // reply to it produces more audio, which is the loop.
        var commandEcho = new ConversationTurnPolicy();
        commandEcho.NoteSpeechStarted(T0);
        Check(commandEcho.Evaluate("send it", T0 + 100).Outcome == TurnOutcome.DroppedAsEcho,
            "an echo that sounds like \"send it\" is discarded rather than submitting");
        Check(commandEcho.Evaluate("stop dictation", T0 + 100).Outcome == TurnOutcome.DroppedAsEcho,
            "an echo that sounds like \"stop dictation\" cannot end the conversation");

        var stillUnguarded = new ConversationTurnPolicy();
        Check(stillUnguarded.Evaluate("send it", T0 + 100).Outcome == TurnOutcome.Send,
            "NEGATIVE CONTROL: \"send it\" really does submit when nothing is being spoken");
    }

    /// <summary>
    /// The tail is a real boundary, not a decoration: closed before it, open after.
    /// </summary>
    private static void CheckSuppressionTailBoundary()
    {
        var policy = new ConversationTurnPolicy();
        Check(policy.SuppressionTailMs == ConversationTurnPolicy.DefaultSuppressionTailMs
            && policy.SuppressionTailMs == 250,
            $"the shipped tail is 250 ms, saw {policy.SuppressionTailMs}");

        policy.NoteSpeechStarted(T0);
        Check(policy.IsSuppressed(T0 + 5_000), "playback of any length keeps the window open");

        policy.NoteSpeechFinished(T0 + 5_000, spokenText: null);
        Check(policy.IsSuppressed(T0 + 5_000),
            "the window is still closed the instant playback ends");
        Check(policy.IsSuppressed(T0 + 5_000 + 249),
            "the window is still closed 249 ms after playback ends");
        Check(!policy.IsSuppressed(T0 + 5_000 + 250),
            "the window reopens exactly at the tail, not later");

        // Passing null spoken text above matters: it leaves guard 2 disarmed, so
        // this boundary is guard 1 measured on its own rather than the two of them
        // covering for each other.
        var afterTail = policy.Evaluate("ship the manifest on Friday", T0 + 5_000 + 250);
        Check(afterTail.Outcome == TurnOutcome.TypeAndSend,
            $"real speech after the tail is accepted, saw {afterTail.Outcome}");

        // A custom tail is honoured, and a nonsensical one cannot throw or wedge
        // the microphone — it clamps.
        var longTail = new ConversationTurnPolicy(autoSend: true, suppressionTailMs: 900);
        longTail.NoteSpeechFinished(T0, null);
        Check(longTail.IsSuppressed(T0 + 899) && !longTail.IsSuppressed(T0 + 900),
            "--tail-ms 900 moves the boundary to 900 ms");

        var negative = new ConversationTurnPolicy(autoSend: true, suppressionTailMs: -50);
        Check(negative.SuppressionTailMs == 0,
            "a negative tail clamps to zero rather than inverting the comparison");
    }

    /// <summary>
    /// The speaking flag can be raised by another process. If that process dies
    /// holding it, this host must recover rather than sit deaf forever.
    /// </summary>
    private static void CheckStaleSpeakingFlagCannotDeafenForever()
    {
        var policy = new ConversationTurnPolicy();
        policy.NoteSpeechStarted(T0);

        Check(policy.IsSuppressed(T0 + ConversationTurnPolicy.MaxSpeakingHoldMs),
            "a reply is still believed right up to the staleness cap");
        Check(!policy.IsSpeakingFlagStale(T0 + ConversationTurnPolicy.MaxSpeakingHoldMs),
            "the flag is not called stale before the cap");

        var pastCap = T0 + ConversationTurnPolicy.MaxSpeakingHoldMs + 1;
        Check(policy.IsSpeakingFlagStale(pastCap),
            "past the cap the flag is reported stale so the host can say why");
        Check(!policy.IsSuppressed(pastCap),
            "past the cap the microphone opens again instead of staying dead");
        Check(policy.Evaluate("are you still there", pastCap).Outcome == TurnOutcome.TypeAndSend,
            "and speech is accepted again after a killed speak process");
    }

    // ---- guard 2: the spoken-text near-match --------------------------------

    /// <summary>
    /// The leak guard 1 is blind to: a fragment of our own reply arriving AFTER
    /// the tail has already reopened the microphone.
    /// </summary>
    private static void CheckSpokenTextNearMatchDropsLateEcho()
    {
        // 1.2 s after playback ended — well past the 250 ms tail, so guard 1 has
        // already reopened the window and this is guard 2 or nothing.
        var late = T0 + 1_200;

        var policy = new ConversationTurnPolicy();
        policy.NoteSpeechFinished(T0, SpokenReply);
        Check(!policy.IsSuppressed(late), "guard 1 has genuinely reopened by this point");

        var verdict = policy.Evaluate(EchoFragment, late);
        Check(verdict.Outcome == TurnOutcome.DroppedAsEcho,
            $"a late echo fragment is caught by the near-match guard, saw {verdict.Outcome}");

        // NEGATIVE CONTROL, same shape as guard 1's: remove the guard's input —
        // the record of what was said — and the identical transcript at the
        // identical time must be typed and submitted.
        var noSpokenText = new ConversationTurnPolicy();
        noSpokenText.NoteSpeechFinished(T0, spokenText: null);
        Check(noSpokenText.Evaluate(EchoFragment, late).Outcome == TurnOutcome.TypeAndSend,
            "NEGATIVE CONTROL: with no record of what was spoken, the same fragment is "
            + "typed and submitted — so this guard, not the clock, is what caught it");

        // The guard disarms. Otherwise Troy could never repeat a phrase from an
        // old reply, minutes later, without it silently vanishing.
        var wayLater = T0 + ConversationTurnPolicy.EchoTextWindowMs + 1;
        Check(policy.Evaluate(EchoFragment, wayLater).Outcome == TurnOutcome.TypeAndSend,
            "past the near-match window the same words are accepted as real speech");
    }

    /// <summary>
    /// The expensive direction. A guard that eats the user's real sentences is
    /// worse than the echo it prevents, because he can see and scratch an echo
    /// and cannot see a sentence that never arrived.
    /// </summary>
    private static void CheckNearMatchDoesNotEatRealSpeech()
    {
        var policy = new ConversationTurnPolicy();
        policy.NoteSpeechFinished(T0, SpokenReply);
        var justAfter = T0 + 400;

        Check(policy.Evaluate("ship the EDI 204 to the vendor on Friday morning", justAfter)
                .Outcome == TurnOutcome.TypeAndSend,
            "a new sentence right after a reply is accepted");

        // Short answers are the ones people actually say, and their words are very
        // likely to appear somewhere in the reply they are answering. Below the
        // minimum token count the near-match guard does not judge at all.
        foreach (var reply in new[] { "yes", "no", "do it", "go ahead" })
        {
            var fresh = new ConversationTurnPolicy();
            fresh.NoteSpeechFinished(T0, SpokenReply);
            Check(fresh.Evaluate(reply, justAfter).Outcome == TurnOutcome.TypeAndSend,
                $"the short answer \"{reply}\" survives the near-match guard");
        }

        // A sentence built ENTIRELY from words that were in the reply, but which
        // is obviously the user talking, still gets through when it is short.
        var shortOverlap = new ConversationTurnPolicy();
        shortOverlap.NoteSpeechFinished(T0, SpokenReply);
        Check(shortOverlap.Evaluate("speak now", justAfter).Outcome == TurnOutcome.TypeAndSend,
            "\"speak now\" is not judged despite both words appearing in the reply");

        // KNOWN LIMITATION, pinned rather than hidden. If Troy quotes a reply back
        // nearly verbatim within 4 s, this guard eats it. That is the price of
        // catching late echo, and it is the FIRST thing to revisit if he reports a
        // sentence going missing: raise EchoContainmentThreshold, or shorten
        // EchoTextWindowMs. This check asserts today's behaviour so the trade
        // stays visible in the suite instead of surprising someone later.
        var quotedBack = new ConversationTurnPolicy();
        quotedBack.NoteSpeechFinished(T0, SpokenReply);
        Check(quotedBack.Evaluate("I will speak a short version of every reply", justAfter)
                .Outcome == TurnOutcome.DroppedAsEcho,
            "KNOWN LIMITATION: quoting a reply back verbatim within the window is dropped");
    }

    // ---- auto-send ----------------------------------------------------------

    /// <summary>
    /// What makes the mode continuous — and the boundary that keeps it safe.
    /// </summary>
    private static void CheckAutoSendSubmitsSpeechAndNeverCommands()
    {
        var policy = new ConversationTurnPolicy();
        Check(policy.AutoSendEnabled, "converse submits by itself unless told otherwise");

        var spoken = policy.Evaluate("what does the manifest say about Friday", T0);
        Check(spoken.Outcome == TurnOutcome.TypeAndSend,
            $"a finished sentence is typed and submitted, saw {spoken.Outcome}");
        Check(spoken.Text == "what does the manifest say about Friday",
            "the words reach the caller verbatim");

        // "send it" keeps working. It is no longer required; it is not removed.
        Check(policy.Evaluate("send it", T0).Outcome == TurnOutcome.Send,
            "\"send it\" still submits explicitly");

        // THE LOAD-BEARING SWEEP. Every reserved command, in every phrasing the
        // detector knows, must resolve to its own outcome and never to
        // TypeAndSend — a command auto-sent as text would type the words "stop
        // dictation" into a chat box and press Enter.
        var commands = new (string Utterance, TurnOutcome Expected)[]
        {
            ("new line", TurnOutcome.Newline),
            ("newline", TurnOutcome.Newline),
            ("next line", TurnOutcome.Newline),
            ("new paragraph", TurnOutcome.Newline),
            ("scratch that", TurnOutcome.Scratch),
            ("delete that", TurnOutcome.Scratch),
            ("undo that", TurnOutcome.Scratch),
            ("send it", TurnOutcome.Send),
            ("send message", TurnOutcome.Send),
            ("send that", TurnOutcome.Send),
            ("submit", TurnOutcome.Send),
            ("stop listening", TurnOutcome.Stop),
            ("stop dictation", TurnOutcome.Stop),
            ("stop dictating", TurnOutcome.Stop),
            ("voice off", TurnOutcome.Stop),
        };

        foreach (var (utterance, expected) in commands)
        {
            var fresh = new ConversationTurnPolicy();
            var verdict = fresh.Evaluate(utterance, T0);
            Check(verdict.Outcome == expected,
                $"\"{utterance}\" resolves to {expected}, saw {verdict.Outcome}");
            Check(verdict.Outcome != TurnOutcome.TypeAndSend,
                $"\"{utterance}\" is never auto-sent as text");
            Check(verdict.Text.Length == 0,
                $"\"{utterance}\" produces no text to type");
        }

        // Punctuation and casing Whisper inferred must not turn a command into a
        // sentence that then submits itself.
        foreach (var noisy in new[] { "Stop dictation.", "  send it  ", "New line!" })
        {
            var fresh = new ConversationTurnPolicy();
            Check(fresh.Evaluate(noisy, T0).Outcome != TurnOutcome.TypeAndSend,
                $"\"{noisy}\" is still recognised as a command, not auto-sent");
        }

        // A sentence that merely CONTAINS a command word is ordinary speech and
        // does submit — the strictness cuts both ways, and that is intended.
        var lookalike = new ConversationTurnPolicy();
        Check(lookalike.Evaluate("send it to the vendor tomorrow", T0).Outcome
                == TurnOutcome.TypeAndSend,
            "\"send it to the vendor tomorrow\" is speech, and speech submits");

        // Silence produces nothing at all rather than an empty submit.
        foreach (var empty in new[] { null, "", "   ", "..." })
        {
            var fresh = new ConversationTurnPolicy();
            Check(fresh.Evaluate(empty, T0).Outcome == TurnOutcome.Ignore,
                "silence and punctuation-only noise never submit an empty message");
        }
    }

    /// <summary>
    /// Auto-send would make a multi-line message impossible — the first line would
    /// submit before the second was spoken. "new line" is the declaration that
    /// more is coming, so it holds the submit until an explicit "send it".
    /// </summary>
    private static void CheckNewLineHoldsAutoSend()
    {
        var policy = new ConversationTurnPolicy();
        Check(!policy.IsComposing, "a fresh conversation is not composing");

        Check(policy.Evaluate("first the background", T0).Outcome == TurnOutcome.TypeAndSend,
            "before any \"new line\", speech submits normally");

        Check(policy.Evaluate("new line", T0 + 1).Outcome == TurnOutcome.Newline,
            "\"new line\" inserts a break");
        Check(policy.IsComposing, "\"new line\" puts the conversation into composing mode");

        Check(policy.Evaluate("then the detail", T0 + 2).Outcome == TurnOutcome.Type,
            "while composing, speech is typed but NOT submitted");
        Check(policy.Evaluate("and one more thing", T0 + 3).Outcome == TurnOutcome.Type,
            "the hold persists across several utterances");

        // Scratching a mistake does not abandon the multi-line message.
        Check(policy.Evaluate("scratch that", T0 + 4).Outcome == TurnOutcome.Scratch,
            "\"scratch that\" still erases while composing");
        Check(policy.IsComposing, "scratching does not end the hold");
        Check(policy.Evaluate("the corrected detail", T0 + 5).Outcome == TurnOutcome.Type,
            "speech after a scratch is still held");

        Check(policy.Evaluate("send it", T0 + 6).Outcome == TurnOutcome.Send,
            "\"send it\" submits the multi-line message");
        Check(!policy.IsComposing, "the hold is released by the explicit send");
        Check(policy.Evaluate("back to normal", T0 + 7).Outcome == TurnOutcome.TypeAndSend,
            "auto-send resumes after the message is sent");

        // Leaving the mode also clears the hold, so the next conversation does not
        // inherit a state the user cannot see.
        var stopped = new ConversationTurnPolicy();
        stopped.Evaluate("new line", T0);
        Check(stopped.IsComposing, "composing while the hold is set");
        Check(stopped.Evaluate("stop dictation", T0 + 1).Outcome == TurnOutcome.Stop,
            "\"stop dictation\" leaves the mode");
        Check(!stopped.IsComposing, "stopping clears the hold");
    }

    /// <summary>
    /// --no-auto-send restores exactly the press-to-talk contract, so the old
    /// behaviour is a flag away rather than a rebuild away.
    /// </summary>
    private static void CheckAutoSendCanBeTurnedOff()
    {
        var policy = new ConversationTurnPolicy(autoSend: false);
        Check(!policy.AutoSendEnabled, "--no-auto-send turns the submit off");

        Check(policy.Evaluate("this should only be typed", T0).Outcome == TurnOutcome.Type,
            "with auto-send off, speech is typed and never submitted");
        Check(policy.Evaluate("and so should this", T0 + 1).Outcome == TurnOutcome.Type,
            "no utterance submits on its own");
        Check(policy.Evaluate("send it", T0 + 2).Outcome == TurnOutcome.Send,
            "\"send it\" is once again the only way to submit");

        // The echo guard is not tied to auto-send — turning one off must not turn
        // the other off with it.
        var quiet = new ConversationTurnPolicy(autoSend: false);
        quiet.NoteSpeechStarted(T0);
        Check(quiet.Evaluate("echo of a reply", T0 + 10).Outcome == TurnOutcome.DroppedAsEcho,
            "echo suppression still applies with auto-send off");
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            Console.Error.WriteLine($"CONVERSATION MODE SMOKE FAILED: {description}");
            Environment.Exit(1);
        }

        _checks++;
    }
}

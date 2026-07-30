using System.Diagnostics;
using Helmion.Desktop.Core;

/// <summary>
/// Checks for the headless console host that exposes the voice stack to
/// PowerShell (desktop/Helmion.Voice.Host).
/// </summary>
/// <remarks>
/// Three tiers, and the split is deliberate:
///
/// The typist and chord-parser checks are pure — no models, no devices, no
/// process — so they run everywhere. They matter most, because both classes are
/// destructive when wrong: the typist emits backspaces into a real editor, and
/// the chord parser decides which key gets taken away from every other
/// application on the machine.
///
/// The microphone-posture check reads the capture device's mute flag and level
/// around the construction of a real <see cref="LocalVoiceEngine"/> and asserts
/// nothing moved. It exists because of a recorded harm: a previous voice attempt
/// on this machine left Troy's microphone ducked while it spoke
/// (~/.claude/projects/C--Users-troyh/memory/feedback-2026-07-25-voice-mutes-troys-mic.md).
///
/// The end-to-end check RUNS helmion-voice.exe and asserts its round trip. It is
/// skipped with a visible notice when the host has not been built, in the same
/// style as the model round-trip in VoiceSmokeChecks.
///
/// Nothing here plays audio, opens a microphone for capture, injects a
/// keystroke, or creates a window. Injection in particular is untestable without
/// typing into whatever the user has focused, so it is left unexercised on
/// purpose rather than fired at a real desktop.
/// </remarks>
internal static class VoiceHostSmokeChecks
{
    private static int _checks;

    public static void Run()
    {
        _checks = 0;

        CheckTypistTypesButNeverSends();
        CheckScratchCannotEatUserTypedText();
        CheckHotkeyChordParsing();
        CheckVoiceStackCannotMuteTheMicrophone();

        Console.WriteLine($"Helmion voice host smoke tests passed ({_checks} checks).");

        CheckConsoleHostRoundTrip();
    }

    /// <summary>
    /// The separation the whole design rests on: speech becomes typed text, and
    /// the ONLY route to Enter is the explicit "send it" command.
    /// </summary>
    private static void CheckTypistTypesButNeverSends()
    {
        var typist = new DictationTypist();

        var dictated = typist.Translate("ship the EDI 204 by Friday");
        Check(dictated.Count == 1 && dictated[0].Kind == DictationActionKind.TypeText,
            "ordinary speech produces typing and nothing else");
        Check(dictated[0].Text == "ship the EDI 204 by Friday ",
            "dictated text is typed verbatim with a trailing space");

        // The sentence that contains a command word is still just text.
        var lookalike = typist.Translate("send it to the vendor tomorrow");
        Check(lookalike.Count == 1 && lookalike[0].Kind == DictationActionKind.TypeText,
            "\"send it to the vendor tomorrow\" is typed, not submitted");

        var send = typist.Translate("send it");
        Check(send.Count == 1
            && send[0].Kind == DictationActionKind.PressKey
            && send[0].Chord == DictationKeyChord.Enter,
            "\"send it\" is the one utterance that presses Enter");

        var newline = typist.Translate("new line");
        Check(newline.Count == 1 && newline[0].Chord == DictationKeyChord.ShiftEnter,
            "\"new line\" inserts a break without submitting");

        var stop = typist.Translate("stop dictation");
        Check(stop.Count == 1 && stop[0].Kind == DictationActionKind.StopDictation,
            "\"stop dictation\" leaves dictation rather than typing the words");

        Check(typist.Translate("   ").Count == 0, "a silent utterance produces no keystrokes");
        Check(typist.Translate(null).Count == 0, "a null transcript produces no keystrokes");

        // Sweep every literal transcript in the corpus and prove none of them can
        // reach Enter. One false Send submits a half-finished message.
        var corpus = new[]
        {
            "hello", "send it to the vendor tomorrow", "scratch that itch",
            "draw a new line on the chart", "stop listening to that podcast",
            "submit the paperwork on Monday", "delete that file later",
        };

        var sends = 0;
        foreach (var line in corpus)
        {
            var fresh = new DictationTypist();
            foreach (var action in fresh.Translate(line))
            {
                if (action.Kind == DictationActionKind.PressKey
                    && action.Chord == DictationKeyChord.Enter)
                {
                    sends++;
                }
            }
        }

        Check(sends == 0, $"no sentence in the corpus submits, saw {sends}");
    }

    /// <summary>
    /// The destructive one. "scratch that" may only erase characters this typist
    /// typed — never a character the user typed by hand.
    /// </summary>
    private static void CheckScratchCannotEatUserTypedText()
    {
        // Nothing dictated yet: the caret is sitting on the user's own text.
        var cold = new DictationTypist();
        Check(cold.Translate("scratch that").Count == 0,
            "scratch with nothing dictated emits ZERO backspaces");

        var typist = new DictationTypist();
        typist.Translate("hello world");                     // types "hello world " = 12 chars
        var scratch = typist.Translate("scratch that");
        Check(scratch.Count == 1
            && scratch[0].Chord == DictationKeyChord.Backspace
            && scratch[0].Repeat == 12,
            $"scratch erases exactly the 12 characters it typed, saw {(scratch.Count == 1 ? scratch[0].Repeat : -1)}");

        // Scratching twice must not walk backwards through the user's text.
        Check(typist.Translate("scratch that").Count == 0,
            "a second scratch erases nothing more");

        // After a send or a newline, the previous chunk is no longer to the left
        // of the caret, so nothing may be erased.
        var afterSend = new DictationTypist();
        afterSend.Translate("some words");
        afterSend.Translate("send it");
        Check(afterSend.Translate("scratch that").Count == 0,
            "scratch after a send erases nothing");

        var afterNewline = new DictationTypist();
        afterNewline.Translate("some words");
        afterNewline.Translate("new line");
        Check(afterNewline.Translate("scratch that").Count == 0,
            "scratch after a line break erases nothing");

        // Focus moved: the caret may be anywhere, so the history is dropped.
        var refocused = new DictationTypist();
        refocused.Translate("typed into the old window");
        refocused.ForgetTypedHistory();
        Check(refocused.Translate("scratch that").Count == 0,
            "scratch after focus moved to another window erases nothing");

        // The count tracks the LAST chunk only, and includes the trailing space.
        var counted = new DictationTypist();
        counted.Translate("first");
        counted.Translate("second");
        Check(counted.ErasableCharacters == "second ".Length,
            "only the most recent chunk is erasable");

        var noSpace = new DictationTypist(appendSpace: false);
        noSpace.Translate("abc");
        Check(noSpace.ErasableCharacters == 3,
            "with --no-space the erasable count excludes a space that was never typed");
    }

    private static void CheckHotkeyChordParsing()
    {
        Check(HotkeyChord.TryParse("ctrl+shift+alt+h", out var helmion, out _),
            "the default chord parses");
        Check(helmion.Modifiers == (HotkeyChord.ModControl | HotkeyChord.ModShift | HotkeyChord.ModAlt),
            "ctrl+shift+alt maps to the three modifier flags and no others");
        Check(helmion.VirtualKey == 'H', "the key resolves to VK_H");
        Check(helmion.Display == "Ctrl+Shift+Alt+H", "the chord round-trips to a readable name");
        Check((helmion.ModifiersForRegistration & HotkeyChord.ModNoRepeat) != 0,
            "registration suppresses auto-repeat, so a held key cannot fire a toggle storm");

        Check(HotkeyChord.DefaultChord == "ctrl+shift+alt+h",
            "the shipped default is the chord that was probed, not Ctrl+Shift+C");

        Check(HotkeyChord.TryParse("CTRL + ALT + F12", out var fkey, out _)
            && fkey.VirtualKey == 0x7B
            && fkey.Modifiers == (HotkeyChord.ModControl | HotkeyChord.ModAlt),
            "case and spacing are ignored, and F-keys resolve to their VK codes");

        Check(HotkeyChord.TryParse("win+space", out var win, out _)
            && win.Modifiers == HotkeyChord.ModWin
            && win.VirtualKey == 0x20,
            "the Windows key and named keys parse");

        // Failures report a reason instead of throwing or, worse, registering
        // something other than what was asked for.
        Check(!HotkeyChord.TryParse("ctrl+shift", out _, out var noKey) && noKey is not null,
            "modifiers with no key are rejected with a reason");
        Check(!HotkeyChord.TryParse("ctrl+a+b", out _, out var twoKeys) && twoKeys is not null,
            "two non-modifier keys are rejected rather than silently dropping one");
        Check(!HotkeyChord.TryParse("ctrl+notakey", out _, out var unknown) && unknown is not null,
            "an unknown key name is rejected with a reason");
        Check(!HotkeyChord.TryParse("", out _, out _), "an empty chord is rejected");
        Check(!HotkeyChord.TryParse(null, out _, out _), "a null chord is rejected");
    }

    /// <summary>
    /// Proves the voice stack cannot mute or duck the microphone — by source, and
    /// by measurement.
    /// </summary>
    private static void CheckVoiceStackCannotMuteTheMicrophone()
    {
        // ---- by source -----------------------------------------------------
        // Reading the shipped source is the same technique the protected-profile
        // check uses on the csproj (Program.cs). A grep is weaker than a runtime
        // assertion in general, but for "this code contains no call that could
        // mute anything" it is exactly the right instrument: it covers paths a
        // test run would never reach.
        var coreDirectory = FindRepoRelative("desktop", "Helmion.Desktop.Core");
        var hostDirectory = FindRepoRelative("desktop", "Helmion.Voice.Host");

        if (coreDirectory is null || hostDirectory is null)
        {
            Console.WriteLine("  microphone-mute source scan SKIPPED — source directories not found.");
        }
        else
        {
            // Two scans, because the two kinds of ban live in different places.
            //
            // A CALL appears as code: `x.Mute = true`, `new SoundPlayer()`. Those
            // are hunted with comments AND string literals removed, so the prose
            // in these very files — which discusses every one of these APIs while
            // explaining why it was dropped — cannot trip the scan.
            //
            // A REFERENCE to an external thing appears as a string: a COM ProgID,
            // a script name. Those are hunted with strings kept, because stripping
            // them is exactly where `Process.Start("speak.ps1")` would hide.
            string[] bannedCalls =
            [
                ".Mute =",                            // write to an endpoint mute flag
                "MasterVolumeLevelScalar =",          // write to a device level
                "MasterVolumeLevel =",
                "AudioClientShareMode.Exclusive",     // seizing a device from other apps
                "AudioStreamCategory.Communications", // the category that triggers Windows ducking
                "SoundPlayer",
            ];

            string[] bannedReferences =
            [
                "SAPI.SpVoice",                       // COM ProgID — only ever a string
                "AudioCategory_Communications",
                "edge-tts",
                "speak.ps1",
            ];

            // POSITIVE CONTROL. A scanner that finds nothing looks identical to a
            // scanner that is broken, so prove on a fixture that it catches a real
            // offender and ignores an identical mention in prose. Everything below
            // this point is only meaningful because these four assertions hold.
            const string fixture = """
                // A comment naming SoundPlayer and edge-tts, which must NOT match.
                var note = "prose about speak.ps1 and nothing more";
                device.AudioEndpointVolume.Mute = true;
                var player = new SoundPlayer();
                var progId = "SAPI.SpVoice";
                """;

            var fixtureCode = StripComments(fixture, stripStringLiterals: true);
            var fixtureWithStrings = StripComments(fixture, stripStringLiterals: false);

            Check(fixtureCode.Contains(".Mute =", StringComparison.Ordinal)
                && fixtureCode.Contains("SoundPlayer", StringComparison.Ordinal),
                "the source scanner detects a real banned call");
            Check(!fixtureCode.Contains("edge-tts", StringComparison.Ordinal),
                "the source scanner ignores a banned name that appears only in a comment");
            Check(!fixtureCode.Contains("speak.ps1", StringComparison.Ordinal),
                "the call scan does not see inside string literals");
            Check(fixtureWithStrings.Contains("SAPI.SpVoice", StringComparison.Ordinal)
                && fixtureWithStrings.Contains("speak.ps1", StringComparison.Ordinal),
                "the reference scan DOES see inside string literals");

            var offenders = new List<string>();
            var scanned = 0;
            foreach (var file in Directory
                .EnumerateFiles(coreDirectory, "*.cs", SearchOption.TopDirectoryOnly)
                .Concat(Directory.EnumerateFiles(hostDirectory, "*.cs", SearchOption.TopDirectoryOnly)))
            {
                var text = File.ReadAllText(file);
                var code = StripComments(text, stripStringLiterals: true);
                var codeAndStrings = StripComments(text, stripStringLiterals: false);
                scanned++;

                foreach (var fragment in bannedCalls)
                {
                    if (code.Contains(fragment, StringComparison.Ordinal))
                    {
                        offenders.Add($"{Path.GetFileName(file)} calls \"{fragment}\"");
                    }
                }

                foreach (var fragment in bannedReferences)
                {
                    if (codeAndStrings.Contains(fragment, StringComparison.Ordinal))
                    {
                        offenders.Add($"{Path.GetFileName(file)} references \"{fragment}\"");
                    }
                }
            }

            Check(offenders.Count == 0,
                $"no voice source writes a mute/volume, takes a device exclusively, or reaches a "
                + $"banned audio API — found: {string.Join("; ", offenders)}");

            // A scan over an empty directory also finds nothing. Prove it read files.
            Check(scanned >= 20, $"the source scan actually read the voice sources ({scanned} files)");
            Console.WriteLine($"  scanned {scanned} voice source files for banned audio APIs — clean.");
        }

        // ---- by measurement -------------------------------------------------
        // Build the real engine — which constructs the Kokoro synthesizer, starts
        // its device watchdog and enumerates endpoints — and prove the capture
        // device came out the far side identical. No capture is started and no
        // audio is played.
        var before = AudioDevicePosture.ReadDefaultCapture();
        if (before.DeviceName is null)
        {
            Console.WriteLine($"  microphone posture check SKIPPED — {before.Error ?? "no capture device"}.");
            return;
        }

        using (var engine = new LocalVoiceEngine())
        {
            engine.ProbeAudioEndpoints();
            Check(!engine.IsDictationRunning,
                "constructing the engine and probing endpoints does not open the microphone");
        }

        var after = AudioDevicePosture.ReadDefaultCapture();
        Check(before.Fingerprint == after.Fingerprint,
            $"the microphone is untouched by the voice stack ({before.Fingerprint} -> {after.Fingerprint})");

        Console.WriteLine($"  microphone unchanged: {after.Fingerprint}");
    }

    /// <summary>
    /// Runs the real helmion-voice.exe and asserts its round trip, which is the
    /// proof that the stack works OUTSIDE the WPF window rather than only inside it.
    /// </summary>
    private static void CheckConsoleHostRoundTrip()
    {
        var exe = FindVoiceHostExecutable();
        if (exe is null)
        {
            Console.WriteLine(
                "Console host round-trip SKIPPED — helmion-voice.exe not found. "
                + "Build it with: dotnet build desktop/Helmion.Desktop.slnx -c Release");
            return;
        }

        // CreateNoWindow + UseShellExecute:false means CREATE_NO_WINDOW — the
        // child gets no console at all, so this cannot put anything on screen.
        var startInfo = new ProcessStartInfo(exe, "selftest")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("helmion-voice.exe did not start");

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();

        if (!process.WaitForExit(180_000))
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            Check(false, "helmion-voice selftest finished within 180 s");
            return;
        }

        if (process.ExitCode == 3)
        {
            Console.WriteLine($"Console host round-trip SKIPPED — models unavailable. {stderr.Trim()}");
            return;
        }

        Check(process.ExitCode == 0,
            $"helmion-voice selftest exits 0 (got {process.ExitCode}). stderr: {stderr.Trim()}");
        Check(stdout.Contains("round trip  : PASS", StringComparison.Ordinal),
            "the console host reports a passing round trip");
        Check(stdout.Contains("microphone untouched", StringComparison.Ordinal),
            "the console host proves the microphone was untouched by its own run");

        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            Console.WriteLine($"  host | {line.TrimEnd()}");
        }
    }

    /// <summary>
    /// Return a C# file with its comments removed, and optionally its string
    /// literals too, so a scan for banned APIs reads code rather than prose.
    /// </summary>
    /// <remarks>
    /// This is a lexer, not a regex. A naive replace would truncate at the "//"
    /// inside a URL string and silently drop the rest of that line — real code
    /// vanishing from the scan is exactly the hole that makes a passing result
    /// meaningless.
    ///
    /// <paramref name="stripStringLiterals"/> picks which question is being
    /// asked. True: "does this file CALL a banned API" — prose about SoundPlayer
    /// must not match. False: "does this file REFERENCE a banned external thing"
    /// — a COM ProgID or a script name only ever appears as a string, so the
    /// strings must survive.
    /// </remarks>
    private static string StripComments(string source, bool stripStringLiterals)
    {
        var code = new System.Text.StringBuilder(source.Length);
        var i = 0;

        while (i < source.Length)
        {
            var c = source[i];
            var next = i + 1 < source.Length ? source[i + 1] : '\0';

            if (c == '/' && next == '/')
            {
                while (i < source.Length && source[i] != '\n') i++;
                continue;
            }

            if (c == '/' && next == '*')
            {
                i += 2;
                while (i + 1 < source.Length && !(source[i] == '*' && source[i + 1] == '/')) i++;
                i = Math.Min(i + 2, source.Length);
                code.Append(' ');
                continue;
            }

            // Raw string literal: """ ... """ (and longer fences).
            if (c == '"' && next == '"' && i + 2 < source.Length && source[i + 2] == '"')
            {
                var start = i;
                var fence = 0;
                while (i + fence < source.Length && source[i + fence] == '"') fence++;
                var quotes = new string('"', fence);
                var end = source.IndexOf(quotes, i + fence, StringComparison.Ordinal);
                i = end < 0 ? source.Length : end + fence;
                AppendLiteral(code, source, start, i, stripStringLiterals);
                continue;
            }

            // Verbatim string: @"..." where "" is an escaped quote.
            if (c == '@' && next == '"')
            {
                var start = i;
                i += 2;
                while (i < source.Length)
                {
                    if (source[i] == '"')
                    {
                        if (i + 1 < source.Length && source[i + 1] == '"') { i += 2; continue; }
                        i++;
                        break;
                    }

                    i++;
                }

                AppendLiteral(code, source, start, i, stripStringLiterals);
                continue;
            }

            if (c == '"' || c == '\'')
            {
                var start = i;
                var quote = c;
                i++;
                while (i < source.Length && source[i] != quote)
                {
                    i += source[i] == '\\' ? 2 : 1;
                }

                i = Math.Min(i + 1, source.Length);
                AppendLiteral(code, source, start, i, stripStringLiterals);
                continue;
            }

            code.Append(c);
            i++;
        }

        return code.ToString();
    }

    /// <summary>
    /// Emit a string literal, or a single space in its place when the caller is
    /// scanning for calls rather than references.
    /// </summary>
    private static void AppendLiteral(
        System.Text.StringBuilder code,
        string source,
        int start,
        int end,
        bool strip)
    {
        if (strip)
        {
            code.Append(' ');
            return;
        }

        code.Append(source, start, Math.Min(end, source.Length) - start);
    }

    /// <summary>
    /// Locate helmion-voice.exe by walking up from the test binary. Returns null
    /// rather than throwing, so an unbuilt host produces a skip, not a failure.
    /// </summary>
    private static string? FindVoiceHostExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("HELMION_VOICE_HOST");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var hostProject = FindRepoRelative("desktop", "Helmion.Voice.Host");
        if (hostProject is null)
        {
            return null;
        }

        foreach (var configuration in new[] { "Release", "Debug" })
        {
            var candidate = Path.Combine(
                hostProject, "bin", configuration, "net10.0-windows", "helmion-voice.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>Walk up from the test binary looking for a directory in the repo.</summary>
    private static string? FindRepoRelative(params string[] segments)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; directory is not null && depth < 10; depth++, directory = directory.Parent)
        {
            var candidate = Path.Combine([directory.FullName, .. segments]);
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        // The suite is also run with the repo root as the working directory.
        var fromCurrent = Path.Combine([Environment.CurrentDirectory, .. segments]);
        return Directory.Exists(fromCurrent) ? fromCurrent : null;
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            Console.Error.WriteLine($"VOICE HOST SMOKE FAILED: {description}");
            Environment.Exit(1);
        }

        _checks++;
    }
}

using System.Text;
using Helmion.Desktop.Core;

namespace Helmion.Voice.Host;

/// <summary>
/// Console front end for Helmion's local voice stack — Whisper in, Kokoro out.
/// </summary>
/// <remarks>
/// The engine itself was already proven (LocalVoiceEngine + the smoke suite's
/// round trip), but it was reachable from exactly one place: inside the WPF
/// window. This host exists so the same two models can be driven from any
/// PowerShell session, which is where Troy actually talks to an AI.
///
/// Console only. No WPF reference, no Windows Forms, no hidden window, no
/// message box. The one place this touches the UI world at all is SendInput,
/// which types into whatever window ALREADY has focus and creates nothing.
///
/// Everything runs offline against the two model files. Nothing here opens a
/// socket, and there is no edge-tts, no SAPI and no SoundPlayer anywhere in the
/// dependency graph.
/// </remarks>
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitUsage = 2;
    private const int ExitDegraded = 3;
    private const int ExitAlreadyRunning = 4;
    private const int ExitFailed = 5;

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        if (args.Length == 0 || IsHelp(args[0]))
        {
            PrintUsage();
            return args.Length == 0 ? ExitUsage : ExitOk;
        }

        var verb = args[0].ToLowerInvariant();
        var rest = args[1..];

        HostLog.Configure(HasFlag(rest, "--quiet"), ValueOf(rest, "--log"));

        try
        {
            return verb switch
            {
                "speak" => Speak(rest),
                "listen" => Listen(rest, typeIntoFocusedWindow: false),
                "type" => Listen(rest, typeIntoFocusedWindow: true),
                "hotkey" => Hotkey(rest),
                "transcribe" => Transcribe(rest),
                "probe" => Probe(),
                "selftest" => SelfTest(),
                _ => UnknownVerb(verb),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"helmion-voice: {ex.GetType().Name}: {ex.Message}");
            return ExitFailed;
        }
    }

    // ---- speak ------------------------------------------------------------

    /// <summary>
    /// Synthesize text through Kokoro and block until playback finishes.
    /// Text comes from --text, or from stdin when it is not given, so a reply can
    /// be piped in from anywhere.
    /// </summary>
    private static int Speak(string[] args)
    {
        var text = ValueOf(args, "--text") ?? Console.In.ReadToEnd();
        var raw = HasFlag(args, "--raw");

        if (string.IsNullOrWhiteSpace(text))
        {
            Console.Error.WriteLine("helmion-voice speak: nothing to say (no --text and empty stdin).");
            return ExitUsage;
        }

        // Cleaning strips markdown and tool chrome and caps the length at
        // SpeechTextCleaner.MaxSpokenLength (1200 chars) so one reply cannot
        // monologue. --raw opts out, at the cost of hearing asterisks read aloud.
        var spoken = raw ? text.Trim() : LocalVoiceEngine.CleanForSpeech(text);
        if (string.IsNullOrWhiteSpace(spoken))
        {
            return ExitOk;   // input was entirely markup
        }

        using var engine = new LocalVoiceEngine();
        engine.Error += (_, message) => Console.Error.WriteLine(message);

        var endpoints = engine.ProbeAudioEndpoints();
        if (!endpoints.IsReadyForTts)
        {
            Console.Error.WriteLine(
                $"helmion-voice speak: {endpoints.Warning ?? "TTS is not available."}");
            return ExitDegraded;
        }

        engine.Speak(spoken);
        return engine.State == VoiceState.Degraded ? ExitDegraded : ExitOk;
    }

    // ---- listen / type ----------------------------------------------------

    /// <summary>
    /// Continuous dictation. With <paramref name="typeIntoFocusedWindow"/> the
    /// words are typed into whatever window has focus; without it they are
    /// written to stdout, one utterance per line, for a caller to consume.
    /// </summary>
    private static int Listen(string[] args, bool typeIntoFocusedWindow)
    {
        using var guard = SingleInstanceGuard.TryAcquire(out var busyReason);
        if (guard is null)
        {
            HostLog.Status($"helmion-voice: {busyReason}");
            return ExitAlreadyRunning;
        }

        var typist = new DictationTypist(appendSpace: !HasFlag(args, "--no-space"));
        using var shutdown = new ShutdownSignal();
        using var engine = new LocalVoiceEngine();

        engine.Error += (_, message) => HostLog.Status(message);

        var lastForeground = IntPtr.Zero;

        engine.SpeechRecognized += (_, transcript) =>
        {
            if (!typeIntoFocusedWindow)
            {
                Console.WriteLine(transcript);
                Console.Out.Flush();
                return;
            }

            // Focus moved since the last chunk? Then the caret is no longer after
            // our text and "scratch that" must not backspace through whatever is
            // there now.
            var foreground = KeyboardInjector.ForegroundWindow;
            if (foreground != lastForeground)
            {
                typist.ForgetTypedHistory();
                lastForeground = foreground;
            }

            foreach (var action in typist.Translate(transcript))
            {
                if (action.Kind == DictationActionKind.StopDictation)
                {
                    HostLog.Status("helmion-voice: \"stop dictation\" heard — stopping.");
                    shutdown.Request();
                    return;
                }

                if (!KeyboardInjector.Perform(action))
                {
                    HostLog.Status(
                        "helmion-voice: the OS refused the keystrokes. A window running as "
                        + "administrator, or a secure desktop prompt, has focus.");
                }
            }
        };

        VoiceHostSignals.WritePidFile();
        try
        {
            engine.StartDictation();
            if (!engine.IsDictationRunning)
            {
                HostLog.Status("helmion-voice: the microphone could not be opened.");
                return ExitDegraded;
            }

            HostLog.Status(
                typeIntoFocusedWindow
                    ? "helmion-voice: listening — speak, and the words are typed where your cursor is. "
                      + "Say \"send it\" to submit, \"stop dictation\" to finish."
                    : "helmion-voice: listening — transcripts on stdout. Ctrl+C to finish.");

            shutdown.Wait();
            return ExitOk;
        }
        finally
        {
            engine.StopDictation();
            VoiceHostSignals.DeletePidFile();
        }
    }

    // ---- hotkey -----------------------------------------------------------

    /// <summary>
    /// Sit in the background holding one global hotkey. Pressing it toggles
    /// dictation-into-the-focused-window on and off.
    /// </summary>
    private static int Hotkey(string[] args)
    {
        var chordText = ValueOf(args, "--chord") ?? HotkeyChord.DefaultChord;
        if (!HotkeyChord.TryParse(chordText, out var chord, out var parseError))
        {
            Console.Error.WriteLine($"helmion-voice hotkey: {parseError}");
            return ExitUsage;
        }

        using var guard = SingleInstanceGuard.TryAcquire(out var busyReason);
        if (guard is null)
        {
            HostLog.Status($"helmion-voice: {busyReason}");
            return ExitAlreadyRunning;
        }

        using var listener = new GlobalHotkeyListener(chord);
        if (!listener.TryRegister(out var registerError))
        {
            HostLog.Status($"helmion-voice hotkey: {registerError}");
            return ExitFailed;
        }

        var typist = new DictationTypist(appendSpace: !HasFlag(args, "--no-space"));
        using var shutdown = new ShutdownSignal();
        using var engine = new LocalVoiceEngine();

        engine.Error += (_, message) => HostLog.Status(message);

        var lastForeground = IntPtr.Zero;
        var dictating = false;

        engine.SpeechRecognized += (_, transcript) =>
        {
            if (!Volatile.Read(ref dictating))
            {
                return;
            }

            var foreground = KeyboardInjector.ForegroundWindow;
            if (foreground != lastForeground)
            {
                typist.ForgetTypedHistory();
                lastForeground = foreground;
            }

            foreach (var action in typist.Translate(transcript))
            {
                if (action.Kind == DictationActionKind.StopDictation)
                {
                    Volatile.Write(ref dictating, false);
                    engine.PauseDictation();
                    HostLog.Status("helmion-voice: dictation OFF (heard \"stop dictation\").");
                    return;
                }

                KeyboardInjector.Perform(action);
            }
        };

        VoiceHostSignals.WritePidFile();
        HostLog.Status(
            $"helmion-voice: {chord.Display} is armed. Press it to start dictating into the "
            + "window you are working in; press it again to stop. The microphone stays CLOSED "
            + "until you press it.");

        try
        {
            listener.Run(shutdown.Handle, () =>
            {
                if (Volatile.Read(ref dictating))
                {
                    Volatile.Write(ref dictating, false);
                    engine.PauseDictation();
                    HostLog.Status("helmion-voice: dictation OFF.");
                    return;
                }

                typist.ForgetTypedHistory();
                engine.StartDictation();
                if (!engine.IsDictationRunning)
                {
                    HostLog.Status("helmion-voice: the microphone could not be opened.");
                    return;
                }

                Volatile.Write(ref dictating, true);
                HostLog.Status("helmion-voice: dictation ON — speak.");
            });

            return ExitOk;
        }
        finally
        {
            engine.StopDictation();
            VoiceHostSignals.DeletePidFile();
        }
    }

    // ---- transcribe / probe / selftest -------------------------------------

    private static int Transcribe(string[] args)
    {
        var path = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal));
        if (path is null || !File.Exists(path))
        {
            Console.Error.WriteLine("helmion-voice transcribe: give the path to an existing WAV file.");
            return ExitUsage;
        }

        using var engine = new LocalVoiceEngine();
        engine.Error += (_, message) => Console.Error.WriteLine(message);

        var transcript = engine.TranscribeWavFile(path);
        if (string.IsNullOrWhiteSpace(transcript))
        {
            return ExitDegraded;
        }

        Console.WriteLine(transcript);
        return ExitOk;
    }

    /// <summary>
    /// Report what the stack can do right now, without producing a single sound
    /// and without opening the microphone.
    /// </summary>
    private static int Probe()
    {
        var missing = VoiceModelPaths.DescribeMissingAssets();
        using var engine = new LocalVoiceEngine();
        var endpoints = engine.ProbeAudioEndpoints();
        var mic = AudioDevicePosture.ReadDefaultCapture();

        Console.WriteLine($"models directory : {VoiceModelPaths.ModelsDirectory ?? "<not found>"}");
        Console.WriteLine($"whisper model    : {VoiceModelPaths.WhisperModelPath ?? "<missing>"}");
        Console.WriteLine($"kokoro model     : {VoiceModelPaths.KokoroModelPath ?? "<missing>"}");
        Console.WriteLine($"missing assets   : {missing ?? "none"}");
        Console.WriteLine($"output devices   : {endpoints.RenderDeviceCount}");
        Console.WriteLine($"kokoro voices    : {endpoints.VoiceCount} (preferred: {endpoints.PreferredVoiceName ?? "<none>"})");
        Console.WriteLine($"tts ready        : {endpoints.IsReadyForTts}");
        Console.WriteLine($"microphone       : {mic.DeviceName ?? mic.Error ?? "<unknown>"}");
        Console.WriteLine($"microphone muted : {mic.IsMuted?.ToString() ?? "<unreadable>"}  (this host never writes it)");
        Console.WriteLine($"share mode       : {AudioDevicePosture.DescribeShareMode()}");
        if (endpoints.Warning is not null)
        {
            Console.WriteLine($"warning          : {endpoints.Warning}");
        }

        return endpoints.IsReadyForTts ? ExitOk : ExitDegraded;
    }

    /// <summary>
    /// Prove the round trip inside THIS process: Kokoro writes a sentence to a
    /// WAV, Whisper reads it back, and the two are compared. No speaker, no
    /// microphone, no window — so it is safe to run at any time.
    /// </summary>
    private static int SelfTest()
    {
        const string sentence = "The quick brown fox jumps over the lazy dog.";

        var missing = VoiceModelPaths.DescribeMissingAssets();
        if (missing is not null)
        {
            Console.Error.WriteLine($"helmion-voice selftest: {missing}");
            return ExitDegraded;
        }

        using var engine = new LocalVoiceEngine();
        engine.Error += (_, message) => Console.Error.WriteLine(message);

        var wavPath = Path.Combine(
            Path.GetTempPath(),
            $"helmion-voice-selftest-{Guid.NewGuid():N}.wav");

        var micBefore = AudioDevicePosture.ReadDefaultCapture();

        try
        {
            var watch = System.Diagnostics.Stopwatch.StartNew();
            if (!engine.SynthesizeToWavFile(sentence, wavPath))
            {
                Console.Error.WriteLine("helmion-voice selftest: Kokoro produced no audio.");
                return ExitFailed;
            }

            var synthMs = watch.ElapsedMilliseconds;
            var bytes = new FileInfo(wavPath).Length;
            var seconds = (bytes - 44d) / (VoiceAudio.KokoroSampleRate * 2d);

            watch.Restart();
            var transcript = engine.TranscribeWavFile(wavPath);
            var sttMs = watch.ElapsedMilliseconds;

            var micAfter = AudioDevicePosture.ReadDefaultCapture();

            Console.WriteLine($"synthesized : {bytes:N0} bytes, {seconds:F2}s, {synthMs} ms");
            Console.WriteLine($"spoken      : {sentence}");
            Console.WriteLine($"transcribed : {transcript.Trim()}  ({sttMs} ms)");
            Console.WriteLine($"microphone  : {micBefore.Fingerprint}");

            if (micBefore.Fingerprint != micAfter.Fingerprint)
            {
                Console.Error.WriteLine(
                    $"helmion-voice selftest: the microphone changed during the run "
                    + $"({micBefore.Fingerprint} -> {micAfter.Fingerprint}).");
                return ExitFailed;
            }

            var matches = Simplify(transcript) == Simplify(sentence);
            Console.WriteLine(matches
                ? "round trip  : PASS (transcript matches, microphone untouched)"
                : "round trip  : FAIL (transcript does not match)");

            return matches ? ExitOk : ExitFailed;
        }
        finally
        {
            try
            {
                if (File.Exists(wavPath))
                {
                    File.Delete(wavPath);
                }
            }
            catch (IOException)
            {
            }
        }
    }

    private static string Simplify(string text) =>
        System.Text.RegularExpressions.Regex
            .Replace(text.ToLowerInvariant(), "[^a-z0-9 ]", string.Empty)
            .Replace("  ", " ")
            .Trim();

    // ---- argument helpers --------------------------------------------------

    private static bool IsHelp(string arg) =>
        arg is "-h" or "--help" or "help" or "/?";

    private static bool HasFlag(string[] args, string name) =>
        args.Any(a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));

    private static string? ValueOf(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }

        return null;
    }

    private static int UnknownVerb(string verb)
    {
        Console.Error.WriteLine($"helmion-voice: unknown command '{verb}'.");
        PrintUsage();
        return ExitUsage;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            helmion-voice — Helmion's local voice stack on the command line.
            Whisper (speech to text) and Kokoro (text to speech), both offline.

              speak  [--text "..."] [--raw]   Say it. Reads stdin when --text is absent.
              listen [--no-space]             Dictate; transcripts to stdout, one per line.
              type   [--no-space]             Dictate into whatever window has focus.
              hotkey [--chord "ctrl+shift+alt+h"] [--no-space]
                                              Hold a global hotkey that toggles `type`.
              transcribe <file.wav>           Transcribe an existing WAV.
              probe                           Report readiness. Makes no sound.
              selftest                        Synthesize, transcribe, compare. Makes no sound.

            Dictation commands, spoken as the whole utterance:
              "new line"      insert a line break        "send it"        submit
              "scratch that"  erase the last chunk       "stop dictation" finish

            On any command:
              --quiet                         Write no status to the console.
              --log <file>                    Append status to a file instead.

            Exit codes: 0 ok, 2 usage, 3 degraded, 4 already running, 5 failed.
            """);
    }
}

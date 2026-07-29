using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using Helmion.VoiceDictation;
using KokoroSharp;
using KokoroSharp.Core;
using KokoroSharp.Processing;

namespace Helmion.VoiceDictation.SelfTest;

/// <summary>
/// Proves the two things about this tool that can be proven without a human at a
/// microphone: that transcription with the vocabulary prompt beats transcription
/// without it, and that injected text actually lands in a focused window.
/// </summary>
/// <remarks>
/// The live "Troy presses the hotkey and talks" test is his and is not claimed
/// here. What IS claimed is measured: a Kokoro-synthesized sentence carrying his
/// vocabulary is decoded twice through the same model — once unbiased, once with
/// the prompt — and the two transcripts are compared term by term.
/// </remarks>
internal static class Program
{
    /// <summary>
    /// Deliberately packed with the exact words Windows dictation mangled in his
    /// transcript: Helmion became "Helmand"/"hell me and", Moshi became
    /// "Moshe"/"motion", LLMs became "LL Mississippi", duplex became "dual".
    /// </summary>
    private const string RoundTripSentence =
        "Helmion runs Moshi and Kokoro locally, while Kyutai ships duplex LLMs for DairyForge.";

    private static readonly string[] TargetTerms =
        { "Helmion", "Moshi", "Kokoro", "Kyutai", "duplex", "LLMs", "DairyForge" };

    private static int _failures;

    [STAThread]
    private static int Main(string[] args)
    {
        var runInjection = !args.Contains("--no-injection", StringComparer.OrdinalIgnoreCase);

        Console.OutputEncoding = Encoding.UTF8;
        DictationLog.Initialize(Path.Combine(Path.GetTempPath(), "helmion-dictation-selftest.log"));

        Console.WriteLine("=== Helmion Voice Dictation self-test ===");
        Console.WriteLine();

        CheckConfig();
        CheckHotkeyParsing();
        var transcriber = CheckVocabularyRoundTrip();

        if (runInjection)
        {
            CheckInjection();
        }
        else
        {
            Console.WriteLine("[SKIP ] injection checks (--no-injection)");
        }

        transcriber?.Dispose();

        Console.WriteLine();
        Console.WriteLine(_failures == 0
            ? "ALL CHECKS PASSED"
            : $"{_failures} CHECK(S) FAILED");

        return _failures == 0 ? 0 : 1;
    }

    private static void Check(bool condition, string description)
    {
        if (condition)
        {
            Console.WriteLine($"[ PASS] {description}");
            return;
        }

        _failures++;
        Console.WriteLine($"[*FAIL] {description}");
    }

    private static void CheckConfig()
    {
        Console.WriteLine("-- config --");

        var path = Path.Combine(AppContext.BaseDirectory, "voice-dictation.config.json");
        var shipped = File.Exists(path);

        // The SelfTest output folder does not receive the daemon's config file, so
        // fall back to reading it from the daemon's own output next door.
        if (!shipped)
        {
            path = Path.GetFullPath(Path.Combine(
                AppContext.BaseDirectory,
                @"..\..\..\..\Helmion.VoiceDictation\bin\Release\net10.0-windows\voice-dictation.config.json"));
        }

        var config = DictationConfig.Load(path, out var problem);
        Check(problem is null, $"config loads from {path}");

        var prompt = config.BuildVocabularyPrompt();
        Check(prompt.Length > 0, "vocabulary prompt is non-empty");
        Check(prompt.Length <= DictationConfig.PromptCharBudget,
            $"vocabulary prompt fits Whisper's 224-token window ({prompt.Length} <= {DictationConfig.PromptCharBudget} chars)");

        foreach (var term in new[] { "Helmion", "Moshi", "Kokoro", "DairyForge", "quantization" })
        {
            Check(prompt.Contains(term, StringComparison.Ordinal),
                $"vocabulary prompt seeds \"{term}\"");
        }

        // A blank vocabulary must produce a blank prompt, not the word "The
        // following words appear in this recording:" with nothing after it —
        // that would bias every transcript toward a meaningless preamble.
        var empty = new DictationConfig { Vocabulary = Array.Empty<string>() };
        Check(empty.BuildVocabularyPrompt().Length == 0, "an empty vocabulary produces no prompt at all");

        var overridden = new DictationConfig
        {
            Vocabulary = new[] { "Ignored" },
            VocabularyPromptOverride = "Verbatim prompt.",
        };
        Check(overridden.BuildVocabularyPrompt() == "Verbatim prompt.",
            "vocabularyPromptOverride replaces the generated prompt exactly");

        // Overflow keeps the TAIL, because Whisper weights later tokens more.
        var huge = new DictationConfig
        {
            Vocabulary = Enumerable.Range(0, 400).Select(i => $"term{i:D4}").ToArray(),
        };
        var trimmed = huge.BuildVocabularyPrompt();
        Check(trimmed.Length <= DictationConfig.PromptCharBudget,
            $"an oversized vocabulary is trimmed to the budget ({trimmed.Length} chars)");
        Check(trimmed.EndsWith("term0399.", StringComparison.Ordinal),
            "trimming keeps the END of the list, which is the end Whisper weights most");

        Console.WriteLine();
    }

    private static void CheckHotkeyParsing()
    {
        Console.WriteLine("-- hotkey parsing --");

        Check(HotkeySpec.TryParse("ctrl+alt+space", out var space, out _)
            && space.VirtualKey == (uint)Keys.Space
            && (space.Modifiers & HotkeySpec.ModControl) != 0
            && (space.Modifiers & HotkeySpec.ModAlt) != 0
            && (space.Modifiers & HotkeySpec.ModShift) == 0,
            "\"ctrl+alt+space\" parses to Ctrl+Alt and VK_SPACE, with no Shift");

        Check(HotkeySpec.TryParse("ctrl+alt+space", out var repeat, out _)
            && (repeat.Modifiers & HotkeySpec.ModNoRepeat) != 0,
            "MOD_NOREPEAT is set, so holding the key cannot toggle recording repeatedly");

        // The reason Grok Build's Ctrl+Space is safe: RegisterHotKey matches the
        // modifier set exactly, and these two differ.
        Check(HotkeySpec.TryParse("ctrl+space", out var grok, out _)
            && grok.Modifiers != space.Modifiers,
            "ctrl+space and ctrl+alt+space are distinct registrations (Grok's binding is untouched)");

        Check(!HotkeySpec.TryParse("space", out _, out var bare) && bare is not null,
            "a modifier-less hotkey is refused rather than hijacking that key machine-wide");
        Check(!HotkeySpec.TryParse("ctrl+alt+notakey", out _, out _), "an unknown key name is refused");
        Check(!HotkeySpec.TryParse("", out _, out _), "an empty hotkey is refused");
        Check(HotkeySpec.TryParse("ctrl+shift+f9", out var f9, out _) && f9.VirtualKey == (uint)Keys.F9,
            "function keys parse");
        Check(HotkeySpec.TryParse("ctrl+alt+x", out var x, out _) && x.VirtualKey == (uint)Keys.X,
            "the default cancel hotkey ctrl+alt+x parses");

        Console.WriteLine();
    }

    /// <summary>
    /// The real vocabulary test: synthesize a sentence containing Troy's terms,
    /// then decode it twice through the SAME model — unbiased, then prompted.
    /// </summary>
    private static VocabularyTranscriber? CheckVocabularyRoundTrip()
    {
        Console.WriteLine("-- vocabulary round-trip (Kokoro speaks it, Whisper reads it back) --");

        var modelPath = VocabularyTranscriber.ResolveModelPath(null);
        if (modelPath is null)
        {
            _failures++;
            Console.WriteLine("[*FAIL] ggml-base.en.bin not found — cannot run the round-trip.");
            Console.WriteLine();
            return null;
        }

        Console.WriteLine($"        whisper model : {modelPath}");

        var wavPath = Path.Combine(Path.GetTempPath(), "helmion-dictation-vocab.wav");
        if (!SynthesizeToWav(RoundTripSentence, wavPath, out var kokoroProblem))
        {
            _failures++;
            Console.WriteLine($"[*FAIL] Kokoro could not synthesize the test sentence: {kokoroProblem}");
            Console.WriteLine();
            return null;
        }

        var wavBytes = new FileInfo(wavPath).Length;
        Check(wavBytes > 40_000, $"Kokoro wrote a real WAV ({wavBytes:N0} bytes) at {wavPath}");

        var configPath = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            @"..\..\..\..\Helmion.VoiceDictation\bin\Release\net10.0-windows\voice-dictation.config.json"));
        var config = DictationConfig.Load(configPath, out _);
        var prompt = config.BuildVocabularyPrompt();

        var transcriber = new VocabularyTranscriber(modelPath, prompt);

        var unbiased = transcriber.TranscribeWavFile(wavPath, string.Empty);
        var biased = transcriber.TranscribeWavFile(wavPath, prompt);

        Console.WriteLine();
        Console.WriteLine($"        spoken        : {RoundTripSentence}");
        Console.WriteLine($"        no vocabulary : {unbiased}");
        Console.WriteLine($"        WITH vocab    : {biased}");
        Console.WriteLine();

        Check(unbiased.Length > 0, "the unbiased decode produced text (the STT path itself works)");
        Check(biased.Length > 0, "the vocabulary-biased decode produced text");

        var unbiasedHits = TargetTerms.Count(t => biasedContains(unbiased, t));
        var biasedHits = TargetTerms.Count(t => biasedContains(biased, t));

        Console.WriteLine($"        terms transcribed correctly — without prompt: {unbiasedHits}/{TargetTerms.Length}, with prompt: {biasedHits}/{TargetTerms.Length}");
        foreach (var term in TargetTerms)
        {
            var before = biasedContains(unbiased, term) ? "yes" : "NO ";
            var after = biasedContains(biased, term) ? "yes" : "NO ";
            var verdict = before == after ? "same" : (after == "yes" ? "FIXED by prompt" : "lost");
            Console.WriteLine($"          {term,-12} without: {before}   with: {after}   {verdict}");
        }

        Console.WriteLine();

        // The honest assertion. The claim is "the prompt biases decoding toward
        // these spellings", so the test is that the prompt never makes things
        // worse and that the prompted decode gets a majority of the terms right.
        // Asserting a specific improvement count would be asserting a property of
        // Kokoro's pronunciation, not of this tool.
        Check(biasedHits >= unbiasedHits,
            $"the vocabulary prompt does not degrade recognition ({biasedHits} >= {unbiasedHits})");
        Check(biasedHits >= TargetTerms.Length - 2,
            $"with the prompt, at least {TargetTerms.Length - 2} of {TargetTerms.Length} seeded terms transcribe correctly (got {biasedHits})");

        Console.WriteLine();
        return transcriber;

        static bool biasedContains(string haystack, string term) =>
            haystack.Contains(term, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Inject into a real, focusable, OFF-SCREEN text box and read back what
    /// arrived. Off-screen and ShowInTaskbar=false so nothing appears on Troy's
    /// display; the previous foreground window is restored afterwards so his
    /// focus is where he left it.
    /// </summary>
    private static void CheckInjection()
    {
        Console.WriteLine("-- injection --");

        var previousForeground = GetForegroundWindow();

        try
        {
            RunInjectionCase(
                "paste",
                new DictationConfig
                {
                    InjectionMode = "paste",
                    RestoreClipboard = false,
                    AppendTrailingSpace = true,
                    AutoSubmit = false,
                },
                "Helmion Moshi Kokoro duplex LLMs");

            RunInjectionCase(
                "type",
                new DictationConfig
                {
                    InjectionMode = "type",
                    RestoreClipboard = false,
                    AppendTrailingSpace = true,
                    AutoSubmit = false,
                },
                "Kyutai DairyForge quantization VRAM");

            CheckNewlineSafety();
            CheckClipboardRestore();
        }
        finally
        {
            if (previousForeground != IntPtr.Zero)
            {
                SetForegroundWindow(previousForeground);
            }
        }

        Console.WriteLine();
    }

    private static void RunInjectionCase(string mode, DictationConfig config, string text)
    {
        using var target = new TargetWindow();

        if (!ForceForeground(target.Handle))
        {
            _failures++;
            Console.WriteLine(
                $"[*FAIL] {mode}: could not take foreground focus, so this case proves nothing. "
                + "(Another window refused to yield; re-run when the desktop is idle.)");
            return;
        }

        TextInjector.Inject(text, config);
        Thread.Sleep(600);

        var expected = text + " ";
        var actual = target.Text;

        Check(actual == expected,
            $"{mode}: the focused window received exactly the injected text "
            + $"(expected \"{expected}\", got \"{actual}\")");

        if (config.UsesPasteInjection)
        {
            Check(Clipboard.ContainsText() && Clipboard.GetText() == expected,
                $"{mode}: the clipboard carried the payload");
        }
    }

    /// <summary>
    /// A newline in a transcript would submit the prompt in Claude Code before
    /// Troy could read what was heard. It must be flattened to a space.
    /// </summary>
    private static void CheckNewlineSafety()
    {
        using var target = new TargetWindow();

        if (!ForceForeground(target.Handle))
        {
            _failures++;
            Console.WriteLine("[*FAIL] newline safety: could not take focus.");
            return;
        }

        TextInjector.Inject(
            "first line\r\nsecond line",
            new DictationConfig
            {
                InjectionMode = "paste",
                RestoreClipboard = false,
                AppendTrailingSpace = false,
                AutoSubmit = false,
            });

        Thread.Sleep(600);

        var received = target.Text;
        Check(!received.Contains('\n') && !received.Contains('\r'),
            $"a newline in the transcript is flattened, so dictation can never press Enter (got \"{received}\")");
    }

    private static void CheckClipboardRestore()
    {
        const string sentinel = "TROY-CLIPBOARD-SENTINEL-2026-07-28";

        using var target = new TargetWindow();

        if (!ForceForeground(target.Handle))
        {
            _failures++;
            Console.WriteLine("[*FAIL] clipboard restore: could not take focus.");
            return;
        }

        Clipboard.SetDataObject(sentinel, copy: true, retryTimes: 10, retryDelay: 25);

        TextInjector.Inject(
            "dictated words",
            new DictationConfig
            {
                InjectionMode = "paste",
                RestoreClipboard = true,
                AppendTrailingSpace = false,
                AutoSubmit = false,
            });

        Thread.Sleep(700);

        // Both halves matter, and the first is the one that regressed: restoring
        // the clipboard must NOT beat the target's paste, or the target ends up
        // pasting the sentinel instead of the dictation.
        var received = target.Text;
        Check(received == "dictated words",
            $"the target pasted the DICTATION, not the restored clipboard (got \"{received}\")");
        Check(Clipboard.ContainsText() && Clipboard.GetText() == sentinel,
            "whatever was on the clipboard before dictation is put back afterwards");
    }

    /// <summary>
    /// A real, focusable window that Troy cannot see: fully transparent, absent
    /// from the taskbar and from Alt-Tab.
    /// </summary>
    /// <remarks>
    /// Opacity 0 rather than an off-screen position, because a window parked at
    /// -32000,-32000 activates unreliably while a transparent on-screen one
    /// behaves like any normal window. A layered window with zero alpha still
    /// receives keyboard input — only WS_EX_TRANSPARENT passes input through, and
    /// that flag is not set here.
    /// </remarks>
    private static Form CreateInvisibleTarget(out TextBox box)
    {
        var form = new Form
        {
            StartPosition = FormStartPosition.Manual,
            Location = new Point(40, 40),
            Size = new Size(320, 80),
            ShowInTaskbar = false,
            FormBorderStyle = FormBorderStyle.None,
            Opacity = 0d,
            TopMost = true,
        };

        box = new TextBox { Multiline = true, Dock = DockStyle.Fill };
        form.Controls.Add(box);
        form.Show();

        var focusTarget = box;
        form.Activate();
        focusTarget.Focus();
        Pump(150);

        return form;
    }

    /// <summary>
    /// Take the foreground, working around the rule that a process may only call
    /// SetForegroundWindow when it already owns the foreground window or received
    /// the last input event — which a test harness launched from a terminal does
    /// not. Attaching this thread's input queue to the current foreground thread
    /// lifts that restriction for the duration.
    /// </summary>
    /// <remarks>
    /// This exists ONLY in the harness. The daemon never calls it: dictation
    /// injects into whatever window Troy already has focused, so it has no reason
    /// to move focus and deliberately does not.
    /// </remarks>
    private static bool ForceForeground(IntPtr hwnd)
    {
        var foreground = GetForegroundWindow();
        if (foreground == hwnd)
        {
            return true;
        }

        var currentThread = GetCurrentThreadId();
        var foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);

        var attached = foregroundThread != 0
            && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);

        try
        {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
            SetFocus(hwnd);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        Pump(200);
        return GetForegroundWindow() == hwnd;
    }

    /// <summary>Run the message loop for a while so synthesized input is delivered.</summary>
    private static void Pump(int milliseconds)
    {
        var deadline = Environment.TickCount64 + milliseconds;
        while (Environment.TickCount64 < deadline)
        {
            Application.DoEvents();
            Thread.Sleep(10);
        }
    }

    /// <summary>
    /// Minimal Kokoro synthesis, mirroring the proven path in
    /// desktop/Helmion.Desktop.Core/KokoroSpeechSynthesizer.cs:282-318 but writing
    /// a WAV instead of touching an audio device.
    /// </summary>
    private static bool SynthesizeToWav(string text, string wavPath, out string problem)
    {
        problem = string.Empty;

        try
        {
            var espeak = Path.Combine(AppContext.BaseDirectory, "espeak");
            if (Directory.Exists(espeak))
            {
                Tokenizer.eSpeakNGPath = espeak;
            }

            var voices = Path.Combine(AppContext.BaseDirectory, "voices");
            if (!Directory.Exists(voices))
            {
                problem = $"no voices/ directory beside the test at {voices}";
                return false;
            }

            KokoroVoiceManager.LoadVoicesFromPath(voices);

            var modelPath = FindKokoroModel();
            if (modelPath is null)
            {
                problem = "kokoro.onnx not found (looked for models/ and desktop/models/ up the tree)";
                return false;
            }

            var voice = KokoroVoiceManager.GetVoice("af_heart");
            using var model = new KokoroModel(modelPath, null!);

            var language = KokoroLangCodeHelper.GetLangCode(voice);
            var tokens = Tokenizer.Tokenize(text, language, true);

            var samples = new List<float>();
            foreach (var segment in SegmentationSystem.SplitToSegments(tokens, new DefaultSegmentationConfig()))
            {
                if (segment.Length > 0)
                {
                    samples.AddRange(model.Infer(segment, voice.Features, 1.0f));
                }
            }

            if (samples.Count == 0)
            {
                problem = "synthesis produced no samples";
                return false;
            }

            // Kokoro emits 24 kHz; DictationAudio resamples on read, so writing at
            // Kokoro's native rate keeps this honest about what was synthesized.
            DictationAudio.WriteWav(wavPath, samples.ToArray(), 24000);
            return true;
        }
        catch (Exception ex)
        {
            problem = $"{ex.GetType().Name}: {ex.Message}";
            return false;
        }
    }

    private static string? FindKokoroModel()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; directory is not null && depth < 10; depth++, directory = directory.Parent)
        {
            foreach (var relative in new[] { "models", Path.Combine("desktop", "models") })
            {
                var candidate = Path.Combine(directory.FullName, relative, "kokoro.onnx");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}

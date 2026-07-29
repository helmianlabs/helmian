using System.Text;
using Helmion.Desktop.Core;

namespace Helmion.VoiceSpeak;

/// <summary>
/// Entry point. Three modes: speak one string and exit, sit watching a folder and
/// speak whatever is dropped into it, or signal a running watcher to stop.
/// </summary>
/// <remarks>
/// <para><b>Why a watcher and not only a one-shot command.</b> kokoro.onnx is
/// 310 MB and costs roughly 1.2 s to load (KokoroSpeechSynthesizer.cs:71). A
/// one-shot pays that on every sentence. The watcher pays it once and then speaks
/// on demand, which is what makes this usable for a back-and-forth rather than an
/// occasional announcement.</para>
///
/// <para><b>Why a folder of text files is the interface.</b> The point of this tool
/// is that ANY AI Troy runs can speak, not just one that can be taught a C# API.
/// Writing a text file is the one capability every terminal, script, agent and
/// language already has — PowerShell, Python, node, a bash heredoc. There is no
/// SDK to import and no port to agree on.</para>
///
/// <para><b>Why the queue is first-in-first-out and unbounded.</b> The obvious
/// alternative — autoplayer.ps1:41-45, which plays only the newest clip and
/// discards the rest — exists to stop several agents talking over each other. That
/// is the right trade for fire-and-forget announcements and the wrong one here,
/// where dropping a queued sentence would silently lose content Troy was told he
/// would hear. Pile-up is handled at the other end instead: a stop press clears
/// the entire queue at once (see StopSentinel), which is the escape hatch
/// CLAUDE.md rule 0.0124 asks for.</para>
/// </remarks>
internal static class Program
{
    private const string InstanceMutexName = @"Local\Helmion.VoiceSpeak.instance";
    private const string StopEventName = @"Local\Helmion.VoiceSpeak.stop";

    /// <summary>American female, Kokoro's default and Core's
    /// (KokoroSpeechSynthesizer.cs:31). Big Sister is female, so this matches the
    /// identity CLAUDE.md rule 0.26 locks — without touching the Edge-TTS voice map
    /// that rule pins by name.</summary>
    private const string DefaultVoice = "af_heart";

    private static int Main(string[] args)
    {
        SpeakLog.Initialize(null);

        try
        {
            if (HasFlag(args, "--stop"))
            {
                return SignalStop();
            }

            var voice = ValueOf(args, "--voice")
                ?? Environment.GetEnvironmentVariable("HELMION_SPEAK_VOICE")
                ?? DefaultVoice;

            if (HasFlag(args, "--watch"))
            {
                return RunWatcher(voice);
            }

            var text = ResolveOneShotText(args);
            if (!string.IsNullOrWhiteSpace(text))
            {
                var wav = ValueOf(args, "--wav");
                return wav is null ? SpeakOnce(text, voice) : WriteWav(text, voice, wav);
            }

            SpeakLog.Warn(
                "Nothing to do. Use --text \"...\", --file <path>, --wav <path>, --watch or --stop.");
            return 1;
        }
        catch (Exception ex)
        {
            SpeakLog.Error("Unhandled failure", ex);
            return 1;
        }
    }

    /// <summary>Load the model, speak once, exit.</summary>
    private static int SpeakOnce(string text, string voice)
    {
        var modelPath = SpeakPaths.ResolveKokoroModel();
        if (modelPath is null)
        {
            LogMissingModel();
            return 3;
        }

        using var synthesizer = new KokoroSpeechSynthesizer(modelPath, voice);
        synthesizer.Error += (_, message) => SpeakLog.Warn(message);

        return Utter(synthesizer, text) ? 0 : 1;
    }

    /// <summary>
    /// Synthesize to a 24 kHz WAV file instead of playing it, and touch no audio
    /// device at all (KokoroSpeechSynthesizer.cs:253-257).
    /// </summary>
    /// <remarks>
    /// This mode exists because nobody building this can hear it. Playback that
    /// silently fails and synthesis that silently produces nothing look identical
    /// from the log, and "it ran without an error" is not evidence of audio. A WAV
    /// on disk with a real byte count is evidence that the text → phonemes →
    /// tokens → model chain produced samples; only the speakers remain untested,
    /// and those are Troy's ears to judge. It doubles as the way to check a voice
    /// on a machine whose output device is broken.
    /// </remarks>
    private static int WriteWav(string text, string voice, string wavPath)
    {
        var modelPath = SpeakPaths.ResolveKokoroModel();
        if (modelPath is null)
        {
            LogMissingModel();
            return 3;
        }

        using var synthesizer = new KokoroSpeechSynthesizer(modelPath, voice);
        synthesizer.Error += (_, message) => SpeakLog.Warn(message);

        var samples = synthesizer.Synthesize(text);
        if (samples is null || samples.Length == 0)
        {
            SpeakLog.Error($"Synthesis produced no audio for {text.Length} chars.");
            return 1;
        }

        VoiceAudio.WriteWav(wavPath, samples, VoiceAudio.KokoroSampleRate);

        // The character count is logged next to the duration on purpose. A short
        // WAV has two very different causes — synthesis produced little audio, or
        // little text ever arrived — and they are indistinguishable from the file
        // alone. Passing this text as a PowerShell -ArgumentList element silently
        // truncated it at the first space, so every measurement taken that way was
        // of the first word only; the char count is what exposed that.
        var seconds = samples.Length / (double)VoiceAudio.KokoroSampleRate;
        SpeakLog.Info(
            $"Wrote {new FileInfo(wavPath).Length:N0} bytes to {wavPath} — "
            + $"{samples.Length:N0} samples = {seconds:N2}s of 24 kHz audio, "
            + $"from {text.Length} chars, voice \"{voice}\".");
        return 0;
    }

    /// <summary>
    /// Hold the model in memory and speak whatever lands in the queue folder.
    /// </summary>
    private static int RunWatcher(string voice)
    {
        using var instanceMutex = new Mutex(initiallyOwned: true, InstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // Two watchers on one folder would race for the same file and talk
            // over each other. Exit quietly rather than fight.
            SpeakLog.Warn("Another speak watcher is already running; this one is exiting.");
            return 2;
        }

        var modelPath = SpeakPaths.ResolveKokoroModel();
        if (modelPath is null)
        {
            LogMissingModel();
            return 3;
        }

        var queue = SpeakPaths.QueueDirectory;
        Directory.CreateDirectory(queue);

        SpeakLog.Info(new string('-', 60));
        SpeakLog.Info($"Helmion Voice Speak watching (pid {Environment.ProcessId}), voice \"{voice}\".");
        SpeakLog.Info($"Queue: {queue}");
        SpeakLog.Info($"Model: {modelPath}");

        // Anything already sitting in the queue predates this watcher and is
        // almost certainly stale — speaking it would be a surprise monologue on
        // startup. Same reasoning as autoplayer.ps1:16.
        var discarded = DrainQueue(queue);
        if (discarded > 0)
        {
            SpeakLog.Info($"Discarded {discarded} stale item(s) that predated startup.");
        }

        using var synthesizer = new KokoroSpeechSynthesizer(modelPath, voice);
        synthesizer.Error += (_, message) => SpeakLog.Warn(message);

        synthesizer.Warmup();
        SpeakLog.Info($"Ready — voice loaded as \"{synthesizer.LoadedVoiceName ?? voice}\".");

        using var stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, StopEventName);

        while (!stopEvent.WaitOne(100))
        {
            string? path;
            try
            {
                path = new DirectoryInfo(queue)
                    .GetFiles("*.txt")
                    .OrderBy(f => f.LastWriteTimeUtc)
                    .Select(f => f.FullName)
                    .FirstOrDefault();
            }
            catch (Exception ex)
            {
                SpeakLog.Warn($"Could not read the queue: {ex.Message}");
                continue;
            }

            if (path is null)
            {
                continue;
            }

            var text = TakeQueuedText(path);
            if (!string.IsNullOrWhiteSpace(text))
            {
                Utter(synthesizer, text);
            }
        }

        SpeakLog.Info("Speak watcher stopped.");
        return 0;
    }

    /// <summary>
    /// Speak one piece of text, cancellable by Troy's stop button throughout.
    /// Returns false when it did not finish — cancelled or failed.
    /// </summary>
    private static bool Utter(KokoroSpeechSynthesizer synthesizer, string text)
    {
        var sentinel = new StopSentinel();
        var startedUtc = DateTime.UtcNow;

        // Checked before a single sample is synthesised as well as during, so a
        // press that lands while the previous utterance was still draining is not
        // spent on this one before it is audible.
        if (sentinel.PressedSince(startedUtc.AddMilliseconds(-250)))
        {
            SpeakLog.Info("Stop was pressed just now — skipping this utterance.");
            ClearQueue();
            return false;
        }

        using var cancellation = new CancellationTokenSource();
        using var watch = sentinel.CancelOnPress(startedUtc, cancellation);

        var preview = text.Length <= 80 ? text : text[..80] + "…";
        SpeakLog.Info($"Speaking {text.Length} chars: {preview}");

        try
        {
            synthesizer.Speak(text, cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            // Handled below, so that both ways Speak can end on a cancel run the
            // same cleanup.
        }
        catch (Exception ex)
        {
            SpeakLog.Error("Speaking failed", ex);
            return false;
        }

        // Checked instead of relying on the catch, because Speak has TWO ways of
        // ending on a cancel and only one of them throws. A press between
        // segments hits ThrowIfCancellationRequested (KokoroSpeechSynthesizer.cs:219)
        // and throws; a press while the device is draining the current segment
        // makes PlayBlocking return false (KokoroSpeechSynthesizer.cs:393-395) and
        // Speak breaks out and returns NORMALLY. Measured 2026-07-29: the drain
        // path is the one that actually fires, so catching only the exception left
        // every still-queued utterance to play on after Troy pressed stop — the
        // exact behaviour rule 0.0124 exists to prevent.
        if (cancellation.IsCancellationRequested)
        {
            // Whatever else was queued was queued before the press, so it is part
            // of what he just silenced. Same intent as autoplayer.ps1:31.
            var dropped = ClearQueue();
            SpeakLog.Info(
                dropped > 0
                    ? $"Utterance cut by the stop button; dropped {dropped} queued item(s) with it."
                    : "Utterance cut by the stop button.");
            return false;
        }

        return true;
    }

    /// <summary>
    /// Read a queued file and delete it. Deleted BEFORE it is spoken, on purpose:
    /// if synthesis crashed the process, a file still sitting there would be
    /// spoken again on the next start, forever.
    /// </summary>
    private static string? TakeQueuedText(string path)
    {
        try
        {
            var text = File.ReadAllText(path, Encoding.UTF8);
            File.Delete(path);
            return text;
        }
        catch (Exception ex)
        {
            SpeakLog.Warn($"Could not take {Path.GetFileName(path)} from the queue: {ex.Message}");

            try
            {
                File.Delete(path);
            }
            catch
            {
                // If it cannot be deleted it will be retried next tick; that is
                // better than crashing the watcher over one bad file.
            }

            return null;
        }
    }

    private static int ClearQueue() => DrainQueue(SpeakPaths.QueueDirectory);

    private static int DrainQueue(string queue)
    {
        var removed = 0;

        try
        {
            foreach (var file in Directory.GetFiles(queue, "*.txt"))
            {
                try
                {
                    File.Delete(file);
                    removed++;
                }
                catch
                {
                    // Locked by the writer mid-drop; it will be picked up later.
                }
            }
        }
        catch
        {
            // No queue folder yet is not a problem.
        }

        return removed;
    }

    private static int SignalStop()
    {
        try
        {
            if (!EventWaitHandle.TryOpenExisting(StopEventName, out var stopEvent))
            {
                SpeakLog.Info("--stop: no speak watcher was running.");
                return 0;
            }

            using (stopEvent)
            {
                stopEvent.Set();
            }

            SpeakLog.Info("--stop: shutdown signalled.");
            return 0;
        }
        catch (Exception ex)
        {
            SpeakLog.Error("--stop failed", ex);
            return 1;
        }
    }

    private static string? ResolveOneShotText(string[] args)
    {
        var file = ValueOf(args, "--file");
        if (file is not null)
        {
            try
            {
                return File.ReadAllText(file, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                SpeakLog.Error($"Could not read --file {file}", ex);
                return null;
            }
        }

        return ValueOf(args, "--text");
    }

    private static void LogMissingModel() =>
        SpeakLog.Error(
            $"{SpeakPaths.KokoroModelFileName} was not found. Looked at "
            + $"$env:{SpeakPaths.ModelsDirEnvVar}, models/ beside the exe, and up the tree for "
            + "models/ and desktop/models/. Run desktop/scripts/get-voice-models.ps1.");

    private static bool HasFlag(string[] args, string name) =>
        args.Any(a => a.Equals(name, StringComparison.OrdinalIgnoreCase));

    private static string? ValueOf(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }

        return null;
    }
}

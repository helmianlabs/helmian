namespace Helmion.VoiceDictation;

/// <summary>
/// Entry point. Loads config, resolves the model, registers the hotkey and hands
/// control to the message pump. Nothing here writes to a console, because in a
/// WinExe there is no console to write to.
/// </summary>
internal static class Program
{
    private const string InstanceMutexName = @"Local\Helmion.VoiceDictation.instance";
    private const string StopEventName = @"Local\Helmion.VoiceDictation.stop";

    [STAThread]
    private static int Main(string[] args)
    {
        // --stop signals a running instance to shut down cleanly, so the tray
        // icon is removed and the microphone released rather than the process
        // being killed out from under them.
        if (args.Any(a => a.Equals("--stop", StringComparison.OrdinalIgnoreCase)))
        {
            return SignalStop();
        }

        using var instanceMutex = new Mutex(initiallyOwned: true, InstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // A second copy would fight the first for the same hotkey and lose,
            // then sit there doing nothing. Exit quietly instead.
            DictationLog.Initialize(null);
            DictationLog.Warn("Another dictation instance is already running; this one is exiting.");
            return 2;
        }

        var config = DictationConfig.Load(DictationConfig.DefaultPath, out var configProblem);
        DictationLog.Initialize(config.LogPath);

        DictationLog.Info(new string('-', 60));
        DictationLog.Info($"Helmion Voice Dictation starting (pid {Environment.ProcessId}).");

        if (configProblem is not null)
        {
            DictationLog.Warn(configProblem);
        }

        if (!HotkeySpec.TryParse(config.Hotkey, out var dictateHotkey, out var hotkeyProblem))
        {
            DictationLog.Error(
                $"Hotkey \"{config.Hotkey}\" is unusable ({hotkeyProblem}). Falling back to ctrl+alt+space.");

            if (!HotkeySpec.TryParse("ctrl+alt+space", out dictateHotkey, out _))
            {
                DictationLog.Error("The fallback hotkey failed to parse. Exiting.");
                return 3;
            }
        }

        HotkeySpec? cancelHotkey = null;
        if (!string.IsNullOrWhiteSpace(config.CancelHotkey))
        {
            if (HotkeySpec.TryParse(config.CancelHotkey, out var parsedCancel, out var cancelProblem))
            {
                cancelHotkey = parsedCancel;
            }
            else
            {
                DictationLog.Warn($"Cancel hotkey \"{config.CancelHotkey}\" ignored ({cancelProblem}).");
            }
        }

        var modelPath = VocabularyTranscriber.ResolveModelPath(config.ModelPath);
        if (modelPath is null)
        {
            // Still start: the tray icon reports the fault and the log says how to
            // fix it. Exiting silently would leave Troy pressing a dead hotkey.
            DictationLog.Error(
                "ggml-base.en.bin was not found. Looked at the modelPath in the config, "
                + "$env:HELMION_VOICE_MODELS, models/ beside the exe, and desktop/models up the tree. "
                + "Run desktop/scripts/get-voice-models.ps1.");
            modelPath = string.Empty;
        }

        var prompt = config.BuildVocabularyPrompt();
        DictationLog.Info(
            prompt.Length == 0
                ? "No custom vocabulary configured — transcription runs unbiased."
                : $"Vocabulary prompt ({prompt.Length} chars): {prompt}");

        using var transcriber = new VocabularyTranscriber(modelPath, prompt);

        ApplicationConfiguration.Initialize();

        using var host = new DictationHost(config, dictateHotkey, cancelHotkey, transcriber);
        using var stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, StopEventName);

        var registration = ThreadPool.RegisterWaitForSingleObject(
            stopEvent,
            (_, _) =>
            {
                try
                {
                    if (host.IsHandleCreated)
                    {
                        host.BeginInvoke(host.Close);
                    }
                }
                catch (Exception ex)
                {
                    DictationLog.Error("Stop signal could not be delivered", ex);
                }
            },
            state: null,
            millisecondsTimeOutInterval: Timeout.Infinite,
            executeOnlyOnce: true);

        try
        {
            Application.Run(host);
        }
        catch (Exception ex)
        {
            DictationLog.Error("Message loop terminated unexpectedly", ex);
            return 1;
        }
        finally
        {
            registration.Unregister(null);
            instanceMutex.ReleaseMutex();
        }

        return 0;
    }

    private static int SignalStop()
    {
        DictationLog.Initialize(null);

        try
        {
            if (!EventWaitHandle.TryOpenExisting(StopEventName, out var stopEvent))
            {
                DictationLog.Info("--stop: no dictation instance was running.");
                return 0;
            }

            using (stopEvent)
            {
                stopEvent.Set();
            }

            DictationLog.Info("--stop: shutdown signalled.");
            return 0;
        }
        catch (Exception ex)
        {
            DictationLog.Error("--stop failed", ex);
            return 1;
        }
    }
}

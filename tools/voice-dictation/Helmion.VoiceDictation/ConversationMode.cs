using System.Diagnostics;

namespace Helmion.VoiceDictation;

/// <summary>
/// The on/off switch for hands-free conversation: when it is on, every finished
/// Claude Code reply is spoken by the local Kokoro voice.
/// </summary>
/// <remarks>
/// <para><b>Why a file and not a socket, a pipe or an env var.</b> The thing that
/// has to read this switch is a Claude Code Stop hook — a short-lived Python
/// process spawned per reply by Claude Code itself. It has no handle on this
/// application, cannot be handed an env var after the fact, and dies before the
/// next reply. A file on disk is the only channel two processes with no
/// relationship can share, and the gate already existed:
/// <c>stop_hook_speak.py:139-144</c> has been reading
/// <c>~/.claude/voice_enabled.txt</c> and exiting when it does not say "on" since
/// before this tool was written. This class writes the file that hook already
/// reads.</para>
///
/// <para><b>Why "local" and not "on".</b> That same hook speaks through Edge TTS —
/// a network call, and the voice map CLAUDE.md rule 0.26 pins by name and marks
/// DO NOT FLIP. Writing "on" would turn that path on, which is the thing Troy
/// asked NOT to happen. "local" is a third value: the hook routes to the Kokoro
/// queue instead, and any Claude session running an older copy of the hook sees a
/// value that is not "on" and stays silent — the safe failure, not a surprise
/// cloud voice.</para>
///
/// <para><b>Why the constants are duplicated rather than shared.</b> This project
/// deliberately references neither Helmion.Desktop.Core nor Helmion.VoiceSpeak
/// (see README.md "Why a standalone project"), so there is no assembly to import
/// <c>SpeakPaths.QueueDirectory</c> or <c>StopSentinel.DefaultPath</c> from. They
/// are three short strings, and pulling in a 310 MB Kokoro dependency chain to
/// avoid repeating them would cost far more than it saves. If the queue folder
/// ever moves, it moves in SpeakPaths.cs and here.</para>
/// </remarks>
public static class ConversationMode
{
    /// <summary>The value that means "speak replies through local Kokoro".</summary>
    public const string OnValue = "local";

    /// <summary>Any value that is not <see cref="OnValue"/> means silence; this is the one we write.</summary>
    public const string OffValue = "off";

    /// <summary>The gate <c>stop_hook_speak.py:139-144</c> reads before it speaks anything.</summary>
    public const string DefaultStateFile = @"C:\Users\troyh\.claude\voice_enabled.txt";

    /// <summary>
    /// The sentinel <c>~/.claude/scripts/stop_voice.ps1</c> stamps and
    /// <c>StopSentinel.cs</c> watches. Touching it cuts audio mid-word.
    /// </summary>
    public const string StopSentinelFile = @"C:\Users\troyh\.claude\_voice\STOP";

    /// <summary>
    /// The ONLY thing this application ever speaks on its own: Troy's name, alone.
    /// </summary>
    /// <remarks>
    /// <para>Troy's rule, 2026-07-29: to get his attention, say his NAME — never a
    /// status update. This replaced "Voice conversation on.", which was exactly the
    /// unrequested spoken status the rule forbids.</para>
    ///
    /// <para>It still works as confirmation, and arguably better: one syllable tells
    /// him the switch took, the speaker is alive and the audio device is working,
    /// and the green tray dot carries the rest without making a sound. Duplicated
    /// from <c>ReplyTextCleaner.AttentionUtterance</c> for the same reason the
    /// paths below are duplicated — this project references neither assembly.</para>
    /// </remarks>
    public const string AttentionUtterance = "Troy.";

    private const string SpeakProcessName = "Helmion Voice Speak";
    private const string SpeakExeName = "Helmion Voice Speak.exe";

    public static string ResolveStateFile(string? configured) =>
        string.IsNullOrWhiteSpace(configured) ? DefaultStateFile : configured;

    public static string QueueDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "speak-queue");

    /// <summary>True when replies are currently being spoken. Never throws.</summary>
    public static bool IsOn(string stateFile)
    {
        try
        {
            return File.Exists(stateFile)
                && File.ReadAllText(stateFile).Trim()
                    .Equals(OnValue, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not read {stateFile}: {ex.Message}. Treating conversation mode as off.");
            return false;
        }
    }

    /// <summary>
    /// Flip the switch. Returns the state it is now in; <paramref name="problem"/>
    /// is non-null only when the write failed, in which case nothing changed.
    /// </summary>
    public static bool Toggle(string stateFile, out string? problem)
    {
        problem = null;
        var turningOn = !IsOn(stateFile);

        try
        {
            var directory = Path.GetDirectoryName(stateFile);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // No BOM and no trailing newline: the hook compares the trimmed text
            // to a literal, and speak.ps1's sibling scripts read the same file.
            File.WriteAllText(stateFile, turningOn ? OnValue : OffValue, new System.Text.UTF8Encoding(false));
        }
        catch (Exception ex)
        {
            problem = $"Could not write {stateFile}: {ex.Message}";
            return !turningOn;
        }

        return turningOn;
    }

    /// <summary>
    /// Silence anything speaking right now and drop everything still queued.
    /// </summary>
    /// <remarks>
    /// This reuses Troy's existing stop path rather than inventing a second one.
    /// Stamping the sentinel is exactly what <c>stop_voice.ps1</c> does on every
    /// prompt submit, and <c>StopSentinel.CancelOnPress</c> polls it at 50 ms while
    /// <c>KokoroSpeechSynthesizer</c> checks its token every 20 ms while draining —
    /// the path measured at 16 ms to silence on 2026-07-29. Turning conversation
    /// mode OFF therefore doubles as an instant "stop talking", which matters
    /// because a hotkey is reachable when a mouse is not.
    /// </remarks>
    public static void SilenceNow()
    {
        try
        {
            var directory = Path.GetDirectoryName(StopSentinelFile);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // The WATCHER compares this file's last-write time against the moment
            // its current utterance began, so the content is irrelevant and only
            // the timestamp matters. Writing rather than File.SetLastWriteTime
            // because the file may not exist yet on a fresh machine.
            File.WriteAllText(StopSentinelFile, DateTime.Now.ToString("O"));
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not stamp the stop sentinel: {ex.Message}");
        }

        DrainQueue();
    }

    /// <summary>Delete every pending utterance so nothing speaks after the switch is off.</summary>
    private static void DrainQueue()
    {
        try
        {
            foreach (var file in Directory.GetFiles(QueueDirectory, "*.txt"))
            {
                try { File.Delete(file); } catch { /* being written right now; the watcher drops it */ }
            }
        }
        catch
        {
            // No queue folder yet is not a problem.
        }
    }

    /// <summary>
    /// Speak one exact short line through the local voice. In practice the only
    /// caller passes <see cref="AttentionUtterance"/> — see that constant for why
    /// nothing longer is allowed to come out of here unrequested.
    /// </summary>
    public static void Announce(string text)
    {
        try
        {
            Directory.CreateDirectory(QueueDirectory);

            // NOT a .reply.txt — this is an exact sentence, not a model reply, so
            // it must not go through the lossy cleaner (ReplyTextCleaner.cs).
            var name = $"{DateTime.Now:yyyyMMdd-HHmmss-fff}-mode.txt";
            File.WriteAllText(
                Path.Combine(QueueDirectory, name),
                text,
                new System.Text.UTF8Encoding(false));
        }
        catch (Exception ex)
        {
            DictationLog.Warn($"Could not queue the confirmation: {ex.Message}");
        }
    }

    /// <summary>
    /// Make sure the Kokoro watcher is up, so the first spoken reply is not lost
    /// into a folder nobody is reading.
    /// </summary>
    /// <remarks>
    /// Safe to call when it is already running: the watcher takes a named mutex
    /// and a second copy exits quietly (Helmion.VoiceSpeak/Program.cs:150-157).
    /// The process-name check is only to avoid the pointless spawn.
    /// </remarks>
    public static void EnsureSpeakerRunning(string? configuredExePath)
    {
        try
        {
            if (Process.GetProcessesByName(SpeakProcessName).Length > 0)
            {
                return;
            }

            var exe = ResolveSpeakExe(configuredExePath);
            if (exe is null)
            {
                DictationLog.Error(
                    $"Conversation mode is on but {SpeakExeName} was not found, so replies will queue "
                    + "and never be spoken. Build it with: dotnet build "
                    + "tools\\voice-dictation\\Helmion.VoiceSpeak\\Helmion.VoiceSpeak.csproj -c Release");
                return;
            }

            // CreateNoWindow with UseShellExecute false: the target is already a
            // WinExe with no console, and this guarantees no window even if that
            // ever changes.
            Process.Start(new ProcessStartInfo(exe)
            {
                Arguments = "--watch",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });

            DictationLog.Info($"Started the Kokoro speak watcher: {exe}");
        }
        catch (Exception ex)
        {
            DictationLog.Error("Could not start the speak watcher", ex);
        }
    }

    /// <summary>
    /// Find "Helmion Voice Speak.exe". Same shape as
    /// <c>VocabularyTranscriber.ResolveModelPath</c> and <c>SpeakPaths</c>: an
    /// explicit override, then a walk up the tree, because the two projects build
    /// into sibling bin folders whose relative depth is an implementation detail
    /// of the SDK.
    /// </summary>
    private static string? ResolveSpeakExe(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var beside = Path.Combine(AppContext.BaseDirectory, SpeakExeName);
        if (File.Exists(beside))
        {
            return beside;
        }

        var configuration = AppContext.BaseDirectory.Contains(
            $"{Path.DirectorySeparatorChar}Debug{Path.DirectorySeparatorChar}",
            StringComparison.OrdinalIgnoreCase)
            ? "Debug"
            : "Release";

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; dir is not null && depth < 8; depth++, dir = dir.Parent)
        {
            // Prefer the configuration this build is running as, then the other,
            // so a Debug dictation build does not silently drive a stale Release
            // speaker.
            foreach (var config in new[] { configuration, configuration == "Release" ? "Debug" : "Release" })
            {
                var candidate = Path.Combine(
                    dir.FullName, "Helmion.VoiceSpeak", "bin", config, "net10.0-windows", SpeakExeName);

                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}

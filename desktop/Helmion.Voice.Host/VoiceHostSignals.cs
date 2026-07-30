using System.Diagnostics;

namespace Helmion.Voice.Host;

/// <summary>
/// The machine-wide names that let a second process stop a running dictation
/// host, and the single-instance guard that stops two hosts fighting over one
/// microphone.
/// </summary>
/// <remarks>
/// Two hosts capturing at once is not a theoretical concern: both would open the
/// capture device, both would transcribe, and both would inject keystrokes into
/// the same focused window — the user would see every word twice. The mutex
/// makes the second one refuse to start and say why.
///
/// Names are Local\ rather than Global\ so this needs no elevation and cannot
/// collide with another user's session on the same machine.
/// </remarks>
internal static class VoiceHostSignals
{
    /// <summary>Held for the lifetime of any capture-owning host mode.</summary>
    public const string SingleInstanceMutexName = @"Local\Helmion.Voice.Host.SingleInstance";

    /// <summary>Set by Stop-HelmionDictation; a listening host shuts down cleanly.</summary>
    public const string StopEventName = @"Local\Helmion.Voice.Host.Stop";

    /// <summary>
    /// File a listening host writes its pid into, so the PowerShell module can
    /// fall back to a kill if the event handshake ever fails.
    /// </summary>
    public static string PidFilePath => Path.Combine(
        Path.GetTempPath(),
        "helmion-voice-host.pid");

    public static void WritePidFile()
    {
        try
        {
            File.WriteAllText(PidFilePath, Environment.ProcessId.ToString());
        }
        catch (IOException)
        {
            // A missing pid file only costs the module its fallback path.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    public static void DeletePidFile()
    {
        try
        {
            if (File.Exists(PidFilePath))
            {
                File.Delete(PidFilePath);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// Describe the process currently holding the microphone, for the error the
    /// second instance prints. Returns null when it cannot be identified.
    /// </summary>
    public static string? DescribeRunningHost()
    {
        try
        {
            if (!File.Exists(PidFilePath)
                || !int.TryParse(File.ReadAllText(PidFilePath).Trim(), out var pid))
            {
                return null;
            }

            using var process = Process.GetProcessById(pid);
            return $"pid {pid} ({process.ProcessName})";
        }
        catch (ArgumentException)
        {
            return null;   // stale pid file; the process is gone
        }
        catch (IOException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }
}

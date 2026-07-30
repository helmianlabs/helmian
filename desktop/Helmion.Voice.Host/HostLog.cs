namespace Helmion.Voice.Host;

/// <summary>
/// Where the long-running modes report what they are doing.
/// </summary>
/// <remarks>
/// A background dictation host has nowhere good to write. Inheriting the
/// launching PowerShell console means status lines land in the middle of
/// whatever conversation the user is having with an AI; creating a console of
/// its own means a window on screen, which is not allowed. So the module starts
/// the host with CREATE_NO_WINDOW and <c>--quiet --log &lt;path&gt;</c>, and
/// everything goes to that file instead.
///
/// Run in the foreground without those flags and it behaves like any console
/// tool: status on stderr, results on stdout.
/// </remarks>
internal static class HostLog
{
    private static readonly object Gate = new();

    private static bool _quiet;
    private static string? _path;

    /// <summary>Default file the PowerShell module points --log at.</summary>
    public static string DefaultLogPath => Path.Combine(
        Path.GetTempPath(),
        "helmion-voice-host.log");

    public static void Configure(bool quiet, string? path)
    {
        _quiet = quiet;
        _path = path;

        if (path is not null)
        {
            Status($"--- helmion-voice started (pid {Environment.ProcessId}) ---");
        }
    }

    /// <summary>
    /// One status line. Goes to stderr unless --quiet, and to the log file when
    /// one was given. Never throws: a status message must not be able to take
    /// down a running dictation session.
    /// </summary>
    public static void Status(string message)
    {
        if (!_quiet)
        {
            try
            {
                Console.Error.WriteLine(message);
            }
            catch (IOException)
            {
            }
        }

        var path = _path;
        if (path is null)
        {
            return;
        }

        lock (Gate)
        {
            try
            {
                File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss}  {message}{Environment.NewLine}");
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}

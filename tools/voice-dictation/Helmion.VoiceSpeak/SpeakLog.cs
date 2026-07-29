using System.Text;

namespace Helmion.VoiceSpeak;

/// <summary>
/// The only output channel this process has. There is no console in a WinExe and
/// no message box anywhere in this app, so anything worth knowing goes here.
/// </summary>
/// <remarks>
/// Deliberately a separate file from voice-dictation.log. Input and output are
/// two processes with two lifetimes, and interleaving them makes "why did it not
/// speak" harder to answer, not easier.
///
/// Every method swallows its own exceptions, for the same reason the dictation
/// logger does: a logger that throws would take down the utterance it was called
/// to describe.
/// </remarks>
public static class SpeakLog
{
    private const long MaxBytes = 1_000_000;

    private static readonly object Gate = new();
    private static string _path = DefaultPath;

    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "voice-speak.log");

    public static string Path_ => _path;

    public static void Initialize(string? path)
    {
        lock (Gate)
        {
            _path = string.IsNullOrWhiteSpace(path) ? DefaultPath : path;

            try
            {
                var directory = System.IO.Path.GetDirectoryName(_path);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                RollIfLargeLocked();
            }
            catch
            {
                // A log that cannot be created must not stop speech.
            }
        }
    }

    public static void Info(string message) => Write("INFO ", message);

    public static void Warn(string message) => Write("WARN ", message);

    public static void Error(string message, Exception? ex = null) =>
        Write("ERROR", ex is null ? message : $"{message} — {ex.GetType().Name}: {ex.Message}");

    private static void Write(string level, string message)
    {
        var line = new StringBuilder()
            .Append(DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz"))
            .Append(" [").Append(level).Append("] ")
            .Append(message)
            .Append(Environment.NewLine)
            .ToString();

        lock (Gate)
        {
            try
            {
                RollIfLargeLocked();
                File.AppendAllText(_path, line);
            }
            catch
            {
                // Disk full, file locked, path revoked — none of that is worth
                // interrupting the user over.
            }
        }
    }

    private static void RollIfLargeLocked()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Length < MaxBytes)
            {
                return;
            }

            var previous = _path + ".1";
            if (File.Exists(previous))
            {
                File.Delete(previous);
            }

            File.Move(_path, previous);
        }
        catch
        {
            // ignore
        }
    }
}

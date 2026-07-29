using System.Text;

namespace Helmion.VoiceDictation;

/// <summary>
/// The only output channel this process has. There is no console and no message
/// box anywhere in the app, so if something goes wrong the log file is where it
/// is written and nowhere else.
/// </summary>
/// <remarks>
/// Every method swallows its own exceptions. A logger that throws would take
/// down a dictation the user was in the middle of, which is exactly backwards.
/// </remarks>
public static class DictationLog
{
    private const long MaxBytes = 1_000_000;

    private static readonly object Gate = new();
    private static string _path = DefaultPath;

    public static string DefaultPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "voice-dictation.log");

    public static string Path_ => _path;

    /// <summary>Point the log at <paramref name="path"/>, or the default when blank.</summary>
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
                // A log that cannot be created must not stop dictation.
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

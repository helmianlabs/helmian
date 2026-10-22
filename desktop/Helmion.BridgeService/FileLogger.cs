namespace Helmion.BridgeService;

/// <summary>
/// Small append-only log for the plain-process (sign-in task) mode, where there is no console.
/// %LOCALAPPDATA%\Helmian\logs\bridge-service.log, rotated to .1 at 5 MB. Never throws into the host.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _path;
    private readonly object _gate = new();
    public FileLoggerProvider(string path) => _path = path;
    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);
    public void Dispose() { }

    internal void Write(string line)
    {
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var info = new FileInfo(_path);
                if (info.Exists && RunModeInfo.ShouldRotate(info.Length)) File.Move(_path, _path + ".1", overwrite: true);
                File.AppendAllText(_path, line + Environment.NewLine);
            }
            catch { /* logging must never stop the bridge */ }
        }
    }

    private sealed class FileLogger(FileLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information && !category.StartsWith("Microsoft.", StringComparison.Ordinal) || logLevel >= LogLevel.Warning;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            var text = formatter(state, exception);
            if (exception is not null) text += " | " + exception.GetType().Name + ": " + exception.Message;
            owner.Write($"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {logLevel,-11} {text}");
        }
    }
}

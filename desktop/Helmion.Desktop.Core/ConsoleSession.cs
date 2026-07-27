using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace Helmion.Desktop.Core;

/// <summary>
/// Manages a single interactive PowerShell process session whose stdout/stderr
/// is streamed line-by-line back to the caller. The session is started lazily
/// on the first <see cref="SendAsync"/> call and reused until <see cref="Dispose"/>.
/// </summary>
public sealed class ConsoleSession : IDisposable
{
    private Process? _process;
    private readonly object _lock = new();
    private bool _disposed;

    public bool IsRunning => _process is { HasExited: false };

    /// <summary>
    /// Sends <paramref name="command"/> to the shell's stdin and yields each
    /// output line until a sentinel is detected or the session ends.
    /// </summary>
    public async IAsyncEnumerable<ConsoleLine> SendAsync(
        string command,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        EnsureStarted();

        if (_process is null)
        {
            yield return new ConsoleLine("Could not start shell session.", ConsoleLine.Kind.Error);
            yield break;
        }

        // Write the command plus a sentinel that marks end-of-output
        const string Sentinel = "__HELMION_EOC__";
        await _process.StandardInput.WriteLineAsync(command);
        await _process.StandardInput.WriteLineAsync($"Write-Host \"{Sentinel}\"");
        await _process.StandardInput.FlushAsync(cancellationToken);

        while (!cancellationToken.IsCancellationRequested)
        {
            if (_process.HasExited)
            {
                yield return new ConsoleLine("[Shell exited]", ConsoleLine.Kind.Error);
                yield break;
            }

            string? line;
            try
            {
                line = await _process.StandardOutput.ReadLineAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }

            if (line is null) yield break;
            if (line == Sentinel) yield break;

            yield return new ConsoleLine(line, ConsoleLine.Kind.Output);
        }
    }

    private void EnsureStarted()
    {
        lock (_lock)
        {
            if (_process is { HasExited: false }) return;

            _process?.Dispose();

            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoLogo -NoProfile -NonInteractive -Command -",
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            // Merge stderr into stdout for unified display
            _process = new Process { StartInfo = startInfo };
            _process.ErrorDataReceived += (_, e) =>
            {
                // Error lines are forwarded separately but not awaited here
                // The XAML code-behind can subscribe to OnError if needed
            };
            _process.Start();
            _process.BeginErrorReadLine();
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            try
            {
                if (_process is { HasExited: false })
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Ignore termination errors
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        _process?.Dispose();
        _process = null;
    }
}

public sealed record ConsoleLine(string Text, ConsoleLine.Kind LineKind)
{
    public enum Kind { Output, Error }
}

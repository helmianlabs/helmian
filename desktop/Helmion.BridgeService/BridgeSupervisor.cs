using System.Diagnostics;

namespace Helmion.BridgeService;

/// <summary>Where the bridge lives and how to launch it. Pure: no I/O beyond file probes.</summary>
public sealed record BridgeLaunch(string FileName, IReadOnlyList<string> Arguments, string WorkingDirectory);

public static class BridgeLocator
{
    /// <summary>
    /// Prefer a compiled pc-bridge.exe next to the service (pkg build, no Node needed);
    /// else node + bin\pc-bridge.mjs from HELMIAN_ROOT or the install folder.
    /// Returns null with a reason when nothing runnable is found (never guesses).
    /// </summary>
    public static (BridgeLaunch? Launch, string? Reason) Resolve(
        string serviceDirectory, string? helmianRoot, string? nodeExecutable, Func<string, bool> exists)
    {
        var exe = Path.Combine(serviceDirectory, "pc-bridge.exe");
        if (exists(exe)) return (new BridgeLaunch(exe, Array.Empty<string>(), serviceDirectory), null);
        foreach (var root in new[] { helmianRoot, serviceDirectory })
        {
            if (string.IsNullOrWhiteSpace(root)) continue;
            var script = Path.Combine(root, "bin", "pc-bridge.mjs");
            if (!exists(script)) continue;
            if (string.IsNullOrWhiteSpace(nodeExecutable) || !exists(nodeExecutable))
                return (null, "Node.js 20+ was not found and no pc-bridge.exe is installed.");
            return (new BridgeLaunch(nodeExecutable, new[] { script }, root), null);
        }
        return (null, "Neither pc-bridge.exe nor bin\\pc-bridge.mjs was found. Set HELMIAN_ROOT or reinstall.");
    }
}

/// <summary>Restart backoff: 2s, 4s, 8s ... capped at 5 minutes; resets after 10 healthy minutes.</summary>
public static class RestartBackoff
{
    public static TimeSpan Next(int consecutiveFailures)
    {
        var seconds = Math.Min(300, 2 * Math.Pow(2, Math.Max(0, consecutiveFailures)));
        return TimeSpan.FromSeconds(seconds);
    }
    public static bool CountsAsHealthy(TimeSpan uptime) => uptime >= TimeSpan.FromMinutes(10);
}

public sealed class BridgeWorker : BackgroundService
{
    private readonly ILogger<BridgeWorker> _log;
    public BridgeWorker(ILogger<BridgeWorker> log) => _log = log;

    private static readonly string[] StrippedSecrets =
    {
        // The bridge reads provider keys from its own vault on this PC; never inherit stray ones.
        "HELMION_DATABASE_URL", "DATABASE_URL", "GITHUB_TOKEN",
    };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!ConsentRecord.Exists())
        {
            _log.LogError("Helmian Bridge has no recorded opt-in consent ({Path}). Run the installer; the service will not start the bridge without it.", ConsentRecord.Path);
            return;
        }
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var (launch, reason) = BridgeLocator.Resolve(
                AppContext.BaseDirectory,
                Environment.GetEnvironmentVariable("HELMIAN_ROOT"),
                FindNode(),
                File.Exists);
            if (launch is null)
            {
                _log.LogError("Bridge not started: {Reason}", reason);
                await Task.Delay(RestartBackoff.Next(failures++), stoppingToken).ConfigureAwait(false);
                continue;
            }
            var started = DateTimeOffset.UtcNow;
            try
            {
                var info = new ProcessStartInfo(launch.FileName)
                {
                    WorkingDirectory = launch.WorkingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                foreach (var a in launch.Arguments) info.ArgumentList.Add(a);
                foreach (var name in StrippedSecrets) info.Environment.Remove(name);
                using var process = Process.Start(info) ?? throw new InvalidOperationException("Process.Start returned null.");
                process.OutputDataReceived += (_, e) => { if (e.Data is { Length: > 0 }) _log.LogInformation("{Line}", e.Data); };
                process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 }) _log.LogWarning("{Line}", e.Data); };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                using (stoppingToken.Register(() => { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { } }))
                {
                    await process.WaitForExitAsync(stoppingToken).ConfigureAwait(false);
                }
                _log.LogWarning("Bridge exited with code {Code}.", process.ExitCode);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { _log.LogError(error, "Bridge failed to start."); }
            failures = RestartBackoff.CountsAsHealthy(DateTimeOffset.UtcNow - started) ? 0 : failures + 1;
            await Task.Delay(RestartBackoff.Next(failures), stoppingToken).ConfigureAwait(false);
        }
    }

    private static string? FindNode()
    {
        var explicitPath = Environment.GetEnvironmentVariable("HELMIAN_NODE");
        if (!string.IsNullOrWhiteSpace(explicitPath)) return explicitPath;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var candidate = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        var programFiles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(programFiles) ? programFiles : null;
    }
}

/// <summary>The installer writes this only after the user types I AGREE to the disclosure.</summary>
public static class ConsentRecord
{
    public static string Path => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Helmian", "bridge-consent.json");
    public static bool Exists() => File.Exists(Path);
}

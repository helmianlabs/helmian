using System.Diagnostics;

namespace Helmion.BridgeService;

public sealed class BridgeWorker : BackgroundService
{
    private readonly ILogger<BridgeWorker> _log;
    public BridgeWorker(ILogger<BridgeWorker> log) => _log = log;

    private static readonly string[] StrippedSecrets =
    {
        // The bridge reads provider keys from its own vault on this PC; never inherit stray ones.
        "HELMION_DATABASE_URL", "DATABASE_URL", "GITHUB_TOKEN",
    };

    // Names that must never reach a child process: provider keys live in the PC vault,
    // and the hands spoke runs from its saved pairing, never from a passphrase.
    private static readonly string[] StrippedForSpoke = { "HELMIAN_HANDS_PASSPHRASE" };

    /// <summary>How long to wait before looking for a hands pairing again.</summary>
    public static readonly TimeSpan NotPairedRecheck = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!ConsentRecord.Exists())
        {
            _log.LogError("Helmian Bridge has no recorded opt-in consent ({Path}). Run the installer; the service will not start the bridge without it.", ConsentRecord.Path);
            return;
        }
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        await Task.WhenAll(
            SuperviseAsync("Bridge", () =>
            {
                var (launch, reason) = BridgeLocator.Resolve(AppContext.BaseDirectory, Environment.GetEnvironmentVariable("HELMIAN_ROOT"), FindNode(), File.Exists);
                return (launch, reason, false);
            }, Array.Empty<string>(), appData, stoppingToken),
            SuperviseAsync("Hands spoke", () => SpokeLocator.Resolve(AppContext.BaseDirectory, Environment.GetEnvironmentVariable("HELMIAN_ROOT"), FindNode(), appData, File.Exists),
                StrippedForSpoke, appData, stoppingToken)).ConfigureAwait(false);
    }

    private async Task SuperviseAsync(string name, Func<(BridgeLaunch? Launch, string? Reason, bool NotPaired)> resolve,
        IReadOnlyList<string> extraStripped, string appData, CancellationToken stoppingToken)
    {
        var failures = 0;
        var notPairedLogged = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            var (launch, reason, notPaired) = resolve();
            if (launch is null)
            {
                if (notPaired)
                {
                    if (!notPairedLogged) { _log.LogInformation("{Reason}", reason); notPairedLogged = true; }
                    try { await Task.Delay(NotPairedRecheck, stoppingToken).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                    continue;
                }
                _log.LogError("{Name} not started: {Reason}", name, reason);
                try { await Task.Delay(RestartBackoff.Next(failures++), stoppingToken).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
                continue;
            }
            notPairedLogged = false;
            var started = DateTimeOffset.UtcNow;
            try
            {
                var info = new ProcessStartInfo(launch.FileName)
                {
                    WorkingDirectory = launch.WorkingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                foreach (var a in launch.Arguments) info.ArgumentList.Add(a);
                foreach (var secret in StrippedSecrets) info.Environment.Remove(secret);
                foreach (var secret in extraStripped) info.Environment.Remove(secret);
                // Services run as the user still need APPDATA for the saved pairing and vault.
                if (!string.IsNullOrWhiteSpace(appData) && string.IsNullOrWhiteSpace(info.Environment.TryGetValue("APPDATA", out var cur) ? cur : null))
                    info.Environment["APPDATA"] = appData;
                using var process = Process.Start(info) ?? throw new InvalidOperationException("Process.Start returned null.");
                process.StandardInput.Close(); // never wait on a prompt: no console, no passphrase
                process.OutputDataReceived += (_, e) => { if (e.Data is { Length: > 0 }) _log.LogInformation("[{Name}] {Line}", name, e.Data); };
                process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 }) _log.LogWarning("[{Name}] {Line}", name, e.Data); };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                using (stoppingToken.Register(() => { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { } }))
                {
                    await process.WaitForExitAsync(stoppingToken).ConfigureAwait(false);
                }
                _log.LogWarning("{Name} exited with code {Code}.", name, process.ExitCode);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { _log.LogError(error, "{Name} failed to start.", name); }
            failures = RestartBackoff.CountsAsHealthy(DateTimeOffset.UtcNow - started) ? 0 : failures + 1;
            try { await Task.Delay(RestartBackoff.Next(failures), stoppingToken).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
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

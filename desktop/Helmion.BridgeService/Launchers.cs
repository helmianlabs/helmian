namespace Helmion.BridgeService;

// Pure launch planning for the service's child processes. No I/O beyond the injected file probe,
// so it is tested on any OS (desktop/Helmion.BridgeService.Tests).
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

/// <summary>
/// The hands spoke (bin\hands-spoke.mjs, no args) runs from the saved pairing in
/// %APPDATA%\Helmian\hands-spoke.json. Not paired yet is not an error: the service
/// skips it and looks again later. Pure: no I/O beyond file probes.
/// </summary>
public static class SpokeLocator
{
    public const string NotPairedReason = "Hands spoke is not paired on this PC yet (no hands-spoke.json); skipping it.";

    public static string ConfigPath(string appData) => Path.Combine(appData, "Helmian", "hands-spoke.json");

    public static (BridgeLaunch? Launch, string? Reason, bool NotPaired) Resolve(
        string serviceDirectory, string? helmianRoot, string? nodeExecutable, string appData, Func<string, bool> exists)
    {
        if (string.IsNullOrWhiteSpace(appData) || !exists(ConfigPath(appData))) return (null, NotPairedReason, true);
        foreach (var root in new[] { helmianRoot, serviceDirectory })
        {
            if (string.IsNullOrWhiteSpace(root)) continue;
            var script = Path.Combine(root, "bin", "hands-spoke.mjs");
            if (!exists(script)) continue;
            if (string.IsNullOrWhiteSpace(nodeExecutable) || !exists(nodeExecutable))
                return (null, "Node.js 20+ was not found, so the hands spoke cannot run.", false);
            return (new BridgeLaunch(nodeExecutable, new[] { script }, root), null, false);
        }
        return (null, "bin\\hands-spoke.mjs was not found. Set HELMIAN_ROOT to your Helmian folder.", false);
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


/// <summary>
/// The installer writes helmian-bridge.json next to the exe with the Helmian folder, so the bridge finds it
/// in both run modes (sign-in task or service) without a reboot or a machine-wide variable.
/// HELMIAN_ROOT, when set, still wins. Pure: the file read is injected.
/// </summary>
public static class InstallConfig
{
    public const string FileName = "helmian-bridge.json";

    public static string? HelmianRoot(string serviceDirectory, string? envRoot, Func<string, string?> readText)
    {
        if (!string.IsNullOrWhiteSpace(envRoot)) return envRoot;
        string? json;
        try { json = readText(Path.Combine(serviceDirectory, FileName)); } catch { return null; }
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                && doc.RootElement.TryGetProperty("helmianRoot", out var v)
                && v.ValueKind == System.Text.Json.JsonValueKind.String
                && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString() : null;
        }
        catch (System.Text.Json.JsonException) { return null; }
    }
}

/// <summary>How the exe was started. The default install is a hidden sign-in task (a plain process, no password).</summary>
public enum RunMode { SignInTask, WindowsService }

public static class RunModeInfo
{
    /// <summary>One copy per PC across both modes, so a leftover service and a sign-in task never both run.</summary>
    public const string SingleInstanceName = @"Global\HelmianBridgeService";

    public static RunMode From(bool isWindowsService) => isWindowsService ? RunMode.WindowsService : RunMode.SignInTask;

    /// <summary>Log file for the plain-process mode, where there is no console and maybe no event source.</summary>
    public static string LogPath(string localAppData) => Path.Combine(localAppData, "Helmian", "logs", "bridge-service.log");

    public const long MaxLogBytes = 5 * 1024 * 1024;
    public static bool ShouldRotate(long currentBytes) => currentBytes >= MaxLogBytes;
}

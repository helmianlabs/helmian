using System.Diagnostics;
using System.IO;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// Keeps the PC bridge (bin\pc-bridge.mjs) running while this desktop is
/// linked — the half of the connection the installer never wired. The
/// install stages the bridge beside Helmian.exe (bundled node.exe + bin\,
/// publish.ps1 Stage-BridgeApp), and BridgeLinkFile writes its pairing at
/// link time, so the bridge needs no console, no second install, and no
/// typed consent script: the user's own link in this app is the opt-in,
/// and this host is its keeper while the app runs. (The optional
/// HelmianBridge service covers a PC whose app is closed; the two never
/// fight — both run the same script off the same token file, and log out
/// clears that file and stops this host.)
///
/// The pattern is the Local Service's own (LocalServiceHost /
/// LocalServiceConnector): a hidden child process the app starts, owns,
/// and stops. If the bridge exits while the desktop is still linked it
/// is restarted after a short pause — a dead bridge must not silently
/// become "your PC is offline" again. When the token file goes away
/// (log out) the restarts stop with it, and a bridge that keeps dying
/// within seconds stops being restarted until the next link or launch.
/// </summary>
internal static class BridgeHost
{
    private static readonly object Gate = new();
    private static Process? _process;
    private static bool _stopped = true;
    private static DateTimeOffset _startedAt;
    private static int _fastExits;

    // A bridge that dies within seconds, over and over (a token the cloud
    // refuses, a broken install), must not spin a restart loop for as
    // long as the app is open: after this many fast exits the host waits
    // for the next explicit start — a fresh link, or the next app launch.
    private const int MaxFastExits = 5;

    public static void EnsureStarted()
    {
        lock (Gate)
        {
            _stopped = false;
            _fastExits = 0;
            StartLocked();
        }
    }

    public static void Stop()
    {
        lock (Gate)
        {
            _stopped = true;
            try
            {
                if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Already gone; stopping must never throw into log out or exit.
            }
            _process = null;
        }
    }

    private static void StartLocked()
    {
        if (_stopped) return;
        if (_process is { HasExited: false }) return;
        if (!File.Exists(BridgeLinkFile.DefaultPath())) return;

        var baseDir = AppContext.BaseDirectory;
        var script = Path.Combine(baseDir, "bin", "pc-bridge.mjs");
        var node = Path.Combine(baseDir, "node.exe");
        if (!File.Exists(script) || !File.Exists(node)) return;

        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = baseDir,
        };
        startInfo.ArgumentList.Add(script);
        Process started;
        try
        {
            started = Process.Start(startInfo)
                ?? throw new InvalidOperationException("PC bridge did not start");
        }
        catch
        {
            // A bridge that cannot start leaves the desktop exactly as it
            // was — linked chat, no bridge — never a crashed app.
            _process = null;
            return;
        }
        started.EnableRaisingEvents = true;
        started.Exited += OnBridgeExited;
        _process = started;
        _startedAt = DateTimeOffset.UtcNow;
    }

    private static void OnBridgeExited(object? sender, EventArgs e)
    {
        _ = RestartAsync();
    }

    private static async Task RestartAsync()
    {
        await Task.Delay(TimeSpan.FromSeconds(5));
        lock (Gate)
        {
            if (_process is { HasExited: false }) return;
            _process = null;
            if (DateTimeOffset.UtcNow - _startedAt < TimeSpan.FromSeconds(10))
            {
                _fastExits += 1;
                if (_fastExits >= MaxFastExits) return;
            }
            else
            {
                _fastExits = 0;
            }
            StartLocked();
        }
    }
}

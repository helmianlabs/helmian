using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Contains("--service-smoke-test", StringComparer.Ordinal))
        {
            var succeeded = Task.Run(RunServiceSmokeAsync)
                .GetAwaiter()
                .GetResult();
            ExitWith(succeeded ? 0 : 2);
            return;
        }

        if (e.Args.Contains("--smoke-test", StringComparer.Ordinal))
        {
            var smokeWindow = CreateLaidOutWindow(
                ColorThemeCatalog.DefaultThemeId,
                persistTheme: false);
            foreach (var theme in ColorThemeCatalog.All)
            {
                smokeWindow.ApplyThemeForPreview(theme.Id);
                foreach (var pageName in PilotSnapshot.CreateLive(true, null, "", "", "", "Codex").NavigationItems)
                {
                    smokeWindow.NavigateTo(pageName);
                    smokeWindow.UpdateLayout();
                }
            }
            smokeWindow.Close();
            ExitWith(0);
            return;
        }

        // "A fresh empty workspace must produce zero red banners." — Troy,
        // 2026-07-30. Exit code 3 means at least one first-run state regressed
        // back into being reported as a failure.
        if (e.Args.Contains("--empty-workspace-audit", StringComparer.Ordinal))
        {
            var auditWindow = CreateLaidOutWindow(persistTheme: false);
            var red = auditWindow.CountFreshWorkspaceRedRows();
            Console.WriteLine(red == 0
                ? "Fresh-workspace red audit passed: 0 red rows on an empty workspace."
                : $"Fresh-workspace red audit FAILED: {red} first-run state(s) reported as failures.");
            auditWindow.Close();
            ExitWith(red == 0 ? 0 : 3);
            return;
        }

        var previewIndex = Array.IndexOf(e.Args, "--render-preview");
        if (previewIndex >= 0)
        {
            if (previewIndex + 1 >= e.Args.Length)
            {
                throw new ArgumentException("--render-preview requires an output PNG path");
            }

            var pageIndex = Array.IndexOf(e.Args, "--page");
            var pageName = pageIndex >= 0 && pageIndex + 1 < e.Args.Length
                ? e.Args[pageIndex + 1]
                : "Overview";
            var themeIndex = Array.IndexOf(e.Args, "--theme");
            var themeId = themeIndex >= 0 && themeIndex + 1 < e.Args.Length
                ? e.Args[themeIndex + 1]
                : ColorThemeCatalog.DefaultThemeId;
            // Window size is settable so the layout can be photographed NARROW,
            // not only at the comfortable 1440 default. Clipping hides at width.
            var previewWindow = CreateLaidOutWindow(
                themeId,
                persistTheme: false,
                width: ReadNumericArg(e.Args, "--width") ?? 1440,
                height: ReadNumericArg(e.Args, "--height") ?? 900);
            var previewScale = ReadNumericArg(e.Args, "--text-scale");
            if (previewScale is not null)
            {
                previewWindow.ApplyTextScaleForPreview(previewScale.Value);
            }
            var workspaceIndex = Array.IndexOf(e.Args, "--workspace");
            if (workspaceIndex >= 0)
            {
                if (workspaceIndex + 1 >= e.Args.Length)
                {
                    throw new ArgumentException("--workspace requires an absolute local path");
                }

                previewWindow.ApplyWorkspaceInspectionForPreview(
                    WorkspaceInspector.Inspect(e.Args[workspaceIndex + 1]));
            }
            previewWindow.NavigateTo(pageName);
            if (e.Args.Contains("--reveal-mcp", StringComparer.Ordinal))
            {
                previewWindow.RevealMcpPanelForPreview();
            }
            if (e.Args.Contains("--demo-plugins", StringComparer.Ordinal))
            {
                previewWindow.RunPlusMenuActionForPreview(PlusMenuKind.Plugin);
            }
            if (e.Args.Contains("--demo-empty-states", StringComparer.Ordinal))
            {
                previewWindow.NavigateTo("Console");
                previewWindow.CountFreshWorkspaceRedRows();
            }
            previewWindow.UpdateLayout();
            RenderPreview(previewWindow, e.Args[previewIndex + 1]);
            previewWindow.Close();
            ExitWith(0);
            return;
        }

        // Show the shell first, then auto-start the named-pipe service so the
        // sidebar can flip to ONLINE without a manual "Connect" click.
        MainWindow = new MainWindow();
        MainWindow.Show();
        _ = PrestartLocalServiceAsync();
    }

    private static async Task PrestartLocalServiceAsync()
    {
        try
        {
            // Service cold-start + pipe bind can exceed a few seconds on this machine.
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var hello = await LocalServiceHost.EnsureStartedAsync(timeout.Token);
            if (Current?.MainWindow is MainWindow main)
            {
                await main.Dispatcher.InvokeAsync(() =>
                {
                    main.NotifyLocalServiceOnline(
                        $"Protocol v{hello.ProtocolVersion} · named pipe connected");
                });
            }
        }
        catch
        {
            if (Current?.MainWindow is MainWindow main)
            {
                await main.Dispatcher.InvokeAsync(() =>
                {
                    main.NotifyLocalServiceUnavailable(
                        "Local service did not auto-start — use Retry local service");
                });
            }
        }
    }

    protected override async void OnExit(ExitEventArgs e)
    {
        try
        {
            await LocalServiceHost.StopAsync();
        }
        catch
        {
            // Best-effort shutdown
        }

        base.OnExit(e);
    }

    /// <summary>
    /// Ends a headless run with an exit code the CALLER can actually see.
    ///
    /// <see cref="Application.Shutdown(int)"/> alone is not enough. WPF generates
    /// a <c>void Main()</c>, so nothing ever returns Application.ExitCode to the
    /// OS and the process exits 0 no matter what was passed. Measured 2026-07-30:
    /// a deliberately failing audit printed FAILED and still exited 0, which means
    /// publish.ps1's Invoke-PackagedSmoke — whose only check is
    /// <c>$smokeProcess.ExitCode -ne 0</c> — could never have failed a build.
    /// Setting Environment.ExitCode is what the OS actually reads.
    /// </summary>
    private void ExitWith(int exitCode)
    {
        Environment.ExitCode = exitCode;
        Shutdown(exitCode);
    }

    private static async Task<bool> RunServiceSmokeAsync()
    {
        var connector = new LocalServiceConnector();
        try
        {
            var hello = await connector.EnsureConnectedAsync();
            var capabilities = await connector.DetectCapabilitiesAsync();
            var inspection = await connector.InspectWorkspaceAsync(AppContext.BaseDirectory);
            return hello.ProtocolVersion == 1
                && !hello.WritesEnabled
                && capabilities.Count == 6
                && !inspection.ProjectWasModified;
        }
        finally
        {
            await connector.StopStartedProcessAsync();
        }
    }

    /// <summary>Reads a numeric preview flag, or null when it is absent or unparseable.</summary>
    private static double? ReadNumericArg(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0
            && index + 1 < args.Length
            && double.TryParse(
                args[index + 1],
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out var value)
                ? value
                : null;
    }

    /// <summary>
    /// Where headless layout windows live: far outside any real desktop.
    ///
    /// -32000 is beyond the virtual screen of any monitor arrangement Windows
    /// supports, so the window is off every display rather than merely behind
    /// something.
    /// </summary>
    private const double OffscreenOrigin = -32000;

    /// <summary>
    /// Builds a fully laid-out window for the headless paths WITHOUT PUTTING
    /// ANYTHING ON THE USER'S SCREEN.
    ///
    /// ── THIS IS THE BUG THAT COST TROY AN AFTERNOON. ──
    ///
    /// This method used to call <c>window.Show()</c> on a 1440x900 window with
    /// <c>WindowStyle.None</c> and <c>ShowInTaskbar = false</c>. publish.ps1 runs
    /// the packaged exe twice through paths that reach here — line 98
    /// (--smoke-test) and line 103 (--empty-workspace-audit) — so every publish
    /// presented two real, borderless windows. Borderless meant no close button;
    /// ShowInTaskbar = false meant no taskbar entry to right-click. They were
    /// literally undismissable, and they appeared while Troy was on sales calls.
    ///
    /// WHY IT HID FOR SO LONG: publish.ps1:54 sets
    /// <c>ProcessStartInfo.CreateNoWindow = true</c>, which reads like "no windows
    /// please". It only suppresses a CONSOLE window and has no effect whatsoever on
    /// a WPF window. The script looked like it had already handled this.
    ///
    /// ── WHY THIS STILL CALLS Show(), OFF-SCREEN, RATHER THAN NOT AT ALL ──
    ///
    /// The obvious fix is to drop Show() and call Measure/Arrange directly. That
    /// produces a layout pass, but WPF raises <c>FrameworkElement.Loaded</c> only
    /// when an element is connected to a PresentationSource — which a never-shown
    /// window does not have. MainWindow does real wiring in Loaded handlers
    /// (ConsolePlusRows_Loaded assigns the + menu's ItemsSource, among others), so
    /// a never-shown window would run the checks against half-wired controls. The
    /// red-row audit in particular would count zero red rows because the rows were
    /// never populated, and report that as a PASS. That is a false green, and
    /// trading Troy's screen for his coverage is not a fix.
    ///
    /// So the window is still shown — at <see cref="OffscreenOrigin"/>, off every
    /// display, and with <c>ShowActivated = false</c> so it cannot take focus from
    /// whatever he is actually doing. Layout, Loaded, and the rendered visual tree
    /// all behave exactly as before; the only thing that changes is that no pixel
    /// of it can land on a monitor.
    ///
    /// NOT VERIFIED BY RUNNING: nothing may launch this exe, so this has been
    /// proven to compile and is pinned by OffscreenWindowChecks in the console
    /// smoke suite, which fails if these guards are ever removed. It has NOT been
    /// observed running. A session permitted to launch it should confirm both that
    /// nothing appears and that the checks still count what they used to.
    /// </summary>
    private static MainWindow CreateLaidOutWindow(
        string? themeOverride = null,
        bool persistTheme = false,
        double width = 1440,
        double height = 900)
    {
        var window = new MainWindow(themeOverride, persistTheme)
        {
            Width = width,
            Height = height,
            WindowStyle = WindowStyle.None,
            ShowInTaskbar = false,

            // Manual, and set BEFORE Show(), or WPF centres it on the primary
            // display and the move happens after it is already visible.
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = OffscreenOrigin,
            Top = OffscreenOrigin,

            // Never steal focus. A window that cannot be seen but eats the next
            // keystroke of a sales call is its own kind of harm.
            ShowActivated = false
        };
        window.Show();
        window.UpdateLayout();
        return window;
    }

    private static void RenderPreview(Window window, string outputPath)
    {
        window.InvalidateMeasure();
        window.InvalidateArrange();
        window.InvalidateVisual();
        window.UpdateLayout();
        window.Dispatcher.Invoke(DispatcherPriority.Render, new Action(() => { }));

        var target = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(target)
            ?? throw new InvalidOperationException("Preview path has no parent directory"));

        var dpi = VisualTreeHelper.GetDpi(window);
        var width = Math.Max(1, (int)Math.Ceiling(window.ActualWidth * dpi.DpiScaleX));
        var height = Math.Max(1, (int)Math.Ceiling(window.ActualHeight * dpi.DpiScaleY));
        var bitmap = new RenderTargetBitmap(
            width,
            height,
            96 * dpi.DpiScaleX,
            96 * dpi.DpiScaleY,
            PixelFormats.Pbgra32);
        bitmap.Render(window);

        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
        encoder.Save(stream);
    }
}

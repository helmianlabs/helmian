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
            Shutdown(succeeded ? 0 : 2);
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
            Shutdown(0);
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
            var previewWindow = CreateLaidOutWindow(themeId, persistTheme: false);
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
            previewWindow.UpdateLayout();
            RenderPreview(previewWindow, e.Args[previewIndex + 1]);
            previewWindow.Close();
            Shutdown(0);
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

    private static MainWindow CreateLaidOutWindow(
        string? themeOverride = null,
        bool persistTheme = false)
    {
        var window = new MainWindow(themeOverride, persistTheme)
        {
            Width = 1440,
            Height = 900,
            WindowStyle = WindowStyle.None,
            ShowInTaskbar = false
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

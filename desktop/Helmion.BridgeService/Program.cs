using System.Diagnostics;
using Helmion.BridgeService;
using Microsoft.Extensions.Hosting.WindowsServices;

// Two ways to run, same exe:
//  - Default: a hidden "on sign-in" scheduled task as you (no Windows password needed). A plain process.
//  - Optional: the HelmianBridge Windows service (installer -Mode Service).
var mode = RunModeInfo.From(WindowsServiceHelpers.IsWindowsService());

// Only one copy per PC, whichever way it was started.
Mutex single;
try
{
    single = new Mutex(initiallyOwned: true, RunModeInfo.SingleInstanceName, out var firstCopy);
    if (!firstCopy) { single.Dispose(); return 0; }
}
catch (UnauthorizedAccessException) { return 0; } // held by another account's copy

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "HelmianBridge"); // no-op outside SCM
builder.Services.AddHostedService<BridgeWorker>();

var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
if (!string.IsNullOrWhiteSpace(localAppData))
    builder.Logging.AddProvider(new FileLoggerProvider(RunModeInfo.LogPath(localAppData)));
// The event source is registered by an elevated install. Without it, writing would fail, so skip it.
if (OperatingSystem.IsWindows() && EventSourceReady("Helmian Bridge"))
    builder.Logging.AddEventLog(settings => settings.SourceName = "Helmian Bridge");

var host = builder.Build();
host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Helmian Bridge")
    .LogInformation("Starting ({Mode}).", mode == RunMode.WindowsService ? "Windows service" : "sign-in task, no window");
host.Run();
single.ReleaseMutex();
single.Dispose();
return 0;

static bool EventSourceReady(string source)
{
    if (!OperatingSystem.IsWindows()) return false;
    try { return EventLog.SourceExists(source); }
    catch { return false; } // a normal account cannot scan every log; treat as missing
}

using Helmion.BridgeService;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "HelmianBridge");
builder.Services.AddHostedService<BridgeWorker>();
builder.Logging.AddEventLog(settings => settings.SourceName = "Helmian Bridge");
builder.Build().Run();

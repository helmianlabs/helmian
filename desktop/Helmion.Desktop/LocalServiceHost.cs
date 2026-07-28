using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

/// <summary>
/// Process-wide local service host so App startup and MainWindow share one
/// connector and do not kill each other's loopback process.
/// </summary>
internal static class LocalServiceHost
{
    private static readonly Lazy<LocalServiceConnector> Shared =
        new(() => new LocalServiceConnector());

    public static LocalServiceConnector Connector => Shared.Value;

    /// <summary>
    /// Starts the named-pipe local service if needed and returns the hello handshake.
    /// Safe to call from App.OnStartup before the main window is shown.
    /// </summary>
    public static Task<ServiceHello> EnsureStartedAsync(
        CancellationToken cancellationToken = default)
    {
        return Connector.EnsureConnectedAsync(cancellationToken);
    }

    public static Task StopAsync()
    {
        return Connector.StopStartedProcessAsync();
    }
}

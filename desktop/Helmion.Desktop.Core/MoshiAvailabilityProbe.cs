using System.Net.Sockets;

namespace Helmion.Desktop.Core;

/// <summary>Outcome of a Moshi host liveness probe.</summary>
/// <param name="IsAvailable">True only when a listener accepted a connection.</param>
/// <param name="Reason">Why it is unavailable. Null when available.</param>
public sealed record MoshiAvailability(bool IsAvailable, string? Reason)
{
    public static MoshiAvailability Available { get; } = new(true, null);

    public static MoshiAvailability Unavailable(string reason) => new(false, reason);
}

/// <summary>Answers whether a Moshi host can be reached right now.</summary>
public interface IMoshiAvailabilityProbe
{
    Task<MoshiAvailability> ProbeAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Probes a Moshi server by opening a TCP connection to its host and port.
/// </summary>
/// <remarks>
/// <para>
/// This proves a listener is accepting on that endpoint — it does not prove the
/// listener is Moshi. That asymmetry is deliberate and safe in this direction:
/// a failed connect is conclusive (nothing is there, fall back), while a false
/// positive is absorbed downstream, because
/// <see cref="VoiceBackendSelector"/> falls back on a duplex session that fails
/// to start or dies. The probe exists to avoid paying a connection timeout on
/// every start, not to authenticate the peer.
/// </para>
/// <para>
/// The timeout is short on purpose: this runs on the path between the user
/// pressing the mic button and the microphone opening.
/// </para>
/// </remarks>
public sealed class MoshiAvailabilityProbe : IMoshiAvailabilityProbe
{
    /// <summary>The port moshi-server serves its web UI and WebSocket on.</summary>
    public const int DefaultPort = 8998;

    public const string DefaultHost = "127.0.0.1";

    private readonly string _host;
    private readonly int _port;
    private readonly TimeSpan _timeout;

    public MoshiAvailabilityProbe()
        : this(DefaultHost, DefaultPort, TimeSpan.FromMilliseconds(750))
    {
    }

    public MoshiAvailabilityProbe(string host, int port, TimeSpan timeout)
    {
        _host = host;
        _port = port;
        _timeout = timeout;
    }

    public async Task<MoshiAvailability> ProbeAsync(CancellationToken cancellationToken = default)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(_timeout);

        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(_host, _port, timeoutSource.Token).ConfigureAwait(false);
            return client.Connected
                ? MoshiAvailability.Available
                : MoshiAvailability.Unavailable($"No Moshi host at {_host}:{_port}.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return MoshiAvailability.Unavailable("Moshi probe cancelled.");
        }
        catch (OperationCanceledException)
        {
            return MoshiAvailability.Unavailable(
                $"No Moshi host at {_host}:{_port} (probe timed out after {_timeout.TotalMilliseconds:F0} ms).");
        }
        catch (SocketException ex)
        {
            return MoshiAvailability.Unavailable($"No Moshi host at {_host}:{_port} ({ex.SocketErrorCode}).");
        }
        catch (Exception ex)
        {
            // Never let a probe fault take voice down — an unavailable answer
            // simply routes the selector to the turn-based stack.
            return MoshiAvailability.Unavailable($"Moshi probe failed: {ex.Message}");
        }
    }
}

/// <summary>
/// The probe used when no Moshi host is configured for this machine. It reports
/// unavailable with a fixed reason and opens no sockets.
/// </summary>
public sealed class MoshiNotConfiguredProbe : IMoshiAvailabilityProbe
{
    private readonly MoshiAvailability _answer;

    public MoshiNotConfiguredProbe(string reason) =>
        _answer = MoshiAvailability.Unavailable(reason);

    public Task<MoshiAvailability> ProbeAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(_answer);
}

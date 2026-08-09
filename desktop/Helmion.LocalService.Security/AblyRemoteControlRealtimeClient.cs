using System.Collections.Concurrent;
using System.Text.Json;
using Helmion.LocalService.Protocol;
using IO.Ably;
using IO.Ably.Realtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Helmion.LocalService.Security;

/// <summary>
/// Consumes only a server-signed, short-lived Desktop TokenRequest. This class
/// never accepts an Ably API key and publishes only to result channels returned
/// by the account control plane.
/// </summary>
public sealed class AblyRemoteControlRealtimeClient : IRemoteControlRealtimeClient
{
    private readonly ConcurrentDictionary<string, RemoteControlResultEnvelope> _completed = new();
    private AblyRealtime? _client;
    private string _state = "stopped";

    public string State => _state;

    public async Task RunAsync(
        RemoteDesktopRealtimeGrant grant,
        Func<RemoteControlRequestEnvelope, CancellationToken, Task<RemoteControlResultEnvelope>> dispatch,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ArgumentNullException.ThrowIfNull(dispatch);
        var token = grant.TokenRequest;
        var tokenUsed = 0;
        var options = new ClientOptions
        {
            AutoConnect = true,
            EchoMessages = false,
            // Channel attachment begins while the signed connection is still
            // establishing. Queue that SDK setup work; requests are still only
            // accepted after the channel attaches and the dispatcher validates
            // them, so no user action is sent early.
            QueueMessages = true,
            UseBinaryProtocol = false,
            AuthCallback = _ =>
            {
                if (Interlocked.Increment(ref tokenUsed) != 1)
                {
                    throw new InvalidOperationException("The scoped Ably TokenRequest was already consumed.");
                }
                return Task.FromResult<object>(new TokenRequest
                {
                    KeyName = token.KeyName,
                    Ttl = TimeSpan.FromMilliseconds(token.Ttl),
                    Capability = new Capability(token.Capability),
                    ClientId = token.ClientId,
                    Timestamp = DateTimeOffset.FromUnixTimeMilliseconds(token.Timestamp),
                    Nonce = token.Nonce,
                    Mac = token.Mac
                });
            }
        };

        _state = "connecting";
        try
        {
        using var client = new AblyRealtime(options);
        _client = client;
        var disconnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var attachedToRequestChannel = false;
        client.Connection.ConnectionStateChanged += (_, change) =>
        {
            if (!attachedToRequestChannel) return;
            if (change.Current is ConnectionState.Disconnected
                or ConnectionState.Suspended or ConnectionState.Failed or ConnectionState.Closed)
            {
                _state = "offline";
                disconnected.TrySetResult();
            }
        };
        var requestChannel = client.Channels.Get(grant.Channels.Requests);
        requestChannel.Subscribe(message => _ = ProcessAsync(
            client, grant, message, dispatch, cancellationToken));
        var attached = await requestChannel.AttachAsync().ConfigureAwait(false);
        if (!attached.IsSuccess)
        {
            _state = "offline";
            var reason = attached.Error?.Message;
            throw new IOException(string.IsNullOrWhiteSpace(reason)
                ? "The scoped Ably request channel could not attach."
                : $"The scoped Ably request channel could not attach: {reason}");
        }
        attachedToRequestChannel = true;
        _state = "active";

        try
        {
            var cancelled = Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            var completed = await Task.WhenAny(cancelled, disconnected.Task).ConfigureAwait(false);
            if (completed == disconnected.Task)
                throw new IOException("The scoped Ably connection went offline.");
            await cancelled.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            requestChannel.Unsubscribe();
            client.Close();
            _client = null;
            _state = "stopped";
        }
        }
        catch (Exception error)
        {
            _state = "offline";
            WriteDiagnostic($"{error.GetType().Name}: {error.Message}");
            throw;
        }
    }

    private async Task ProcessAsync(
        AblyRealtime client,
        RemoteDesktopRealtimeGrant grant,
        Message message,
        Func<RemoteControlRequestEnvelope, CancellationToken, Task<RemoteControlResultEnvelope>> dispatch,
        CancellationToken cancellationToken)
    {
        try
        {
            WriteDiagnostic($"Received remote control message on {grant.Channels.Requests} from {message.ClientId ?? "unknown"}.");
            var grantId = GrantId(message.ClientId);
            var resultChannelName = grant.Channels.Results.SingleOrDefault(channel =>
                channel.EndsWith($":control:{grantId}:results", StringComparison.Ordinal));
            if (resultChannelName is null)
            {
                // Phone can mint a control grant after this Desktop token was
                // signed. Prefer a derived channel name so we do not silently
                // drop the request; Ably will still refuse publish if the token
                // capability omits that grant (then the next heartbeat re-mints).
                resultChannelName = DeriveResultChannel(grant.Channels.Requests, grantId);
                WriteDiagnostic(
                    $"Remote control grant {grantId} was not in the signed token results. "
                    + $"Derived channel {resultChannelName}. Available: {string.Join(",", grant.Channels.Results)}. "
                    + "If publish fails, the next Desktop heartbeat will re-mint Ably capabilities.");
            }
            var request = ParseRequest(message.Data, message.ClientId!);
            if (!_completed.TryGetValue(request.RequestId, out var result))
            {
                // Once Ably has delivered a valid request, let the local
                // Desktop gateway finish its bounded response even if this
                // grant is about to refresh. Otherwise an early refresh can
                // silently drop the acknowledgement after the phone queued it.
                using var dispatchTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                result = await dispatch(request, dispatchTimeout.Token).ConfigureAwait(false);
                WriteDiagnostic($"Desktop dispatcher returned {result.State} for {request.RequestId}.");
                if (_completed.Count >= 512) _completed.Clear();
                _completed.TryAdd(request.RequestId, result);
            }
            // Phone normalizeResult only accepts camelCase (v/product/kind/requestId/state).
            // Ably.NET defaults to Newtonsoft PascalCase on C# records, which the PWA
            // silently drops — publish a web-shaped JSON string instead.
            var resultJson = System.Text.Json.JsonSerializer.Serialize(
                result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            var publish = await client.Channels.Get(resultChannelName)
                .PublishAsync("remote-result", resultJson).ConfigureAwait(false);
            if (!publish.IsSuccess) throw new IOException("Ably refused the Remote Control result.");
            WriteDiagnostic($"Published remote control result {result.State} for {request.RequestId}.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            WriteDiagnostic("Remote control message was cancelled while the relay session closed.");
        }
        catch (Exception error)
        {
            // A malformed or unauthorized request is dropped. The scheduler's
            // transport state remains source-backed by the SDK connection.
            WriteDiagnostic($"Remote control message failed: {error.GetType().Name}: {error.Message}");
        }
    }

    private static RemoteControlRequestEnvelope ParseRequest(object? data, string clientId)
    {
        var json = data switch
        {
            string text => text,
            JToken jsonToken => jsonToken.ToString(Formatting.None),
            _ => System.Text.Json.JsonSerializer.Serialize(data)
        };
        var value = System.Text.Json.JsonSerializer.Deserialize<RemoteControlRequestEnvelope>(
            json, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidDataException("Remote Control request was empty.");
        if (value.V != 1
            || value.Product != "helmian-herald"
            || value.Kind != "request"
            || value.DeviceId != clientId
            || value.Action is not ("instruction.submit" or "approval.decide")
            || !ValidId(value.RequestId))
        {
            throw new InvalidDataException("Remote Control request envelope was invalid.");
        }
        return value;
    }

    private static string GrantId(string? clientId)
    {
        const string prefix = "herald-control:";
        if (clientId is null || !clientId.StartsWith(prefix, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Ably message did not have an account-control identity.");
        }
        var value = clientId[prefix.Length..];
        if (!ValidId(value)) throw new InvalidDataException("Account-control identity was invalid.");
        return value;
    }

    /// <summary>
    /// requests = helmian:herald:herald_xxx:requests
    /// results  = helmian:herald:herald_xxx:control:{grantId}:results
    /// </summary>
    private static string DeriveResultChannel(string requestsChannel, string grantId)
    {
        const string suffix = ":requests";
        if (!requestsChannel.EndsWith(suffix, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Request channel name was not in the expected form.");
        }
        return requestsChannel[..^suffix.Length] + $":control:{grantId}:results";
    }

    private static bool ValidId(string value) => value.Length is >= 1 and <= 128
        && value.All(character => char.IsAsciiLetterOrDigit(character)
            || character is '.' or '_' or ':' or '-');

    public ValueTask DisposeAsync()
    {
        _client?.Close();
        _client = null;
        _state = "stopped";
        _completed.Clear();
        return ValueTask.CompletedTask;
    }

    private static void WriteDiagnostic(string value)
    {
        try
        {
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Helmion");
            Directory.CreateDirectory(folder);
            File.AppendAllText(Path.Combine(folder, "remote-control-realtime.log"),
                $"{DateTimeOffset.UtcNow:O} {value.Replace('\r', ' ').Replace('\n', ' ')}{Environment.NewLine}");
        }
        catch { }
    }
}

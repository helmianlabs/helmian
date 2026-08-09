using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

namespace Helmion.LocalService;

internal sealed class RemoteDesktopGatewayDispatcher : IRemoteDesktopRequestDispatcher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<RemoteControlResultEnvelope> DispatchAsync(
        RemoteControlRequestEnvelope request,
        CancellationToken cancellationToken)
    {
        try
        {
            var payload = request.Action switch
            {
                "instruction.submit" => JsonSerializer.SerializeToElement(new DesktopInstructionRequest(
                    request.RequestId,
                    request.DeviceId,
                    Required(request.Payload, "projectId"),
                    Required(request.Payload, "sessionId"),
                    Required(request.Payload, "text"),
                    Confirmed(request.Payload),
                    DateTimeOffset.UtcNow), JsonOptions),
                "approval.decide" => JsonSerializer.SerializeToElement(new DesktopApprovalDecision(
                    request.RequestId,
                    request.DeviceId,
                    Required(request.Payload, "projectId"),
                    Required(request.Payload, "sessionId"),
                    Required(request.Payload, "approvalId"),
                    Required(request.Payload, "decision"),
                    Confirmed(request.Payload),
                    DateTimeOffset.UtcNow), JsonOptions),
                _ => throw new InvalidDataException("Remote Control action is not available.")
            };
            var response = await CallDesktopAsync(new DesktopPipeRequest(
                request.RequestId, request.Action, payload), cancellationToken).ConfigureAwait(false);
            var gateway = response.Value?.Deserialize<DesktopGatewayResult>(JsonOptions);
            var state = response.Ok && gateway is not null
                ? gateway.Accepted ? "ok" : "refused"
                : "error";
            var message = gateway?.Message ?? "Helmian Desktop could not complete the request.";
            // Surface the refusal reason in the service log — silent "refused"
            // without text made Herald look offline when the real cause was a
            // project/session mismatch or missing confirmation.
            try
            {
                var log = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Helmion", "remote-control-realtime.log");
                Directory.CreateDirectory(Path.GetDirectoryName(log)!);
                File.AppendAllText(log,
                    $"{DateTimeOffset.UtcNow:O} Gateway {state} for {request.RequestId} action={request.Action}: {message}{Environment.NewLine}");
            }
            catch { /* diagnostics must never break the reply path */ }
            return Result(request, state, message);
        }
        catch (Exception error) when (error is IOException or TimeoutException
            or InvalidDataException or UnauthorizedAccessException)
        {
            return Result(request, "error", "Helmian Desktop is unavailable; no remote action was performed.");
        }
    }

    private static async Task<DesktopPipeResponse> CallDesktopAsync(
        DesktopPipeRequest request, CancellationToken cancellationToken)
    {
        await using var pipe = new NamedPipeClientStream(
            ".", PipeNameForCurrentUser(), PipeDirection.InOut,
            PipeOptions.Asynchronous, System.Security.Principal.TokenImpersonationLevel.Identification);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);
        await WriteAsync(pipe, request, timeout.Token).ConfigureAwait(false);
        return await ReadAsync<DesktopPipeResponse>(pipe, timeout.Token).ConfigureAwait(false)
            ?? throw new EndOfStreamException("Desktop gateway closed the pipe.");
    }

    private static RemoteControlResultEnvelope Result(
        RemoteControlRequestEnvelope request, string state, string message) => new(
        1, "helmian-herald", "result", request.RequestId, request.Action,
        request.DeviceId, state, JsonSerializer.SerializeToElement(new { message }, JsonOptions));

    private static string Required(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"Remote Control {name} is required.");
        return property.GetString() ?? throw new InvalidDataException($"Remote Control {name} is empty.");
    }

    private static bool Confirmed(JsonElement value) =>
        value.TryGetProperty("confirmed", out var property) && property.ValueKind == JsonValueKind.True;

    private static async Task WriteAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        if (payload.Length is < 1 or > MaxMessageBytes)
            throw new InvalidDataException("Desktop gateway request exceeded its protocol limit.");
        await stream.WriteAsync(BitConverter.GetBytes(payload.Length), cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task<T?> ReadAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        var prefix = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(prefix, cancellationToken).ConfigureAwait(false);
        var length = BitConverter.ToInt32(prefix);
        if (length is < 1 or > MaxMessageBytes)
            throw new InvalidDataException("Desktop gateway response exceeded its protocol limit.");
        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Deserialize<T>(payload, JsonOptions);
    }

    private const int MaxMessageBytes = 64 * 1024;

    private static string PipeNameForCurrentUser()
    {
        var user = new string(Environment.UserName.ToLowerInvariant()
            .Select(character => char.IsAsciiLetterOrDigit(character) ? character : '-')
            .ToArray()).Trim('-');
        return $"helmion-herald-desktop-{(user.Length == 0 ? "user" : user)}";
    }

    private sealed record DesktopPipeRequest(string Id, string Action, JsonElement Payload);
    private sealed record DesktopPipeResponse(string Id, bool Ok, JsonElement? Value, string? Error);
    private sealed record DesktopGatewayResult(bool Accepted, string State, string Message);
    private sealed record DesktopInstructionRequest(
        string Id, string DeviceId, string ProjectId, string SessionId,
        string Text, bool Confirmed, DateTimeOffset SubmittedAt);
    private sealed record DesktopApprovalDecision(
        string Id, string DeviceId, string ProjectId, string SessionId,
        string ApprovalId, string Decision, bool Confirmed, DateTimeOffset DecidedAt);
}

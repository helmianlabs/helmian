using System.IO.Pipes;
using System.Text.Json;

namespace Helmion.Desktop.Core;

public sealed record HeraldPipeRequest(string Id, string Action, JsonElement Payload);
public sealed record HeraldPipeResponse(string Id, bool Ok, JsonElement? Value = null, string? Error = null);

/// <summary>
/// Current-Windows-user-only local IPC between the Node Herald service and the
/// running desktop window. It is not a network listener and exposes only the
/// fixed Herald gateway actions.
/// </summary>
public sealed class HeraldDesktopPipeServer(string pipeName, HeraldDesktopGateway gateway)
{
    public const int MaxMessageBytes = 64 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public string PipeName { get; } = string.IsNullOrWhiteSpace(pipeName)
        ? throw new ArgumentException("Herald pipe name is required.", nameof(pipeName))
        : pipeName;

    public static string PipeNameForCurrentUser()
    {
        var user = new string(Environment.UserName.ToLowerInvariant()
            .Select(character => char.IsAsciiLetterOrDigit(character) ? character : '-')
            .ToArray()).Trim('-');
        return $"helmion-herald-desktop-{(user.Length == 0 ? "user" : user)}";
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.WriteThrough);
            await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            await ServeClientAsync(pipe, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ServeClientAsync(Stream pipe, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            HeraldPipeRequest? request;
            try
            {
                request = await ReadAsync<HeraldPipeRequest>(pipe, cancellationToken).ConfigureAwait(false);
                if (request is null) return;
            }
            catch (EndOfStreamException)
            {
                return;
            }

            var response = await HandleAsync(request, cancellationToken).ConfigureAwait(false);
            await WriteAsync(pipe, response, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<HeraldPipeResponse> HandleAsync(
        HeraldPipeRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 128)
        {
            return new HeraldPipeResponse(request.Id ?? string.Empty, false, Error: "invalid_request_id");
        }

        try
        {
            return request.Action switch
            {
                "presence" => Ok(request, new { available = gateway.IsAvailable() }),
                "session.read" => gateway.GetSessionSnapshot() is { } snapshot
                    ? Ok(request, snapshot)
                    : new HeraldPipeResponse(request.Id, false, Error: "desktop_unavailable"),
                "instruction.submit" => Ok(request, await gateway.SubmitInstructionAsync(
                    Deserialize<HeraldInstructionRequest>(request.Payload), cancellationToken).ConfigureAwait(false)),
                "approval.decide" => Ok(request, await gateway.DecideApprovalAsync(
                    Deserialize<HeraldApprovalDecision>(request.Payload), cancellationToken).ConfigureAwait(false)),
                _ => new HeraldPipeResponse(request.Id, false, Error: "unknown_action"),
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return new HeraldPipeResponse(request.Id, false, Error: "desktop_request_failed");
        }
    }

    private static T Deserialize<T>(JsonElement payload) =>
        payload.Deserialize<T>(JsonOptions)
        ?? throw new InvalidDataException("Herald pipe payload was empty.");

    private static HeraldPipeResponse Ok<T>(HeraldPipeRequest request, T value) =>
        new(request.Id, true, JsonSerializer.SerializeToElement(value, JsonOptions));

    internal static async Task WriteAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        if (payload.Length == 0 || payload.Length > MaxMessageBytes)
        {
            throw new InvalidDataException("Herald pipe message exceeds the protocol limit.");
        }
        var prefix = BitConverter.GetBytes(payload.Length);
        await stream.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<T?> ReadAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        var prefix = new byte[sizeof(int)];
        var first = await stream.ReadAsync(prefix.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
        if (first == 0) return default;
        await ReadExactlyAsync(stream, prefix.AsMemory(1), cancellationToken).ConfigureAwait(false);
        var length = BitConverter.ToInt32(prefix);
        if (length <= 0 || length > MaxMessageBytes)
        {
            throw new InvalidDataException("Herald pipe message length is invalid.");
        }
        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Deserialize<T>(payload, JsonOptions)
            ?? throw new InvalidDataException("Herald pipe message was empty.");
    }

    private static async Task ReadExactlyAsync(
        Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
    }
}

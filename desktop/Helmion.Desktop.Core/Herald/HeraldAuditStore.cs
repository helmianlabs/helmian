using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Durable append-only local records for paired Herald requests and results.
/// Records contain identifiers and outcomes, never instruction text, credentials,
/// file contents, or workspace paths.
/// </summary>
public static class HeraldAuditStore
{
    public const string AuditDirectory = @".helmion\audit";
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates =
        new(StringComparer.OrdinalIgnoreCase);

    public static async Task<string> AppendAsync(
        string workspace,
        HeraldAuditRecord record,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(workspace) || !Directory.Exists(workspace))
        {
            throw new DirectoryNotFoundException("Herald audit needs the active project directory.");
        }

        var directory = Path.Combine(Path.GetFullPath(workspace), AuditDirectory);
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"herald-{record.At.UtcDateTime:yyyy-MM-dd}.jsonl");
        var gate = Gates.GetOrAdd(path, _ => new SemaphoreSlim(1, 1));
        var line = JsonSerializer.Serialize(new
        {
            at = record.At.ToUniversalTime().ToString("O"),
            @event = record.Event,
            requestId = record.RequestId,
            deviceId = record.DeviceId,
            projectId = record.ProjectId,
            sessionId = record.SessionId,
            result = record.Result,
        }) + "\n";

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await using var stream = new FileStream(path, FileMode.Append, FileAccess.Write,
                FileShare.Read, 4_096, FileOptions.Asynchronous | FileOptions.WriteThrough);
            var bytes = Encoding.UTF8.GetBytes(line);
            await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }

        return path;
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

public sealed record ProjectCanvasSnapshot(
    string ProjectRoot,
    string DocumentPath,
    string Text,
    DateTimeOffset? ModifiedAtUtc);

public sealed record ProjectActivityEntry(
    string Id,
    DateTimeOffset AtUtc,
    string Kind,
    string Title,
    string Detail,
    string Status,
    string Source,
    string? EvidenceHash = null)
{
    public string KindLabel => Kind.ToUpperInvariant();
    public string TimeLabel => AtUtc.ToLocalTime().ToString("g");
}

/// <summary>
/// Local, project-scoped storage for the Canvas and its reviewable activity.
/// Nothing is sent to a provider. Writes occur only after an explicit UI action
/// and are confined to fixed paths beneath the selected project.
/// </summary>
public static class ProjectWorkbenchStore
{
    public const int MaxCanvasChars = 200_000;
    public const int MaxActivityDetailChars = 8_000;
    public const string CanvasRelativePath = "planning/canvas.md";
    public const string ActivityRelativePath = ".helmion/audit/project-activity.jsonl";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static ProjectCanvasSnapshot LoadCanvas(string projectRoot)
    {
        var root = RequireProjectRoot(projectRoot);
        var path = ResolveInside(root, CanvasRelativePath);
        if (!File.Exists(path))
        {
            return new ProjectCanvasSnapshot(root, path, string.Empty, null);
        }

        var text = File.ReadAllText(path, Encoding.UTF8);
        var modified = new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero);
        return new ProjectCanvasSnapshot(root, path, text, modified);
    }

    public static ProjectActivityEntry SaveCanvas(
        string projectRoot,
        string? text,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        var normalized = text ?? string.Empty;
        if (normalized.Length > MaxCanvasChars)
        {
            throw new ArgumentException(
                $"Canvas is {normalized.Length:N0} characters; the limit is {MaxCanvasChars:N0}.",
                nameof(text));
        }

        var path = ResolveInside(root, CanvasRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        WriteAtomically(path, normalized);

        var bytes = Encoding.UTF8.GetBytes(normalized);
        var entry = NewEntry(
            now,
            kind: "note",
            title: "Canvas notes saved",
            detail: $"Saved {normalized.Length:N0} characters to {CanvasRelativePath}.",
            status: "recorded",
            source: "Helmian Canvas",
            evidenceHash: Convert.ToHexString(SHA256.HashData(bytes)));
        AppendActivity(root, entry);
        return entry;
    }

    public static ProjectActivityEntry RecordDecision(
        string projectRoot,
        string detail,
        DateTimeOffset? now = null)
    {
        var normalized = RequireDetail(detail);
        var entry = NewEntry(
            now,
            kind: "decision",
            title: "Project decision",
            detail: normalized,
            status: "recorded",
            source: "Helmian Canvas");
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    public static ProjectActivityEntry RecordBrowserReference(
        string projectRoot,
        string displayAddress,
        string title,
        int characterCount,
        string evidenceHash,
        DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(displayAddress);
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(evidenceHash);
        if (characterCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(characterCount));
        }

        var entry = NewEntry(
            now,
            kind: "browser",
            title: $"Reference read · {title.Trim()}",
            detail: $"Read {characterCount:N0} inert text characters from {displayAddress.Trim()}.",
            status: "read",
            source: "Helmian Browser",
            evidenceHash: evidenceHash.Trim());
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    public static ProjectActivityEntry RecordConnectorEvent(
        string projectRoot,
        string connectorName,
        string title,
        string detail,
        string status,
        string evidenceHash,
        DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectorName);
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(status);
        ArgumentException.ThrowIfNullOrWhiteSpace(evidenceHash);
        var entry = NewEntry(
            now,
            kind: "connector",
            title: $"{connectorName.Trim()} · {title.Trim()}",
            detail: RequireDetail(detail),
            status: status.Trim().ToLowerInvariant(),
            source: "Helmian Project Connectors",
            evidenceHash: evidenceHash.Trim());
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    /// <summary>
    /// Typed seam for a real approval flow. The Canvas UI does not manufacture
    /// approvals; a caller must supply the actual approval id, decision and
    /// source after that flow has completed.
    /// </summary>
    public static ProjectActivityEntry RecordApproval(
        string projectRoot,
        string approvalId,
        string decision,
        string detail,
        string source,
        DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(approvalId);
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        var normalizedDecision = decision?.Trim().ToLowerInvariant();
        if (normalizedDecision is not ("approved" or "denied" or "expired"))
        {
            throw new ArgumentException("Approval decision must be approved, denied, or expired.", nameof(decision));
        }

        var entry = NewEntry(
            now,
            kind: "approval",
            title: $"Approval {normalizedDecision}",
            detail: $"{approvalId.Trim()}: {RequireDetail(detail)}",
            status: normalizedDecision,
            source: source.Trim());
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    /// <summary>
    /// Records Artifact Studio lifecycle metadata without copying provider
    /// credentials or generation instructions into the general activity feed.
    /// The full request remains in its project-local, append-only ledger.
    /// </summary>
    public static ProjectActivityEntry RecordArtifactStudioEvent(
        string projectRoot,
        string requestId,
        string title,
        string detail,
        string status,
        string evidenceHash,
        DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(status);
        ArgumentException.ThrowIfNullOrWhiteSpace(evidenceHash);
        var entry = NewEntry(
            now,
            kind: "artifact",
            title: title.Trim(),
            detail: $"{requestId.Trim()}: {RequireDetail(detail)}",
            status: status.Trim(),
            source: "Helmian Artifact Studio",
            evidenceHash: evidenceHash.Trim());
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    public static ProjectActivityEntry RecordAgentWorkbenchEvent(
        string projectRoot,
        string title,
        string detail,
        string status,
        string? evidenceHash = null,
        DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(status);
        var entry = NewEntry(
            now,
            kind: "agent",
            title: title.Trim(),
            detail: RequireDetail(detail),
            status: status.Trim().ToLowerInvariant(),
            source: "Helmian Agent Workbench",
            evidenceHash: string.IsNullOrWhiteSpace(evidenceHash) ? null : evidenceHash.Trim());
        AppendActivity(RequireProjectRoot(projectRoot), entry);
        return entry;
    }

    public static IReadOnlyList<ProjectActivityEntry> ReadActivity(
        string projectRoot,
        int limit = 100)
    {
        var root = RequireProjectRoot(projectRoot);
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), "Activity limit must be between 1 and 500.");
        }

        var path = ResolveInside(root, ActivityRelativePath);
        if (!File.Exists(path)) return [];

        var entries = new List<ProjectActivityEntry>();
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var entry = JsonSerializer.Deserialize<ProjectActivityEntry>(line, JsonOptions);
                if (entry is not null
                    && !string.IsNullOrWhiteSpace(entry.Id)
                    && !string.IsNullOrWhiteSpace(entry.Kind))
                {
                    entries.Add(entry);
                }
            }
            catch (JsonException)
            {
                // One partial/corrupt append must not hide the valid history.
            }
        }

        return entries
            .OrderByDescending(entry => entry.AtUtc)
            .ThenByDescending(entry => entry.Id, StringComparer.Ordinal)
            .Take(limit)
            .ToArray();
    }

    private static void AppendActivity(string root, ProjectActivityEntry entry)
    {
        var path = ResolveInside(root, ActivityRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var line = JsonSerializer.Serialize(entry, JsonOptions) + Environment.NewLine;
        File.AppendAllText(path, line, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static ProjectActivityEntry NewEntry(
        DateTimeOffset? now,
        string kind,
        string title,
        string detail,
        string status,
        string source,
        string? evidenceHash = null)
    {
        var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        return new ProjectActivityEntry(
            $"{at:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}",
            at,
            kind,
            title,
            detail,
            status,
            source,
            evidenceHash);
    }

    private static string RequireDetail(string? detail)
    {
        var normalized = detail?.Trim() ?? string.Empty;
        if (normalized.Length == 0) throw new ArgumentException("Activity detail is required.", nameof(detail));
        if (normalized.Length > MaxActivityDetailChars)
        {
            throw new ArgumentException(
                $"Activity detail is {normalized.Length:N0} characters; the limit is {MaxActivityDetailChars:N0}.",
                nameof(detail));
        }

        return normalized;
    }

    private static string RequireProjectRoot(string? projectRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectRoot);
        var root = Path.GetFullPath(projectRoot);
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException($"Selected project does not exist: {root}");
        }

        return Path.TrimEndingDirectorySeparator(root);
    }

    private static string ResolveInside(string root, string relativePath)
    {
        var full = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Workbench path escaped the selected project.");
        }

        return full;
    }

    private static void WriteAtomically(string path, string text)
    {
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporary, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            try
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
            catch
            {
                // Best-effort cleanup; the intended document is already safe.
            }
        }
    }
}

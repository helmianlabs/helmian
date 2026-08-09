using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

public enum ConnectorActionDraftStatus
{
    Draft,
    Withdrawn
}

public enum ConnectorActionDraftReviewState
{
    NeedsReview,
    Reviewed
}

public sealed record ConnectorActionDraft(
    string Id,
    int Revision,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string ConnectorId,
    string OperationId,
    string Destination,
    string Body,
    string PayloadSha256,
    ConnectorActionDraftStatus Status,
    ConnectorActionDraftReviewState ReviewState = ConnectorActionDraftReviewState.NeedsReview)
{
    public string ConnectorLabel => ProjectConnectorCatalog.Find(ConnectorId)?.Name ?? ConnectorId;
    public string OperationLabel => ConnectorOperationCatalog.Find(OperationId)?.Label ?? OperationId;
    public string UpdatedLabel => UpdatedAtUtc.ToLocalTime().ToString("g");
    public string StatusLabel => Status.ToString().ToUpperInvariant();
    public string ReviewStateLabel => ReviewState == ConnectorActionDraftReviewState.Reviewed
        ? "REVIEWED LOCALLY · NOT APPROVED"
        : "NEEDS LOCAL REVIEW · NOT AN APPROVAL";
    public string BodyPreview => Body.Length <= 240 ? Body : Body[..240].TrimEnd() + "…";
}

public sealed record ConnectorDraftMutation(
    ConnectorActionDraft Draft,
    ConnectorAuditEntry Audit,
    ProjectActivityEntry Activity);

/// <summary>
/// Append-only local review drafts. There is deliberately no approval mutation,
/// send method, HTTP client, CLI invocation, credential field, or gateway call.
/// </summary>
public static class ConnectorActionDraftStore
{
    public const string DraftsRelativePath = ".helmion/connectors/action-drafts.jsonl";
    private static readonly object WriteGate = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    public static ConnectorDraftMutation Create(
        string projectRoot,
        string connectorId,
        string operationId,
        string destination,
        string body,
        DateTimeOffset? now = null)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        var validation = ConnectorProtocolPolicy.ValidateDraftFields(
            connectorId,
            operationId,
            destination,
            body);
        if (!validation.Allowed) throw new ArgumentException(validation.Message);

        lock (WriteGate)
        {
            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var normalizedBody = body.Trim();
            var draft = new ConnectorActionDraft(
                $"draft-{Guid.NewGuid():N}",
                Revision: 1,
                at,
                at,
                connectorId.Trim().ToLowerInvariant(),
                operationId.Trim().ToLowerInvariant(),
                destination.Trim(),
                normalizedBody,
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalizedBody))),
                ConnectorActionDraftStatus.Draft,
                ConnectorActionDraftReviewState.NeedsReview);
            AppendRevision(root, draft);

            var operation = ConnectorOperationCatalog.Find(draft.OperationId)!;
            var connector = ProjectConnectorCatalog.Find(draft.ConnectorId)!;
            var detail =
                $"Saved local {operation.Label.ToLowerInvariant()} draft for {draft.Destination}. "
                + "No approval was requested and nothing was sent to the provider.";
            var activity = ProjectWorkbenchStore.RecordConnectorEvent(
                root,
                connector.Name,
                "Outbound action draft saved",
                detail,
                "draft",
                draft.PayloadSha256,
                at);
            var audit = ProjectConnectorStore.AppendAuditEvent(
                root,
                draft.ConnectorId,
                "draft_created",
                "local_only",
                detail,
                draft.PayloadSha256,
                activity.Id,
                at);
            return new ConnectorDraftMutation(draft, audit, activity);
        }
    }

    public static ConnectorDraftMutation MarkReviewed(
        string projectRoot,
        string draftId,
        DateTimeOffset? now = null)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(draftId);
        lock (WriteGate)
        {
            var current = Read(root, includeWithdrawn: true, limit: 500)
                .FirstOrDefault(item => string.Equals(item.Id, draftId, StringComparison.Ordinal));
            if (current is null) throw new InvalidOperationException("Connector draft was not found.");
            if (current.Status != ConnectorActionDraftStatus.Draft)
            {
                throw new InvalidOperationException("A withdrawn draft cannot be reviewed.");
            }
            if (current.ReviewState == ConnectorActionDraftReviewState.Reviewed)
            {
                throw new InvalidOperationException("Connector draft is already marked reviewed.");
            }

            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var next = current with
            {
                Revision = current.Revision + 1,
                UpdatedAtUtc = at,
                ReviewState = ConnectorActionDraftReviewState.Reviewed
            };
            AppendRevision(root, next);

            var connector = ProjectConnectorCatalog.Find(next.ConnectorId)!;
            var operation = ConnectorOperationCatalog.Find(next.OperationId)!;
            var evidenceHash = HashRevision(next);
            var detail =
                $"Marked local {operation.Label.ToLowerInvariant()} draft for {next.Destination} reviewed. "
                + "This was not an approval and nothing was sent.";
            var activity = ProjectWorkbenchStore.RecordConnectorEvent(
                root,
                connector.Name,
                "Outbound action draft reviewed",
                detail,
                "reviewed-local-only",
                evidenceHash,
                at);
            var audit = ProjectConnectorStore.AppendAuditEvent(
                root,
                next.ConnectorId,
                "draft_reviewed",
                "local_only_not_approved",
                detail,
                evidenceHash,
                activity.Id,
                at);
            return new ConnectorDraftMutation(next, audit, activity);
        }
    }

    public static ConnectorDraftMutation Withdraw(
        string projectRoot,
        string draftId,
        DateTimeOffset? now = null)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(draftId);
        lock (WriteGate)
        {
            var current = Read(root, includeWithdrawn: true, limit: 500)
                .FirstOrDefault(item => string.Equals(item.Id, draftId, StringComparison.Ordinal));
            if (current is null) throw new InvalidOperationException("Connector draft was not found.");
            if (current.Status != ConnectorActionDraftStatus.Draft)
            {
                throw new InvalidOperationException("Connector draft is already withdrawn.");
            }

            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var next = current with
            {
                Revision = current.Revision + 1,
                UpdatedAtUtc = at,
                Status = ConnectorActionDraftStatus.Withdrawn
            };
            AppendRevision(root, next);

            var connector = ProjectConnectorCatalog.Find(next.ConnectorId)!;
            var operation = ConnectorOperationCatalog.Find(next.OperationId)!;
            var evidenceHash = HashRevision(next);
            var detail =
                $"Withdrew local {operation.Label.ToLowerInvariant()} draft for {next.Destination}. "
                + "No provider state was changed.";
            var activity = ProjectWorkbenchStore.RecordConnectorEvent(
                root,
                connector.Name,
                "Outbound action draft withdrawn",
                detail,
                "withdrawn",
                evidenceHash,
                at);
            var audit = ProjectConnectorStore.AppendAuditEvent(
                root,
                next.ConnectorId,
                "draft_withdrawn",
                "local_only",
                detail,
                evidenceHash,
                activity.Id,
                at);
            return new ConnectorDraftMutation(next, audit, activity);
        }
    }

    public static IReadOnlyList<ConnectorActionDraft> Read(
        string projectRoot,
        bool includeWithdrawn = false,
        int limit = 100)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        if (limit is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(limit));
        var path = ProjectConnectorStore.ResolveInside(root, DraftsRelativePath);
        if (!File.Exists(path)) return [];

        var latest = new Dictionary<string, ConnectorActionDraft>(StringComparer.Ordinal);
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var revision = JsonSerializer.Deserialize<ConnectorActionDraft>(line, JsonOptions);
                if (revision is null
                    || revision.Id.Length == 0
                    || ProjectConnectorCatalog.Find(revision.ConnectorId) is null
                    || ConnectorOperationCatalog.Find(revision.OperationId) is null)
                {
                    continue;
                }

                if (!latest.TryGetValue(revision.Id, out var prior)
                    || revision.Revision > prior.Revision)
                {
                    latest[revision.Id] = revision;
                }
            }
            catch (JsonException)
            {
                // One partial append cannot hide intact draft revisions.
            }
        }

        return latest.Values
            .Where(item => includeWithdrawn || item.Status == ConnectorActionDraftStatus.Draft)
            .OrderByDescending(item => item.UpdatedAtUtc)
            .ThenByDescending(item => item.Id, StringComparer.Ordinal)
            .Take(limit)
            .ToArray();
    }

    private static void AppendRevision(string root, ConnectorActionDraft draft)
    {
        var path = ProjectConnectorStore.ResolveInside(root, DraftsRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(
            path,
            JsonSerializer.Serialize(draft, JsonOptions) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static string HashRevision(ConnectorActionDraft draft) =>
        Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(draft, JsonOptions))));
}

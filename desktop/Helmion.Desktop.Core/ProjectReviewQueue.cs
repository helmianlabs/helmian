namespace Helmion.Desktop.Core;

public sealed record ProjectReviewFilter(string Id, string Label);

public static class ProjectReviewFilterCatalog
{
    public static IReadOnlyList<ProjectReviewFilter> All { get; } =
    [
        new("all", "All review records"),
        new("needs-action", "Needs action"),
        new("artifact", "Artifact approvals"),
        new("connector", "Connector local reviews"),
        new("history", "Completed history")
    ];

    public static ProjectReviewFilter Require(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase))
        ?? throw new ArgumentException("Select a supported review filter.", nameof(id));
}

public sealed record ArtifactApprovalReviewView(
    string Id,
    string Title,
    string Detail,
    string ProviderLabel,
    string Destination,
    string UpdatedLabel,
    string EvidenceLabel);

public sealed record ConnectorLocalReviewView(
    string Id,
    string Title,
    string Detail,
    string Destination,
    string UpdatedLabel,
    string ReviewStateLabel,
    string EvidenceLabel,
    bool CanMarkReviewed);

public sealed record CompletedReviewView(
    string Id,
    DateTimeOffset AtUtc,
    string TypeLabel,
    string Title,
    string Detail,
    string StateLabel,
    string UpdatedLabel,
    string EvidenceLabel);

public sealed record ProjectReviewSnapshot(
    string ProjectRoot,
    string FilterId,
    string FilterLabel,
    int ActionableCount,
    int TotalCount,
    IReadOnlyList<ArtifactApprovalReviewView> ArtifactApprovals,
    IReadOnlyList<ConnectorLocalReviewView> ConnectorReviews,
    IReadOnlyList<CompletedReviewView> CompletedHistory)
{
    public string CountLabel => $"{ActionableCount:N0} ACTIONABLE · {TotalCount:N0} SHOWN";
    public string EmptyMessage => TotalCount == 0
        ? "No project review records match this filter."
        : string.Empty;
}

/// <summary>
/// Project-scoped local review projection. Artifact decisions are durable local
/// approvals, but never dispatch. Connector drafts are reviewable and withdrawable
/// only; marking one reviewed is explicitly not provider authorization.
/// </summary>
public static class ProjectReviewQueue
{
    public static ProjectReviewSnapshot Load(string projectRoot, string? filterId = null)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        var filter = ProjectReviewFilterCatalog.Require(
            string.IsNullOrWhiteSpace(filterId) ? "all" : filterId);
        var artifactHistory = ArtifactStudioWorkflow.ReadHistory(root, 500);
        var drafts = ConnectorActionDraftStore.Read(root, includeWithdrawn: true, limit: 500);
        var approvalActivity = ProjectWorkbenchStore.ReadActivity(root, 500)
            .Where(item => string.Equals(item.Kind, "approval", StringComparison.OrdinalIgnoreCase))
            .ToArray();

        var artifacts = artifactHistory
            .Where(item => item.CanDecide)
            .Select(item => new ArtifactApprovalReviewView(
                item.Id,
                item.Title,
                $"{item.KindLabel} · {item.DataScope}",
                $"{item.ProviderName} · LOCAL DECISION ONLY",
                item.Destination,
                item.UpdatedLabel,
                $"SHA-256 · {item.EvidenceHash}"))
            .ToArray();

        var connectorReviews = drafts
            .Where(item => item.Status == ConnectorActionDraftStatus.Draft
                && item.ReviewState == ConnectorActionDraftReviewState.NeedsReview)
            .Select(item => new ConnectorLocalReviewView(
                item.Id,
                $"{item.ConnectorLabel} · {item.OperationLabel}",
                item.BodyPreview,
                item.Destination,
                item.UpdatedLabel,
                item.ReviewStateLabel,
                $"SHA-256 · {item.PayloadSha256}",
                item.ReviewState == ConnectorActionDraftReviewState.NeedsReview))
            .ToArray();

        var history = artifactHistory
            .Where(item => !item.CanDecide)
            .Select(item => new CompletedReviewView(
                item.Id,
                item.UpdatedAtUtc,
                "ARTIFACT APPROVAL",
                item.Title,
                item.StatusDetail,
                $"{item.ApprovalState.ToUpperInvariant()} · {item.DeliveryState.ToUpperInvariant()}",
                item.UpdatedLabel,
                $"SHA-256 · {item.EvidenceHash}"))
            .Concat(drafts
                .Where(item => item.Status == ConnectorActionDraftStatus.Withdrawn
                    || item.ReviewState == ConnectorActionDraftReviewState.Reviewed)
                .Select(item => new CompletedReviewView(
                    item.Id,
                    item.UpdatedAtUtc,
                    "CONNECTOR LOCAL REVIEW · NOT APPROVAL",
                    $"{item.ConnectorLabel} · {item.OperationLabel}",
                    item.BodyPreview,
                    item.Status == ConnectorActionDraftStatus.Withdrawn
                        ? "WITHDRAWN · NOTHING SENT"
                        : "REVIEWED LOCALLY · NOT APPROVED",
                    item.UpdatedLabel,
                    $"SHA-256 · {item.PayloadSha256}")))
            .Concat(approvalActivity.Select(item => new CompletedReviewView(
                item.Id,
                item.AtUtc,
                "PROJECT APPROVAL RECORD",
                item.Title,
                item.Detail,
                item.Status.ToUpperInvariant(),
                item.TimeLabel,
                string.IsNullOrWhiteSpace(item.EvidenceHash)
                    ? "NO CONTENT HASH RECORDED"
                    : $"SHA-256 · {item.EvidenceHash}")))
            .OrderByDescending(item => item.AtUtc)
            .ToArray();

        var showArtifacts = filter.Id is "all" or "needs-action" or "artifact";
        var showConnectors = filter.Id is "all" or "needs-action" or "connector";
        var shownArtifacts = showArtifacts ? artifacts : [];
        var shownConnectors = showConnectors
            ? connectorReviews.Where(item => filter.Id != "needs-action" || item.CanMarkReviewed).ToArray()
            : [];
        var shownHistory = filter.Id switch
        {
            "all" or "history" => history,
            "artifact" => history.Where(item => item.TypeLabel == "ARTIFACT APPROVAL").ToArray(),
            "connector" => history.Where(item => item.TypeLabel.StartsWith(
                "CONNECTOR", StringComparison.Ordinal)).ToArray(),
            _ => []
        };
        var actionable = shownArtifacts.Length + shownConnectors.Count(item => item.CanMarkReviewed);
        var total = shownArtifacts.Length + shownConnectors.Length + shownHistory.Length;

        return new ProjectReviewSnapshot(
            root,
            filter.Id,
            filter.Label,
            actionable,
            total,
            shownArtifacts,
            shownConnectors,
            shownHistory);
    }

    public static ArtifactStudioRequest DecideArtifact(
        string projectRoot,
        string requestId,
        bool approve,
        DateTimeOffset? now = null)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        var at = now ?? DateTimeOffset.UtcNow;
        var result = ArtifactStudioWorkflow.Decide(
            root,
            requestId,
            approve,
            new ArtifactStudioProviderReadiness(
                CredentialConfigured: false,
                AdapterInstalled: false),
            at);
        ProjectWorkbenchStore.RecordApproval(
            root,
            result.Id,
            approve ? "approved" : "denied",
            approve
                ? $"Artifact request approved locally; delivery remains {result.DeliveryState}. Nothing was sent."
                : "Artifact request denied locally. Nothing was sent or created.",
            "Helmian Approvals",
            at);
        return result;
    }

    public static ConnectorDraftMutation MarkConnectorReviewed(
        string projectRoot,
        string draftId,
        DateTimeOffset? now = null) =>
        ConnectorActionDraftStore.MarkReviewed(projectRoot, draftId, now);

    public static ConnectorDraftMutation WithdrawConnectorDraft(
        string projectRoot,
        string draftId,
        DateTimeOffset? now = null) =>
        ConnectorActionDraftStore.Withdraw(projectRoot, draftId, now);
}

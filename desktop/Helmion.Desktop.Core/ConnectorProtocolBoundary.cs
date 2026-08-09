using System.Security.Cryptography;
using System.Text;

namespace Helmion.Desktop.Core;

public sealed record ConnectorOperationDefinition(
    string Id,
    string ConnectorId,
    string Label,
    string DestinationLabel,
    string RequiredCapabilityId,
    bool IsExternalWrite,
    bool RequiresApproval);

public sealed record ConnectorAuthorizationIntent(
    string RequestId,
    string ConnectorId,
    string ProjectEvidenceHash,
    IReadOnlyList<string> RequestedCapabilityIds);

public sealed record ConnectorDispatchIntent(
    string DraftId,
    string ConnectorId,
    string OperationId,
    string Destination,
    string PayloadSha256,
    string ConnectionId,
    string ConnectionAttestationHash,
    string ApprovalId,
    string IdempotencyKey);

public sealed record VerifiedConnectorSession(
    string ConnectorId,
    string ConnectionId,
    string ProjectEvidenceHash,
    IReadOnlyList<string> GrantedCapabilityIds,
    DateTimeOffset VerifiedAtUtc,
    string AttestationEvidenceHash);

public sealed record ConnectorDispatchReceipt(
    string ConnectorId,
    string OperationId,
    string Outcome,
    string? ProviderReceiptId,
    DateTimeOffset CompletedAtUtc,
    string Detail);

public sealed record ConnectorProtocolValidation(
    bool Allowed,
    string Message);

public sealed record ConnectorDraftReviewView(
    string Id,
    string ConnectorLabel,
    string OperationLabel,
    string Destination,
    string BodyPreview,
    string UpdatedLabel,
    string ReviewStateLabel,
    string ReadinessLabel,
    string BlockerSummary,
    bool CanDispatch);

/// <summary>
/// Future service boundary. No implementation exists in the desktop assembly;
/// the renderer cannot begin OAuth, inspect auth state, or call provider APIs.
/// </summary>
public interface IProjectConnectorGateway
{
    Task<ProjectConnectorState> BeginAuthorizationAsync(
        ConnectorAuthorizationIntent intent,
        CancellationToken cancellationToken);

    Task<VerifiedConnectorSession?> QueryStatusAsync(
        string connectorId,
        string projectEvidenceHash,
        CancellationToken cancellationToken);

    Task<ConnectorDispatchReceipt> DispatchApprovedAsync(
        ConnectorDispatchIntent intent,
        CancellationToken cancellationToken);
}

public static class ConnectorOperationCatalog
{
    public static IReadOnlyList<ConnectorOperationDefinition> All { get; } =
    [
        new(
            "slack.post_message",
            ProjectConnectorCatalog.SlackId,
            "Post message",
            "Workspace / channel",
            "slack.messages.post",
            IsExternalWrite: true,
            RequiresApproval: true),
        new(
            "github.create_issue",
            ProjectConnectorCatalog.GitHubId,
            "Create issue",
            "Owner/repository",
            "github.issues.write",
            IsExternalWrite: true,
            RequiresApproval: true),
        new(
            "github.comment",
            ProjectConnectorCatalog.GitHubId,
            "Comment on issue or pull request",
            "Owner/repository#number",
            "github.issues.write",
            IsExternalWrite: true,
            RequiresApproval: true)
    ];

    public static ConnectorOperationDefinition? Find(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase));

    public static IReadOnlyList<ConnectorOperationDefinition> ForConnector(string connectorId) =>
        All.Where(item => string.Equals(
                item.ConnectorId,
                connectorId,
                StringComparison.OrdinalIgnoreCase))
            .ToArray();
}

/// <summary>
/// Pure policy for the later gateway seam. Local drafts contain no approval and
/// cannot cross this boundary. Every external write needs a verified connection,
/// an approval id, an idempotency key, and a matching content hash.
/// </summary>
public static class ConnectorProtocolPolicy
{
    public const int MaxDestinationCharacters = 500;
    public const int MaxDraftBodyCharacters = 50_000;
    public static readonly TimeSpan MaxVerifiedSessionAge = TimeSpan.FromMinutes(5);

    public static ConnectorProtocolValidation ValidateDraftFields(
        string? connectorId,
        string? operationId,
        string? destination,
        string? body)
    {
        var connector = ProjectConnectorCatalog.Find(connectorId);
        if (connector is null)
        {
            return new ConnectorProtocolValidation(false, "Connector must be Slack or GitHub.");
        }

        var operation = ConnectorOperationCatalog.Find(operationId);
        if (operation is null
            || !string.Equals(operation.ConnectorId, connector.Id, StringComparison.OrdinalIgnoreCase))
        {
            return new ConnectorProtocolValidation(
                false,
                "The selected action does not belong to this connector.");
        }

        var normalizedDestination = destination?.Trim() ?? string.Empty;
        if (normalizedDestination.Length == 0)
        {
            return new ConnectorProtocolValidation(false, $"{operation.DestinationLabel} is required.");
        }

        if (normalizedDestination.Length > MaxDestinationCharacters)
        {
            return new ConnectorProtocolValidation(
                false,
                $"Destination exceeds {MaxDestinationCharacters:N0} characters.");
        }

        var normalizedBody = body?.Trim() ?? string.Empty;
        if (normalizedBody.Length == 0)
        {
            return new ConnectorProtocolValidation(false, "Draft content is required.");
        }

        if (normalizedBody.Length > MaxDraftBodyCharacters)
        {
            return new ConnectorProtocolValidation(
                false,
                $"Draft content exceeds {MaxDraftBodyCharacters:N0} characters.");
        }

        return new ConnectorProtocolValidation(
            true,
            "Valid local draft. This is not authorization or permission to send.");
    }

    public static ConnectorDraftReviewView ReviewLocalDraft(
        ConnectorActionDraft draft,
        ProjectConnectorState displayState)
    {
        ArgumentNullException.ThrowIfNull(draft);
        ArgumentNullException.ThrowIfNull(displayState);
        var blockers = new List<string>
        {
            "No Slack/GitHub gateway is installed in this desktop build.",
            "No short-lived connector-service attestation exists.",
            "No real approval has been requested or granted."
        };
        blockers.Add(displayState.Stage switch
        {
            ProjectConnectorStage.AuthorizationPrepared =>
                "The project has local authorization intent only; the provider has not authorized it.",
            ProjectConnectorStage.Connected =>
                "Project JSON says connected, but editable display state is never dispatch authority.",
            _ => "The project has no reported connector authorization."
        });

        return new ConnectorDraftReviewView(
            draft.Id,
            draft.ConnectorLabel,
            draft.OperationLabel,
            draft.Destination,
            draft.BodyPreview,
            draft.UpdatedLabel,
            draft.ReviewStateLabel,
            "NOT READY TO SEND",
            string.Join(" · ", blockers),
            CanDispatch: false);
    }

    public static ConnectorAuthorizationIntent CreateAuthorizationIntent(
        string projectRoot,
        ProjectConnectorState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (state.Stage != ProjectConnectorStage.AuthorizationPrepared
            || string.IsNullOrWhiteSpace(state.AuthorizationRequestId))
        {
            throw new InvalidOperationException(
                "A local authorization request must be prepared before a future gateway can receive intent.");
        }

        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        return new ConnectorAuthorizationIntent(
            state.AuthorizationRequestId,
            state.ConnectorId,
            ProjectEvidenceHash(root),
            state.RequestedCapabilityIds);
    }

    public static ConnectorProtocolValidation ValidateDispatch(
        ConnectorActionDraft draft,
        VerifiedConnectorSession? verifiedSession,
        string projectEvidenceHash,
        string? approvalId,
        string? idempotencyKey,
        DateTimeOffset? now = null)
    {
        ArgumentNullException.ThrowIfNull(draft);
        if (draft.Status != ConnectorActionDraftStatus.Draft)
        {
            return new ConnectorProtocolValidation(false, "Only an active local draft can be dispatched.");
        }

        if (verifiedSession is null)
        {
            return new ConnectorProtocolValidation(
                false,
                "A live connection attestation from the future connector service is required.");
        }

        if (!string.Equals(
                verifiedSession.ProjectEvidenceHash,
                projectEvidenceHash,
                StringComparison.Ordinal))
        {
            return new ConnectorProtocolValidation(
                false,
                "The verified connector session belongs to a different project.");
        }

        if (!string.Equals(
                draft.ConnectorId,
                verifiedSession.ConnectorId,
                StringComparison.OrdinalIgnoreCase))
        {
            return new ConnectorProtocolValidation(false, "Draft and connection belong to different connectors.");
        }

        if (string.IsNullOrWhiteSpace(verifiedSession.ConnectionId)
            || !IsSha256(verifiedSession.AttestationEvidenceHash))
        {
            return new ConnectorProtocolValidation(
                false,
                "The connector service attestation is incomplete.");
        }

        var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var verifiedAt = verifiedSession.VerifiedAtUtc.ToUniversalTime();
        if (verifiedAt > at.AddMinutes(1) || at - verifiedAt > MaxVerifiedSessionAge)
        {
            return new ConnectorProtocolValidation(
                false,
                "The connector service attestation is stale.");
        }

        var operation = ConnectorOperationCatalog.Find(draft.OperationId);
        if (operation is null
            || !string.Equals(
                operation.ConnectorId,
                verifiedSession.ConnectorId,
                StringComparison.OrdinalIgnoreCase))
        {
            return new ConnectorProtocolValidation(false, "Draft operation does not match the connection.");
        }

        if (!verifiedSession.GrantedCapabilityIds.Contains(
                operation.RequiredCapabilityId,
                StringComparer.Ordinal))
        {
            return new ConnectorProtocolValidation(
                false,
                "The verified connection does not report the required capability.");
        }

        if (operation.RequiresApproval && string.IsNullOrWhiteSpace(approvalId))
        {
            return new ConnectorProtocolValidation(
                false,
                "This external write requires a real approval id.");
        }

        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return new ConnectorProtocolValidation(
                false,
                "An idempotency key is required before an external write.");
        }

        return new ConnectorProtocolValidation(
            true,
            "Dispatch contract is complete. A separate gateway implementation is still required.");
    }

    public static ConnectorDispatchIntent CreateDispatchIntent(
        ConnectorActionDraft draft,
        VerifiedConnectorSession verifiedSession,
        string projectEvidenceHash,
        string approvalId,
        string idempotencyKey,
        DateTimeOffset? now = null)
    {
        var validation = ValidateDispatch(
            draft,
            verifiedSession,
            projectEvidenceHash,
            approvalId,
            idempotencyKey,
            now);
        if (!validation.Allowed)
        {
            throw new InvalidOperationException(validation.Message);
        }

        return new ConnectorDispatchIntent(
            draft.Id,
            draft.ConnectorId,
            draft.OperationId,
            draft.Destination,
            draft.PayloadSha256,
            verifiedSession.ConnectionId,
            verifiedSession.AttestationEvidenceHash,
            approvalId.Trim(),
            idempotencyKey.Trim());
    }

    public static string CreateProjectEvidenceHash(string projectRoot)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        return ProjectEvidenceHash(root);
    }

    private static bool IsSha256(string? value) =>
        value?.Length == 64 && value.All(Uri.IsHexDigit);

    private static string ProjectEvidenceHash(string root) =>
        Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant())));
}

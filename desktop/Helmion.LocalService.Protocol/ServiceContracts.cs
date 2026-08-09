namespace Helmion.LocalService.Protocol;

public static class ReadOnlyServiceContract
{
    public const int ProtocolVersion = 2;
    public const string HelloCommand = "hello";
    public const string InspectWorkspaceCommand = "workspace.inspect";
    public const string DetectCapabilitiesCommand = "capabilities.detect";
    public const string ProvisionSchemaCommand = "schema.provision";
    public const string RemoteStatusCommand = "remote.status";
    public const string RemoteEnrollCommand = "remote.enrollment.request";
    public const string RemoteRedeemCommand = "remote.enrollment.redeem";
    public const string RemoteSessionPublishCommand = "remote.session.publish";
    public const string RemoteSessionClearCommand = "remote.session.clear";
    public const string ArtifactProviderStatusCommand = "artifact.provider.status";
    public const string GenerateApprovedArtifactCommand = "artifact.generate-approved";
    public const int MaximumMessageBytes = 1024 * 1024;
}

public sealed record PipeRequest(
    string Id,
    string Command,
    string? WorkspacePath = null,
    string? DatabaseUrl = null,
    string? EndpointId = null,
    TeamConnectorPipeInput? TeamConnector = null,
    string? InstallationId = null,
    string? DesktopDisplayName = null,
    RemoteSelectedSessionMetadata? RemoteSession = null,
    string? ArtifactRequestId = null,
    string? EvidenceHash = null);

public sealed record PipeResponse(
    string Id,
    bool Ok,
    string? ErrorCode = null,
    string? ErrorMessage = null,
    ServiceHello? Hello = null,
    WorkspaceInspection? Workspace = null,
    IReadOnlyList<LocalCapability>? Capabilities = null,
    SchemaProvisioningResult? SchemaProvisioning = null,
    TeamConnectionState? TeamConnection = null,
    TeamAuthorizationLaunch? TeamAuthorization = null,
    TeamConversationSnapshot? TeamConversation = null,
    RemoteControlLocalStatus? RemoteControl = null,
    RemoteEnrollmentChallenge? EnrollmentChallenge = null,
    ArtifactProviderStatus? ArtifactProvider = null,
    ArtifactGenerationResult? ArtifactGeneration = null);

public sealed record ServiceHello(
    int ProtocolVersion,
    string Mode,
    string Authentication,
    IReadOnlyList<string> Capabilities,
    bool WritesEnabled);

public sealed record LocalCapability(
    string Id,
    string DisplayName,
    bool Available,
    string Status,
    string DetectionMethod);

public sealed record MigrationSourceItem(
    string Version,
    string Name,
    string Sha256,
    long SizeBytes);

public sealed record EvidenceInventoryItem(
    string Kind,
    string Name,
    string Detail,
    string Source);

public sealed record LeasePosture(
    string Status,
    string Label,
    string Detail,
    bool IsLive);

public sealed record WorkspaceInspection(
    string ProjectName,
    string ProjectPath,
    string Branch,
    bool HelmionConfigPresent,
    bool LooksLikeHelmionWorkspace,
    LeasePosture Lease,
    IReadOnlyList<MigrationSourceItem> Migrations,
    IReadOnlyList<EvidenceInventoryItem> Evidence,
    string MigrationStateLabel,
    string EvidenceStateLabel,
    DateTimeOffset InspectedAt,
    bool ProjectWasModified);

public sealed record SchemaProvisioningResult(
    bool Success,
    int MigrationCount,
    string? ErrorMessage);

public sealed record ArtifactProviderStatus(
    string ProviderId,
    string ProviderName,
    string ProviderInterface,
    string Model,
    bool CredentialConfigured,
    bool AdapterInstalled,
    string CredentialCustody,
    string StatusDetail,
    IReadOnlyList<MediaProviderCapabilityStatus> Capabilities);

public static class MediaProviderCapabilityKinds
{
    public const string ImageGeneration = "image-generation";
    public const string VideoGeneration = "video-generation";

    public static IReadOnlyList<string> All { get; } =
        [ImageGeneration, VideoGeneration];
}

public static class MediaProviderAvailability
{
    public const string Available = "available";
    public const string ConfigurationRequired = "configuration-required";
    public const string ConfiguredNotTested = "configured-not-tested";
    public const string ProviderNotSelected = "provider-not-selected";
    public const string Unavailable = "unavailable";

    public static IReadOnlyList<string> All { get; } =
    [
        Available,
        ConfigurationRequired,
        ConfiguredNotTested,
        ProviderNotSelected,
        Unavailable
    ];
}

/// <summary>
/// One image or video generation lane. Chat providers intentionally do not use
/// this contract. ProviderAvailable means a provider test supplied positive
/// evidence; installed code or a stored credential alone never implies it.
/// </summary>
public sealed record MediaProviderCapabilityStatus(
    string Kind,
    string Label,
    string? ProviderId,
    string? ProviderName,
    string? ProviderInterface,
    string? Model,
    bool AdapterInstalled,
    bool CredentialConfigured,
    bool ProviderAccessTested,
    bool ProviderAvailable,
    bool ApprovalRequired,
    string ApprovalPolicy,
    string CostPolicy,
    string Availability,
    string StatusDetail)
{
    public bool CanAttemptAfterApproval =>
        ProviderId is not null && AdapterInstalled && CredentialConfigured && ApprovalRequired;
}

public static class MediaProviderCapabilityValidation
{
    public static IReadOnlyList<MediaProviderCapabilityStatus> Validate(
        IReadOnlyList<MediaProviderCapabilityStatus> capabilities)
    {
        ArgumentNullException.ThrowIfNull(capabilities);
        if (capabilities.Count != MediaProviderCapabilityKinds.All.Count)
        {
            throw new InvalidDataException("Media provider status must report image and video separately.");
        }

        var remainingKinds = new HashSet<string>(
            MediaProviderCapabilityKinds.All,
            StringComparer.Ordinal);
        foreach (var capability in capabilities)
        {
            if (!remainingKinds.Remove(capability.Kind)
                || string.IsNullOrWhiteSpace(capability.Label)
                || string.IsNullOrWhiteSpace(capability.ApprovalPolicy)
                || string.IsNullOrWhiteSpace(capability.CostPolicy)
                || string.IsNullOrWhiteSpace(capability.StatusDetail)
                || !MediaProviderAvailability.All.Contains(
                    capability.Availability,
                    StringComparer.Ordinal))
            {
                throw new InvalidDataException("Media provider capability status is invalid.");
            }

            if (!capability.ApprovalRequired)
            {
                throw new InvalidDataException("Image and video provider calls must require explicit approval.");
            }

            if (capability.ProviderAvailable
                && (!capability.ProviderAccessTested
                    || !capability.AdapterInstalled
                    || !capability.CredentialConfigured
                    || capability.Availability != MediaProviderAvailability.Available))
            {
                throw new InvalidDataException("Media provider availability requires positive provider-test evidence.");
            }

            switch (capability.Availability)
            {
                case MediaProviderAvailability.Available
                    when !capability.ProviderAvailable:
                    throw new InvalidDataException("Available media status requires positive provider-test evidence.");
                case MediaProviderAvailability.ConfiguredNotTested
                    when !capability.AdapterInstalled
                         || !capability.CredentialConfigured
                         || capability.ProviderAccessTested
                         || capability.ProviderAvailable:
                    throw new InvalidDataException("Configured-not-tested media status is inconsistent.");
                case MediaProviderAvailability.ConfigurationRequired
                    when !capability.AdapterInstalled
                         || capability.CredentialConfigured
                         || capability.ProviderAccessTested
                         || capability.ProviderAvailable:
                    throw new InvalidDataException("Configuration-required media status is inconsistent.");
                case MediaProviderAvailability.Unavailable
                    when capability.ProviderAvailable:
                    throw new InvalidDataException("Unavailable media status cannot claim provider availability.");
            }

            if (!capability.AdapterInstalled && capability.CredentialConfigured)
            {
                throw new InvalidDataException("A media credential cannot be ready without its local adapter.");
            }

            if (capability.ProviderId is null)
            {
                if (capability.ProviderName is not null
                    || capability.ProviderInterface is not null
                    || capability.Model is not null
                    || capability.AdapterInstalled
                    || capability.CredentialConfigured
                    || capability.ProviderAccessTested
                    || capability.ProviderAvailable
                    || capability.Availability != MediaProviderAvailability.ProviderNotSelected)
                {
                    throw new InvalidDataException("An unselected media provider cannot claim provider readiness.");
                }
            }
            else if (string.IsNullOrWhiteSpace(capability.ProviderName)
                     || string.IsNullOrWhiteSpace(capability.ProviderInterface)
                     || string.IsNullOrWhiteSpace(capability.Model))
            {
                throw new InvalidDataException("A selected media provider requires a complete redacted identity.");
            }
        }

        if (remainingKinds.Count != 0)
        {
            throw new InvalidDataException("Media provider status omitted a required capability.");
        }
        return capabilities;
    }
}

public sealed record ArtifactGenerationResult(
    string RequestId,
    string ApprovalState,
    string DeliveryState,
    string StatusDetail,
    string Destination,
    string EvidenceHash,
    string? ArtifactSha256,
    string? ProviderRequestId,
    string? ProviderModel,
    string? ContentType,
    long? SizeBytes);

public sealed record ApprovedArtifactGenerationRequest(
    string Id,
    string ProviderId,
    string Kind,
    string Instructions,
    string Destination,
    string EvidenceHash);

public sealed record ArtifactStudioDelivery(
    string FileName,
    string ContentType,
    byte[] Bytes,
    string? ProviderRequestId = null,
    string? ProviderModel = null);

/// <summary>
/// Trusted provider seam. Implementations execute only in the Helmion Local
/// Service and receive an approved, credential-free request.
/// </summary>
public interface IArtifactStudioProviderAdapter
{
    string ProviderId { get; }
    bool IsConfigured { get; }
    bool Supports(string kind);
    Task<ArtifactStudioDelivery> GenerateAsync(
        ApprovedArtifactGenerationRequest request,
        CancellationToken cancellationToken);
}

public interface IArtifactGenerationService
{
    Task<ArtifactProviderStatus> GetProviderStatusAsync(
        CancellationToken cancellationToken);

    Task<ArtifactGenerationResult> GenerateApprovedAsync(
        string projectRoot,
        string requestId,
        string evidenceHash,
        CancellationToken cancellationToken);
}

public sealed record RemoteControlLocalStatus(
    RemoteDesktopEnrollmentDescriptor Enrollment,
    string SchedulerState,
    string RealtimeState,
    string Detail,
    DateTimeOffset UpdatedAtUtc,
    int ConsecutiveFailures,
    DateTimeOffset? NextAttemptAtUtc,
    string? SelectedSessionId);

public interface IRemoteControlLocalCommands : IAsyncDisposable
{
    Task<RemoteControlLocalStatus> GetStatusAsync(CancellationToken cancellationToken);
    Task<(RemoteControlLocalStatus Status, RemoteEnrollmentChallenge Challenge)> RequestEnrollmentAsync(
        string installationId, string desktopDisplayName, CancellationToken cancellationToken);
    Task<RemoteControlLocalStatus> RedeemEnrollmentAsync(CancellationToken cancellationToken);
    Task<RemoteControlLocalStatus> PublishSessionAsync(
        RemoteSelectedSessionMetadata session, CancellationToken cancellationToken);
    Task<RemoteControlLocalStatus> ClearSessionAsync(CancellationToken cancellationToken);
}

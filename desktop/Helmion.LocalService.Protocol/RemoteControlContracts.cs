using System.Text.Json.Serialization;

namespace Helmion.LocalService.Protocol;

/// <summary>
/// Canonical v1 web routes required by the account-owned Remote Control desktop.
/// The older /api/herald-* paths are compatibility aliases and are deliberately
/// not used by the desktop contract.
/// </summary>
public static class RemoteControlApiRoutes
{
    public const string ContractVersion = "v1";
    public const string Enrollment = "/api/remote/v1/enrollment";
    public const string RegisteredDesktop = "/api/remote/v1/desktop";
    public const string AccountDesktopRegistry = "/api/remote/v1/desktops";
    public const string Control = "/api/remote/v1/control";
    public const string ControlToken = "/api/remote/v1/control-token";
    public const string DesktopRealtimeToken = "/api/remote/v1/desktop-token";
    public const string NonceHeader = "x-helmian-nonce";

    public const string RequestEnrollmentAction = "request";
    public const string ConfirmEnrollmentAction = "confirm";
    public const string RedeemEnrollmentAction = "redeem";
    public const string StatusAction = "status";
    public const string HeartbeatAction = "heartbeat";
    public const string StopSessionAction = "stop-session";
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteEnrollmentStage>))]
public enum RemoteEnrollmentStage
{
    Unenrolled,
    Requesting,
    AwaitingAccountConfirmation,
    Redeeming,
    Enrolled,
    Revoking,
    Revoked,
    Expired,
    Denied,
    Failed
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteEnrollmentRedemptionStatus>))]
public enum RemoteEnrollmentRedemptionStatus
{
    PendingAccountConfirmation,
    Redeemed,
    Denied,
    Expired
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteDesktopPresenceState>))]
public enum RemoteDesktopPresenceState
{
    Online,
    Offline,
    Revoked
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteSelectedSessionLifecycle>))]
public enum RemoteSelectedSessionLifecycle
{
    Registering,
    Online,
    Updating,
    Revoking,
    Revoked,
    Offline
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteSessionActivityState>))]
public enum RemoteSessionActivityState
{
    Ready,
    Working,
    Unavailable
}

[JsonConverter(typeof(JsonStringEnumConverter<RemoteGuardState>))]
public enum RemoteGuardState
{
    Unknown,
    Normal,
    Warning,
    Critical
}

public sealed record RemoteEnrollmentRequest(
    string InstallationId,
    string DesktopDisplayName,
    string ContractVersion);

/// <summary>
/// The nonce is a one-time proof held in memory only until redemption. It must
/// never be persisted in desktop settings, logs, a project, or the PWA.
/// </summary>
public sealed record RemoteEnrollmentRequestResponse(
    string EnrollmentRequestId,
    string UserCode,
    string VerificationUri,
    byte[] RedemptionNonce,
    DateTimeOffset ExpiresAtUtc);

public sealed record RemoteEnrollmentRedemptionRequest(
    string EnrollmentRequestId,
    string InstallationId,
    byte[] RedemptionNonce,
    string ContractVersion);

public sealed record RemoteDesktopCredentialGrant(
    string InstallationId,
    string DesktopId,
    byte[] BearerCredential,
    DateTimeOffset IssuedAtUtc,
    DateTimeOffset ExpiresAtUtc);

public sealed record RemoteEnrollmentRedemptionResponse(
    RemoteEnrollmentRedemptionStatus Status,
    RemoteDesktopCredentialGrant? Grant,
    string Detail);

/// <summary>
/// Redacted enrollment state safe for renderer/UI/status use. It never contains
/// the redemption nonce or bearer credential. AccountOwned becomes true only
/// after a successful redemption has also been stored by the desktop boundary.
/// </summary>
public sealed record RemoteDesktopEnrollmentDescriptor(
    RemoteEnrollmentStage Stage,
    string? InstallationId,
    string? EnrollmentRequestId,
    string? DesktopId,
    DateTimeOffset? ExpiresAtUtc,
    string Detail,
    DateTimeOffset UpdatedAtUtc)
{
    public bool AccountOwned => Stage == RemoteEnrollmentStage.Enrolled
        && !string.IsNullOrWhiteSpace(DesktopId);

    public static RemoteDesktopEnrollmentDescriptor Unenrolled(DateTimeOffset at) => new(
        RemoteEnrollmentStage.Unenrolled,
        null,
        null,
        null,
        null,
        "This desktop is not enrolled to an account.",
        at.ToUniversalTime());
}

public sealed record RemoteEnrollmentChallenge(
    string EnrollmentRequestId,
    string UserCode,
    string VerificationUri,
    DateTimeOffset ExpiresAtUtc);

public sealed record RemoteEnrollmentStartResult(
    RemoteDesktopEnrollmentDescriptor State,
    RemoteEnrollmentChallenge Challenge);

public sealed record RemoteDesktopAuthentication(
    string DesktopId,
    byte[] BearerCredential);

public sealed record RemoteSelectedSessionMetadata(
    string ProjectId,
    string ProjectDisplayName,
    string SessionId,
    string SessionDisplayName,
    string AgentId,
    string AgentDisplayName,
    RemoteSessionActivityState ActivityState,
    RemoteGuardState GuardState,
    int PendingApprovalCount,
    DateTimeOffset SessionStartedAtUtc);

public sealed record RemoteSelectedSessionSnapshot(
    string ProjectId,
    string ProjectDisplayName,
    string SessionId,
    string SessionDisplayName,
    string AgentId,
    string AgentDisplayName,
    RemoteSessionActivityState ActivityState,
    RemoteGuardState GuardState,
    int PendingApprovalCount,
    DateTimeOffset SessionStartedAtUtc,
    RemoteSelectedSessionLifecycle Lifecycle,
    long Revision,
    string? ServerRegistrationId,
    DateTimeOffset UpdatedAtUtc)
{
    public bool RemotelySelectable =>
        Lifecycle == RemoteSelectedSessionLifecycle.Online
        && !string.IsNullOrWhiteSpace(ServerRegistrationId);
}

/// <summary>
/// Sanitized heartbeat payload. No transcript, instruction, approval summary,
/// workspace path, machine username, provider credential, bearer token, Clerk
/// value, environment setting, tool payload, or file content can be represented.
/// </summary>
public sealed record RemoteDesktopPresenceSnapshot(
    int SchemaVersion,
    string ContractVersion,
    string DesktopId,
    string InstallationId,
    string DesktopDisplayName,
    string AppVersion,
    RemoteDesktopPresenceState State,
    RemoteSelectedSessionSnapshot? SelectedSession,
    DateTimeOffset CapturedAtUtc);

public sealed record RemoteControlPlaneAcknowledgement(
    bool Accepted,
    long ServerRevision,
    string? ServerRegistrationId,
    string Detail,
    DateTimeOffset RecordedAtUtc);

/// <summary>
/// Exact current web-worker wire shapes. ProofSecret, RegistrationToken and
/// request nonces are service-memory values and are never renderer-safe state.
/// </summary>
public sealed record RemoteEnrollmentWireRequest(
    string Action,
    string EnrollmentId,
    string ProofSecret,
    string ConfirmationCode,
    string DisplayName);

public sealed record RemoteEnrollmentWireRedemptionRequest(
    string Action,
    string EnrollmentId,
    string ProofSecret);

public sealed record RemoteEnrollmentWirePendingResponse(
    bool Pending,
    string EnrollmentId,
    DateTimeOffset ExpiresAt,
    bool ConfirmationRequired);

public sealed record RemoteEnrollmentWireRedeemedResponse(
    bool Enrolled,
    string DesktopId,
    string DisplayName,
    string RegistrationToken,
    DateTimeOffset CredentialExpiresAt);

public sealed record RemoteHeartbeatProject(string Id, string Name);
public sealed record RemoteHeartbeatAgent(string Id, string Name, string State);
public sealed record RemoteHeartbeatGuard(string State, string? Detail);

public sealed record RemoteHeartbeatSession(
    string SessionId,
    RemoteHeartbeatProject Project,
    string SessionName,
    string State,
    RemoteHeartbeatAgent Agent,
    RemoteHeartbeatGuard Guard);

public sealed record RemoteRegisteredDesktopHeartbeatRequest(
    string Action,
    string DesktopId,
    RemoteHeartbeatSession Session);

public sealed record RemoteRegisteredDesktopStopSessionRequest(
    string Action,
    string DesktopId,
    string SessionId);

public sealed record RemoteRegisteredDesktopStatusRequest(
    string Action,
    string DesktopId);

public sealed record RemoteRegisteredDesktopStatusResponse(
    bool Registered,
    string DesktopId,
    DateTimeOffset CredentialExpiresAt,
    DateTimeOffset ServerTime);

public sealed record RemoteHeartbeatSessionResponse(
    string SessionId,
    RemoteHeartbeatProject Project,
    string Name,
    string State,
    RemoteHeartbeatAgent? Agent,
    RemoteHeartbeatGuard Guard,
    DateTimeOffset LastSeenAt,
    DateTimeOffset ExpiresAt);

public sealed record RemoteRegisteredDesktopHeartbeatResponse(
    bool Registered,
    string DesktopId,
    RemoteHeartbeatSessionResponse Session,
    DateTimeOffset NextHeartbeatBefore);

public sealed record RemoteRegisteredDesktopStopSessionResponse(
    bool Stopped,
    string DesktopId,
    string SessionId);

public sealed record RemoteDesktopTokenRequest(
    string DesktopId,
    string SessionId);

public sealed record RemoteAblyTokenRequest(
    string KeyName, long Ttl, string Capability, string ClientId,
    long Timestamp, string Nonce, string Mac);

public sealed record RemoteDesktopRealtimeChannels(
    string Requests,
    IReadOnlyList<string> Results);

public sealed record RemoteDesktopRealtimeGrant(
    string Provider,
    string Role,
    bool Realtime,
    RemoteAblyTokenRequest TokenRequest,
    RemoteDesktopRealtimeChannels Channels,
    DateTimeOffset ExpiresAt);

public sealed record RemoteControlRequestEnvelope(
    int V, string Product, string Kind, string RequestId, string Action,
    string DeviceId, System.Text.Json.JsonElement Payload);

public sealed record RemoteControlResultEnvelope(
    int V, string Product, string Kind, string RequestId, string Action,
    string DeviceId, string State, System.Text.Json.JsonElement Payload);

public sealed record RemoteControlApiErrorResponse(
    string? Error,
    string? Message);

/// <summary>
/// Account-control-plane transport seam. A future HTTP adapter belongs behind
/// the local-service boundary. There is no implementation or endpoint call in
/// the desktop renderer.
/// </summary>
public interface IRemoteControlEnrollmentApi
{
    Task<RemoteEnrollmentRequestResponse> RequestEnrollmentAsync(
        RemoteEnrollmentRequest request,
        CancellationToken cancellationToken);

    Task<RemoteEnrollmentRedemptionResponse> RedeemEnrollmentAsync(
        RemoteEnrollmentRedemptionRequest request,
        CancellationToken cancellationToken);

}

public interface IRemoteControlPresenceApi
{
    Task<RemoteRegisteredDesktopStatusResponse> ObserveStatusAsync(
        RemoteDesktopAuthentication authentication,
        CancellationToken cancellationToken);

    Task<RemoteRegisteredDesktopHeartbeatResponse> PublishHeartbeatAsync(
        RemoteDesktopAuthentication authentication,
        RemoteRegisteredDesktopHeartbeatRequest request,
        CancellationToken cancellationToken);

    Task<RemoteRegisteredDesktopStopSessionResponse> StopSelectedSessionAsync(
        RemoteDesktopAuthentication authentication,
        RemoteRegisteredDesktopStopSessionRequest request,
        CancellationToken cancellationToken);
}

public interface IRemoteControlRealtimeTokenApi
{
    Task<RemoteDesktopRealtimeGrant> RequestDesktopTokenAsync(
        RemoteDesktopAuthentication authentication,
        RemoteDesktopTokenRequest request,
        CancellationToken cancellationToken);
}

public interface IRemoteControlRealtimeClient : IAsyncDisposable
{
    string State { get; }

    Task RunAsync(
        RemoteDesktopRealtimeGrant grant,
        Func<RemoteControlRequestEnvelope, CancellationToken, Task<RemoteControlResultEnvelope>> dispatch,
        CancellationToken cancellationToken);
}

/// <summary>
/// Credential custody seam. Implementations must protect the bearer credential
/// for the current user and return only a redacted descriptor to renderer code.
/// </summary>
public interface IRemoteDesktopCredentialStore
{
    Task<RemoteDesktopEnrollmentDescriptor> ReadDescriptorAsync(
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> SaveRedeemedGrantAsync(
        RemoteDesktopCredentialGrant grant,
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopAuthentication> LoadAuthenticationForServiceAsync(
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> MarkRevocationPendingAsync(
        string desktopId,
        DateTimeOffset requestedAtUtc,
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> RemoveAfterServerRevocationAsync(
        string desktopId,
        DateTimeOffset confirmedAtUtc,
        CancellationToken cancellationToken = default);
}

public interface IRemoteDesktopEnrollmentClient
{
    RemoteDesktopEnrollmentDescriptor Current { get; }

    Task<RemoteDesktopEnrollmentDescriptor> InitializeAsync(
        CancellationToken cancellationToken = default);

    Task<RemoteEnrollmentStartResult> RequestEnrollmentAsync(
        string installationId,
        string desktopDisplayName,
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> RedeemEnrollmentAsync(
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> ObserveRegistrationAsync(
        IRemoteControlPresenceApi presenceApi,
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> BeginRevocationAsync(
        string reason,
        CancellationToken cancellationToken = default);

    Task<RemoteDesktopEnrollmentDescriptor> ConfirmServerRevocationAsync(
        string desktopId,
        DateTimeOffset confirmedAtUtc,
        CancellationToken cancellationToken = default);
}

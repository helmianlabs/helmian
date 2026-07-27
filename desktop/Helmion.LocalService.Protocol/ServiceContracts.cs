namespace Helmion.LocalService.Protocol;

public static class ReadOnlyServiceContract
{
    public const int ProtocolVersion = 1;
    public const string HelloCommand = "hello";
    public const string InspectWorkspaceCommand = "workspace.inspect";
    public const string DetectCapabilitiesCommand = "capabilities.detect";
    public const int MaximumMessageBytes = 1024 * 1024;
}

public sealed record PipeRequest(
    string Id,
    string Command,
    string? WorkspacePath = null);

public sealed record PipeResponse(
    string Id,
    bool Ok,
    string? ErrorCode = null,
    string? ErrorMessage = null,
    ServiceHello? Hello = null,
    WorkspaceInspection? Workspace = null,
    IReadOnlyList<LocalCapability>? Capabilities = null);

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

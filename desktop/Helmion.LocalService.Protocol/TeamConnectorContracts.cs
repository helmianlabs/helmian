namespace Helmion.LocalService.Protocol;

public static class TeamConnectorContract
{
    public const int Version = 1;
    public const string SlackProviderId = "slack";
    public const string DiscordProviderId = "discord";
    public const string GitHubProviderId = "github";
    /// <summary>Local Helmian Room (no cloud provider).</summary>
    public const string HelmianRoomProviderId = "helmian";
    public const string StatusCommand = "team.connection.status";
    public const string BeginAuthorizationCommand = "team.connection.begin";
    public const string ReadConversationCommand = "team.conversation.read";

    public static IReadOnlyList<string> ProviderIds { get; } =
        [SlackProviderId, DiscordProviderId, GitHubProviderId];

    public static IReadOnlyList<TeamOperationDefinition> Operations { get; } =
    [
        new("team.sources.read", TeamOperationAccess.Read, RequiresApproval: false),
        new("team.messages.read", TeamOperationAccess.Read, RequiresApproval: false),
        new("team.messages.send", TeamOperationAccess.ExternalWrite, RequiresApproval: true)
    ];

    public static void RequireProvider(string? providerId)
    {
        if (!ProviderIds.Contains(providerId ?? string.Empty, StringComparer.Ordinal))
        {
            throw new ArgumentException("Team provider must be Slack, Discord, or GitHub.", nameof(providerId));
        }
    }

    public static string LabelFor(string? providerId) => providerId switch
    {
        SlackProviderId => "Slack",
        DiscordProviderId => "Discord",
        GitHubProviderId => "GitHub",
        HelmianRoomProviderId => "Helmian",
        _ => providerId ?? "Team"
    };
}

public enum TeamOperationAccess
{
    Read,
    ExternalWrite
}

public enum TeamConnectStage
{
    NotConfigured,
    ReadyToAuthorize,
    AwaitingCallback,
    Connected,
    AuthorizationFailed,
    CredentialExpired
}

public enum TeamScopeKind
{
    Workspace,
    Server
}

public sealed record TeamOperationDefinition(
    string Id,
    TeamOperationAccess Access,
    bool RequiresApproval);

public sealed record TeamConnectorAccount(
    string ProviderId,
    string AccountId,
    string DisplayLabel);

public sealed record TeamScope(
    string ProviderId,
    string Id,
    string DisplayLabel,
    TeamScopeKind Kind)
{
    public string ProviderLabel => TeamConnectorContract.LabelFor(ProviderId);
    public string PickerLabel => $"{ProviderLabel} · {DisplayLabel}";

    /// <summary>1–2 letter glyph for Discord-style server rail circles (never the full name).</summary>
    public string RailInitials
    {
        get
        {
            var s = (DisplayLabel ?? string.Empty).Trim();
            if (s.Length == 0) return "?";
            var parts = s.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length >= 2
                && parts[0].Length > 0
                && parts[1].Length > 0)
            {
                return string.Concat(char.ToUpperInvariant(parts[0][0]), char.ToUpperInvariant(parts[1][0]));
            }

            return s.Length >= 2
                ? s[..2].ToUpperInvariant()
                : s.ToUpperInvariant();
        }
    }
}

public sealed record TeamChannel(
    string ProviderId,
    string ScopeId,
    string Id,
    string DisplayLabel,
    bool CanRead,
    bool CanSend)
{
    public string PickerLabel => DisplayLabel.StartsWith('#')
        ? DisplayLabel
        : $"# {DisplayLabel}";
}

public sealed record TeamMessage(
    string ProviderId,
    string ScopeId,
    string ChannelId,
    string Id,
    string AuthorId,
    string AuthorDisplayLabel,
    string Body,
    DateTimeOffset SentAtUtc,
    string? ThreadId,
    string? ProviderLink)
{
    public string ProviderLabel => TeamConnectorContract.LabelFor(ProviderId).ToUpperInvariant();
    public string TimeLabel => SentAtUtc.ToLocalTime().ToString("g");

    /// <summary>Single letter for Discord-style message avatars.</summary>
    public string AuthorInitials
    {
        get
        {
            var s = (AuthorDisplayLabel ?? "?").Trim();
            return s.Length == 0 ? "?" : char.ToUpperInvariant(s[0]).ToString();
        }
    }
}

public sealed record TeamConnectionState(
    int Version,
    string ProviderId,
    TeamConnectStage Stage,
    bool AuthorizationConfigured,
    bool ReadConfigured,
    TeamConnectorAccount? Account,
    IReadOnlyList<string> GrantedOperationIds,
    DateTimeOffset? UpdatedAtUtc,
    string Detail,
    string? ErrorCode = null,
    IReadOnlyList<string>? SetupSteps = null)
{
    public bool IsConnected => Stage == TeamConnectStage.Connected;
    public IReadOnlyList<string> ResolvedSetupSteps => SetupSteps ?? [];
}

public sealed record TeamAuthorizationLaunch(
    TeamConnectionState Connection,
    string? AuthorizationUri,
    DateTimeOffset? ExpiresAtUtc);

public sealed record TeamConversationSnapshot(
    int Version,
    IReadOnlyList<TeamConnectionState> Connections,
    IReadOnlyList<TeamScope> Scopes,
    IReadOnlyList<TeamChannel> Channels,
    IReadOnlyList<TeamMessage> Messages,
    string? SelectedProviderId,
    string? SelectedScopeId,
    string? SelectedChannelId,
    DateTimeOffset ReadAtUtc,
    bool ProviderReadAttempted,
    string Detail);

public sealed record TeamConnectorPipeInput(
    string? ProviderId = null,
    string? ScopeId = null,
    string? ChannelId = null);

public sealed record TeamExternalWriteIntent(
    string ProviderId,
    string ScopeId,
    string ChannelId,
    string DraftId,
    string PayloadSha256,
    string ApprovalId,
    string IdempotencyKey);

public static class TeamExternalWritePolicy
{
    public static void Validate(TeamExternalWriteIntent intent)
    {
        ArgumentNullException.ThrowIfNull(intent);
        TeamConnectorContract.RequireProvider(intent.ProviderId);
        if (string.IsNullOrWhiteSpace(intent.ScopeId)
            || string.IsNullOrWhiteSpace(intent.ChannelId)
            || string.IsNullOrWhiteSpace(intent.DraftId)
            || string.IsNullOrWhiteSpace(intent.ApprovalId)
            || string.IsNullOrWhiteSpace(intent.IdempotencyKey)
            || intent.PayloadSha256.Length != 64
            || !intent.PayloadSha256.All(Uri.IsHexDigit))
        {
            throw new InvalidDataException(
                "Team external writes require an exact destination, local draft, payload hash, approval, and idempotency key.");
        }
    }
}

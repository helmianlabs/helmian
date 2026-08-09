using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

public enum ProjectConnectorStage
{
    NotConfigured,
    AuthorizationPrepared,
    Connected,
    ConnectionError,
    Revoked
}

public enum ConnectorCapabilityAccess
{
    Read,
    ExternalWrite
}

public sealed record ConnectorCapabilityDefinition(
    string Id,
    string Label,
    ConnectorCapabilityAccess Access,
    bool RequiresApproval);

public sealed record ProjectConnectorDefinition(
    string Id,
    string Name,
    string Description,
    string AuthorizationOwner,
    IReadOnlyList<ConnectorCapabilityDefinition> Capabilities);

public sealed record ProjectConnectorState(
    string ConnectorId,
    ProjectConnectorStage Stage,
    string? AuthorizationRequestId,
    IReadOnlyList<string> RequestedCapabilityIds,
    string? ConnectionId,
    string? ExternalAccountLabel,
    DateTimeOffset? UpdatedAtUtc,
    string Detail);

public sealed record ProjectConnectorView(
    string Id,
    string Name,
    string Description,
    string ConnectionLabel,
    string AuthorizationLabel,
    string Detail,
    string CapabilitySummary,
    string Boundary,
    string PrimaryActionLabel,
    bool PrimaryActionEnabled);

public sealed record ConnectorAuditEntry(
    string Id,
    DateTimeOffset AtUtc,
    string ConnectorId,
    string EventType,
    string Outcome,
    string Detail,
    string EvidenceHash,
    string? ProjectActivityId)
{
    public string ConnectorLabel => ProjectConnectorCatalog.Find(ConnectorId)?.Name ?? ConnectorId;
    public string TimeLabel => AtUtc.ToLocalTime().ToString("g");
    public string EventLabel => EventType.Replace('_', ' ').ToUpperInvariant();
}

public sealed record ProjectConnectorMutation(
    ProjectConnectorState State,
    ConnectorAuditEntry Audit,
    ProjectActivityEntry Activity);

public static class ProjectConnectorCatalog
{
    public const string SlackId = "slack";
    public const string GitHubId = "github";

    public static IReadOnlyList<ProjectConnectorDefinition> All { get; } =
    [
        new(
            SlackId,
            "Slack",
            "Future workspace/channel reads and explicitly approved message posts.",
            "A future service-owned Slack OAuth grant; never a token field in this desktop.",
            [
                new("slack.channels.read", "Read selected workspace/channel identity", ConnectorCapabilityAccess.Read, false),
                new("slack.messages.post", "Post an approved message draft", ConnectorCapabilityAccess.ExternalWrite, true)
            ]),
        new(
            GitHubId,
            "GitHub",
            "Future repository, issue, pull-request, and review operations.",
            "A future service-owned GitHub authorization; existing CLI/browser auth is not reused.",
            [
                new("github.repositories.read", "Read selected repository metadata", ConnectorCapabilityAccess.Read, false),
                new("github.issues.read", "Read issues and pull requests", ConnectorCapabilityAccess.Read, false),
                new("github.issues.write", "Create an approved issue or comment", ConnectorCapabilityAccess.ExternalWrite, true)
            ])
    ];

    public static ProjectConnectorDefinition? Find(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// Project-local connector posture. This store deliberately has no credential,
/// token, OAuth code, browser-session, API-client, or network surface. Preparing
/// authorization records intent only; it does not begin an authorization flow.
/// Its editable JSON is display/audit posture, never dispatch authority; the
/// protocol requires a separate short-lived service attestation.
/// </summary>
public static class ProjectConnectorStore
{
    public const int StateVersion = 1;
    public const string StateRelativePath = ".helmion/connectors/state.json";
    public const string AuditRelativePath = ".helmion/audit/connectors.jsonl";

    private static readonly object WriteGate = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private static readonly JsonSerializerOptions JsonLineOptions = new(JsonOptions)
    {
        WriteIndented = false
    };

    public static IReadOnlyList<ProjectConnectorView> GetViews(string projectRoot)
    {
        var states = LoadStates(projectRoot)
            .ToDictionary(item => item.ConnectorId, StringComparer.OrdinalIgnoreCase);
        return ProjectConnectorCatalog.All
            .Select(definition => ToView(
                definition,
                states.GetValueOrDefault(definition.Id) ?? DefaultState(definition)))
            .ToArray();
    }

    public static IReadOnlyList<ProjectConnectorState> LoadStates(string projectRoot)
    {
        var root = RequireProjectRoot(projectRoot);
        var path = ResolveInside(root, StateRelativePath);
        if (!File.Exists(path)) return ProjectConnectorCatalog.All.Select(DefaultState).ToArray();

        try
        {
            var document = JsonSerializer.Deserialize<ConnectorStateDocument>(
                File.ReadAllText(path, Encoding.UTF8),
                JsonOptions);
            if (document is null || document.Version != StateVersion)
            {
                throw new InvalidDataException(
                    $"Connector state version is not supported. Expected {StateVersion}.");
            }

            var known = new Dictionary<string, ProjectConnectorState>(StringComparer.OrdinalIgnoreCase);
            foreach (var state in document.Connectors)
            {
                var definition = ProjectConnectorCatalog.Find(state.ConnectorId);
                if (definition is null) continue;
                ValidateStoredState(definition, state);
                known[state.ConnectorId] = state;
            }

            return ProjectConnectorCatalog.All
                .Select(definition => known.GetValueOrDefault(definition.Id) ?? DefaultState(definition))
                .ToArray();
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(
                "Project connector state is damaged and was not treated as disconnected.",
                exception);
        }
    }

    public static ProjectConnectorMutation PrepareAuthorization(
        string projectRoot,
        string connectorId,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        var definition = RequireDefinition(connectorId);
        lock (WriteGate)
        {
            var states = LoadStates(root).ToList();
            var current = states.Single(item => item.ConnectorId == definition.Id);
            if (current.Stage != ProjectConnectorStage.NotConfigured
                && current.Stage != ProjectConnectorStage.Revoked
                && current.Stage != ProjectConnectorStage.ConnectionError)
            {
                throw new InvalidOperationException(
                    $"{definition.Name} already has a local authorization request or verified connection state.");
            }

            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var next = new ProjectConnectorState(
                definition.Id,
                ProjectConnectorStage.AuthorizationPrepared,
                $"local-auth-{Guid.NewGuid():N}",
                definition.Capabilities.Select(item => item.Id).ToArray(),
                ConnectionId: null,
                ExternalAccountLabel: null,
                at,
                "Local authorization intent prepared. No provider page opened and no authorization was granted.");
            ReplaceState(states, next);
            SaveStates(root, states);

            var evidenceHash = HashState(next);
            var capabilityText = string.Join(
                "; ",
                definition.Capabilities.Select(capability =>
                    capability.RequiresApproval
                        ? $"{capability.Label} (separate approval required)"
                        : capability.Label));
            var detail =
                $"Prepared a local-only authorization request for: {capabilityText}. "
                + "No OAuth flow, account lookup, credential access, or provider API call occurred.";
            var activity = ProjectWorkbenchStore.RecordConnectorEvent(
                root,
                definition.Name,
                "Authorization request prepared locally",
                detail,
                "prepared",
                evidenceHash,
                at);
            var audit = AppendAuditEvent(
                root,
                definition.Id,
                "authorization_prepared",
                "local_only",
                detail,
                evidenceHash,
                activity.Id,
                at);
            return new ProjectConnectorMutation(next, audit, activity);
        }
    }

    public static ProjectConnectorMutation CancelPreparedAuthorization(
        string projectRoot,
        string connectorId,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        var definition = RequireDefinition(connectorId);
        lock (WriteGate)
        {
            var states = LoadStates(root).ToList();
            var current = states.Single(item => item.ConnectorId == definition.Id);
            if (current.Stage != ProjectConnectorStage.AuthorizationPrepared)
            {
                throw new InvalidOperationException(
                    $"{definition.Name} has no local authorization request to cancel.");
            }

            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var next = DefaultState(definition) with
            {
                UpdatedAtUtc = at,
                Detail = "Local authorization intent cancelled. No provider state was changed."
            };
            ReplaceState(states, next);
            SaveStates(root, states);

            var evidenceHash = HashState(next);
            var detail =
                "Cancelled the local authorization request. No OAuth grant, provider account, or remote connection was changed.";
            var activity = ProjectWorkbenchStore.RecordConnectorEvent(
                root,
                definition.Name,
                "Authorization request cancelled",
                detail,
                "cancelled",
                evidenceHash,
                at);
            var audit = AppendAuditEvent(
                root,
                definition.Id,
                "authorization_cancelled",
                "local_only",
                detail,
                evidenceHash,
                activity.Id,
                at);
            return new ProjectConnectorMutation(next, audit, activity);
        }
    }

    public static IReadOnlyList<ConnectorAuditEntry> ReadAudit(
        string projectRoot,
        int limit = 100)
    {
        var root = RequireProjectRoot(projectRoot);
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var path = ResolveInside(root, AuditRelativePath);
        if (!File.Exists(path)) return [];

        var entries = new List<ConnectorAuditEntry>();
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var entry = JsonSerializer.Deserialize<ConnectorAuditEntry>(line, JsonLineOptions);
                if (entry is not null
                    && ProjectConnectorCatalog.Find(entry.ConnectorId) is not null
                    && entry.Id.Length > 0)
                {
                    entries.Add(entry);
                }
            }
            catch (JsonException)
            {
                // One partial append cannot hide earlier typed audit entries.
            }
        }

        return entries
            .OrderByDescending(item => item.AtUtc)
            .ThenByDescending(item => item.Id, StringComparer.Ordinal)
            .Take(limit)
            .ToArray();
    }

    internal static ConnectorAuditEntry AppendAuditEvent(
        string projectRoot,
        string connectorId,
        string eventType,
        string outcome,
        string detail,
        string evidenceHash,
        string? projectActivityId,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        RequireDefinition(connectorId);
        ArgumentException.ThrowIfNullOrWhiteSpace(eventType);
        ArgumentException.ThrowIfNullOrWhiteSpace(outcome);
        ArgumentException.ThrowIfNullOrWhiteSpace(detail);
        ArgumentException.ThrowIfNullOrWhiteSpace(evidenceHash);
        if (detail.Length > ProjectWorkbenchStore.MaxActivityDetailChars)
        {
            throw new ArgumentException("Connector audit detail is too long.", nameof(detail));
        }

        lock (WriteGate)
        {
            var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
            var entry = new ConnectorAuditEntry(
                $"{at:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}",
                at,
                connectorId.Trim().ToLowerInvariant(),
                eventType.Trim().ToLowerInvariant(),
                outcome.Trim().ToLowerInvariant(),
                detail.Trim(),
                evidenceHash.Trim(),
                string.IsNullOrWhiteSpace(projectActivityId) ? null : projectActivityId.Trim());
            var path = ResolveInside(root, AuditRelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(
                path,
                JsonSerializer.Serialize(entry, JsonLineOptions) + Environment.NewLine,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            return entry;
        }
    }

    internal static string RequireProjectRoot(string? projectRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectRoot);
        var root = Path.GetFullPath(projectRoot.Trim());
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException($"Selected project does not exist: {root}");
        }

        return Path.TrimEndingDirectorySeparator(root);
    }

    internal static string ResolveInside(string root, string relativePath)
    {
        var full = Path.GetFullPath(Path.Combine(
            root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Connector path escaped the selected project.");
        }

        return full;
    }

    private static ProjectConnectorView ToView(
        ProjectConnectorDefinition definition,
        ProjectConnectorState state)
    {
        var capabilities = string.Join(
            " · ",
            definition.Capabilities.Select(item => item.RequiresApproval
                ? $"{item.Label} [approval]"
                : item.Label));
        return new ProjectConnectorView(
            definition.Id,
            definition.Name,
            definition.Description,
            state.Stage == ProjectConnectorStage.Connected ? "CONNECTED" : "NOT CONNECTED",
            state.Stage switch
            {
                ProjectConnectorStage.AuthorizationPrepared => "LOCAL REQUEST PREPARED",
                ProjectConnectorStage.Connected => "VERIFIED BY CONNECTOR SERVICE",
                ProjectConnectorStage.ConnectionError => "CONNECTION ERROR",
                ProjectConnectorStage.Revoked => "AUTHORIZATION REVOKED",
                _ => "NO AUTHORIZATION"
            },
            state.Detail,
            capabilities,
            definition.AuthorizationOwner,
            state.Stage == ProjectConnectorStage.AuthorizationPrepared
                ? "Cancel local request"
                : state.Stage == ProjectConnectorStage.Connected
                    ? "Managed by connector service"
                    : "Prepare authorization request",
            state.Stage != ProjectConnectorStage.Connected);
    }

    private static ProjectConnectorState DefaultState(ProjectConnectorDefinition definition) =>
        new(
            definition.Id,
            ProjectConnectorStage.NotConfigured,
            AuthorizationRequestId: null,
            RequestedCapabilityIds: [],
            ConnectionId: null,
            ExternalAccountLabel: null,
            UpdatedAtUtc: null,
            "No authorization request, external account, or live connection exists for this project.");

    private static void ValidateStoredState(
        ProjectConnectorDefinition definition,
        ProjectConnectorState state)
    {
        if (!string.Equals(definition.Id, state.ConnectorId, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Connector state id does not match its catalog entry.");
        }

        var knownCapabilities = definition.Capabilities.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        if (state.RequestedCapabilityIds.Any(item => !knownCapabilities.Contains(item)))
        {
            throw new InvalidDataException($"{definition.Name} state requests an unknown capability.");
        }

        if (state.Stage == ProjectConnectorStage.AuthorizationPrepared
            && string.IsNullOrWhiteSpace(state.AuthorizationRequestId))
        {
            throw new InvalidDataException(
                $"{definition.Name} authorization-prepared state has no local request id.");
        }

        if (state.Stage == ProjectConnectorStage.Connected
            && string.IsNullOrWhiteSpace(state.ConnectionId))
        {
            throw new InvalidDataException(
                $"{definition.Name} connected state has no verified connection id.");
        }
    }

    private static ProjectConnectorDefinition RequireDefinition(string? connectorId) =>
        ProjectConnectorCatalog.Find(connectorId)
        ?? throw new ArgumentException("Connector must be slack or github.", nameof(connectorId));

    private static void ReplaceState(
        List<ProjectConnectorState> states,
        ProjectConnectorState next)
    {
        var index = states.FindIndex(item =>
            string.Equals(item.ConnectorId, next.ConnectorId, StringComparison.OrdinalIgnoreCase));
        if (index < 0) states.Add(next);
        else states[index] = next;
    }

    private static void SaveStates(
        string root,
        IReadOnlyList<ProjectConnectorState> states)
    {
        var path = ResolveInside(root, StateRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var document = new ConnectorStateDocument(StateVersion, states);
        var json = JsonSerializer.Serialize(document, JsonOptions) + Environment.NewLine;
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(
                temporary,
                json,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
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
                // The durable state is already in place; cleanup is best effort.
            }
        }
    }

    private static string HashState(ProjectConnectorState state) =>
        Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(state, JsonLineOptions))));

    private sealed record ConnectorStateDocument(
        int Version,
        IReadOnlyList<ProjectConnectorState> Connectors);
}

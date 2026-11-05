using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>A team chat channel from helmian.cloud (Envoy).</summary>
public sealed record EnvoyChannel(string Id, string Slug, string Title, string Kind);

/// <summary>A team chat message from helmian.cloud (Envoy).</summary>
public sealed record EnvoyMessage(string Id, string ChannelId, string AuthorSubject, string AuthorKind, string Body, DateTimeOffset? CreatedAt);

/// <summary>A custom specialist agent configured on an Envoy channel.</summary>
public sealed record EnvoyCustomAgent(
    string Id,
    string Name,
    string Handle,
    string Emoji,
    string Provider,
    string AuthMode,
    string JobTitle,
    string SystemPrompt);

/// <summary>A GitHub repository link on an Envoy channel.</summary>
public sealed record EnvoyGithubLink(string Repo, IReadOnlyList<string>? Events, string? LinkedAt);

/// <summary>Channel configuration for an Envoy channel (agents, custom agents, Free-Willy debate, GitHub link).</summary>
public sealed record EnvoyChannelConfig(
    string DebateMode,
    int MaxRoundTurns,
    EnvoyGithubLink? Github,
    IReadOnlyList<EnvoyCustomAgent> CustomAgents);

/// <summary>
/// Desktop link to helmian.cloud team chat. The user presses "Link desktop app" in
/// helmian.cloud/app (Settings), types the 8-character code here, and the cloud
/// returns a desktop token that only works on the Envoy chat routes. The token is
/// kept with Windows DPAPI (CurrentUser) and never written to .env files.
/// </summary>
public sealed partial class EnvoyCloudLinkStore
{
    private static readonly byte[] Entropy = "Helmion.EnvoyCloudLink.v1"u8.ToArray();
    private readonly string _path;

    public EnvoyCloudLinkStore(string? path = null) => _path = path ?? DefaultPath();

    public static string DefaultPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Helmion", "envoy-cloud-link.dat");

    public bool Exists => File.Exists(_path);

    public EnvoyCloudLink? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.CurrentUser);
            var link = JsonSerializer.Deserialize<EnvoyCloudLink>(plain);
            return link is { Token.Length: > 0 } && IsDesktopToken(link.Token) ? link : null;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Save(EnvoyCloudLink link)
    {
        ArgumentNullException.ThrowIfNull(link);
        if (!IsDesktopToken(link.Token)) throw new ArgumentException("Not a Helmian desktop token.", nameof(link));
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllBytes(_path, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(link), Entropy, DataProtectionScope.CurrentUser));
    }

    public void Clear()
    {
        try { if (File.Exists(_path)) File.Delete(_path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public static bool IsDesktopToken(string? value) => value is not null && DesktopTokenPattern().IsMatch(value);

    [GeneratedRegex("^hdt_[A-Za-z0-9_-]{40,80}$")]
    private static partial Regex DesktopTokenPattern();
}

public sealed record EnvoyCloudLink(string Token, string Origin, string? Organization, DateTimeOffset LinkedAt);

/// <summary>One provider connection row as the Integrations cards read it — status only, never secret material.</summary>
public sealed record EnvoyProviderConnection(string ProviderId, string AuthMode, string Lifecycle, DateTimeOffset? UpdatedAt);

/// <summary>HTTP client for helmian.cloud Envoy team chat (same APIs as helmian.cloud/app).</summary>
public sealed partial class EnvoyCloudChatClient(HttpClient http, Uri origin)
{
    public static readonly Uri DefaultOrigin = new("https://helmian.cloud");

    /// <summary>
    /// Mirrors the server's DEFAULT_DEBATE_TURNS (src/cloud/envoy-agents.mjs).
    /// The server's config replies always carry a numeric cap, so this is only
    /// the last-resort fallback: the desktop must never invent a different
    /// number than the server (the old fallback was 12; the server's is 10).
    /// </summary>
    public const int DefaultDebateTurns = 10;

    /// <summary>Mirrors the server's MAX_DEBATE_TURNS clamp (1..50).</summary>
    public const int MaxDebateTurns = 50;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public Uri Origin { get; } = RequireOrigin(origin);

    public static Uri OriginFromEnvironment() =>
        Uri.TryCreate(Environment.GetEnvironmentVariable("HELMION_CLOUD_ORIGIN"), UriKind.Absolute, out var o) ? o : DefaultOrigin;

    /// <summary>Normalizes "abcd efgh" / "ABCD-EFGH" to "ABCD-EFGH"; null when not a valid link code.</summary>
    public static string? NormalizeLinkCode(string? input)
    {
        var raw = new string((input ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (raw.Length != 8) return null;
        var code = $"{raw[..4]}-{raw[4..]}";
        return LinkCodePattern().IsMatch(code) ? code : null;
    }

    /// <summary>
    /// Formats an Envoy message authorSubject + authorKind into a display label matching
    /// helmian.cloud/app (built-in agents, custom @handle agents, Discord/Slack mirrors, PC bridge).
    /// </summary>
    public static string DescribeAuthor(string? authorSubject, string? authorKind)
    {
        var subject = authorSubject ?? string.Empty;
        var kind = authorKind ?? string.Empty;
        if (kind == "agent" || subject.StartsWith("agent:", StringComparison.Ordinal))
        {
            if (subject.EndsWith(":bridge", StringComparison.Ordinal)) return "PC bridge";
            if (subject.StartsWith("agent:custom:", StringComparison.Ordinal))
            {
                var handle = subject["agent:custom:".Length..].Trim();
                return handle.Length > 0 ? $"@{handle}" : "Custom agent";
            }
            var id = subject.StartsWith("agent:", StringComparison.Ordinal) ? subject["agent:".Length..] : subject;
            return id switch
            {
                "claude" => "Claude",
                "openai" => "ChatGPT",
                "grok" => "SuperGrok",
                "gemini" => "Gemini",
                "mistral" => "Mistral Le Chat",
                "runway" => "Runway",
                "ollama" => "Local Ollama",
                _ => id.Length > 0 ? char.ToUpperInvariant(id[0]) + id[1..] : "Agent"
            };
        }
        if (subject.StartsWith("discord:", StringComparison.Ordinal))
        {
            var parts = subject.Split(':', 3);
            var name = parts.Length >= 3 && !string.IsNullOrWhiteSpace(parts[2]) ? parts[2] : "Discord member";
            return $"{name} · Discord";
        }
        if (subject.StartsWith("slack:", StringComparison.Ordinal))
        {
            var parts = subject.Split(':', 3);
            var name = parts.Length >= 3 && !string.IsNullOrWhiteSpace(parts[2]) ? parts[2] : "Slack member";
            return $"{name} · Slack";
        }
        if (kind == "system" || subject.StartsWith("system:", StringComparison.Ordinal)) return "Helmian";
        if (kind == "human") return "Member";
        return string.IsNullOrWhiteSpace(kind) ? "Member" : kind;
    }

    /// <summary>Builds the 1:1 Full Workspace Clone URL (/app#desktop or /app?channel=id#desktop).</summary>
    public Uri BuildFullCloneUri(string? channelId = null) =>
        new(HeraldPairingLink.BuildFullCloneUrl(Origin.AbsoluteUri, channelId, Origin.Host)
            ?? new Uri(Origin, "/app#desktop").AbsoluteUri);

    public async Task<EnvoyCloudLink> LinkAsync(string code, CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeLinkCode(code) ?? throw new ArgumentException("That code doesn't look right. It has 8 letters and numbers, like ABCD-EFGH.");
        using var response = await http.PostAsJsonAsync(new Uri(Origin, "/api/admin/desktop/link/exchange"), new { code = normalized }, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Gone) throw new InvalidOperationException("That code expired or was already used. Make a new one in helmian.cloud/app → Settings.");
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"helmian.cloud could not link this desktop (HTTP {(int)response.StatusCode}).");
        var body = await response.Content.ReadFromJsonAsync<LinkReply>(Json, cancellationToken);
        if (body is null || !EnvoyCloudLinkStore.IsDesktopToken(body.Token)) throw new InvalidDataException("helmian.cloud returned no desktop token.");
        return new EnvoyCloudLink(body.Token, Origin.AbsoluteUri, body.TenantId, DateTimeOffset.UtcNow);
    }

    public async Task<IReadOnlyList<EnvoyChannel>> ListChannelsAsync(string token, CancellationToken cancellationToken = default)
    {
        var body = await SendAsync<ChannelsReply>(HttpMethod.Get, "/api/admin/envoy/channels", token, null, cancellationToken);
        return body.Channels ?? [];
    }

    public async Task<IReadOnlyList<EnvoyMessage>> ListMessagesAsync(string token, string channelId, string? afterId = null, CancellationToken cancellationToken = default)
    {
        var path = $"/api/admin/envoy/messages?channel_id={Uri.EscapeDataString(channelId)}" + (afterId is { Length: > 0 } ? $"&after_id={Uri.EscapeDataString(afterId)}" : string.Empty);
        var body = await SendAsync<MessagesReply>(HttpMethod.Get, path, token, null, cancellationToken);
        return body.Messages ?? [];
    }

    public async Task<EnvoyChannelConfig> GetChannelConfigAsync(string token, string channelId, CancellationToken cancellationToken = default)
    {
        var path = $"/api/admin/envoy/channel-config?channel_id={Uri.EscapeDataString(channelId)}";
        var reply = await SendAsync<ConfigReply>(HttpMethod.Get, path, token, null, cancellationToken);
        var cfg = reply?.Config;
        return new EnvoyChannelConfig(
            cfg?.DebateMode ?? "off",
            cfg?.MaxRoundTurns is > 0 ? cfg.MaxRoundTurns : DefaultDebateTurns,
            cfg?.Github,
            cfg?.CustomAgents ?? []);
    }

    public async Task<EnvoyChannelConfig> SetDebateModeAsync(string token, string channelId, bool enabled, int maxRoundTurns = DefaultDebateTurns, CancellationToken cancellationToken = default)
    {
        var payload = new
        {
            channelId,
            action = enabled ? "set-debate" : "stop-debate",
            debateMode = enabled ? "free-willy" : "off",
            maxRoundTurns = Math.Clamp(maxRoundTurns, 1, MaxDebateTurns)
        };
        var reply = await SendAsync<ConfigReply>(HttpMethod.Post, "/api/admin/envoy/channel-config", token, payload, cancellationToken);
        var cfg = reply?.Config;
        return new EnvoyChannelConfig(
            cfg?.DebateMode ?? (enabled ? "free-willy" : "off"),
            cfg?.MaxRoundTurns is > 0 ? cfg.MaxRoundTurns : maxRoundTurns,
            cfg?.Github,
            cfg?.CustomAgents ?? []);
    }

    public async Task<EnvoyChannelConfig> LinkGitHubAsync(string token, string channelId, string repo, IReadOnlyList<string>? events = null, CancellationToken cancellationToken = default)
    {
        var trimmed = (repo ?? string.Empty).Trim();
        if (!GitHubRepoPattern().IsMatch(trimmed))
            throw new ArgumentException("Enter a valid GitHub repository in owner/repo format.");
        var payload = new
        {
            channelId,
            action = "link-github",
            repo = trimmed,
            events = events ?? ["push", "pull_request", "issues"]
        };
        var reply = await SendAsync<ConfigReply>(HttpMethod.Post, "/api/admin/envoy/channel-config", token, payload, cancellationToken);
        var cfg = reply?.Config;
        return new EnvoyChannelConfig(cfg?.DebateMode ?? "off", cfg?.MaxRoundTurns ?? DefaultDebateTurns, cfg?.Github, cfg?.CustomAgents ?? []);
    }

    public async Task<EnvoyChannelConfig> UnlinkGitHubAsync(string token, string channelId, CancellationToken cancellationToken = default)
    {
        var payload = new { channelId, action = "unlink-github" };
        var reply = await SendAsync<ConfigReply>(HttpMethod.Post, "/api/admin/envoy/channel-config", token, payload, cancellationToken);
        var cfg = reply?.Config;
        return new EnvoyChannelConfig(cfg?.DebateMode ?? "off", cfg?.MaxRoundTurns ?? DefaultDebateTurns, cfg?.Github, cfg?.CustomAgents ?? []);
    }

    public async Task<EnvoyChannelConfig> UpsertCustomAgentAsync(string token, string channelId, EnvoyCustomAgent agent, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(agent);
        var payload = new
        {
            channelId,
            action = "upsert-custom-agent",
            customAgent = new
            {
                id = string.IsNullOrWhiteSpace(agent.Id) ? $"ca_{Guid.NewGuid():N}"[..15] : agent.Id,
                name = agent.Name,
                handle = agent.Handle,
                emoji = string.IsNullOrWhiteSpace(agent.Emoji) ? "🤖" : agent.Emoji,
                provider = string.IsNullOrWhiteSpace(agent.Provider) ? "claude" : agent.Provider,
                authMode = string.IsNullOrWhiteSpace(agent.AuthMode) ? "subscription" : agent.AuthMode,
                jobTitle = agent.JobTitle ?? string.Empty,
                systemPrompt = agent.SystemPrompt ?? string.Empty
            }
        };
        var reply = await SendAsync<ConfigReply>(HttpMethod.Post, "/api/admin/envoy/channel-config", token, payload, cancellationToken);
        var cfg = reply?.Config;
        return new EnvoyChannelConfig(cfg?.DebateMode ?? "off", cfg?.MaxRoundTurns ?? DefaultDebateTurns, cfg?.Github, cfg?.CustomAgents ?? []);
    }

    public async Task SendMessageAsync(string token, string channelId, string text, CancellationToken cancellationToken = default)
    {
        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length is 0 or > 4000) throw new ArgumentException("Messages must be 1–4000 characters.");
        await SendAsync<JsonElement>(HttpMethod.Post, "/api/admin/envoy/messages", token,
            new { channelId, body = trimmed, idempotencyKey = Guid.NewGuid().ToString("N") }, cancellationToken);
    }

    public async Task UnlinkAsync(string token, CancellationToken cancellationToken = default)
    {
        try { await SendAsync<JsonElement>(HttpMethod.Post, "/api/admin/desktop/link/revoke", token, new { }, cancellationToken); }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException) { /* best effort; local copy is cleared by the caller */ }
    }

    // ---- Integrations credential cards ---------------------------------
    // The same shared credential vault the web cards write: the cloud
    // route stores the secret in the credential service and records the
    // provider_connections row. The desktop link token carries the
    // owner's subject and membership role, so the route's owner/admin
    // gate is the person themselves. Nothing is stored on this PC.

    private const string CredentialConnectPath = "/api/admin/envoy/credential/connect";

    /// <summary>Lists the workspace's provider connection rows (status only) for the Integrations cards.</summary>
    public async Task<IReadOnlyList<EnvoyProviderConnection>> ListConnectionsAsync(string token, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        var reply = await SendAsync<ConnectionListReply>(HttpMethod.Get, CredentialConnectPath, token, null, cancellationToken).ConfigureAwait(false);
        if (reply?.Connections is null) return [];
        return reply.Connections
            .Where(row => !string.IsNullOrWhiteSpace(row.ProviderId))
            .Select(row => new EnvoyProviderConnection(row.ProviderId!, row.AuthMode ?? "", row.Lifecycle ?? "", row.UpdatedAt))
            .ToArray();
    }

    /// <summary>Stores a seat sign-in (username + password) in the shared vault. Returns the recorded connection row.</summary>
    public async Task<EnvoyProviderConnection?> ConnectCredentialAsync(string token, string provider, string username, string password, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        ArgumentException.ThrowIfNullOrWhiteSpace(provider);
        ArgumentException.ThrowIfNullOrWhiteSpace(username);
        ArgumentException.ThrowIfNullOrWhiteSpace(password);
        var reply = await SendAsync<ConnectionWriteReply>(HttpMethod.Post, CredentialConnectPath, token,
            new { provider, username, password }, cancellationToken).ConfigureAwait(false);
        return MapConnection(reply?.Connection);
    }

    /// <summary>Stores an API key in the shared vault (a seat's backup door, or a tool service's only road).</summary>
    public async Task<EnvoyProviderConnection?> StoreApiKeyAsync(string token, string provider, string apiKey, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        ArgumentException.ThrowIfNullOrWhiteSpace(provider);
        ArgumentException.ThrowIfNullOrWhiteSpace(apiKey);
        var reply = await SendAsync<ConnectionWriteReply>(HttpMethod.Post, CredentialConnectPath, token,
            new { provider, apiKey }, cancellationToken).ConfigureAwait(false);
        return MapConnection(reply?.Connection);
    }

    private static EnvoyProviderConnection? MapConnection(ConnectionDto? row) =>
        row is null || string.IsNullOrWhiteSpace(row.ProviderId)
            ? null
            : new EnvoyProviderConnection(row.ProviderId!, row.AuthMode ?? "", row.Lifecycle ?? "", row.UpdatedAt);

    private sealed record ConnectionDto(string? ProviderId, string? AuthMode, string? Lifecycle, DateTimeOffset? UpdatedAt);
    private sealed record ConnectionListReply(IReadOnlyList<ConnectionDto>? Connections);
    private sealed record ConnectionWriteReply(ConnectionDto? Connection);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, string token, object? payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, new Uri(Origin, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (payload is not null) request.Content = JsonContent.Create(payload);
        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            throw new UnauthorizedAccessException("This desktop is no longer linked to your Helmian team. Link it again from helmian.cloud/app → Settings.");
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Team chat is unavailable right now (HTTP {(int)response.StatusCode}).");
        return (await response.Content.ReadFromJsonAsync<T>(Json, cancellationToken))!;
    }

    private static Uri RequireOrigin(Uri origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        if (!origin.IsAbsoluteUri || (origin.Scheme != Uri.UriSchemeHttps && !origin.IsLoopback))
            throw new ArgumentException("helmian.cloud origin must be HTTPS.", nameof(origin));
        return new Uri(origin.GetLeftPart(UriPartial.Authority));
    }

    [GeneratedRegex("^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")]
    private static partial Regex LinkCodePattern();

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")]
    private static partial Regex GitHubRepoPattern();

    private sealed record LinkReply(string Token, string? TenantId);
    private sealed record ChannelsReply(IReadOnlyList<EnvoyChannel>? Channels);
    private sealed record MessagesReply(IReadOnlyList<EnvoyMessage>? Messages);
    private sealed record ConfigDto(string? DebateMode, int MaxRoundTurns, EnvoyGithubLink? Github, IReadOnlyList<EnvoyCustomAgent>? CustomAgents);
    private sealed record ConfigReply(ConfigDto? Config);
}

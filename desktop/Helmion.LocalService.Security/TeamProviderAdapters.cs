using System.Globalization;
using System.Net.Http.Headers;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

internal sealed record TeamProviderConfiguration(
    string ProviderId,
    string ClientId,
    string ClientSecret,
    Uri? RedirectUri,
    IReadOnlyList<string> Scopes,
    string? BotToken = null,
    bool SendEnabled = false,
    Uri? HandoffBaseUri = null,
    string? HandoffToken = null)
{
    private static readonly IReadOnlySet<string> SlackReadScopes = new HashSet<string>(
        ["channels:read", "channels:history", "groups:read", "groups:history"],
        StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> DiscordReadScopes = new HashSet<string>(
        ["identify", "guilds", "bot"],
        StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> DiscordHostedUserScopes = new HashSet<string>(
        ["identify", "guilds"],
        StringComparer.Ordinal);

    // Slack and Discord use a hosted HTTPS callback + one-time handoff.
    // GitHub pilot uses a personal access token on Local Service (no browser OAuth).
    public bool UsesHostedHandoff => ProviderId is TeamConnectorContract.SlackProviderId
        or TeamConnectorContract.DiscordProviderId;

    public bool UsesPersonalAccessToken => ProviderId == TeamConnectorContract.GitHubProviderId;

    public bool AuthorizationConfigured => ConfigurationIssues(includeReadCredential: false).Count == 0;

    public bool ReadConfigured => ConfigurationIssues(includeReadCredential: true).Count == 0;

    public string MissingConfigurationDetail()
    {
        var missing = ConfigurationIssues(includeReadCredential: true);
        return missing.Count == 0
            ? UsesHostedHandoff
                ? $"{ProviderId} uses a hosted HTTPS callback and one-time, account-scoped desktop handoff."
                : UsesPersonalAccessToken
                    ? "GitHub is ready to connect with the Local Service personal access token."
                    : "The provider is not configured."
            : $"Setup needed: {string.Join(" ", missing)}";
    }

    public IReadOnlyList<string> SetupSteps() => ProviderId switch
    {
        TeamConnectorContract.GitHubProviderId =>
        [
            "Create a classic GitHub personal access token with read:user, repo (or public_repo), and read:org as needed.",
            "Set HELMION_GITHUB_TOKEN only for the Local Service process environment (never in XAML or project files).",
            "Press Connect GitHub. Helmian validates the token against the GitHub API and stores it with Windows CurrentUser DPAPI.",
            "GitHub is read-only in this Team build: repos, issues, and recent comments. No PR write or push."
        ],
        _ when UsesHostedHandoff && ProviderId == TeamConnectorContract.DiscordProviderId =>
        [
            "Register https://helmian.vercel.app/api/team-oauth/discord/callback on the Discord app OAuth2 Redirects.",
            "Set HELMION_DISCORD_CLIENT_ID and HELMION_DISCORD_CLIENT_SECRET on Local Service.",
            "Set HELMION_DISCORD_HANDOFF_BASE_URI and HELMION_DISCORD_HANDOFF_TOKEN.",
            "Connect Discord = sign in as that person only (identify + guilds). No server ownership. No bot install on Connect.",
            "Optional later: HELMION_DISCORD_BOT_TOKEN + Message Content Intent so channel history works in servers where an admin installed the bot once."
        ],
        _ when UsesHostedHandoff =>
        [
            $"Register https://helmian.vercel.app/api/team-oauth/{ProviderId}/callback as the OAuth Redirect URL on the {ProviderId} application.",
            $"Set HELMION_{ProviderId.ToUpperInvariant()}_CLIENT_ID and _CLIENT_SECRET on Local Service for pilot token exchange.",
            "Slack bot scopes: channels:read, channels:history, groups:read, groups:history (no chat:write).",
            $"Set HELMION_{ProviderId.ToUpperInvariant()}_HANDOFF_BASE_URI=https://helmian.vercel.app/api/team-oauth/{ProviderId}/ and the matching HANDOFF_TOKEN.",
            "Each person authorizes their own account; the handoff stores only a short-lived encrypted code until Local Service redeems and exchanges it."
        ],
        _ =>
        [
            "Create a Discord app and bot, enable Message Content intent, and register one exact HTTP loopback callback ending in /.",
            "Install the bot with View Channels + Read Message History (permission value 66560) in the server to read.",
            "Set HELMION_DISCORD_CLIENT_ID, HELMION_DISCORD_CLIENT_SECRET, HELMION_DISCORD_REDIRECT_URI, and HELMION_DISCORD_BOT_TOKEN only for the Local Service.",
            "Keep scopes exactly identify guilds bot. Helmian does not request Send Messages and exposes no Team send command."
        ]
    };

    private List<string> ConfigurationIssues(bool includeReadCredential)
    {
        var missing = new List<string>();
        if (ProviderId == TeamConnectorContract.GitHubProviderId)
        {
            if (string.IsNullOrWhiteSpace(BotToken) || BotToken.Length < 20)
            {
                missing.Add("Set HELMION_GITHUB_TOKEN to a GitHub personal access token (read:user + repo/public_repo).");
            }
            if (SendEnabled)
            {
                missing.Add("Remove the send-enable flag; this Team build is deliberately read-only.");
            }
            return missing;
        }

        var prefix = ProviderId == TeamConnectorContract.SlackProviderId
            ? "HELMION_SLACK"
            : "HELMION_DISCORD";
        if (ClientId.Length == 0) missing.Add($"Set {prefix}_CLIENT_ID.");
        // Pilot: Local Service exchanges the hosted code, so secret is required.
        if (ClientSecret.Length == 0) missing.Add($"Set {prefix}_CLIENT_SECRET on Local Service for pilot token exchange.");
        var allowedScopes = ProviderId switch
        {
            TeamConnectorContract.SlackProviderId => SlackReadScopes,
            TeamConnectorContract.DiscordProviderId when UsesHostedHandoff => DiscordHostedUserScopes,
            _ => DiscordReadScopes
        };
        if (Scopes.Count == 0
            || Scopes.Any(scope => !allowedScopes.Contains(scope))
            || (ProviderId == TeamConnectorContract.SlackProviderId
                ? !SlackReadScopes.SetEquals(Scopes)
                : UsesHostedHandoff
                    ? !DiscordHostedUserScopes.SetEquals(Scopes)
                    : !DiscordReadScopes.SetEquals(Scopes)))
        {
            missing.Add(ProviderId switch
            {
                TeamConnectorContract.SlackProviderId => "Use only the four documented Slack read scopes.",
                _ when UsesHostedHandoff => "Use exactly the Discord user scopes identify guilds.",
                _ => "Use exactly the Discord scopes identify guilds bot."
            });
        }
        if (UsesHostedHandoff)
        {
            if (!IsValidHostedBase(HandoffBaseUri))
            {
                missing.Add($"Set {prefix}_HANDOFF_BASE_URI to the deployed HTTPS /api/team-oauth/{ProviderId}/ URL ending in /.");
            }
            if (string.IsNullOrWhiteSpace(HandoffToken) || HandoffToken.Length < 32)
            {
                missing.Add($"Set {prefix}_HANDOFF_TOKEN to the per-installation handoff proof (at least 32 characters).");
            }
            if (HandoffBaseUri is null
                || RedirectUri is null
                || RedirectUri != new Uri(HandoffBaseUri, "callback"))
            {
                missing.Add("The callback must resolve to the hosted handoff /callback HTTPS URL.");
            }
        }
        else if (!IsValidDiscordLoopback(RedirectUri))
        {
            missing.Add("Set HELMION_DISCORD_REDIRECT_URI to an exact HTTP loopback URL ending in /.");
        }
        // Discord login is user OAuth only. A bot is optional and only needed later
        // for channel message history — never required to Connect / sign in.
        if (SendEnabled)
        {
            missing.Add("Remove the send-enable flag; this Team build is deliberately read-only.");
        }
        return missing;
    }

    private static bool IsValidHostedBase(Uri? uri) =>
        uri is { IsAbsoluteUri: true }
        && uri.Scheme == Uri.UriSchemeHttps
        && !uri.IsLoopback
        && uri.AbsolutePath.EndsWith("/", StringComparison.Ordinal)
        && string.IsNullOrEmpty(uri.Query)
        && string.IsNullOrEmpty(uri.Fragment)
        && string.IsNullOrEmpty(uri.UserInfo);

    private static bool IsValidDiscordLoopback(Uri? uri) =>
        uri is { IsAbsoluteUri: true, IsLoopback: true }
        && uri.Scheme == Uri.UriSchemeHttp
        && uri.AbsolutePath.EndsWith("/", StringComparison.Ordinal)
        && string.IsNullOrEmpty(uri.Query)
        && string.IsNullOrEmpty(uri.Fragment)
        && string.IsNullOrEmpty(uri.UserInfo);

    public static TeamProviderConfiguration FromEnvironment(string providerId)
    {
        TeamConnectorContract.RequireProvider(providerId);
        if (providerId == TeamConnectorContract.GitHubProviderId)
        {
            return new TeamProviderConfiguration(
                providerId,
                ClientId: "github-pat",
                ClientSecret: string.Empty,
                RedirectUri: null,
                Scopes: ["read:user", "repo"],
                BotToken: Environment.GetEnvironmentVariable("HELMION_GITHUB_TOKEN")?.Trim()
                    ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN")?.Trim(),
                SendEnabled: false);
        }

        var isSlack = providerId == TeamConnectorContract.SlackProviderId;
        var prefix = isSlack ? "HELMION_SLACK" : "HELMION_DISCORD";
        var handoffText = Environment.GetEnvironmentVariable($"{prefix}_HANDOFF_BASE_URI")?.Trim();
        Uri? handoffBase = null;
        if (Uri.TryCreate(handoffText, UriKind.Absolute, out var parsedHandoff)
            && parsedHandoff.Scheme == Uri.UriSchemeHttps
            && !parsedHandoff.IsLoopback
            && parsedHandoff.AbsolutePath.EndsWith("/", StringComparison.Ordinal)
            && string.IsNullOrEmpty(parsedHandoff.Query)
            && string.IsNullOrEmpty(parsedHandoff.Fragment)
            && string.IsNullOrEmpty(parsedHandoff.UserInfo))
        {
            handoffBase = parsedHandoff;
        }
        // Hosted callback is .../callback (no trailing slash). Vercel + Discord
        // OAuth both use that shape; do not require a trailing slash here.
        var redirectText = handoffBase is null
            ? null
            : new Uri(handoffBase, "callback").AbsoluteUri;
        Uri? redirect = null;
        if (Uri.TryCreate(redirectText, UriKind.Absolute, out var parsed)
            && parsed.Scheme == Uri.UriSchemeHttps && !parsed.IsLoopback
            && parsed.AbsolutePath.EndsWith("/callback", StringComparison.Ordinal)
            && string.IsNullOrEmpty(parsed.Query)
            && string.IsNullOrEmpty(parsed.Fragment)
            && string.IsNullOrEmpty(parsed.UserInfo))
        {
            redirect = parsed;
        }

        var defaultScopes = isSlack
            ? "channels:read,channels:history,groups:read,groups:history"
            : "identify guilds";
        var scopeSeparator = isSlack ? ',' : ' ';
        var scopes = (Environment.GetEnvironmentVariable($"{prefix}_SCOPES") ?? defaultScopes)
            .Split(scopeSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return new TeamProviderConfiguration(
            providerId,
            Environment.GetEnvironmentVariable($"{prefix}_CLIENT_ID")?.Trim() ?? string.Empty,
            Environment.GetEnvironmentVariable($"{prefix}_CLIENT_SECRET")?.Trim() ?? string.Empty,
            redirect,
            scopes,
            // Pilot Local Service may hold the Discord bot token for channel reads.
            BotToken: Environment.GetEnvironmentVariable($"{prefix}_BOT_TOKEN")?.Trim(),
            SendEnabled: false,
            HandoffBaseUri: handoffBase,
            HandoffToken: Environment.GetEnvironmentVariable($"{prefix}_HANDOFF_TOKEN")?.Trim());
    }
}

internal sealed record TeamTokenBundle(
    string ProviderId,
    string AccessToken,
    string? RefreshToken,
    string TokenType,
    DateTimeOffset? ExpiresAtUtc,
    string AccountId,
    string AccountLabel,
    IReadOnlyList<string> GrantedScopes,
    bool ReadValidated = false,
    DateTimeOffset? ReadValidatedAtUtc = null);

internal sealed record TeamProviderReadResult(
    TeamConnectorAccount Account,
    IReadOnlyList<TeamScope> Scopes,
    IReadOnlyList<TeamChannel> Channels,
    IReadOnlyList<TeamMessage> Messages,
    string Detail);

internal interface ITeamProviderAdapter
{
    string ProviderId { get; }
    TeamProviderConfiguration Configuration { get; }
    Uri BuildAuthorizationUri(string state);
    Task<TeamTokenBundle> ExchangeCodeAsync(string code, CancellationToken cancellationToken);
    Task<TeamProviderReadResult> ReadAsync(
        TeamTokenBundle token,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken);
}

internal sealed class TeamProviderCredentialException(string message) : InvalidOperationException(message);

internal abstract class TeamProviderAdapterBase(
    TeamProviderConfiguration configuration,
    HttpClient httpClient) : ITeamProviderAdapter
{
    protected HttpClient HttpClient { get; } = httpClient;
    public TeamProviderConfiguration Configuration { get; } = configuration;
    public string ProviderId => Configuration.ProviderId;

    public abstract Uri BuildAuthorizationUri(string state);
    public abstract Task<TeamTokenBundle> ExchangeCodeAsync(
        string code,
        CancellationToken cancellationToken);
    public abstract Task<TeamProviderReadResult> ReadAsync(
        TeamTokenBundle token,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken);

    protected static Uri UriWithQuery(string baseUri, IEnumerable<KeyValuePair<string, string>> values)
    {
        var query = string.Join("&", values.Select(value =>
            $"{Uri.EscapeDataString(value.Key)}={Uri.EscapeDataString(value.Value)}"));
        return new Uri($"{baseUri}?{query}");
    }

    protected async Task<JsonDocument> SendJsonAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        using var response = await HttpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                throw new TeamProviderCredentialException(
                    $"{ProviderId} rejected the protected credential. Connect again; no response body was exposed.");
            }
            throw new InvalidOperationException(
                $"{ProviderId} returned HTTP {(int)response.StatusCode}; no credential or response body was exposed.");
        }
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    protected static string RequireString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"{property} was missing from the provider response.");
        }
        return value.GetString()!;
    }

    protected static string OptionalString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
}

internal sealed class SlackTeamProviderAdapter(
    TeamProviderConfiguration configuration,
    HttpClient httpClient) : TeamProviderAdapterBase(configuration, httpClient)
{
    public override Uri BuildAuthorizationUri(string state) => UriWithQuery(
        "https://slack.com/oauth/v2/authorize",
        [
            new("client_id", Configuration.ClientId),
            new("scope", string.Join(',', Configuration.Scopes)),
            new("redirect_uri", Configuration.RedirectUri!.AbsoluteUri),
            new("state", state)
        ]);

    public override async Task<TeamTokenBundle> ExchangeCodeAsync(
        string code,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://slack.com/api/oauth.v2.access")
        {
            Content = new FormUrlEncodedContent(
            [
                new("code", code),
                new("redirect_uri", Configuration.RedirectUri!.AbsoluteUri)
            ])
        };
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(
                $"{Configuration.ClientId}:{Configuration.ClientSecret}")));
        using var json = await SendJsonAsync(request, cancellationToken);
        var root = json.RootElement;
        if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        {
            throw new InvalidOperationException(
                $"Slack authorization failed ({OptionalString(root, "error") switch { "" => "provider_error", var value => value }}). No token was stored.");
        }
        var team = root.GetProperty("team");
        var accountId = RequireString(team, "id");
        var accountLabel = OptionalString(team, "name");
        var scopes = OptionalString(root, "scope")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var missingScopes = Configuration.Scopes.Except(scopes, StringComparer.Ordinal).ToArray();
        if (missingScopes.Length > 0)
        {
            throw new InvalidOperationException(
                $"Slack did not grant the required read-only scopes: {string.Join(", ", missingScopes)}. No token was stored.");
        }
        return new TeamTokenBundle(
            ProviderId,
            RequireString(root, "access_token"),
            OptionalString(root, "refresh_token") is { Length: > 0 } refresh ? refresh : null,
            OptionalString(root, "token_type") is { Length: > 0 } type ? type : "Bearer",
            root.TryGetProperty("expires_in", out var expires) && expires.TryGetInt32(out var seconds)
                ? DateTimeOffset.UtcNow.AddSeconds(seconds)
                : null,
            accountId,
            accountLabel.Length > 0 ? accountLabel : accountId,
            scopes,
            ReadValidated: true,
            ReadValidatedAtUtc: DateTimeOffset.UtcNow);
    }

    public override async Task<TeamProviderReadResult> ReadAsync(
        TeamTokenBundle token,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken)
    {
        var account = new TeamConnectorAccount(ProviderId, token.AccountId, token.AccountLabel);
        var scopes = new[]
        {
            new TeamScope(ProviderId, token.AccountId, token.AccountLabel, TeamScopeKind.Workspace)
        };
        if (scopeId is not null && scopeId != token.AccountId)
        {
            return new TeamProviderReadResult(account, scopes, [], [], "Selected Slack workspace does not match this connection.");
        }

        var channels = new List<TeamChannel>();
        var cursor = string.Empty;
        do
        {
            var uri = UriWithQuery(
                "https://slack.com/api/conversations.list",
                [
                    new("limit", "200"),
                    new("types", "public_channel,private_channel"),
                    new("exclude_archived", "true"),
                    new("cursor", cursor)
                ]);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.AccessToken);
            using var json = await SendJsonAsync(request, cancellationToken);
            EnsureSlackOk(json.RootElement, "channel listing");
            foreach (var item in json.RootElement.GetProperty("channels").EnumerateArray())
            {
                var id = RequireString(item, "id");
                var name = OptionalString(item, "name");
                var isMember = item.TryGetProperty("is_member", out var member) && member.GetBoolean();
                channels.Add(new TeamChannel(
                    ProviderId,
                    token.AccountId,
                    id,
                    name.Length > 0 ? name : id,
                    CanRead: isMember,
                    CanSend: false));
            }
            cursor = json.RootElement.TryGetProperty("response_metadata", out var metadata)
                ? OptionalString(metadata, "next_cursor")
                : string.Empty;
        }
        while (cursor.Length > 0 && channels.Count < 500);

        var messages = new List<TeamMessage>();
        if (!string.IsNullOrWhiteSpace(channelId))
        {
            var selected = channels.SingleOrDefault(item => item.Id == channelId)
                ?? throw new InvalidOperationException("Selected Slack channel is not available to this connection.");
            if (!selected.CanRead)
            {
                throw new InvalidOperationException("The Slack app is not a member of the selected channel.");
            }
            var uri = UriWithQuery(
                "https://slack.com/api/conversations.history",
                [new("channel", channelId), new("limit", "50")]);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.AccessToken);
            using var json = await SendJsonAsync(request, cancellationToken);
            EnsureSlackOk(json.RootElement, "message history");
            foreach (var item in json.RootElement.GetProperty("messages").EnumerateArray())
            {
                var ts = RequireString(item, "ts");
                messages.Add(new TeamMessage(
                    ProviderId,
                    token.AccountId,
                    channelId,
                    ts,
                    OptionalString(item, "user") is { Length: > 0 } user ? user : "slack-app",
                    OptionalString(item, "user") is { Length: > 0 } author ? author : "Slack app",
                    OptionalString(item, "text"),
                    ParseSlackTimestamp(ts),
                    OptionalString(item, "thread_ts") is { Length: > 0 } thread ? thread : null,
                    null));
            }
        }
        return new TeamProviderReadResult(
            account,
            scopes,
            channels.OrderBy(item => item.DisplayLabel, StringComparer.OrdinalIgnoreCase).ToArray(),
            messages.OrderBy(item => item.SentAtUtc).ToArray(),
            channelId is null
                ? "Slack workspaces and channels were read. Pick a channel to load recent messages."
                : $"Read {messages.Count} recent Slack messages without writing to Slack.");
    }

    private static void EnsureSlackOk(JsonElement root, string operation)
    {
        if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        {
            throw new InvalidOperationException(
                $"Slack {operation} failed ({OptionalString(root, "error") switch { "" => "provider_error", var value => value }}). No response body was exposed.");
        }
    }

    private static DateTimeOffset ParseSlackTimestamp(string value)
    {
        var whole = value.Split('.')[0];
        return long.TryParse(whole, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
            ? DateTimeOffset.FromUnixTimeSeconds(seconds)
            : DateTimeOffset.UnixEpoch;
    }
}

internal sealed class DiscordTeamProviderAdapter(
    TeamProviderConfiguration configuration,
    HttpClient httpClient) : TeamProviderAdapterBase(configuration, httpClient)
{
    public override Uri BuildAuthorizationUri(string state) => UriWithQuery(
        "https://discord.com/oauth2/authorize",
        [
            // User login only: identify + list guilds the person is already in.
            // No bot scope. No permissions integer. That was the "own a server /
            // add bot" confusion and is not part of Connect Discord.
            new("response_type", "code"),
            new("client_id", Configuration.ClientId),
            new("scope", string.Join(' ', Configuration.Scopes)),
            new("state", state),
            new("redirect_uri", Configuration.RedirectUri!.AbsoluteUri),
            new("prompt", "consent")
        ]);

    public override async Task<TeamTokenBundle> ExchangeCodeAsync(
        string code,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://discord.com/api/v10/oauth2/token")
        {
            Content = new FormUrlEncodedContent(
            [
                new("grant_type", "authorization_code"),
                new("code", code),
                new("redirect_uri", Configuration.RedirectUri!.AbsoluteUri)
            ])
        };
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(
                $"{Configuration.ClientId}:{Configuration.ClientSecret}")));
        using var tokenJson = await SendJsonAsync(request, cancellationToken);
        var accessToken = RequireString(tokenJson.RootElement, "access_token");
        var scopes = RequireString(tokenJson.RootElement, "scope")
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var missingScopes = Configuration.Scopes.Except(scopes, StringComparer.Ordinal).ToArray();
        if (missingScopes.Length > 0)
        {
            throw new InvalidOperationException(
                $"Discord did not grant the required sign-in scopes: {string.Join(", ", missingScopes)}. No token was stored.");
        }
        using var identityRequest = new HttpRequestMessage(HttpMethod.Get, "https://discord.com/api/v10/users/@me");
        identityRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var identityJson = await SendJsonAsync(identityRequest, cancellationToken);
        var identity = identityJson.RootElement;
        var accountId = RequireString(identity, "id");
        var username = RequireString(identity, "username");
        var displayName = OptionalString(identity, "global_name");

        // Identity is complete. Bot / shared-server checks are NOT part of login.
        // Channel history is a separate capability checked at read time.
        return new TeamTokenBundle(
            ProviderId,
            accessToken,
            OptionalString(tokenJson.RootElement, "refresh_token") is { Length: > 0 } refresh ? refresh : null,
            OptionalString(tokenJson.RootElement, "token_type") is { Length: > 0 } type ? type : "Bearer",
            tokenJson.RootElement.TryGetProperty("expires_in", out var expires) && expires.TryGetInt32(out var seconds)
                ? DateTimeOffset.UtcNow.AddSeconds(seconds)
                : null,
            accountId,
            displayName.Length > 0 ? displayName : username,
            scopes,
            ReadValidated: true,
            ReadValidatedAtUtc: DateTimeOffset.UtcNow);
    }

    public override async Task<TeamProviderReadResult> ReadAsync(
        TeamTokenBundle token,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken)
    {
        var account = new TeamConnectorAccount(ProviderId, token.AccountId, token.AccountLabel);

        // Always: list servers this Discord user is already a member of (no ownership required).
        using var userGuildRequest = DiscordGet(
            "https://discord.com/api/v10/users/@me/guilds?limit=200",
            "Bearer",
            token.AccessToken);
        using var userGuildJson = await SendJsonAsync(userGuildRequest, cancellationToken);
        var scopes = userGuildJson.RootElement.EnumerateArray()
            .Select(item => new TeamScope(
                ProviderId,
                RequireString(item, "id"),
                RequireString(item, "name"),
                TeamScopeKind.Server))
            .OrderBy(item => item.DisplayLabel, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        // Channel + message history requires a bot that is also in that server.
        // That is a separate capability from "logged into Discord as this person."
        if (string.IsNullOrWhiteSpace(Configuration.BotToken))
        {
            return new TeamProviderReadResult(
                account,
                scopes,
                [],
                [],
                scopes.Length == 0
                    ? $"Signed in as {account.DisplayLabel}. No Discord servers on this account yet."
                    : $"Signed in as {account.DisplayLabel}. Showing {scopes.Length} server(s) you belong to. Channel history needs the Helmian bot installed in a server (anyone with Manage Server can do that once — members do not need to own a server).");
        }

        using var botGuildRequest = DiscordGet(
            "https://discord.com/api/v10/users/@me/guilds?limit=200",
            "Bot",
            Configuration.BotToken);
        using var botGuildJson = await SendJsonAsync(botGuildRequest, cancellationToken);
        var readableGuildIds = EligibleGuildIds(userGuildJson.RootElement, botGuildJson.RootElement);

        var channels = new List<TeamChannel>();
        if (!string.IsNullOrWhiteSpace(scopeId))
        {
            if (!scopes.Any(item => item.Id == scopeId))
            {
                throw new InvalidOperationException("Selected Discord server is not available to the signed-in account.");
            }
            if (!readableGuildIds.Contains(scopeId))
            {
                return new TeamProviderReadResult(
                    account,
                    scopes,
                    [],
                    [],
                    "You are in that server, but the Helmian bot is not (or lacks View Channels + Read Message History). A server admin installs the bot once; you do not need to own the server.");
            }
            using var channelRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://discord.com/api/v10/guilds/{Uri.EscapeDataString(scopeId)}/channels");
            channelRequest.Headers.Authorization = new AuthenticationHeaderValue("Bot", Configuration.BotToken);
            using var channelJson = await SendJsonAsync(channelRequest, cancellationToken);
            foreach (var item in channelJson.RootElement.EnumerateArray())
            {
                if (!item.TryGetProperty("type", out var type) || type.GetInt32() is not (0 or 5)) continue;
                var id = RequireString(item, "id");
                var name = OptionalString(item, "name");
                channels.Add(new TeamChannel(
                    ProviderId,
                    scopeId,
                    id,
                    name.Length > 0 ? name : id,
                    CanRead: true,
                    CanSend: false));
            }
        }

        var messages = new List<TeamMessage>();
        if (!string.IsNullOrWhiteSpace(channelId))
        {
            var selected = channels.SingleOrDefault(item => item.Id == channelId)
                ?? throw new InvalidOperationException("Selected Discord channel is not available to this connection.");
            using var messageRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://discord.com/api/v10/channels/{Uri.EscapeDataString(selected.Id)}/messages?limit=50");
            messageRequest.Headers.Authorization = new AuthenticationHeaderValue("Bot", Configuration.BotToken);
            using var messageJson = await SendJsonAsync(messageRequest, cancellationToken);
            foreach (var item in messageJson.RootElement.EnumerateArray())
            {
                var author = item.GetProperty("author");
                var authorId = RequireString(author, "id");
                var authorLabel = OptionalString(author, "global_name");
                if (authorLabel.Length == 0) authorLabel = RequireString(author, "username");
                messages.Add(new TeamMessage(
                    ProviderId,
                    scopeId!,
                    selected.Id,
                    RequireString(item, "id"),
                    authorId,
                    authorLabel,
                    OptionalString(item, "content"),
                    DateTimeOffset.Parse(RequireString(item, "timestamp"), CultureInfo.InvariantCulture),
                    item.TryGetProperty("message_reference", out var reference)
                        ? OptionalString(reference, "message_id") is { Length: > 0 } thread ? thread : null
                        : null,
                    $"https://discord.com/channels/{scopeId}/{selected.Id}/{RequireString(item, "id")}"));
            }
        }

        string detail;
        if (channelId is not null)
            detail = $"Read {messages.Count} recent Discord messages without writing to Discord.";
        else if (scopeId is not null)
            detail = "Discord channels were read. Pick a channel to load recent messages.";
        else if (readableGuildIds.Count == 0)
            detail = $"Signed in as {account.DisplayLabel}. {scopes.Length} server(s) on your account. Channel history needs the Helmian bot in a server you share (admin installs once).";
        else
            detail = $"Signed in as {account.DisplayLabel}. {scopes.Length} server(s); {readableGuildIds.Count} with channel history available.";

        return new TeamProviderReadResult(
            account,
            scopes,
            channels.OrderBy(item => item.DisplayLabel, StringComparer.OrdinalIgnoreCase).ToArray(),
            messages.OrderBy(item => item.SentAtUtc).ToArray(),
            detail);
    }

    private static HttpRequestMessage DiscordGet(string uri, string scheme, string credential)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue(scheme, credential);
        return request;
    }

    private static HashSet<string> EligibleGuildIds(JsonElement userGuilds, JsonElement botGuilds)
    {
        var userIds = userGuilds.EnumerateArray()
            .Select(item => RequireString(item, "id"))
            .ToHashSet(StringComparer.Ordinal);
        return botGuilds.EnumerateArray()
            .Where(HasDiscordReadPermissions)
            .Select(item => RequireString(item, "id"))
            .Where(userIds.Contains)
            .ToHashSet(StringComparer.Ordinal);
    }

    private static bool HasDiscordReadPermissions(JsonElement guild)
    {
        if (!guild.TryGetProperty("permissions", out var permissionValue)) return false;
        var text = permissionValue.ValueKind switch
        {
            JsonValueKind.String => permissionValue.GetString(),
            JsonValueKind.Number => permissionValue.GetRawText(),
            _ => null
        };
        return BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var permissions)
            && (permissions & new BigInteger(66_560)) == new BigInteger(66_560);
    }

    private static bool HasMessageContentIntent(JsonElement application)
    {
        var text = application.TryGetProperty("flags_new", out var flagsNew)
                   && flagsNew.ValueKind == JsonValueKind.String
            ? flagsNew.GetString()
            : application.TryGetProperty("flags", out var flags)
                ? flags.GetRawText()
                : null;
        if (!BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value)) return false;
        var messageContent = BigInteger.One << 18;
        var messageContentLimited = BigInteger.One << 19;
        return (value & messageContent) != 0 || (value & messageContentLimited) != 0;
    }
}

/// <summary>
/// GitHub Team adapter (pilot): personal access token on Local Service.
/// Repos map to scopes, open issues to channels, recent issue comments to messages.
/// </summary>
internal sealed class GitHubTeamProviderAdapter(
    TeamProviderConfiguration configuration,
    HttpClient httpClient) : TeamProviderAdapterBase(configuration, httpClient)
{
    public override Uri BuildAuthorizationUri(string state) =>
        throw new InvalidOperationException(
            "GitHub uses a Local Service personal access token. Press Connect with HELMION_GITHUB_TOKEN set; no browser OAuth is used.");

    public override Task<TeamTokenBundle> ExchangeCodeAsync(
        string code,
        CancellationToken cancellationToken) =>
        throw new InvalidOperationException("GitHub does not exchange an OAuth authorization code in this pilot build.");

    public async Task<TeamTokenBundle> ConnectWithPersonalAccessTokenAsync(
        CancellationToken cancellationToken)
    {
        var pat = Configuration.BotToken
            ?? throw new InvalidOperationException("HELMION_GITHUB_TOKEN is not set.");
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/user");
        ApplyGitHubHeaders(request, pat);
        using var json = await SendJsonAsync(request, cancellationToken);
        var id = json.RootElement.TryGetProperty("id", out var idEl)
            ? idEl.GetRawText()
            : RequireString(json.RootElement, "login");
        var login = RequireString(json.RootElement, "login");
        var name = OptionalString(json.RootElement, "name");
        return new TeamTokenBundle(
            ProviderId,
            pat,
            RefreshToken: null,
            TokenType: "token",
            ExpiresAtUtc: null,
            id,
            name.Length > 0 ? $"{name} ({login})" : login,
            ["read:user", "repo"],
            ReadValidated: true,
            ReadValidatedAtUtc: DateTimeOffset.UtcNow);
    }

    public override async Task<TeamProviderReadResult> ReadAsync(
        TeamTokenBundle token,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken)
    {
        var account = new TeamConnectorAccount(ProviderId, token.AccountId, token.AccountLabel);
        using var reposRequest = new HttpRequestMessage(
            HttpMethod.Get,
            "https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator,organization_member");
        ApplyGitHubHeaders(reposRequest, token.AccessToken);
        using var reposJson = await SendJsonAsync(reposRequest, cancellationToken);
        var scopes = reposJson.RootElement.EnumerateArray()
            .Select(item => new TeamScope(
                ProviderId,
                RequireString(item, "full_name"),
                RequireString(item, "full_name"),
                TeamScopeKind.Workspace))
            .OrderBy(item => item.DisplayLabel, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var channels = new List<TeamChannel>();
        if (!string.IsNullOrWhiteSpace(scopeId))
        {
            if (!scopes.Any(item => item.Id == scopeId))
            {
                throw new InvalidOperationException("Selected GitHub repository is not available to this token.");
            }
            // state=all so repos without open issues still surface recent work.
            // Include pull requests (GitHub returns them from the issues API).
            using var issuesRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://api.github.com/repos/{scopeId}/issues?state=all&per_page=30&sort=updated");
            ApplyGitHubHeaders(issuesRequest, token.AccessToken);
            using var issuesJson = await SendJsonAsync(issuesRequest, cancellationToken);
            foreach (var item in issuesJson.RootElement.EnumerateArray())
            {
                var isPull = item.TryGetProperty("pull_request", out _);
                var number = item.TryGetProperty("number", out var num)
                    ? num.GetInt32().ToString(CultureInfo.InvariantCulture)
                    : RequireString(item, "id");
                var title = OptionalString(item, "title");
                var state = OptionalString(item, "state");
                var kind = isPull ? "PR" : "Issue";
                var label = title.Length > 0
                    ? $"#{number} [{kind}/{state}] {title}"
                    : $"#{number} [{kind}/{state}]";
                channels.Add(new TeamChannel(
                    ProviderId,
                    scopeId,
                    number,
                    label,
                    CanRead: true,
                    CanSend: false));
            }
        }

        var messages = new List<TeamMessage>();
        if (!string.IsNullOrWhiteSpace(channelId) && !string.IsNullOrWhiteSpace(scopeId))
        {
            using var commentsRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://api.github.com/repos/{scopeId}/issues/{Uri.EscapeDataString(channelId)}/comments?per_page=50");
            ApplyGitHubHeaders(commentsRequest, token.AccessToken);
            using var commentsJson = await SendJsonAsync(commentsRequest, cancellationToken);
            foreach (var item in commentsJson.RootElement.EnumerateArray())
            {
                var user = item.GetProperty("user");
                var login = RequireString(user, "login");
                var created = DateTimeOffset.Parse(
                    RequireString(item, "created_at"), CultureInfo.InvariantCulture);
                messages.Add(new TeamMessage(
                    ProviderId,
                    scopeId,
                    channelId,
                    RequireId(item, "id"),
                    login,
                    login,
                    OptionalString(item, "body"),
                    created,
                    ThreadId: null,
                    OptionalString(item, "html_url") is { Length: > 0 } link ? link : null));
            }
        }

        // Also surface the issue or PR body itself as the first "message" when
        // comments are empty, so Team still shows the conversation seed.
        if (messages.Count == 0 && !string.IsNullOrWhiteSpace(channelId))
        {
            using var issueRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://api.github.com/repos/{scopeId}/issues/{Uri.EscapeDataString(channelId)}");
            ApplyGitHubHeaders(issueRequest, token.AccessToken);
            using var issueJson = await SendJsonAsync(issueRequest, cancellationToken);
            var root = issueJson.RootElement;
            var user = root.GetProperty("user");
            var login = RequireString(user, "login");
            var body = OptionalString(root, "body");
            var title = OptionalString(root, "title");
            var created = DateTimeOffset.Parse(
                RequireString(root, "created_at"), CultureInfo.InvariantCulture);
            messages.Add(new TeamMessage(
                ProviderId,
                scopeId!,
                channelId,
                RequireId(root, "id"),
                login,
                login,
                string.IsNullOrWhiteSpace(body)
                    ? (title.Length > 0 ? title : "(no description)")
                    : body,
                created,
                ThreadId: null,
                OptionalString(root, "html_url") is { Length: > 0 } link ? link : null));
        }

        return new TeamProviderReadResult(
            account,
            scopes,
            channels.ToArray(),
            messages.OrderBy(item => item.SentAtUtc).ToArray(),
            channelId is null
                ? scopeId is null
                    ? "GitHub repositories were read. Pick a repo, then an issue or pull request, to load comments."
                    : channels.Count == 0
                        ? "This repo has no issues or pull requests yet, so there is nothing to open in Team."
                        : $"Found {channels.Count} recent issue(s) or PR(s). Pick one on the right to load comments."
                : $"Read {messages.Count} recent GitHub comments without writing to GitHub.");
    }

    private static void ApplyGitHubHeaders(HttpRequestMessage request, string token)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.TryAddWithoutValidation("User-Agent", "Helmion-TeamConnector");
        request.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
    }

    private static string RequireId(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value))
            throw new InvalidDataException($"{property} was missing from the provider response.");
        return value.ValueKind switch
        {
            JsonValueKind.String when !string.IsNullOrWhiteSpace(value.GetString()) => value.GetString()!,
            JsonValueKind.Number => value.GetRawText(),
            _ => throw new InvalidDataException($"{property} was missing from the provider response.")
        };
    }
}

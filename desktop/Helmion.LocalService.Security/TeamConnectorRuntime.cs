using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

public sealed class TeamConnectorRuntime : IAsyncDisposable
{
    private static readonly TimeSpan AuthorizationLifetime = TimeSpan.FromMinutes(10);
    private readonly ProtectedProviderProfileStore _profileStore;
    private readonly HttpClient _httpClient;
    private readonly HostedOAuthHandoffClient _handoffClient;
    private readonly IReadOnlyDictionary<string, ITeamProviderAdapter> _adapters;
    private readonly Dictionary<string, PendingAuthorization> _pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TeamConnectionState> _latest = new(StringComparer.Ordinal);
    private readonly object _stateGate = new();

    public TeamConnectorRuntime()
        : this(new ProtectedProviderProfileStore(), new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
    {
    }

    internal TeamConnectorRuntime(
        ProtectedProviderProfileStore profileStore,
        HttpClient httpClient,
        IReadOnlyList<ITeamProviderAdapter>? adapters = null)
    {
        _profileStore = profileStore;
        _httpClient = httpClient;
        _handoffClient = new HostedOAuthHandoffClient(httpClient);
        _adapters = (adapters ?? CreateAdapters(httpClient))
            .ToDictionary(item => item.ProviderId, StringComparer.Ordinal);
    }

    public async Task<TeamConnectionState> GetConnectionAsync(
        string providerId,
        CancellationToken cancellationToken = default)
    {
        var adapter = RequireAdapter(providerId);
        lock (_stateGate)
        {
            if (_pending.TryGetValue(providerId, out var pending)
                && pending.ExpiresAtUtc > DateTimeOffset.UtcNow)
            {
                return NewState(
                    adapter.Configuration,
                    TeamConnectStage.AwaitingCallback,
                    null,
                    [],
                    adapter.Configuration.UsesHostedHandoff
                        ? $"Waiting for {ProviderLabel(providerId)}'s HTTPS callback and protected one-time desktop handoff."
                        : $"Waiting for {ProviderLabel(providerId)} authorization callback.");
            }
            if (_latest.TryGetValue(providerId, out var latest)
                && latest.Stage is TeamConnectStage.AuthorizationFailed or TeamConnectStage.CredentialExpired)
            {
                return latest;
            }
        }

        if (!adapter.Configuration.AuthorizationConfigured)
        {
            return NewState(
                adapter.Configuration,
                TeamConnectStage.NotConfigured,
                null,
                [],
                adapter.Configuration.MissingConfigurationDetail(),
                "provider_configuration_missing");
        }

        try
        {
            var descriptor = await _profileStore.ReadDescriptorAsync(ProfileId(providerId), cancellationToken);
            var bytes = await _profileStore.LoadProtectedMaterialForServiceAsync(ProfileId(providerId), cancellationToken);
            try
            {
                var token = JsonSerializer.Deserialize<TeamTokenBundle>(bytes)
                    ?? throw new InvalidDataException("Protected Team credential is empty.");
                var account = new TeamConnectorAccount(providerId, token.AccountId, token.AccountLabel);
                if (!token.ReadValidated)
                {
                    return NewState(
                        adapter.Configuration,
                        TeamConnectStage.AuthorizationFailed,
                        account,
                        [],
                        "The saved grant predates required read-permission validation. Connect again before Helmian reports this provider connected.",
                        "read_validation_required");
                }
                if (token.ExpiresAtUtc is { } expires && expires <= DateTimeOffset.UtcNow)
                {
                    return NewState(
                        adapter.Configuration,
                        TeamConnectStage.CredentialExpired,
                        account,
                        [],
                        "The provider grant expired. Connect again to refresh it.",
                        "credential_expired");
                }
                return NewState(
                    adapter.Configuration,
                    TeamConnectStage.Connected,
                    account,
                    GrantedOperations(adapter, token),
                    $"Connected as {descriptor.Manifest.DisplayName}. Read scopes and provider prerequisites were validated; live access is rechecked on each read. Credentials remain protected inside the local service.");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(bytes);
            }
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return NewState(
                adapter.Configuration,
                adapter.Configuration.ReadConfigured
                    ? TeamConnectStage.ReadyToAuthorize
                    : TeamConnectStage.NotConfigured,
                null,
                [],
                adapter.Configuration.ReadConfigured
                    ? "Ready to open the provider authorization page."
                    : adapter.Configuration.MissingConfigurationDetail(),
                adapter.Configuration.ReadConfigured ? null : "provider_configuration_missing");
        }
    }

    public async Task<TeamAuthorizationLaunch> BeginAuthorizationAsync(
        string providerId,
        CancellationToken cancellationToken = default)
    {
        var adapter = RequireAdapter(providerId);
        if (!adapter.Configuration.ReadConfigured)
        {
            var missing = NewState(
                adapter.Configuration,
                TeamConnectStage.NotConfigured,
                null,
                [],
                adapter.Configuration.MissingConfigurationDetail(),
                "provider_configuration_missing");
            return new TeamAuthorizationLaunch(missing, null, null);
        }

        if (providerId == TeamConnectorContract.GitHubProviderId
            && adapter is GitHubTeamProviderAdapter githubAdapter)
        {
            try
            {
                var token = await githubAdapter.ConnectWithPersonalAccessTokenAsync(cancellationToken)
                    .ConfigureAwait(false);
                var tokenBytes = JsonSerializer.SerializeToUtf8Bytes(token);
                try
                {
                    var manifest = new ProviderProfileManifest(
                        Version: 1,
                        Id: ProfileId(providerId),
                        AdapterId: "github-pat-v1",
                        DisplayName: token.AccountLabel,
                        AuthenticationClass: "GitHub personal access token",
                        CredentialCustody: "Windows CurrentUser DPAPI · Helmion local service only",
                        Target: null,
                        HasProtectedMaterial: true,
                        UpdatedAt: DateTimeOffset.UtcNow);
                    await _profileStore.SaveAsync(manifest, tokenBytes, cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(tokenBytes);
                }
                var connected = NewState(
                    adapter.Configuration,
                    TeamConnectStage.Connected,
                    new TeamConnectorAccount(providerId, token.AccountId, token.AccountLabel),
                    GrantedOperations(adapter, token),
                    $"Connected to GitHub as {token.AccountLabel}. No write was performed.");
                lock (_stateGate) _latest[providerId] = connected;
                return new TeamAuthorizationLaunch(connected, null, null);
            }
            catch (Exception error) when (
                error is HttpRequestException
                    or InvalidOperationException
                    or InvalidDataException
                    or TeamProviderCredentialException)
            {
                var failed = NewState(
                    adapter.Configuration,
                    TeamConnectStage.AuthorizationFailed,
                    null,
                    [],
                    $"GitHub connection failed: {error.Message}",
                    "authorization_failed");
                lock (_stateGate) _latest[providerId] = failed;
                return new TeamAuthorizationLaunch(failed, null, null);
            }
        }

        lock (_stateGate)
        {
            if (_pending.TryGetValue(providerId, out var current)
                && current.ExpiresAtUtc > DateTimeOffset.UtcNow)
            {
                return new TeamAuthorizationLaunch(
                    NewState(
                        adapter.Configuration,
                        TeamConnectStage.AwaitingCallback,
                        null,
                        [],
                        "Authorization is already waiting in the browser."),
                    current.AuthorizationUri.AbsoluteUri,
                    current.ExpiresAtUtc);
            }
        }

        var hostedHandoff = adapter.Configuration.UsesHostedHandoff;
        var requestId = hostedHandoff ? $"team_{RandomUrlToken(18)}" : null;
        var state = hostedHandoff
            ? $"{requestId}.{RandomUrlToken(32)}"
            : RandomUrlToken(32);
        var redemptionSecret = hostedHandoff ? RandomUrlToken(32) : null;
        var expiresAt = DateTimeOffset.UtcNow.Add(AuthorizationLifetime);
        var authorizationUri = adapter.BuildAuthorizationUri(state);
        if (hostedHandoff)
        {
            await _handoffClient.RegisterAsync(
                adapter.Configuration.HandoffBaseUri!,
                adapter.Configuration.HandoffToken!,
                requestId!,
                state,
                redemptionSecret!,
                cancellationToken);
        }
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        lifetime.CancelAfter(AuthorizationLifetime);
        var pending = new PendingAuthorization(
            state,
            authorizationUri,
            expiresAt,
            lifetime,
            Task.CompletedTask,
            requestId,
            redemptionSecret);
        pending = pending with
        {
            Completion = CompleteAuthorizationAsync(adapter, pending)
        };
        lock (_stateGate)
        {
            _pending[providerId] = pending;
            _latest.Remove(providerId);
        }

        return new TeamAuthorizationLaunch(
            NewState(
                adapter.Configuration,
                TeamConnectStage.AwaitingCallback,
                null,
                [],
                hostedHandoff
                    ? $"{ProviderLabel(providerId)} authorization opened. Helmian is waiting for the HTTPS callback and one-time protected desktop handoff."
                    : $"{ProviderLabel(providerId)} authorization opened. Helmian is waiting for the callback."),
            authorizationUri.AbsoluteUri,
            expiresAt);
    }

    public async Task<TeamConversationSnapshot> ReadConversationAsync(
        string? providerId,
        string? scopeId,
        string? channelId,
        CancellationToken cancellationToken = default)
    {
        if (providerId is not null) TeamConnectorContract.RequireProvider(providerId);
        if (channelId is not null && (providerId is null || scopeId is null))
        {
            throw new ArgumentException("A provider and workspace/server are required when reading a Team channel.");
        }
        if (scopeId is not null && providerId is null)
        {
            throw new ArgumentException("A provider is required when selecting a Team workspace/server.");
        }

        var providerIds = providerId is null
            ? TeamConnectorContract.ProviderIds
            : [providerId];
        var connections = new List<TeamConnectionState>();
        var scopes = new List<TeamScope>();
        var channels = new List<TeamChannel>();
        var messages = new List<TeamMessage>();
        var details = new List<string>();
        var readAttempted = false;
        foreach (var id in providerIds)
        {
            var connection = await GetConnectionAsync(id, cancellationToken);
            connections.Add(connection);
            if (!connection.IsConnected) continue;
            readAttempted = true;
            var adapter = RequireAdapter(id);
            var bytes = await _profileStore.LoadProtectedMaterialForServiceAsync(ProfileId(id), cancellationToken);
            try
            {
                var token = JsonSerializer.Deserialize<TeamTokenBundle>(bytes)
                    ?? throw new InvalidDataException("Protected Team credential is empty.");
                var result = await adapter.ReadAsync(
                    token,
                    id == providerId ? scopeId : null,
                    id == providerId ? channelId : null,
                    cancellationToken);
                scopes.AddRange(result.Scopes);
                channels.AddRange(result.Channels);
                messages.AddRange(result.Messages);
                details.Add(result.Detail);
            }
            catch (TeamProviderCredentialException error)
            {
                var expired = NewState(
                    adapter.Configuration,
                    TeamConnectStage.CredentialExpired,
                    connection.Account,
                    [],
                    $"{ProviderLabel(id)} no longer accepts the protected grant. Connect again. {error.Message}",
                    "credential_rejected");
                connections[^1] = expired;
                lock (_stateGate) _latest[id] = expired;
                details.Add(expired.Detail);
            }
            catch (Exception error) when (
                error is HttpRequestException
                    or TaskCanceledException
                    or InvalidOperationException
                    or InvalidDataException)
            {
                details.Add($"{ProviderLabel(id)} read failed: {error.Message}");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(bytes);
            }
        }

        return new TeamConversationSnapshot(
            TeamConnectorContract.Version,
            connections,
            scopes,
            channels,
            messages.OrderBy(item => item.SentAtUtc).ToArray(),
            providerId,
            scopeId,
            channelId,
            DateTimeOffset.UtcNow,
            readAttempted,
            details.Count > 0
                ? string.Join(" · ", details)
                : "No connected Team provider was read.");
    }

    private async Task CompleteAuthorizationAsync(
        ITeamProviderAdapter adapter,
        PendingAuthorization pending)
    {
        TeamConnectionState final;
        try
        {
            var code = adapter.Configuration.UsesHostedHandoff
                ? await _handoffClient.ReceiveCodeAsync(
                    adapter.Configuration.HandoffBaseUri!,
                    adapter.Configuration.HandoffToken!,
                    pending.HandoffRequestId!,
                    pending.RedemptionSecret!,
                    pending.Lifetime.Token)
                : await LoopbackOAuthCallbackReceiver.ReceiveCodeAsync(
                    adapter.Configuration.RedirectUri!,
                    pending.State,
                    pending.Lifetime.Token);
            // Pilot path: Local Service holds the app client secret and exchanges
            // the one-time code after the hosted HTTPS callback stores it.
            // Multi-tenant hosted exchange can replace this without changing handoff shape.
            if (adapter.Configuration.UsesHostedHandoff
                && string.IsNullOrWhiteSpace(adapter.Configuration.ClientSecret))
            {
                throw new InvalidOperationException(
                    "Hosted callback succeeded, but the Local Service is missing the provider CLIENT_SECRET for pilot token exchange. Nothing was stored.");
            }
            var token = await adapter.ExchangeCodeAsync(code, pending.Lifetime.Token);
            var tokenBytes = JsonSerializer.SerializeToUtf8Bytes(token);
            try
            {
                var manifest = new ProviderProfileManifest(
                    Version: 1,
                    Id: ProfileId(adapter.ProviderId),
                    AdapterId: adapter.ProviderId switch
                    {
                        TeamConnectorContract.SlackProviderId => "slack-oauth-v2",
                        TeamConnectorContract.DiscordProviderId => "discord-oauth2-bot",
                        TeamConnectorContract.GitHubProviderId => "github-pat-v1",
                        _ => $"{adapter.ProviderId}-oauth"
                    },
                    DisplayName: token.AccountLabel,
                    AuthenticationClass: "OAuth 2.0 authorization-code",
                    CredentialCustody: "Windows CurrentUser DPAPI · Helmion local service only",
                    Target: null,
                    HasProtectedMaterial: true,
                    UpdatedAt: DateTimeOffset.UtcNow);
                await _profileStore.SaveAsync(manifest, tokenBytes, pending.Lifetime.Token);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(tokenBytes);
            }
            final = NewState(
                adapter.Configuration,
                TeamConnectStage.Connected,
                new TeamConnectorAccount(adapter.ProviderId, token.AccountId, token.AccountLabel),
                GrantedOperations(adapter, token),
                adapter.ProviderId == TeamConnectorContract.DiscordProviderId
                    ? $"Connected to Discord as {token.AccountLabel}. Sign-in only — no server ownership required. Channel history is separate and only works where the Helmian bot is installed."
                    : $"Connected to {ProviderLabel(adapter.ProviderId)} as {token.AccountLabel}. No message was sent.");
        }
        catch (OperationCanceledException)
        {
            final = NewState(
                adapter.Configuration,
                TeamConnectStage.AuthorizationFailed,
                null,
                [],
                "Provider authorization timed out or was cancelled. Nothing was stored.",
                "authorization_timeout");
        }
        catch (Exception error) when (
            error is HttpListenerException
                or HttpRequestException
                or InvalidOperationException
                or InvalidDataException
                or UnauthorizedAccessException)
        {
            final = NewState(
                adapter.Configuration,
                TeamConnectStage.AuthorizationFailed,
                null,
                [],
                $"Provider authorization failed: {error.Message}",
                "authorization_failed");
        }
        finally
        {
            pending.Lifetime.Dispose();
        }

        lock (_stateGate)
        {
            if (_pending.TryGetValue(adapter.ProviderId, out var current)
                && ReferenceEquals(current.Lifetime, pending.Lifetime))
            {
                _pending.Remove(adapter.ProviderId);
            }
            _latest[adapter.ProviderId] = final;
        }
    }

    private ITeamProviderAdapter RequireAdapter(string providerId)
    {
        TeamConnectorContract.RequireProvider(providerId);
        return _adapters.GetValueOrDefault(providerId)
            ?? throw new InvalidOperationException($"No {ProviderLabel(providerId)} Team adapter is installed.");
    }

    private static TeamConnectionState NewState(
        TeamProviderConfiguration configuration,
        TeamConnectStage stage,
        TeamConnectorAccount? account,
        IReadOnlyList<string> operations,
        string detail,
        string? errorCode = null) =>
        new(
            TeamConnectorContract.Version,
            configuration.ProviderId,
            stage,
            configuration.AuthorizationConfigured,
            configuration.ReadConfigured,
            account,
            operations,
            DateTimeOffset.UtcNow,
            detail,
            errorCode,
            configuration.SetupSteps());

    private static IReadOnlyList<string> GrantedOperations(
        ITeamProviderAdapter adapter,
        TeamTokenBundle token)
    {
        var result = new List<string>();
        if (!token.ReadValidated) return result;
        if (adapter.ProviderId == TeamConnectorContract.SlackProviderId)
        {
            if (token.GrantedScopes.Any(scope => scope is "channels:read" or "groups:read"))
            {
                result.Add("team.sources.read");
            }
            if (token.GrantedScopes.Any(scope => scope is "channels:history" or "groups:history"))
            {
                result.Add("team.messages.read");
            }
        }
        else if (adapter.ProviderId == TeamConnectorContract.GitHubProviderId
                 && token.ReadValidated)
        {
            result.Add("team.sources.read");
            result.Add("team.messages.read");
        }
        else if (adapter.ProviderId == TeamConnectorContract.DiscordProviderId
                 && token.ReadValidated)
        {
            // Login always grants source list (servers you belong to). Message
            // history is only claimed when a bot token is configured; live
            // channel access is still rechecked per server at read time.
            result.Add("team.sources.read");
            if (!string.IsNullOrWhiteSpace(adapter.Configuration.BotToken))
            {
                result.Add("team.messages.read");
            }
        }
        else if (token.GrantedScopes.Contains("guilds", StringComparer.Ordinal)
                 && adapter.Configuration.ReadConfigured)
        {
            result.Add("team.sources.read");
            result.Add("team.messages.read");
        }
        return result;
    }

    private static IReadOnlyList<ITeamProviderAdapter> CreateAdapters(HttpClient httpClient) =>
    [
        new SlackTeamProviderAdapter(
            TeamProviderConfiguration.FromEnvironment(TeamConnectorContract.SlackProviderId),
            httpClient),
        new DiscordTeamProviderAdapter(
            TeamProviderConfiguration.FromEnvironment(TeamConnectorContract.DiscordProviderId),
            httpClient),
        new GitHubTeamProviderAdapter(
            TeamProviderConfiguration.FromEnvironment(TeamConnectorContract.GitHubProviderId),
            httpClient)
    ];

    private static string ProfileId(string providerId) => $"team-{providerId}";
    private static string ProviderLabel(string providerId) => providerId switch
    {
        TeamConnectorContract.SlackProviderId => "Slack",
        TeamConnectorContract.DiscordProviderId => "Discord",
        TeamConnectorContract.GitHubProviderId => "GitHub",
        _ => providerId
    };

    private static string RandomUrlToken(int byteCount) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(byteCount))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    public async ValueTask DisposeAsync()
    {
        PendingAuthorization[] pending;
        lock (_stateGate)
        {
            pending = _pending.Values.ToArray();
            _pending.Clear();
        }
        foreach (var item in pending) item.Lifetime.Cancel();
        await Task.WhenAll(pending.Select(item => item.Completion));
        _httpClient.Dispose();
    }

    private sealed record PendingAuthorization(
        string State,
        Uri AuthorizationUri,
        DateTimeOffset ExpiresAtUtc,
        CancellationTokenSource Lifetime,
        Task Completion,
        string? HandoffRequestId,
        string? RedemptionSecret);
}

internal static class LoopbackOAuthCallbackReceiver
{
    public static async Task<string> ReceiveCodeAsync(
        Uri redirectUri,
        string expectedState,
        CancellationToken cancellationToken)
    {
        if (redirectUri.Scheme != Uri.UriSchemeHttp || !redirectUri.IsLoopback)
        {
            throw new InvalidOperationException("OAuth redirect URI must be an HTTP loopback address owned by the local service.");
        }
        var prefix = redirectUri.AbsoluteUri.EndsWith('/')
            ? redirectUri.AbsoluteUri
            : redirectUri.AbsoluteUri + "/";
        using var listener = new HttpListener();
        listener.Prefixes.Add(prefix);
        listener.Start();
        var context = await listener.GetContextAsync().WaitAsync(cancellationToken);
        var request = context.Request;
        var state = request.QueryString["state"] ?? string.Empty;
        var code = request.QueryString["code"] ?? string.Empty;
        var error = request.QueryString["error"] ?? string.Empty;
        var validation = OAuthCallbackValidator.Validate(expectedState, state, code, error);
        var success = validation.Accepted;
        var message = success
            ? "Helmian connected this provider. You can close this tab and return to the Team workspace."
            : "Helmian could not accept this authorization. You can close this tab and try Connect again.";
        var body = Encoding.UTF8.GetBytes(
            $"<!doctype html><meta charset=\"utf-8\"><title>Helmian Team connection</title><body style=\"font-family:system-ui;max-width:42rem;margin:10vh auto;padding:2rem\"><h1>Helmian</h1><p>{WebUtility.HtmlEncode(message)}</p></body>");
        context.Response.StatusCode = success ? 200 : 400;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength64 = body.Length;
        await context.Response.OutputStream.WriteAsync(body, cancellationToken);
        context.Response.Close();
        if (!validation.Accepted) throw validation.Error!;
        return code;
    }
}

internal sealed record OAuthCallbackValidation(bool Accepted, Exception? Error);

internal static class OAuthCallbackValidator
{
    public static OAuthCallbackValidation Validate(
        string expectedState,
        string actualState,
        string code,
        string providerError)
    {
        if (providerError.Length > 0)
        {
            return new OAuthCallbackValidation(
                false,
                new InvalidOperationException("The provider declined authorization."));
        }
        var expectedBytes = Encoding.UTF8.GetBytes(expectedState);
        var actualBytes = Encoding.UTF8.GetBytes(actualState);
        var stateMatches = expectedBytes.Length == actualBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
        if (!stateMatches)
        {
            return new OAuthCallbackValidation(
                false,
                new InvalidDataException("OAuth callback state did not match the local authorization request."));
        }
        if (code.Length is <= 0 or > 4096)
        {
            return new OAuthCallbackValidation(
                false,
                new InvalidDataException("OAuth callback code was missing or invalid."));
        }
        return new OAuthCallbackValidation(true, null);
    }
}

public sealed class TeamConnectorPipeHandler(TeamConnectorRuntime runtime)
{
    public static IReadOnlyList<string> Capabilities { get; } =
    [
        TeamConnectorContract.StatusCommand,
        TeamConnectorContract.BeginAuthorizationCommand,
        TeamConnectorContract.ReadConversationCommand
    ];

    public async Task<PipeResponse> HandleAsync(
        PipeRequest request,
        CancellationToken cancellationToken)
    {
        if (request.TeamConnector is null)
        {
            return Error(request, "invalid_team_request", "Team connector input is required.");
        }
        try
        {
            return request.Command switch
            {
                TeamConnectorContract.StatusCommand => new PipeResponse(
                    request.Id,
                    true,
                    TeamConnection: await runtime.GetConnectionAsync(
                        request.TeamConnector.ProviderId ?? string.Empty,
                        cancellationToken)),
                TeamConnectorContract.BeginAuthorizationCommand => new PipeResponse(
                    request.Id,
                    true,
                    TeamAuthorization: await runtime.BeginAuthorizationAsync(
                        request.TeamConnector.ProviderId ?? string.Empty,
                        cancellationToken)),
                TeamConnectorContract.ReadConversationCommand => new PipeResponse(
                    request.Id,
                    true,
                    TeamConversation: await runtime.ReadConversationAsync(
                        request.TeamConnector.ProviderId,
                        request.TeamConnector.ScopeId,
                        request.TeamConnector.ChannelId,
                        cancellationToken)),
                _ => Error(request, "team_command_rejected", "Unsupported Team connector command.")
            };
        }
        catch (Exception error) when (
            error is ArgumentException
                or InvalidOperationException
                or InvalidDataException
                or HttpRequestException)
        {
            return Error(request, "team_connector_failed", error.Message);
        }
    }

    private static PipeResponse Error(PipeRequest request, string code, string message) =>
        new(request.Id, false, code, message);
}

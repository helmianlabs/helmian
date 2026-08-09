using System.Net;
using System.Reflection;
using System.Text;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

internal static class TeamConnectorChecks
{
    public static async Task RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException($"Team connector check failed: {description}");
            checks += 1;
        }

        Check(TeamConnectorContract.ProviderIds.SequenceEqual(["slack", "discord", "github"]),
            "the shared Team contract supports Slack, Discord, and GitHub");
        Check(TeamConnectorContract.Operations.Single(item => item.Id == "team.messages.send") is
            { Access: TeamOperationAccess.ExternalWrite, RequiresApproval: true },
            "the future Team send contract remains classified as an approval-gated external write");
        Check(!TeamConnectorPipeHandler.Capabilities.Contains("team.messages.send", StringComparer.Ordinal),
            "the live Local Service pipe exposes no Team send command");
        Check(typeof(TeamConnectionState).GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .All(property => !new[] { "token", "secret", "credential", "oauthcode" }.Any(fragment =>
                    property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))),
            "renderer-facing Team state exposes no credential-bearing property");

        var validWrite = new TeamExternalWriteIntent(
            "slack", "workspace-fixture", "channel-fixture", "draft-fixture",
            new string('A', 64), "approval-fixture", "idempotency-fixture");
        TeamExternalWritePolicy.Validate(validWrite);
        Check(true, "a complete future external-write intent passes the pure contract");
        foreach (var invalid in new[]
                 {
                     validWrite with { ApprovalId = string.Empty },
                     validWrite with { IdempotencyKey = string.Empty },
                     validWrite with { PayloadSha256 = "not-a-hash" }
                 })
        {
            try
            {
                TeamExternalWritePolicy.Validate(invalid);
                throw new InvalidOperationException("Incomplete Team write intent was accepted.");
            }
            catch (InvalidDataException)
            {
                Check(true, "incomplete external-write evidence fails closed");
            }
        }

        var handoffBase = new Uri("https://connect.example.test/api/team-oauth/slack/");
        var slackConfiguration = new TeamProviderConfiguration(
            "slack",
            "fixture-client",
            "fixture-secret-never-in-uri",
            new Uri(handoffBase, "callback"),
            ["channels:read", "channels:history", "groups:read", "groups:history"],
            HandoffBaseUri: handoffBase,
            HandoffToken: new string('h', 40));
        using var uriHttp = new HttpClient(new CountingHandler());
        var slackAdapter = new SlackTeamProviderAdapter(slackConfiguration, uriHttp);
        var authorizationUri = slackAdapter.BuildAuthorizationUri("state-fixture").AbsoluteUri;
        Check(slackConfiguration.ReadConfigured
              && authorizationUri.StartsWith("https://slack.com/oauth/v2/authorize?", StringComparison.Ordinal)
              && authorizationUri.Contains("state=state-fixture", StringComparison.Ordinal)
              && authorizationUri.Contains(Uri.EscapeDataString("https://connect.example.test/api/team-oauth/slack/callback"), StringComparison.Ordinal)
              && !authorizationUri.Contains("fixture-secret-never-in-uri", StringComparison.Ordinal),
            "Slack authorization uses the configured HTTPS callback with state and no client secret in the URL");
        var loopbackSlack = slackConfiguration with
        {
            RedirectUri = new Uri("http://127.0.0.1:47823/oauth/slack/"),
            HandoffBaseUri = null
        };
        Check(!loopbackSlack.ReadConfigured
              && loopbackSlack.MissingConfigurationDetail().Contains("HTTPS", StringComparison.Ordinal),
            "Slack loopback configuration is rejected instead of being presented as provider-viable");

        var discordHandoffBase = new Uri("https://connect.example.test/api/team-oauth/discord/");
        var discordConfiguration = new TeamProviderConfiguration(
            "discord",
            "fixture-client",
            "fixture-secret-never-in-uri",
            new Uri(discordHandoffBase, "callback"),
            ["identify", "guilds"],
            BotToken: null,
            HandoffBaseUri: discordHandoffBase,
            HandoffToken: new string('h', 40));
        var discordAdapter = new DiscordTeamProviderAdapter(discordConfiguration, uriHttp);
        var discordAuthorizationUri = discordAdapter.BuildAuthorizationUri("state-fixture").AbsoluteUri;
        Check(discordConfiguration.ReadConfigured
              && !discordAuthorizationUri.Contains("permissions=", StringComparison.Ordinal)
              && !discordAuthorizationUri.Contains("bot", StringComparison.Ordinal)
              && discordAuthorizationUri.Contains("identify", StringComparison.Ordinal)
              && discordAuthorizationUri.Contains("guilds", StringComparison.Ordinal),
            "Discord Connect is user sign-in only (identify + guilds), with no bot install on the auth URL");
        Check(discordConfiguration.SetupSteps().Any(item => item.Contains("No server ownership", StringComparison.Ordinal))
              && discordConfiguration.SetupSteps().Any(item => item.Contains("sign in", StringComparison.OrdinalIgnoreCase)),
            "Discord setup guidance separates login from optional channel-history bot install");

        Check(OAuthCallbackValidator.Validate("expected", "expected", "code", "").Accepted,
            "a callback with an exact state and bounded code is accepted");
        Check(!OAuthCallbackValidator.Validate("expected", "wrong", "code", "").Accepted
              && OAuthCallbackValidator.Validate("expected", "wrong", "code", "").Error is InvalidDataException,
            "a callback with mismatched state fails closed");
        Check(!OAuthCallbackValidator.Validate("expected", "expected", "", "access_denied").Accepted,
            "a provider-declined callback is never accepted");

        var handoffHandler = new RecordingHandler((request, _) =>
            request.RequestUri!.AbsolutePath.EndsWith("/start", StringComparison.Ordinal)
                ? Json(HttpStatusCode.Created, "{\"state\":\"pending\",\"expiresAtUtc\":\"2026-08-01T00:10:00Z\"}")
                : Json(HttpStatusCode.OK, "{\"code\":\"one-time-code\"}"));
        using var handoffHttp = new HttpClient(handoffHandler);
        var handoffClient = new HostedOAuthHandoffClient(handoffHttp);
        var state = $"team_{new string('r', 24)}.{new string('s', 43)}";
        var redemptionSecret = new string('d', 43);
        await handoffClient.RegisterAsync(
            handoffBase, new string('h', 40), $"team_{new string('r', 24)}", state, redemptionSecret, CancellationToken.None);
        var receivedCode = await handoffClient.ReceiveCodeAsync(
            handoffBase, new string('h', 40), $"team_{new string('r', 24)}", redemptionSecret, CancellationToken.None);
        Check(receivedCode == "one-time-code"
              && handoffHandler.Requests.Count == 2
              && handoffHandler.Requests.All(item => item.Method == HttpMethod.Post)
              && handoffHandler.Requests.All(item => item.AuthorizationScheme == "Bearer")
              && !handoffHandler.Requests[0].Body.Contains(state, StringComparison.Ordinal)
              && !handoffHandler.Requests[0].Body.Contains(redemptionSecret, StringComparison.Ordinal)
              && handoffHandler.Requests[1].Body.Contains(redemptionSecret, StringComparison.Ordinal),
            "the HTTPS handoff registers only hashes and releases a code only with the per-request redemption secret");

        var discordExchangeHandler = new SequenceJsonHandler(
        [
            "{\"access_token\":\"user-token\",\"refresh_token\":\"refresh\",\"token_type\":\"Bearer\",\"expires_in\":3600,\"scope\":\"identify guilds\"}",
            "{\"id\":\"user-1\",\"username\":\"reader\",\"global_name\":\"Reader\"}"
        ]);
        using var discordExchangeHttp = new HttpClient(discordExchangeHandler);
        var validatedDiscordAdapter = new DiscordTeamProviderAdapter(discordConfiguration, discordExchangeHttp);
        var discordToken = await validatedDiscordAdapter.ExchangeCodeAsync("oauth-code", CancellationToken.None);
        Check(discordToken.ReadValidated
              && discordToken.AccountLabel == "Reader"
              && discordExchangeHandler.Requests.Count == 2
              && discordExchangeHandler.Requests[0].Method == HttpMethod.Post
              && discordExchangeHandler.Requests[1].Method == HttpMethod.Get,
            "Discord Connect stores a grant after user OAuth + identity only (no bot/server ownership gate)");

        var discordReadHandler = new RecordingHandler((request, _) =>
        {
            var path = request.RequestUri!.PathAndQuery;
            if (path == "/api/v10/users/@me/guilds?limit=200"
                && request.Headers.Authorization?.Scheme == "Bearer")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"guild-1\",\"name\":\"Demo server\"}]");
            }
            if (path == "/api/v10/users/@me/guilds?limit=200")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"guild-1\",\"name\":\"Demo server\",\"permissions\":\"66560\"}]");
            }
            if (path == "/api/v10/guilds/guild-1/channels")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"channel-1\",\"name\":\"general\",\"type\":0}]");
            }
            if (path == "/api/v10/channels/channel-1/messages?limit=50")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"message-1\",\"content\":\"hello\",\"timestamp\":\"2026-08-01T00:00:00Z\",\"author\":{\"id\":\"user-2\",\"username\":\"teammate\"}}]");
            }
            return Json(HttpStatusCode.NotFound, "{}");
        });
        using var discordReadHttp = new HttpClient(discordReadHandler);
        var readAdapter = new DiscordTeamProviderAdapter(discordConfiguration, discordReadHttp);
        var read = await readAdapter.ReadAsync(discordToken, "guild-1", "channel-1", CancellationToken.None);
        // User login alone: list guilds the person belongs to. Channel history
        // requires BotToken (separate install). Without a bot, messages stay empty.
        Check(read.Messages.Count == 0
              && read.Scopes.Any(s => s.Id == "guild-1")
              && discordReadHandler.Requests.All(item => item.Method == HttpMethod.Get)
              && read.Detail.Contains("bot", StringComparison.OrdinalIgnoreCase),
            "Discord user login lists servers; channel history waits for optional bot");

        var discordWithBot = discordConfiguration with { BotToken = "Bot.Fixture.Token.AtLeast20Chars" };
        var botReadHandler = new RecordingHandler((request, _) =>
        {
            var path = request.RequestUri!.PathAndQuery;
            var scheme = request.Headers.Authorization?.Scheme;
            if (path == "/api/v10/users/@me/guilds?limit=200" && scheme == "Bearer")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"guild-1\",\"name\":\"Demo server\"}]");
            }
            if (path == "/api/v10/users/@me/guilds?limit=200" && scheme == "Bot")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"guild-1\",\"name\":\"Demo server\",\"permissions\":\"66560\"}]");
            }
            if (path == "/api/v10/guilds/guild-1/channels")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"channel-1\",\"name\":\"general\",\"type\":0}]");
            }
            if (path == "/api/v10/channels/channel-1/messages?limit=50")
            {
                return Json(HttpStatusCode.OK, "[{\"id\":\"message-1\",\"content\":\"hello\",\"timestamp\":\"2026-08-01T00:00:00Z\",\"author\":{\"id\":\"user-2\",\"username\":\"teammate\"}}]");
            }
            return Json(HttpStatusCode.NotFound, "{}");
        });
        using var botReadHttp = new HttpClient(botReadHandler);
        var botReadAdapter = new DiscordTeamProviderAdapter(discordWithBot, botReadHttp);
        var botRead = await botReadAdapter.ReadAsync(discordToken, "guild-1", "channel-1", CancellationToken.None);
        Check(botRead.Messages.Count >= 1
              && botRead.Messages[0].Body == "hello"
              && botRead.Channels.Any(c => c is { CanRead: true, CanSend: false })
              && botReadHandler.Requests.All(item => item.Method == HttpMethod.Get),
            "with bot token, Discord conversation path is GET-only and never marks a channel sendable");

        var root = Path.Combine(Path.GetTempPath(), $"helmion-team-connector-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var countingHandler = new CountingHandler();
        var runtimeHttp = new HttpClient(countingHandler);
        var missingSlack = new TeamProviderConfiguration("slack", "", "", null, []);
        var missingDiscord = new TeamProviderConfiguration("discord", "", "", null, [], null);
        var adapters = new ITeamProviderAdapter[]
        {
            new SlackTeamProviderAdapter(missingSlack, runtimeHttp),
            new DiscordTeamProviderAdapter(missingDiscord, runtimeHttp)
        };
        await using var runtime = new TeamConnectorRuntime(
            new ProtectedProviderProfileStore(root, allowTestRoot: true), runtimeHttp, adapters);
        try
        {
            var launch = await runtime.BeginAuthorizationAsync("slack");
            Check(launch.AuthorizationUri is null
                  && launch.Connection.Stage == TeamConnectStage.NotConfigured
                  && (launch.Connection.Detail.Contains("HELMION_SLACK_CLIENT_ID", StringComparison.Ordinal)
                      || launch.Connection.Detail.Contains("Setup needed", StringComparison.Ordinal)
                      || launch.Connection.Detail.Contains("CLIENT_ID", StringComparison.Ordinal))
                  && (launch.Connection.ResolvedSetupSteps.Count == 0
                      || launch.Connection.ResolvedSetupSteps.Any(item =>
                          item.Contains("HTTPS", StringComparison.Ordinal)
                          || item.Contains("Slack", StringComparison.OrdinalIgnoreCase)
                          || item.Contains("CLIENT", StringComparison.Ordinal))),
                "missing Slack deployment/app config fails clearly without launching a browser");
            // Explicit provider with empty config — no browser, no provider HTTP.
            var snapshot = await runtime.ReadConversationAsync("slack", null, null);
            Check(snapshot.Messages.Count == 0
                  && countingHandler.RequestCount == 0,
                "disconnected Team composition performs no provider traffic");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }

        Console.WriteLine($"Helmion Team connector checks passed ({checks} checks).");
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private sealed record RequestSnapshot(
        HttpMethod Method,
        string Uri,
        string? AuthorizationScheme,
        string Body);

    private sealed class RecordingHandler(
        Func<HttpRequestMessage, int, HttpResponseMessage> response) : HttpMessageHandler
    {
        public List<RequestSnapshot> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RequestSnapshot(
                request.Method,
                request.RequestUri!.AbsoluteUri,
                request.Headers.Authorization?.Scheme,
                body));
            return response(request, Requests.Count - 1);
        }
    }

    private sealed class SequenceJsonHandler(IReadOnlyList<string> responses) : HttpMessageHandler
    {
        public List<RequestSnapshot> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RequestSnapshot(
                request.Method,
                request.RequestUri!.AbsoluteUri,
                request.Headers.Authorization?.Scheme,
                body));
            return Json(HttpStatusCode.OK, responses[Requests.Count - 1]);
        }
    }

    private sealed class CountingHandler : HttpMessageHandler
    {
        public int RequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestCount += 1;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError));
        }
    }
}

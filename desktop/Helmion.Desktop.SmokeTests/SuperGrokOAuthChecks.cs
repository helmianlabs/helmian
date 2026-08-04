using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under "Login with SuperGrok".
///
/// <para>
/// WHY IT IS THIS THOROUGH. An auth flow is the textbook case of a feature that gets clicked
/// once on the happy path and never again — and every state that matters here is a failure
/// state: the code the user never approves, the code they decline, the token that expires
/// mid-session, the refresh token that was revoked yesterday. Those are exercised below
/// against a REAL loopback HTTP server speaking the real RFC 8628 error codes, not against a
/// mock of our own client, because a client proven only against a stub of itself is proven
/// against nothing.
/// </para>
///
/// <para>
/// THE CONSTANTS ARE PINNED. The endpoint paths, grant type and client id were confirmed
/// against the live auth.x.ai server on 2026-08-04 (device/code returned HTTP 200 with a real
/// user code; token returned authorization_pending, then invalid_grant for a junk refresh
/// token). If someone edits one by hand, the first check fails rather than the feature
/// failing silently in front of a user.
/// </para>
///
/// <para>
/// NO REAL CREDENTIAL IS TOUCHED. Every token below is a synthetic JWT built in this file
/// with an obviously fake signature. The suite never reads the machine's real
/// <c>~/.grok/auth.json</c> — the Grok CLI reader is pointed at temp files instead.
/// </para>
/// </summary>
internal static class SuperGrokOAuthChecks
{
    public static void Run()
    {
        var checks = 0;
        checks += VerifiedConstants();
        checks += DeviceFlowHappyPath();
        checks += DeviceFlowBackoffAndDenial();
        checks += TokenStoreRoundTrip();
        checks += GrokCliAdoption();
        checks += CredentialPreferenceAndFallback();
        checks += TokensNeverLeakIntoStatusText();

        Console.WriteLine($"SuperGrok OAuth smoke tests passed ({checks} checks).");
    }

    // --- 1. THE VERIFIED CONSTANTS ------------------------------------------------
    private static int VerifiedConstants()
    {
        Assert(SuperGrokOAuthClient.Issuer == "https://auth.x.ai", "issuer is xAI's auth server");
        Assert(
            SuperGrokOAuthClient.DeviceCodeEndpoint == "https://auth.x.ai/oauth2/device/code",
            "device authorization endpoint matches the path confirmed live");
        Assert(
            SuperGrokOAuthClient.TokenEndpoint == "https://auth.x.ai/oauth2/token",
            "token endpoint matches the path confirmed live");
        Assert(
            SuperGrokOAuthClient.DeviceCodeGrantType
                == "urn:ietf:params:oauth:grant-type:device_code",
            "grant type is the RFC 8628 device code URN");
        Assert(
            SuperGrokOAuthClient.ClientId == "b1a00492-073a-47ea-816f-4c329264a828",
            "client id is xAI's first-party device client, confirmed as the token audience");
        Assert(
            !typeof(SuperGrokOAuthClient).GetFields(
                    System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic
                    | System.Reflection.BindingFlags.Static)
                .Any(f => f.Name.Contains("secret", StringComparison.OrdinalIgnoreCase)),
            "device flow is a public client — there is no client secret anywhere in it");
        return 6;
    }

    // --- 2. THE HAPPY PATH, END TO END --------------------------------------------
    private static int DeviceFlowHappyPath()
    {
        using var server = new OAuthStub();
        server.PendingPolls = 2;
        server.AccessToken = SyntheticJwt("pilot@example.test", DateTimeOffset.UtcNow.AddHours(1));
        server.RefreshToken = "refresh-alpha";

        using var client = server.CreateClient();
        var device = client.RequestDeviceCodeAsync().GetAwaiter().GetResult();

        Assert(device.UserCode == "ABCD-1234", "the user code is passed through for the user to read");
        Assert(
            device.VerificationUriComplete.Contains(device.UserCode, StringComparison.Ordinal),
            "the browser URL carries the code so the user does not have to retype it");
        Assert(device.PollInterval == TimeSpan.FromSeconds(1), "the server's poll interval is honoured");
        Assert(
            server.LastDeviceForm["client_id"] == SuperGrokOAuthClient.ClientId,
            "the device request sends the client id the live server requires");

        var progressReports = new List<string>();
        var tokens = client
            .PollForTokenAsync(device, new Progress<string>(progressReports.Add))
            .GetAwaiter()
            .GetResult();

        Assert(server.PollCount == 3, "polling continued through authorization_pending, then stopped");
        Assert(tokens.AccessToken == server.AccessToken, "the access token is carried back intact");
        Assert(tokens.RefreshToken == "refresh-alpha", "the refresh token is kept for renewal");
        Assert(tokens.Email == "pilot@example.test", "the signed-in identity is read from the token claims");
        Assert(tokens.Origin == SuperGrokTokens.OriginDeviceFlow, "the session records how it was obtained");
        Assert(!tokens.IsExpired(DateTimeOffset.UtcNow), "a one-hour token is not treated as expired");
        Assert(
            tokens.IsExpired(tokens.ExpiresAt.AddSeconds(-30)),
            "a token 30 s from death is treated as expired, so none leaves mid-flight");
        Assert(
            server.LastTokenForm["grant_type"] == SuperGrokOAuthClient.DeviceCodeGrantType,
            "the poll uses the device_code grant type");

        // Refresh replaces the access token and keeps a refresh token even when the server
        // omits one — the common OAuth server behaviour that silently logs users out.
        server.AccessToken = SyntheticJwt("pilot@example.test", DateTimeOffset.UtcNow.AddHours(2));
        server.RefreshToken = null;
        var refreshed = client.RefreshAsync("refresh-alpha").GetAwaiter().GetResult();
        Assert(refreshed.AccessToken == server.AccessToken, "refresh returns the new access token");
        Assert(
            refreshed.RefreshToken == "refresh-alpha",
            "a response with no refresh_token keeps the existing one instead of dropping it");

        return 13;
    }

    // --- 3. THE STATES NOBODY CLICKS ----------------------------------------------
    private static int DeviceFlowBackoffAndDenial()
    {
        // slow_down must widen the interval, not spin.
        using (var server = new OAuthStub())
        {
            server.SlowDownPolls = 1;
            server.PendingPolls = 1;
            server.AccessToken = SyntheticJwt("a@example.test", DateTimeOffset.UtcNow.AddHours(1));

            using var client = server.CreateClient();
            var device = client.RequestDeviceCodeAsync().GetAwaiter().GetResult();
            var started = DateTimeOffset.UtcNow;
            var tokens = client.PollForTokenAsync(device).GetAwaiter().GetResult();

            Assert(tokens.AccessToken.Length > 0, "sign-in still completes after a slow_down");
            Assert(
                DateTimeOffset.UtcNow - started >= TimeSpan.FromSeconds(6),
                "slow_down actually widened the interval by 5 s rather than being ignored");
        }

        // access_denied is terminal and must say so in words a user can act on.
        using (var server = new OAuthStub { TerminalError = "access_denied" })
        {
            using var client = server.CreateClient();
            var device = client.RequestDeviceCodeAsync().GetAwaiter().GetResult();
            var error = CatchAuthException(() => client.PollForTokenAsync(device).GetAwaiter().GetResult());

            Assert(error is not null, "a declined sign-in throws instead of polling forever");
            Assert(error!.ErrorCode == "access_denied", "the OAuth error code is preserved");
            Assert(
                error.Message.Contains("declined", StringComparison.OrdinalIgnoreCase)
                    && error.Message.Contains("Nothing was changed", StringComparison.Ordinal),
                "the declined message is plain English and says nothing was changed");
            Assert(
                !error.Message.Contains("access_denied", StringComparison.Ordinal),
                "the user is not shown a raw OAuth error code");
        }

        // An expired device code stops rather than polling against a dead code.
        using (var server = new OAuthStub())
        {
            using var client = server.CreateClient();
            var device = client.RequestDeviceCodeAsync().GetAwaiter().GetResult() with
            {
                ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1),
            };
            var error = CatchAuthException(() => client.PollForTokenAsync(device).GetAwaiter().GetResult());

            Assert(error?.ErrorCode == "expired_token", "an expired device code is reported as expired");
            Assert(server.PollCount == 0, "an expired code is never sent to the server");
        }

        // A dead endpoint produces a connection message, not an unhandled exception.
        using (var deadPort = new TcpListener(IPAddress.Loopback, 0))
        {
            deadPort.Start();
            var port = ((IPEndPoint)deadPort.LocalEndpoint).Port;
            deadPort.Stop();

            using var client = new SuperGrokOAuthClient
            {
                DeviceCodeUrl = $"http://127.0.0.1:{port}/oauth2/device/code",
                TokenUrl = $"http://127.0.0.1:{port}/oauth2/token",
            };
            var error = CatchAuthException(
                () => client.RequestDeviceCodeAsync().GetAwaiter().GetResult());

            Assert(error is not null, "an unreachable auth server is reported, not thrown raw");
            Assert(
                error!.Message.Contains("internet connection", StringComparison.OrdinalIgnoreCase),
                "the network failure message tells the user what to check");
        }

        return 10;
    }

    // --- 4. THE STORE -------------------------------------------------------------
    private static int TokenStoreRoundTrip()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmion-supergrok-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "supergrok-oauth.dat");

        try
        {
            var store = new SuperGrokTokenStore(path);
            Assert(!store.Exists, "a fresh store holds nothing");
            Assert(store.Load() is null, "loading an absent store returns null rather than throwing");

            var accessToken = SyntheticJwt("owner@example.test", DateTimeOffset.UtcNow.AddHours(1));
            var session = new SuperGrokTokens(
                accessToken,
                "refresh-beta",
                DateTimeOffset.UtcNow.AddHours(1),
                "owner@example.test",
                SuperGrokTokens.OriginDeviceFlow);
            store.Save(session);

            // THE POINT OF THE WHOLE FILE: the token must not be sitting on disk in the clear.
            var onDisk = File.ReadAllBytes(path);
            var asText = Encoding.UTF8.GetString(onDisk);
            Assert(
                !asText.Contains(accessToken, StringComparison.Ordinal)
                    && !asText.Contains("refresh-beta", StringComparison.Ordinal),
                "the access and refresh tokens are encrypted at rest, not readable in the file");
            Assert(
                !asText.Contains("owner@example.test", StringComparison.Ordinal),
                "even the account email is inside the encrypted blob");

            var reloaded = store.Load();
            Assert(reloaded is not null, "a saved session reloads");
            Assert(reloaded!.AccessToken == accessToken, "the access token survives the DPAPI round trip");
            Assert(reloaded.RefreshToken == "refresh-beta", "the refresh token survives too");
            Assert(reloaded.Email == "owner@example.test", "the identity survives");

            // A corrupt or foreign-user blob must degrade to "signed out", never crash the app.
            File.WriteAllBytes(path, [1, 2, 3, 4, 5, 6, 7, 8]);
            Assert(
                new SuperGrokTokenStore(path).Load() is null,
                "an undecryptable store reads as signed-out instead of throwing");

            store.Save(session);
            store.Clear();
            Assert(!store.Exists && store.Load() is null, "signing out removes the stored session");

            return 9;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp */ }
        }
    }

    // --- 5. ADOPTING THE GROK CLI'S SESSION ---------------------------------------
    private static int GrokCliAdoption()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmion-grokcli-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            Assert(
                GrokCliSessionReader.TryRead(Path.Combine(root, "missing.json")) is null,
                "no Grok CLI file means no session, not an exception");

            File.WriteAllText(Path.Combine(root, "garbage.json"), "{ this is not json");
            Assert(
                GrokCliSessionReader.TryRead(Path.Combine(root, "garbage.json")) is null,
                "an unreadable Grok CLI file is ignored rather than crashing the settings page");

            // The real shape, with synthetic tokens: object keyed "<issuer>::<client-id>".
            var live = SyntheticJwt("cli-user@example.test", DateTimeOffset.UtcNow.AddHours(3));
            var livePath = Path.Combine(root, "auth.json");
            File.WriteAllText(livePath, $$"""
                {
                  "https://auth.x.ai::{{SuperGrokOAuthClient.ClientId}}": {
                    "key": "{{live}}",
                    "refresh_token": "cli-refresh",
                    "expires_at": {{DateTimeOffset.UtcNow.AddHours(3).ToUnixTimeSeconds()}},
                    "email": "cli-user@example.test",
                    "oidc_issuer": "https://auth.x.ai"
                  }
                }
                """);

            var adopted = GrokCliSessionReader.TryRead(livePath);
            Assert(adopted is not null, "a live Grok CLI session is found");
            Assert(adopted!.AccessToken == live, "the CLI's access token is adopted as-is");
            Assert(adopted.RefreshToken == "cli-refresh", "the CLI's refresh token comes with it");
            Assert(adopted.Email == "cli-user@example.test", "the CLI session's identity is read");
            Assert(
                adopted.Origin == SuperGrokTokens.OriginGrokCli,
                "the session is labelled as adopted so the UI can say where it came from");

            // Helmion must not touch the CLI's own file.
            var before = File.ReadAllBytes(livePath);
            GrokCliSessionReader.TryRead(livePath);
            Assert(
                File.ReadAllBytes(livePath).SequenceEqual(before),
                "reading the Grok CLI session leaves that file byte-identical");

            // An expired CLI session must not be adopted — it would fail on first use.
            var stalePath = Path.Combine(root, "stale.json");
            File.WriteAllText(stalePath, $$"""
                {
                  "https://auth.x.ai::{{SuperGrokOAuthClient.ClientId}}": {
                    "key": "{{SyntheticJwt("old@example.test", DateTimeOffset.UtcNow.AddHours(-2))}}",
                    "refresh_token": "stale"
                  }
                }
                """);
            Assert(
                GrokCliSessionReader.TryRead(stalePath) is null,
                "an expired Grok CLI session is not adopted");

            // A file holding only some other provider's entry yields nothing.
            var otherPath = Path.Combine(root, "other.json");
            File.WriteAllText(otherPath, """
                { "https://accounts.google.com::abc": { "key": "not-xai" } }
                """);
            Assert(
                GrokCliSessionReader.TryRead(otherPath) is null,
                "entries that are not xAI sessions are ignored");

            return 10;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp */ }
        }
    }

    // --- 6. WHICH CREDENTIAL WINS -------------------------------------------------
    private static int CredentialPreferenceAndFallback()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmion-supergrok-cred-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            var storePath = Path.Combine(root, "cred.dat");

            // (a) No session at all → the API key carries the request.
            using (var provider = new SuperGrokCredentialProvider(new SuperGrokTokenStore(storePath)))
            {
                var credential = provider.ResolveAsync("xai-fallback-key").GetAwaiter().GetResult();
                Assert(credential.Mode == GrokAuthMode.ApiKey, "with no sign-in, the API key is used");
                Assert(credential.Token == "xai-fallback-key", "the API key is the bearer value");
                Assert(credential.StatusLabel == "Using API key", "the status says which one is live");

                var none = provider.ResolveAsync("").GetAwaiter().GetResult();
                Assert(none.Mode == GrokAuthMode.None, "no session and no key means nothing to send");
                Assert(!none.CanSend, "a mode of None cannot send");
                Assert(
                    none.StatusLabel.Contains("Login with SuperGrok", StringComparison.Ordinal),
                    "the empty state tells the user what button to press");
            }

            // (b) A live session beats the API key.
            using (var server = new OAuthStub())
            using (var oauth = server.CreateClient())
            using (var provider = new SuperGrokCredentialProvider(
                new SuperGrokTokenStore(storePath), oauth))
            {
                var live = SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddHours(1));
                provider.Adopt(new SuperGrokTokens(
                    live, "r1", DateTimeOffset.UtcNow.AddHours(1), "live@example.test",
                    SuperGrokTokens.OriginDeviceFlow));

                var credential = provider.ResolveAsync("xai-fallback-key").GetAwaiter().GetResult();
                Assert(
                    credential.Mode == GrokAuthMode.SuperGrok,
                    "a valid subscription session outranks the API key");
                Assert(credential.Token == live, "the subscription token is the bearer value");
                Assert(
                    credential.StatusLabel.StartsWith("Using SuperGrok subscription", StringComparison.Ordinal)
                        && credential.StatusLabel.Contains("live@example.test", StringComparison.Ordinal),
                    "the status names the subscription and who is signed in");
            }

            // (c) Session reloads across a restart, and an expired one is refreshed once.
            using (var server = new OAuthStub())
            using (var oauth = server.CreateClient())
            {
                var fresh = SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddHours(4));
                server.AccessToken = fresh;
                server.RefreshToken = "r2";

                using var provider = new SuperGrokCredentialProvider(
                    new SuperGrokTokenStore(storePath), oauth);
                Assert(provider.IsSignedIn, "the session survives a restart via the DPAPI store");

                // Force an expiry the way real life does.
                provider.Adopt(new SuperGrokTokens(
                    SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddMinutes(-5)),
                    "r1",
                    DateTimeOffset.UtcNow.AddMinutes(-5),
                    "live@example.test",
                    SuperGrokTokens.OriginDeviceFlow));

                var credential = provider.ResolveAsync("xai-fallback-key").GetAwaiter().GetResult();
                Assert(
                    credential.Mode == GrokAuthMode.SuperGrok && credential.Token == fresh,
                    "an expired session is refreshed rather than dropped");
                Assert(server.RefreshCount == 1, "exactly one refresh was attempted");
                Assert(
                    new SuperGrokTokenStore(storePath).Load()?.AccessToken == fresh,
                    "the refreshed token is written back so the next launch is still signed in");
            }

            // (d) A revoked refresh token clears the session and falls back — out loud.
            using (var server = new OAuthStub { RefreshError = "invalid_grant" })
            using (var oauth = server.CreateClient())
            {
                using var provider = new SuperGrokCredentialProvider(
                    new SuperGrokTokenStore(storePath), oauth);
                provider.Adopt(new SuperGrokTokens(
                    SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddMinutes(-5)),
                    "revoked",
                    DateTimeOffset.UtcNow.AddMinutes(-5),
                    "live@example.test",
                    SuperGrokTokens.OriginDeviceFlow));

                var credential = provider.ResolveAsync("xai-fallback-key").GetAwaiter().GetResult();
                Assert(credential.Mode == GrokAuthMode.ApiKey, "a revoked session falls back to the API key");
                Assert(!provider.IsSignedIn, "the dead session is cleared rather than retried forever");
                Assert(
                    new SuperGrokTokenStore(storePath).Load() is null,
                    "the revoked session is erased from disk too");
                Assert(
                    credential.StatusLabel.Contains("no longer valid", StringComparison.OrdinalIgnoreCase),
                    "the fallback is not silent — the status says why");
            }

            // (e) Revoked with NO API key to fall back to: still explained, never blank.
            using (var server = new OAuthStub { RefreshError = "invalid_grant" })
            using (var oauth = server.CreateClient())
            {
                using var provider = new SuperGrokCredentialProvider(
                    new SuperGrokTokenStore(Path.Combine(root, "cred2.dat")), oauth);
                provider.Adopt(new SuperGrokTokens(
                    SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddMinutes(-5)),
                    "revoked",
                    DateTimeOffset.UtcNow.AddMinutes(-5),
                    null,
                    SuperGrokTokens.OriginDeviceFlow));

                var credential = provider.ResolveAsync("").GetAwaiter().GetResult();
                Assert(credential.Mode == GrokAuthMode.None, "no credential is left to send with");
                Assert(
                    credential.StatusLabel.Contains("no API key", StringComparison.OrdinalIgnoreCase),
                    "the dead end is stated plainly instead of failing silently");
            }

            // (f) The chat session reports the same decision without a network call.
            using (var session = new GrokChatSession(""))
            {
                Assert(!session.HasKey, "no key and no session means Grok cannot send");
            }

            using (var provider = new SuperGrokCredentialProvider(
                new SuperGrokTokenStore(Path.Combine(root, "cred3.dat"))))
            using (var session = new GrokChatSession("", provider))
            {
                provider.Adopt(new SuperGrokTokens(
                    SyntheticJwt("live@example.test", DateTimeOffset.UtcNow.AddHours(1)),
                    "r",
                    DateTimeOffset.UtcNow.AddHours(1),
                    "live@example.test",
                    SuperGrokTokens.OriginDeviceFlow));

                Assert(
                    session.HasKey,
                    "a SuperGrok session alone is enough to send — no API key required");
                Assert(
                    session.DescribeAuthAsync().GetAwaiter().GetResult().Mode == GrokAuthMode.SuperGrok,
                    "the chat session reports the subscription as the live credential");
            }

            return 22;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp */ }
        }
    }

    // --- 7. THE SECRET STAYS A SECRET ---------------------------------------------
    private static int TokensNeverLeakIntoStatusText()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmion-supergrok-leak-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            const string RefreshSecret = "refresh-secret-value";
            var accessToken = SyntheticJwt("leak@example.test", DateTimeOffset.UtcNow.AddHours(1));

            using var provider = new SuperGrokCredentialProvider(
                new SuperGrokTokenStore(Path.Combine(root, "leak.dat")));
            provider.Adopt(new SuperGrokTokens(
                accessToken,
                RefreshSecret,
                DateTimeOffset.UtcNow.AddHours(1),
                "leak@example.test",
                SuperGrokTokens.OriginGrokCli));

            var credential = provider.ResolveAsync("xai-secret-api-key").GetAwaiter().GetResult();
            Assert(
                !credential.StatusLabel.Contains(accessToken, StringComparison.Ordinal)
                    && !credential.StatusLabel.Contains(RefreshSecret, StringComparison.Ordinal)
                    && !credential.StatusLabel.Contains("xai-secret-api-key", StringComparison.Ordinal),
                "the user-facing status line contains no token and no API key");
            Assert(
                credential.StatusLabel.Contains("adopted from Grok CLI", StringComparison.Ordinal),
                "an adopted session says so, so the user knows which sign-in is in play");

            // The provider's public surface must not hand a token to anything that logs.
            var leakyProperties = typeof(SuperGrokCredentialProvider)
                .GetProperties()
                .Where(p => p.PropertyType == typeof(string))
                .Select(p => p.GetValue(provider) as string)
                .Where(value => value is not null)
                .ToArray();
            Assert(
                leakyProperties.All(value =>
                    !value!.Contains(accessToken, StringComparison.Ordinal)
                    && !value.Contains(RefreshSecret, StringComparison.Ordinal)),
                "no string property on the credential provider exposes token material");

            return 3;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp */ }
        }
    }

    // --- helpers ------------------------------------------------------------------

    /// <summary>
    /// An access token shaped like xAI's — three dot-separated base64url segments with real
    /// <c>email</c> and <c>exp</c> claims — carrying a signature that is deliberately the word
    /// "not-a-signature" so it can never be mistaken for a live credential.
    /// </summary>
    private static string SyntheticJwt(string email, DateTimeOffset expires)
    {
        static string Encode(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        var header = Encode("""{"alg":"none","typ":"at+jwt"}""");
        var payload = Encode(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["iss"] = SuperGrokOAuthClient.Issuer,
            ["aud"] = SuperGrokOAuthClient.ClientId,
            ["email"] = email,
            ["exp"] = expires.ToUnixTimeSeconds(),
        }));

        return $"{header}.{payload}.not-a-signature";
    }

    private static SuperGrokAuthException? CatchAuthException(Action action)
    {
        try
        {
            action();
            return null;
        }
        catch (SuperGrokAuthException ex)
        {
            return ex;
        }
    }

    private static void Assert(bool condition, string description)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SuperGrok OAuth check failed: {description}");
        }
    }

    /// <summary>
    /// A loopback OAuth 2.0 device-flow server that answers with the real RFC 8628 response and
    /// error shapes. Raw sockets, matching the OpenAI stub already in Program.cs, so the suite
    /// needs no URL ACL reservation.
    /// </summary>
    private sealed class OAuthStub : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _cts = new();

        public OAuthStub()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(AcceptLoopAsync);
        }

        public int Port { get; }

        /// <summary>Polls answered with authorization_pending before the token is issued.</summary>
        public int PendingPolls { get; set; }

        /// <summary>Polls answered with slow_down before anything else.</summary>
        public int SlowDownPolls { get; set; }

        /// <summary>When set, every poll returns this terminal OAuth error.</summary>
        public string? TerminalError { get; set; }

        /// <summary>When set, every refresh returns this OAuth error.</summary>
        public string? RefreshError { get; set; }

        public string AccessToken { get; set; } = "stub-access-token";
        public string? RefreshToken { get; set; } = "stub-refresh-token";

        public int PollCount { get; private set; }
        public int RefreshCount { get; private set; }
        public Dictionary<string, string> LastDeviceForm { get; private set; } = [];
        public Dictionary<string, string> LastTokenForm { get; private set; } = [];

        public SuperGrokOAuthClient CreateClient() => new()
        {
            DeviceCodeUrl = $"http://127.0.0.1:{Port}/oauth2/device/code",
            TokenUrl = $"http://127.0.0.1:{Port}/oauth2/token",
        };

        private async Task AcceptLoopAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(_cts.Token);
                }
                catch (Exception ex) when (ex is OperationCanceledException or SocketException
                                               or ObjectDisposedException)
                {
                    return;
                }

                _ = Task.Run(() => ServeAsync(client));
            }
        }

        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                try
                {
                    var stream = client.GetStream();
                    var buffer = new byte[8192];
                    var read = await stream.ReadAsync(buffer, _cts.Token);
                    if (read == 0) return;

                    var request = Encoding.UTF8.GetString(buffer, 0, read);
                    var separator = request.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    var path = request.Split(' ').Skip(1).FirstOrDefault() ?? "";
                    var body = separator >= 0 ? request[(separator + 4)..] : "";

                    var (status, json) = path.Contains("/device/code", StringComparison.Ordinal)
                        ? HandleDeviceCode(body)
                        : HandleToken(body);

                    var payload = Encoding.UTF8.GetBytes(json);
                    var head = Encoding.UTF8.GetBytes(
                        $"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
                        + $"Content-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
                    await stream.WriteAsync(head, _cts.Token);
                    await stream.WriteAsync(payload, _cts.Token);
                    await stream.FlushAsync(_cts.Token);
                }
                catch (Exception ex) when (ex is IOException or OperationCanceledException
                                              or ObjectDisposedException or SocketException)
                {
                    // Client hung up; nothing to report from a stub.
                }
            }
        }

        private (string Status, string Json) HandleDeviceCode(string body)
        {
            LastDeviceForm = ParseForm(body);
            return ("200 OK", """
                {"device_code":"stub-device-code","user_code":"ABCD-1234",
                 "verification_uri":"https://accounts.x.ai/oauth2/device",
                 "verification_uri_complete":"https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
                 "expires_in":1800,"interval":1}
                """);
        }

        private (string Status, string Json) HandleToken(string body)
        {
            var form = ParseForm(body);
            if (form.GetValueOrDefault("grant_type") == "refresh_token")
            {
                RefreshCount++;
                return RefreshError is not null
                    ? ("400 Bad Request", Error(RefreshError))
                    : ("200 OK", TokenJson());
            }

            LastTokenForm = form;
            PollCount++;

            if (TerminalError is not null) return ("400 Bad Request", Error(TerminalError));
            if (SlowDownPolls-- > 0) return ("400 Bad Request", Error("slow_down"));
            if (PendingPolls-- > 0) return ("400 Bad Request", Error("authorization_pending"));

            return ("200 OK", TokenJson());
        }

        private string TokenJson()
        {
            var refresh = RefreshToken is null
                ? ""
                : $",\"refresh_token\":{JsonSerializer.Serialize(RefreshToken)}";
            return $"{{\"access_token\":{JsonSerializer.Serialize(AccessToken)}"
                + $",\"token_type\":\"Bearer\",\"expires_in\":3600{refresh}}}";
        }

        private static string Error(string code) =>
            $"{{\"error\":{JsonSerializer.Serialize(code)},\"error_description\":\"stub\"}}";

        private static Dictionary<string, string> ParseForm(string body)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var index = pair.IndexOf('=');
                if (index < 0) continue;
                result[Uri.UnescapeDataString(pair[..index])] =
                    Uri.UnescapeDataString(pair[(index + 1)..].Replace('+', ' '));
            }

            return result;
        }

        public void Dispose()
        {
            _cts.Cancel();
            try { _listener.Stop(); } catch { /* already stopped */ }
            _cts.Dispose();
        }
    }
}

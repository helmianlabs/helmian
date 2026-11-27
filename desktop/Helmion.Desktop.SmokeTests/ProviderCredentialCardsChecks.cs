using System.Net;
using System.Text;
using Helmion.Desktop.Core;

/// <summary>
/// Source-level checks for the desktop Integrations credential cards: the
/// catalog matches the web cards' providers, names, and sign-in lines
/// (web/marketing/app/integrations-view.mjs), seats carry the password
/// road, tool cards carry only the API-key slot, and the status words
/// never claim more than a vault write earned.
/// </summary>
internal static class ProviderCredentialCardsChecks
{
    public static void Run()
    {
        var seats = ProviderCredentialCards.Seats;
        Equal(5, seats.Count, "five seat cards");
        Equal("claude,openai,gemini,grok,mistral", string.Join(",", seats.Select(card => card.ProviderId)), "seat order matches the web");
        Equal("Claude", seats[0].Name, "claude name");
        Equal("Sign in with your Claude account.", seats[0].Blurb, "claude blurb is the web card's line");
        Equal("ChatGPT", seats[1].Name, "openai name");
        Equal("Sign in with your ChatGPT account.", seats[1].Blurb, "openai blurb");
        Equal("Gemini", seats[2].Name, "gemini name");
        Equal("Sign in with your Google account.", seats[2].Blurb, "gemini blurb");
        Equal("Grok", seats[3].Name, "grok name");
        Equal("Sign in with your Grok account.", seats[3].Blurb, "grok blurb");
        Equal("Mistral Le Chat", seats[4].Name, "mistral name");
        Equal("Sign in with your Mistral account.", seats[4].Blurb, "mistral blurb");
        Check(seats.All(card => card.HasPasswordRoad), "every seat card carries Email + Password + Connect");

        var tools = ProviderCredentialCards.Tools;
        Equal("runway,heygen,higgsfield", string.Join(",", tools.Select(card => card.ProviderId)), "tool cards: runway + the API-key services");
        Equal("Use your Runway account for video and image generation.", tools[0].Blurb, "runway blurb is the web card's line");
        Check(tools.All(card => !card.HasPasswordRoad), "tool cards carry the API-key slot only, no password fields");

        Equal("Not connected", ProviderCredentialCards.StatusText(null), "no row reads Not connected");
        Equal("Not connected", ProviderCredentialCards.StatusText(""), "blank auth mode reads Not connected");
        Equal("Sign-in saved", ProviderCredentialCards.StatusText("password_session"), "a stored sign-in is saved, never claimed live");
        Equal("API key saved", ProviderCredentialCards.StatusText("api_key"), "a stored key reads API key saved");
        Equal("Connected", ProviderCredentialCards.StatusText("oauth_subscription"), "an OAuth row reads Connected");

        RunWireChecksAsync().GetAwaiter().GetResult();
    }

    // The client wire shape, exercised against a stub transport: the
    // desktop posts exactly the two credential shapes the cloud route
    // accepts, to the route the web cards use, and maps the returned
    // connection row (status only) back.
    private static async Task RunWireChecksAsync()
    {
        var handler = new StubHandler();
        var client = new EnvoyCloudChatClient(new HttpClient(handler), new Uri("https://helmian.cloud"));
        var token = "hdt_" + new string('a', 43);

        handler.NextJson = """{"valid":true,"stored":true,"connection":{"providerId":"claude","authMode":"password_session","credentialReference":"vault://tenant/t/claude/password","lifecycle":"pending","updatedAt":"2026-11-05T00:00:00Z"},"secretMaterial":"not_returned"}""";
        var connected = await client.ConnectCredentialAsync(token, "claude", "person@example.com", "canary-password");
        Equal(HttpMethod.Post, handler.LastMethod, "connect uses POST");
        Equal("/api/admin/envoy/credential/connect", handler.LastPath, "connect posts to the web cards' route");
        Check(handler.LastBody.Contains("\"provider\":\"claude\""), "connect body names the provider");
        Check(handler.LastBody.Contains("\"username\":\"person@example.com\""), "connect body carries the username");
        Check(handler.LastBody.Contains("\"password\":\"canary-password\""), "connect body carries the password to the vault route");
        Check(connected is not null && connected.AuthMode == "password_session", "connect maps the recorded row");

        handler.NextJson = """{"valid":true,"stored":true,"connectionRecorded":true,"connection":{"providerId":"runway","authMode":"api_key","credentialReference":"vault://tenant/t/runway/api-key","lifecycle":"pending","updatedAt":"2026-11-05T00:00:00Z"},"secretMaterial":"not_returned"}""";
        var keyed = await client.StoreApiKeyAsync(token, "runway", "canary-api-key");
        Check(handler.LastBody.Contains("\"apiKey\":\"canary-api-key\""), "api-key body carries the key");
        Check(!handler.LastBody.Contains("password"), "api-key body carries no password shape");
        Check(keyed is not null && keyed.AuthMode == "api_key", "api-key store maps the recorded row");

        handler.NextJson = """{"valid":true,"connections":[{"providerId":"claude","authMode":"password_session","lifecycle":"pending","updatedAt":"2026-11-05T00:00:00Z"}],"secretMaterial":"not_returned"}""";
        var rows = await client.ListConnectionsAsync(token);
        Equal(HttpMethod.Get, handler.LastMethod, "list uses GET on the same path");
        Equal(1, rows.Count, "list maps the rows");
        Equal("Sign-in saved", ProviderCredentialCards.StatusText(rows[0].AuthMode), "a listed sign-in renders as saved");
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        public HttpMethod LastMethod = HttpMethod.Get;
        public string? LastPath;
        public string LastBody = "";
        public string NextJson = "{}";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastMethod = request.Method;
            LastPath = request.RequestUri?.AbsolutePath;
            LastBody = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(NextJson, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static void Check(bool condition, string what)
    {
        if (!condition) throw new InvalidOperationException($"ProviderCredentialCards check failed: {what}");
    }

    private static void Equal<T>(T expected, T actual, string what)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"ProviderCredentialCards check failed: {what} — expected '{expected}', got '{actual}'");
    }
}

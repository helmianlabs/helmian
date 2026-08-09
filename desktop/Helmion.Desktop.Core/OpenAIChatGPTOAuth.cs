using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Raised when ChatGPT sign-in cannot continue. The message is written to be shown to the user
/// verbatim — no stack traces, no OAuth jargon without a plain translation.
/// </summary>
public sealed class ChatGptAuthException(string message, string? errorCode = null)
    : Exception(message)
{
    public string? ErrorCode { get; } = errorCode;
}

/// <summary>
/// A live "Sign in with ChatGPT" session. Mirrors <see cref="SuperGrokTokens"/> in shape and in
/// the secrecy rules around <see cref="AccessToken"/> / <see cref="RefreshToken"/>: never log
/// them, never put them in a window title, never write them to .env.
/// </summary>
public sealed record ChatGptTokens(
    string AccessToken,
    string? RefreshToken,
    DateTimeOffset ExpiresAt,
    string? Email,
    string? AccountId,
    string Origin)
{
    public const string OriginAuthCodeFlow = "auth-code-flow";
    public const string OriginCodexCli = "codex-cli";

    public bool IsExpired(DateTimeOffset now) => ExpiresAt - TimeSpan.FromSeconds(60) <= now;
}

/// <summary>
/// OAuth 2.0 Authorization Code + PKCE against OpenAI's auth server, so a user with a ChatGPT
/// Plus/Pro/Team subscription can sign in instead of pasting an API key.
///
/// <para>
/// VERIFIED 2026-08-04. <c>auth.openai.com/oauth/token</c> and <c>auth.openai.com/oauth/revoke</c>
/// were read directly out of the installed Codex CLI binary
/// (<c>%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe</c>). The authorize endpoint, client id,
/// scopes, redirect port, and the extra OpenAI-specific authorize parameters were cross-referenced
/// against a public sample OAuth client for the same flow (7shi/codex-oauth) and OpenAI's own
/// Codex authentication docs, which confirm "Sign in with ChatGPT for subscription access" and a
/// device-code alternative exist, without publishing the raw endpoint values themselves.
/// </para>
///
/// <para>
/// The client id below is OpenAI's own public Codex app registration — a native/public OAuth
/// client, not a secret, the same class of credential as xAI's Grok CLI client id in
/// <see cref="SuperGrokOAuthClient"/>. There is nothing for Helmion to register with OpenAI.
/// </para>
/// </summary>
public sealed class ChatGptOAuthClient : IDisposable
{
    public const string Issuer = "https://auth.openai.com";
    public const string AuthorizeEndpoint = Issuer + "/oauth/authorize";
    public const string TokenEndpoint = Issuer + "/oauth/token";
    public const string RevokeEndpoint = Issuer + "/oauth/revoke";

    /// <summary>OpenAI's public Codex CLI client id — confirmed via a public reimplementation of
    /// the same "Sign in with ChatGPT" flow (7shi/codex-oauth) and consistent with the endpoints
    /// read out of the shipped Codex binary.</summary>
    public const string ClientId = "app_EMoamEEZ73f0CkXaXp7hrann";

    public const string Scope = "openai profile email offline_access";

    /// <summary>Codex CLI binds its local callback listener here; reusing the same port keeps
    /// Helmion consistent with the official client in case OpenAI ever allowlists by port.</summary>
    public const int CallbackPort = 1455;
    public const string RedirectUri = "http://localhost:1455/auth/callback";

    /// <summary>The chat backend a subscription-authenticated session actually calls — distinct
    /// from api.openai.com, which is the pay-per-token surface. Confirmed via the same public
    /// reimplementation referenced above and consistent with the "chatgpt.com/backend-api"
    /// string present in the shipped Codex binary.</summary>
    public const string ChatBackendEndpoint = "https://chatgpt.com/backend-api/wham";

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    public ChatGptOAuthClient(HttpClient? http = null)
    {
        _ownsHttp = http is null;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    public string AuthorizeUrl { get; init; } = AuthorizeEndpoint;
    public string TokenUrl { get; init; } = TokenEndpoint;

    /// <summary>
    /// Runs the full interactive flow: generates a PKCE pair, opens the system browser to
    /// OpenAI's consent screen, listens on <see cref="CallbackPort"/> for the redirect, and
    /// exchanges the returned code for tokens. Throws if the port is already in use — the caller
    /// should surface that as "close whatever else is using port 1455" rather than a raw
    /// HttpListenerException.
    /// </summary>
    public async Task<ChatGptTokens> SignInAsync(
        Func<string, Task> openBrowser,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(openBrowser);

        var verifier = GenerateCodeVerifier();
        var challenge = ComputeCodeChallenge(verifier);
        var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://localhost:{CallbackPort}/auth/callback/");
        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            throw new ChatGptAuthException(
                $"Could not start the sign-in listener on port {CallbackPort} ({ex.Message}). "
                + "Close whatever else is using that port and try again, or use the API key field.");
        }

        var authorizeUrl = BuildAuthorizeUrl(challenge, state);
        progress?.Report("Opening your browser to sign in with ChatGPT…");
        await openBrowser(authorizeUrl);

        HttpListenerContext context;
        try
        {
            var getContextTask = listener.GetContextAsync();
            var timeoutTask = Task.Delay(TimeSpan.FromMinutes(5), cancellationToken);
            var completed = await Task.WhenAny(getContextTask, timeoutTask);
            if (completed == timeoutTask)
            {
                throw new ChatGptAuthException(
                    "The sign-in page was never completed. Press \"Login with ChatGPT\" to try again.",
                    "timeout");
            }
            context = await getContextTask;
        }
        finally
        {
            listener.Stop();
        }

        var query = context.Request.QueryString;
        var returnedState = query["state"];
        var code = query["code"];
        var error = query["error"];

        await RespondToBrowserAsync(context, error is null);

        if (error is not null)
        {
            throw new ChatGptAuthException(
                error == "access_denied"
                    ? "The sign-in was declined in the browser. Nothing was changed — press "
                      + "\"Login with ChatGPT\" to try again."
                    : $"OpenAI's sign-in service returned an error: {error}.",
                error);
        }

        if (!string.Equals(returnedState, state, StringComparison.Ordinal))
        {
            throw new ChatGptAuthException(
                "The sign-in response did not match the request that started it (state mismatch). "
                + "For safety this sign-in was rejected. Try again.",
                "state_mismatch");
        }

        if (string.IsNullOrEmpty(code))
        {
            throw new ChatGptAuthException(
                "OpenAI's sign-in service did not return an authorization code. Try again, or use "
                + "the API key field instead.");
        }

        return await ExchangeCodeAsync(code, verifier, cancellationToken);
    }

    private string BuildAuthorizeUrl(string codeChallenge, string state)
    {
        var query = new Dictionary<string, string>
        {
            ["response_type"] = "code",
            ["client_id"] = ClientId,
            ["redirect_uri"] = RedirectUri,
            ["scope"] = Scope,
            ["state"] = state,
            ["code_challenge"] = codeChallenge,
            ["code_challenge_method"] = "S256",
            // OpenAI-specific parameters confirmed against the public reimplementation of this
            // same flow — without these the token Codex-style clients receive is missing the
            // organization/account claims the chat backend expects.
            ["id_token_add_organizations"] = "true",
            ["codex_cli_simplified_flow"] = "true",
            ["originator"] = "helmion",
        };
        var qs = string.Join("&", query.Select(kv =>
            $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
        return $"{AuthorizeUrl}?{qs}";
    }

    public async Task<ChatGptTokens> RefreshAsync(
        string refreshToken,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            throw new ChatGptAuthException(
                "This ChatGPT session has no refresh token, so it cannot be renewed. Sign in again.",
                "invalid_grant");
        }

        var root = await PostFormAsync(
            TokenUrl,
            new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["client_id"] = ClientId,
                ["refresh_token"] = refreshToken,
            },
            cancellationToken);

        var refreshed = ReadTokens(root, ChatGptTokens.OriginAuthCodeFlow);
        return refreshed.RefreshToken is null
            ? refreshed with { RefreshToken = refreshToken }
            : refreshed;
    }

    private async Task<ChatGptTokens> ExchangeCodeAsync(
        string code,
        string codeVerifier,
        CancellationToken cancellationToken)
    {
        var root = await PostFormAsync(
            TokenUrl,
            new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = ClientId,
                ["code"] = code,
                ["redirect_uri"] = RedirectUri,
                ["code_verifier"] = codeVerifier,
            },
            cancellationToken);

        return ReadTokens(root, ChatGptTokens.OriginAuthCodeFlow);
    }

    private static ChatGptTokens ReadTokens(JsonElement root, string origin)
    {
        var accessToken = ReadString(root, "access_token");
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            throw new ChatGptAuthException(
                "OpenAI approved the sign-in but returned no access token. Try signing in again.");
        }

        var lifetime = root.TryGetProperty("expires_in", out var expiresEl)
            && expiresEl.TryGetInt32(out var expiresIn) && expiresIn > 0
                ? TimeSpan.FromSeconds(expiresIn)
                : TimeSpan.FromHours(1);

        var (email, accountId) = ChatGptTokenReader.ReadClaims(
            ReadString(root, "id_token") ?? accessToken);

        return new ChatGptTokens(
            accessToken,
            ReadString(root, "refresh_token"),
            DateTimeOffset.UtcNow + lifetime,
            email,
            accountId,
            origin);
    }

    private static async Task RespondToBrowserAsync(HttpListenerContext context, bool success)
    {
        var title = success ? "Signed in" : "Sign-in failed";
        var body = success
            ? "Signed in to ChatGPT. You can close this tab and return to Helmion."
            : "Sign-in did not complete. You can close this tab and return to Helmion.";
        var html = $"<html><head><title>{title}</title></head><body style=\"font-family:sans-serif;"
            + $"text-align:center;padding-top:4rem\"><h2>{title}</h2><p>{body}</p></body></html>";
        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
        context.Response.OutputStream.Close();
    }

    private async Task<JsonElement> PostFormAsync(
        string url,
        Dictionary<string, string> form,
        CancellationToken cancellationToken)
    {
        HttpResponseMessage response;
        string body;
        try
        {
            using var content = new FormUrlEncodedContent(form);
            response = await _http.PostAsync(url, content, cancellationToken);
            body = await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            throw new ChatGptAuthException(
                $"Could not reach OpenAI's sign-in service ({ex.Message}). Check your internet "
                + "connection or a corporate proxy, then try again.");
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            throw new ChatGptAuthException(
                $"OpenAI's sign-in service returned an unreadable reply (HTTP {(int)response.StatusCode}).");
        }

        using (document)
        {
            var root = document.RootElement.Clone();
            if (response.IsSuccessStatusCode && !root.TryGetProperty("error", out _))
            {
                return root;
            }

            var code = ReadString(root, "error");
            throw new ChatGptAuthException(
                code == "invalid_grant"
                    ? "This ChatGPT session is no longer valid — it was revoked, or it expired. "
                      + "Sign in again, or use the API key field."
                    : "OpenAI's sign-in service returned "
                      + (code is null ? $"HTTP {(int)response.StatusCode}" : $"'{code}'")
                      + (ReadString(root, "error_description") is { } detail ? $": {detail}" : "")
                      + ".",
                code);
        }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;

    private static string GenerateCodeVerifier()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Base64UrlEncode(bytes);
    }

    private static string ComputeCodeChallenge(string verifier)
    {
        var hash = SHA256.HashData(Encoding.ASCII.GetBytes(verifier));
        return Base64UrlEncode(hash);
    }

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
    }
}

/// <summary>
/// On-disk home for the ChatGPT session, encrypted with Windows DPAPI — same shape and rationale
/// as <see cref="SuperGrokTokenStore"/>.
/// </summary>
public sealed class ChatGptSubscriptionTokenStore
{
    private readonly string _path;

    public ChatGptSubscriptionTokenStore(string? path = null)
    {
        _path = path ?? DefaultPath();
    }

    public static string DefaultPath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "chatgpt-oauth.dat");

    public bool Exists => File.Exists(_path);

    public ChatGptTokens? Load()
    {
        if (!File.Exists(_path)) return null;

        try
        {
            var plaintext = System.Security.Cryptography.ProtectedData.Unprotect(
                File.ReadAllBytes(_path),
                Entropy,
                System.Security.Cryptography.DataProtectionScope.CurrentUser);
            var record = JsonSerializer.Deserialize<StoredSession>(plaintext);
            if (record?.AccessToken is null or "") return null;

            return new ChatGptTokens(
                record.AccessToken,
                string.IsNullOrWhiteSpace(record.RefreshToken) ? null : record.RefreshToken,
                DateTimeOffset.FromUnixTimeSeconds(record.ExpiresAtUnix),
                record.Email,
                record.AccountId,
                record.Origin ?? ChatGptTokens.OriginAuthCodeFlow);
        }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException
                                       or JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Save(ChatGptTokens tokens)
    {
        ArgumentNullException.ThrowIfNull(tokens);

        var payload = JsonSerializer.SerializeToUtf8Bytes(new StoredSession
        {
            AccessToken = tokens.AccessToken,
            RefreshToken = tokens.RefreshToken,
            ExpiresAtUnix = tokens.ExpiresAt.ToUnixTimeSeconds(),
            Email = tokens.Email,
            AccountId = tokens.AccountId,
            Origin = tokens.Origin,
        });

        var directory = System.IO.Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllBytes(
            _path,
            System.Security.Cryptography.ProtectedData.Protect(
                payload, Entropy, System.Security.Cryptography.DataProtectionScope.CurrentUser));
    }

    public void Clear()
    {
        try
        {
            if (File.Exists(_path)) File.Delete(_path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Sign-out is best effort.
        }
    }

    private static readonly byte[] Entropy =
        Encoding.UTF8.GetBytes("Helmion.ChatGpt.OAuth.v1");

    private sealed class StoredSession
    {
        [System.Text.Json.Serialization.JsonPropertyName("access_token")]
        public string? AccessToken { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("refresh_token")]
        public string? RefreshToken { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("expires_at")]
        public long ExpiresAtUnix { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("email")]
        public string? Email { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("account_id")]
        public string? AccountId { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("origin")]
        public string? Origin { get; set; }
    }
}

/// <summary>
/// Reads the unsigned, non-sensitive claims out of a ChatGPT id/access token so the UI can say
/// WHO is signed in. Deliberately not a validating JWT parse, mirroring
/// <see cref="SuperGrokTokenReader"/> — Helmion is not the audience and asserts nothing about
/// the signature.
/// </summary>
public static class ChatGptTokenReader
{
    /// <summary>
    /// Account id extraction follows the same fallback chain used by the public reimplementation
    /// of this flow: a top-level <c>chatgpt_account_id</c> claim, then
    /// <c>https://api.openai.com/auth.chatgpt_account_id</c>, then the first organization id.
    /// </summary>
    public static (string? Email, string? AccountId) ReadClaims(string? token)
    {
        var payload = ReadPayload(token);
        if (payload is null) return (null, null);

        var email = ReadString(payload.Value, "email");

        var accountId = ReadString(payload.Value, "chatgpt_account_id");
        if (accountId is null
            && payload.Value.TryGetProperty("https://api.openai.com/auth", out var authClaims)
            && authClaims.ValueKind == JsonValueKind.Object)
        {
            accountId = ReadString(authClaims, "chatgpt_account_id");
        }
        if (accountId is null
            && payload.Value.TryGetProperty("organizations", out var orgs)
            && orgs.ValueKind == JsonValueKind.Array
            && orgs.GetArrayLength() > 0)
        {
            accountId = ReadString(orgs[0], "id");
        }

        return (email, accountId);
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static JsonElement? ReadPayload(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;

        var parts = token.Split('.');
        if (parts.Length < 2) return null;

        try
        {
            var segment = parts[1].Replace('-', '+').Replace('_', '/');
            segment = (segment.Length % 4) switch
            {
                2 => segment + "==",
                3 => segment + "=",
                0 => segment,
                _ => null!,
            };
            if (segment is null) return null;

            using var document = JsonDocument.Parse(Convert.FromBase64String(segment));
            return document.RootElement.Clone();
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }
    }
}

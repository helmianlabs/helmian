using System.Net.Http;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Raised when SuperGrok sign-in cannot continue. The message is written to be shown
/// to the user verbatim — no stack traces, no OAuth jargon without a plain translation.
/// </summary>
public sealed class SuperGrokAuthException(string message, string? errorCode = null)
    : Exception(message)
{
    /// <summary>The raw OAuth <c>error</c> code when the auth server supplied one.</summary>
    public string? ErrorCode { get; } = errorCode;
}

/// <summary>Device authorization response — safe to show; the user code is meant to be read aloud.</summary>
public sealed record SuperGrokDeviceCode(
    string DeviceCode,
    string UserCode,
    string VerificationUri,
    string VerificationUriComplete,
    DateTimeOffset ExpiresAt,
    TimeSpan PollInterval);

/// <summary>
/// A live SuperGrok session. <see cref="AccessToken"/> and <see cref="RefreshToken"/> are
/// secrets: never log them, never put them in a window title, never write them to .env.
/// </summary>
public sealed record SuperGrokTokens(
    string AccessToken,
    string? RefreshToken,
    DateTimeOffset ExpiresAt,
    string? Email,
    string Origin)
{
    /// <summary>Signed in through Helmion's own device-code flow.</summary>
    public const string OriginDeviceFlow = "device-flow";

    /// <summary>Adopted from an existing Grok CLI session on this machine.</summary>
    public const string OriginGrokCli = "grok-cli";

    /// <summary>
    /// Treat a token as expired 60 s early so a request never leaves with a token that
    /// dies in flight.
    /// </summary>
    public bool IsExpired(DateTimeOffset now) => ExpiresAt - TimeSpan.FromSeconds(60) <= now;
}

/// <summary>
/// OAuth 2.0 Device Authorization Grant (RFC 8628) against xAI's auth server, so a user with
/// a SuperGrok subscription can sign in instead of pasting an API key.
///
/// <para>
/// VERIFIED AGAINST THE LIVE SERVER 2026-08-04. Every constant below was confirmed two ways:
/// the literals were read out of the official Grok CLI binary (<c>~/.grok/bin/grok.exe</c>,
/// v0.2.118 — it contains <c>/oauth2/device/code</c>, <c>/oauth2/token</c> and
/// <c>urn:ietf:params:oauth:grant-type:device_code</c>), and then each endpoint was called
/// directly. <c>POST /oauth2/device/code</c> with this client id returned HTTP 200 and a real
/// <c>device_code</c>/<c>user_code</c>/<c>verification_uri</c>; polling <c>/oauth2/token</c>
/// returned <c>authorization_pending</c>; a junk refresh token returned <c>invalid_grant</c>.
/// </para>
///
/// <para>
/// The client id is xAI's own first-party device client — the same one the official CLI uses.
/// It is not a secret and there is nothing for Helmion to register: it is the audience
/// (<c>aud</c>) claim of the tokens the CLI already mints. This is public-client device flow,
/// so there is no client secret anywhere in this file by design.
/// </para>
/// </summary>
public sealed class SuperGrokOAuthClient : IDisposable
{
    public const string Issuer = "https://auth.x.ai";
    public const string DeviceCodeEndpoint = Issuer + "/oauth2/device/code";
    public const string TokenEndpoint = Issuer + "/oauth2/token";
    public const string DeviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";

    /// <summary>
    /// Minimal public-client device authorization scope. xAI requires a scope on this
    /// request; <c>openid</c> identifies the signed-in session and <c>offline_access</c>
    /// requests refresh-token continuity. No chat, tool, data, or provider API scope is
    /// requested here.
    /// </summary>
    public const string DeviceAuthorizationScope = "openid offline_access";

    /// <summary>
    /// xAI's first-party device-flow client id. Confirmed as the <c>aud</c> claim of a live
    /// Grok CLI access token and accepted by <see cref="DeviceCodeEndpoint"/>.
    /// </summary>
    public const string ClientId = "b1a00492-073a-47ea-816f-4c329264a828";

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    public SuperGrokOAuthClient(HttpClient? http = null)
    {
        _ownsHttp = http is null;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    /// <summary>Overridable so the smoke tests can point the flow at a loopback stub.</summary>
    public string DeviceCodeUrl { get; init; } = DeviceCodeEndpoint;

    public string TokenUrl { get; init; } = TokenEndpoint;

    /// <summary>Step 1 — ask xAI for a user code and the page the user types it into.</summary>
    public async Task<SuperGrokDeviceCode> RequestDeviceCodeAsync(
        CancellationToken cancellationToken = default)
    {
        var root = await PostFormAsync(
            DeviceCodeUrl,
            new Dictionary<string, string>
            {
                ["client_id"] = ClientId,
                ["scope"] = DeviceAuthorizationScope,
            },
            cancellationToken);

        var deviceCode = ReadString(root, "device_code");
        var userCode = ReadString(root, "user_code");
        var verificationUri = ReadString(root, "verification_uri");
        if (deviceCode is null || userCode is null || verificationUri is null)
        {
            throw new SuperGrokAuthException(
                "xAI's sign-in service answered, but the response was missing the device code. "
                + "Try again, or use the API key field instead.");
        }

        var interval = root.TryGetProperty("interval", out var intervalEl)
            && intervalEl.TryGetInt32(out var seconds) && seconds > 0
                ? TimeSpan.FromSeconds(seconds)
                : TimeSpan.FromSeconds(5);

        var lifetime = root.TryGetProperty("expires_in", out var expiresEl)
            && expiresEl.TryGetInt32(out var expiresIn) && expiresIn > 0
                ? TimeSpan.FromSeconds(expiresIn)
                : TimeSpan.FromMinutes(15);

        return new SuperGrokDeviceCode(
            deviceCode,
            userCode,
            verificationUri,
            ReadString(root, "verification_uri_complete") ?? verificationUri,
            DateTimeOffset.UtcNow + lifetime,
            interval);
    }

    /// <summary>
    /// Step 2 — poll until the user finishes in the browser. Honours the RFC 8628
    /// <c>slow_down</c> backoff, and stops on every terminal error rather than spinning.
    /// </summary>
    public async Task<SuperGrokTokens> PollForTokenAsync(
        SuperGrokDeviceCode device,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(device);

        var interval = device.PollInterval;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (DateTimeOffset.UtcNow >= device.ExpiresAt)
            {
                throw new SuperGrokAuthException(
                    "The sign-in code expired before it was approved. Press "
                    + "\"Login with SuperGrok\" to get a new one.",
                    "expired_token");
            }

            await Task.Delay(interval, cancellationToken);

            JsonElement root;
            try
            {
                root = await PostFormAsync(
                    TokenUrl,
                    new Dictionary<string, string>
                    {
                        ["grant_type"] = DeviceCodeGrantType,
                        ["client_id"] = ClientId,
                        ["device_code"] = device.DeviceCode,
                    },
                    cancellationToken);
            }
            catch (SuperGrokAuthException ex) when (ex.ErrorCode == "authorization_pending")
            {
                progress?.Report("Waiting for you to approve the sign-in in your browser…");
                continue;
            }
            catch (SuperGrokAuthException ex) when (ex.ErrorCode == "slow_down")
            {
                interval += TimeSpan.FromSeconds(5);
                progress?.Report("xAI asked us to slow down — still waiting for approval…");
                continue;
            }

            return ReadTokens(root, SuperGrokTokens.OriginDeviceFlow);
        }
    }

    /// <summary>
    /// Exchange a refresh token for a fresh access token. xAI issues refresh tokens under the
    /// <c>offline_access</c> scope, which the device flow above grants; when a response omits
    /// <c>refresh_token</c> the caller keeps the one it already had.
    /// </summary>
    public async Task<SuperGrokTokens> RefreshAsync(
        string refreshToken,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            throw new SuperGrokAuthException(
                "This SuperGrok session has no refresh token, so it cannot be renewed. "
                + "Sign in again.",
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

        var refreshed = ReadTokens(root, SuperGrokTokens.OriginDeviceFlow);
        return refreshed.RefreshToken is null
            ? refreshed with { RefreshToken = refreshToken }
            : refreshed;
    }

    private static SuperGrokTokens ReadTokens(JsonElement root, string origin)
    {
        var accessToken = ReadString(root, "access_token");
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            throw new SuperGrokAuthException(
                "xAI approved the sign-in but returned no access token. Try signing in again.");
        }

        var lifetime = root.TryGetProperty("expires_in", out var expiresEl)
            && expiresEl.TryGetInt32(out var expiresIn) && expiresIn > 0
                ? TimeSpan.FromSeconds(expiresIn)
                : TimeSpan.FromHours(1);

        return new SuperGrokTokens(
            accessToken,
            ReadString(root, "refresh_token"),
            DateTimeOffset.UtcNow + lifetime,
            SuperGrokTokenReader.ReadEmailClaim(accessToken),
            origin);
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
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SuperGrokAuthException(
                "xAI's sign-in service did not answer in time. Check your internet connection "
                + "and try again.");
        }
        catch (HttpRequestException ex)
        {
            throw new SuperGrokAuthException(
                $"Could not reach xAI's sign-in service ({ex.Message}). Check your internet "
                + "connection or a corporate proxy, then try again.");
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            throw new SuperGrokAuthException(
                $"xAI's sign-in service returned an unreadable reply (HTTP {(int)response.StatusCode}).");
        }

        using (document)
        {
            var root = document.RootElement.Clone();
            if (response.IsSuccessStatusCode && !root.TryGetProperty("error", out _))
            {
                return root;
            }

            var code = ReadString(root, "error");
            throw new SuperGrokAuthException(DescribeError(code, root, response.StatusCode), code);
        }
    }

    private static string DescribeError(string? code, JsonElement root, System.Net.HttpStatusCode status) =>
        code switch
        {
            // Not user-facing: PollForTokenAsync catches these two before they surface.
            "authorization_pending" => "Waiting for approval.",
            "slow_down" => "Polling too fast.",
            "access_denied" =>
                "The sign-in was declined in the browser. Nothing was changed — press "
                + "\"Login with SuperGrok\" to try again.",
            "expired_token" =>
                "The sign-in code expired before it was approved. Press \"Login with SuperGrok\" "
                + "to get a new one.",
            "invalid_grant" =>
                "This SuperGrok session is no longer valid — it was revoked, or it expired. "
                + "Sign in again, or use the API key field.",
            "invalid_client" =>
                "xAI rejected Helmion's sign-in client. Use the API key field until this is fixed.",
            _ => "xAI's sign-in service returned "
                + (code is null ? $"HTTP {(int)status}" : $"'{code}'")
                + (ReadString(root, "error_description") is { } detail ? $": {detail}" : "")
                + ".",
        };

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;

    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
    }
}

/// <summary>
/// Reads the unsigned, non-sensitive claims out of an access token so the UI can say WHO is
/// signed in and WHEN the session lapses.
///
/// <para>
/// This is deliberately not a validating JWT parse: Helmion is not the audience and has no
/// business asserting the signature. Nothing here is a security decision — the auth server
/// is the only thing that decides whether a token is good. If the token is opaque or
/// malformed, every method returns null and the caller falls back to what the store recorded.
/// </para>
/// </summary>
public static class SuperGrokTokenReader
{
    public static string? ReadEmailClaim(string? accessToken) => ReadClaim(accessToken, "email");

    /// <summary>Expiry from the token's own <c>exp</c> claim, or null when unreadable.</summary>
    public static DateTimeOffset? ReadExpiry(string? accessToken)
    {
        var payload = ReadPayload(accessToken);
        if (payload is null) return null;

        return payload.Value.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var seconds)
            ? DateTimeOffset.FromUnixTimeSeconds(seconds)
            : null;
    }

    private static string? ReadClaim(string? accessToken, string name)
    {
        var payload = ReadPayload(accessToken);
        if (payload is null) return null;

        return payload.Value.TryGetProperty(name, out var element)
            && element.ValueKind == JsonValueKind.String
                ? element.GetString()
                : null;
    }

    private static JsonElement? ReadPayload(string? accessToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken)) return null;

        var parts = accessToken.Split('.');
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

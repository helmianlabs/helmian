using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// A subscription session adopted read-only from a provider's own official CLI, plus the
/// arguments to invoke that CLI non-interactively for one chat turn.
///
/// <para>
/// SUPERSEDES the raw-OAuth approach in OpenAIChatGPTOAuth.cs / GoogleGeminiOAuth.cs for actual
/// chat requests. Verified 2026-08-04: OpenAI's and Google's subscription chat backends
/// (chatgpt.com/backend-api/..., cloudcode-pa.googleapis.com) are undocumented private APIs with
/// no verifiable public request/response shape — see feedback-2026-08-04-responsible-uncertainty-
/// vs-weak-hedging.md. Troy's explicit call: default to shelling out to each provider's own
/// official CLI/SDK login flow rather than reverse-engineering those endpoints. The CLI already
/// knows how to talk to its own backend correctly; Helmion does not need to.
/// </para>
///
/// <para>
/// Mirrors <see cref="GrokCliSessionReader"/>'s read-only philosophy exactly: Helmion never
/// writes to, rewrites, or deletes a CLI's own auth file. It only reads far enough to know
/// whether a session exists and who it belongs to, for the status line.
/// </para>
/// </summary>
public sealed record ProviderCliSession(string? Email, string? AccountId, DateTimeOffset? ExpiresAt)
{
    public bool IsExpired(DateTimeOffset now) => ExpiresAt is { } at && at <= now;
}

/// <summary>
/// Reads whether the OpenAI Codex CLI has an active login, from <c>~/.codex/auth.json</c>.
///
/// <para>
/// SHAPE, VERIFIED 2026-08-04 against a real file on this machine:
/// <c>{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id },
/// last_refresh }</c>. Only structural keys were inspected — no token value was read into any
/// claim in this codebase.
/// </para>
/// </summary>
public static class CodexCliSessionReader
{
    public static string DefaultAuthFilePath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".codex",
        "auth.json");

    public static ProviderCliSession? TryRead(string? authFilePath = null)
    {
        var path = authFilePath ?? DefaultAuthFilePath();
        if (!File.Exists(path)) return null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("tokens", out var tokens) || tokens.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var accessToken = ReadString(tokens, "access_token");
            if (string.IsNullOrWhiteSpace(accessToken)) return null;

            var idToken = ReadString(tokens, "id_token") ?? accessToken;
            var (email, accountId) = ChatGptTokenReader.ReadClaims(idToken);
            var expiry = ReadExpiryClaim(accessToken);
            var explicitAccountId = ReadString(tokens, "account_id") ?? accountId;

            return new ProviderCliSession(email, explicitAccountId, expiry);
        }
    }

    private static DateTimeOffset? ReadExpiryClaim(string token)
    {
        var parts = token.Split('.');
        if (parts.Length < 2) return null;
        try
        {
            var segment = parts[1].Replace('-', '+').Replace('_', '/');
            segment = (segment.Length % 4) switch { 2 => segment + "==", 3 => segment + "=", 0 => segment, _ => null! };
            if (segment is null) return null;
            using var doc = JsonDocument.Parse(Convert.FromBase64String(segment));
            return doc.RootElement.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var seconds)
                ? DateTimeOffset.FromUnixTimeSeconds(seconds)
                : null;
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>
/// Reads whether the Google Gemini CLI has an active login. Google's own CLI stores this under
/// <c>~/.gemini/oauth_creds.json</c> once a user completes `gemini` interactive login — confirmed
/// by the client id / endpoint constants read out of the installed @google/gemini-cli package
/// (see GoogleGeminiOAuth.cs remarks); the credential FILE itself was not present on this machine
/// to verify its exact field names against, so this reads defensively and returns null on any
/// shape it doesn't recognize rather than guessing a field name.
/// </summary>
public static class GeminiCliSessionReader
{
    public static string DefaultAuthFilePath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".gemini",
        "oauth_creds.json");

    public static ProviderCliSession? TryRead(string? authFilePath = null)
    {
        var path = authFilePath ?? DefaultAuthFilePath();
        if (!File.Exists(path)) return null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var accessToken = ReadString(root, "access_token");
            if (string.IsNullOrWhiteSpace(accessToken)) return null;

            var idToken = ReadString(root, "id_token");
            var email = idToken is not null ? GoogleGeminiTokenReader.ReadEmailClaim(idToken) : null;

            DateTimeOffset? expiry = null;
            if (root.TryGetProperty("expiry_date", out var expiryEl))
            {
                if (expiryEl.ValueKind == JsonValueKind.Number && expiryEl.TryGetInt64(out var millis))
                {
                    expiry = DateTimeOffset.FromUnixTimeMilliseconds(millis);
                }
            }

            return new ProviderCliSession(email, null, expiry);
        }
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

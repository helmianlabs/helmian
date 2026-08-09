using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Reads the unsigned <c>email</c> claim out of a Google id token so the UI can say WHO is
/// signed in. Deliberately not a validating JWT parse, mirroring <see cref="SuperGrokTokenReader"/>.
///
/// <para>
/// EXTRACTED 2026-08-09 out of <c>GoogleGeminiOAuth.cs</c>, unchanged. That file hardcodes a real
/// Google OAuth client secret and is therefore being held back from this public repo pending
/// Troy's decision, but this type is the ONE piece of it that production code actually calls
/// (<c>ProviderCliSession.cs:148</c> -> <see cref="ReadEmailClaim"/>). It needs no secret, no HTTP
/// and no OAuth client: it base64url-decodes the payload segment and reads one string property.
/// Splitting it out is what lets the rest stay uncommitted without breaking the build.
/// </para>
/// </summary>
public static class GoogleGeminiTokenReader
{
    public static string? ReadEmailClaim(string? idToken)
    {
        var payload = ReadPayload(idToken);
        if (payload is null) return null;

        return payload.Value.TryGetProperty("email", out var value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
    }

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

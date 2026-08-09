using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Helmion.Desktop.Core;

/// <summary>
/// On-disk home for the SuperGrok session, encrypted with Windows DPAPI at
/// <see cref="DataProtectionScope.CurrentUser"/> scope.
///
/// <para>
/// WHY NOT .env. Every other credential in this app lands in a plaintext <c>.env</c> through
/// <see cref="EnvironmentSettingsStore"/>, and <c>ApplyToProcess</c> pushes those into
/// environment variables that child agent processes inherit. An OAuth access token must not
/// travel that way: it is a bearer credential for the user's whole xAI account, it rotates,
/// and an environment variable is readable by every child process and shows up in crash
/// dumps. So this store is a separate file that only ever holds ciphertext, and the plaintext
/// exists only inside this process's memory. The provider registry has been promising
/// "DPAPI-protected local storage" since <c>ProviderProfiles.cs</c> was written; this is the
/// first thing that actually does it.
/// </para>
/// </summary>
public sealed class SuperGrokTokenStore
{
    private readonly string _path;

    public SuperGrokTokenStore(string? path = null)
    {
        _path = path ?? DefaultPath();
    }

    public static string DefaultPath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "supergrok-oauth.dat");

    public string FilePath => _path;

    public bool Exists => File.Exists(_path);

    /// <summary>
    /// Returns the stored session, or null when there is none, when the file was written by a
    /// different Windows user, or when it is corrupt. A store that cannot be read is treated as
    /// empty rather than fatal — the user can always sign in again or fall back to the API key.
    /// </summary>
    public SuperGrokTokens? Load()
    {
        if (!File.Exists(_path)) return null;

        try
        {
            var plaintext = ProtectedData.Unprotect(
                File.ReadAllBytes(_path),
                Entropy,
                DataProtectionScope.CurrentUser);
            var record = JsonSerializer.Deserialize<StoredSession>(plaintext);
            if (record?.AccessToken is null or "") return null;

            return new SuperGrokTokens(
                record.AccessToken,
                string.IsNullOrWhiteSpace(record.RefreshToken) ? null : record.RefreshToken,
                DateTimeOffset.FromUnixTimeSeconds(record.ExpiresAtUnix),
                record.Email,
                record.Origin ?? SuperGrokTokens.OriginDeviceFlow);
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or IOException
                                       or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Save(SuperGrokTokens tokens)
    {
        ArgumentNullException.ThrowIfNull(tokens);

        var payload = JsonSerializer.SerializeToUtf8Bytes(new StoredSession
        {
            AccessToken = tokens.AccessToken,
            RefreshToken = tokens.RefreshToken,
            ExpiresAtUnix = tokens.ExpiresAt.ToUnixTimeSeconds(),
            Email = tokens.Email,
            Origin = tokens.Origin,
        });

        var directory = System.IO.Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllBytes(
            _path,
            ProtectedData.Protect(payload, Entropy, DataProtectionScope.CurrentUser));
    }

    public void Clear()
    {
        try
        {
            if (File.Exists(_path)) File.Delete(_path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Sign-out is best effort; the caller already dropped the in-memory copy.
        }
    }

    /// <summary>
    /// Extra entropy mixed into DPAPI so a blob from this store cannot be decrypted by another
    /// application running as the same user just by calling Unprotect on the bytes.
    /// </summary>
    private static readonly byte[] Entropy =
        Encoding.UTF8.GetBytes("Helmion.SuperGrok.OAuth.v1");

    private sealed class StoredSession
    {
        [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
        [JsonPropertyName("refresh_token")] public string? RefreshToken { get; set; }
        [JsonPropertyName("expires_at")] public long ExpiresAtUnix { get; set; }
        [JsonPropertyName("email")] public string? Email { get; set; }
        [JsonPropertyName("origin")] public string? Origin { get; set; }
    }
}

/// <summary>
/// Finds an existing SuperGrok session belonging to the official Grok CLI so a user who has
/// already run <c>grok login</c> does not have to authorise a second device code.
///
/// <para>
/// SHAPE, VERIFIED 2026-08-04 against a real <c>%USERPROFILE%\.grok\auth.json</c>. The file is
/// an object keyed by <c>"&lt;issuer&gt;::&lt;client-id&gt;"</c>; each value carries
/// <c>key</c> (the access token), <c>refresh_token</c>, <c>expires_at</c>, <c>email</c>,
/// <c>oidc_issuer</c> and <c>oidc_client_id</c>. Redacted example:
/// </para>
/// <code>
/// { "https://auth.x.ai::00000000-0000-0000-0000-000000000000": {
///     "key": "&lt;jwt&gt;", "refresh_token": "&lt;opaque&gt;",
///     "expires_at": 1785857986, "email": "user@example.com",
///     "oidc_issuer": "https://auth.x.ai",
///     "oidc_client_id": "00000000-0000-0000-0000-000000000000" } }
/// </code>
///
/// <para>
/// READ ONLY, ALWAYS. Helmion never writes to, rewrites, or deletes the Grok CLI's file — it
/// copies the session into Helmion's own DPAPI store and leaves the CLI's state exactly as it
/// found it. Note that <see cref="EnvironmentSettingsStore.IsProviderHomeDirectory"/> already
/// bars <c>~/.grok</c> from ever becoming the agent tool workspace; this narrow, explicit,
/// user-initiated read is the one sanctioned exception, and it touches one known file.
/// </para>
/// </summary>
public static class GrokCliSessionReader
{
    public static string DefaultAuthFilePath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".grok",
        "auth.json");

    /// <summary>
    /// Returns the newest non-expired xAI session in the Grok CLI's auth file, or null when the
    /// file is absent, unreadable, holds no auth.x.ai entry, or every entry has lapsed.
    /// </summary>
    public static SuperGrokTokens? TryRead(string? authFilePath = null)
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
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;

            SuperGrokTokens? best = null;
            foreach (var entry in document.RootElement.EnumerateObject())
            {
                if (!entry.Name.StartsWith(SuperGrokOAuthClient.Issuer, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var candidate = ReadEntry(entry.Value);
                if (candidate is null) continue;
                if (best is null || candidate.ExpiresAt > best.ExpiresAt) best = candidate;
            }

            return best is not null && !best.IsExpired(DateTimeOffset.UtcNow) ? best : null;
        }
    }

    private static SuperGrokTokens? ReadEntry(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object) return null;

        var accessToken = ReadString(entry, "key");
        if (string.IsNullOrWhiteSpace(accessToken)) return null;

        // Prefer the token's own exp claim over the file's expires_at: the claim is what the
        // auth server will actually enforce, and the file's copy can drift.
        var expiry = SuperGrokTokenReader.ReadExpiry(accessToken)
            ?? (entry.TryGetProperty("expires_at", out var storedExpiry)
                && storedExpiry.TryGetInt64(out var unixSeconds)
                    ? DateTimeOffset.FromUnixTimeSeconds(unixSeconds)
                    : DateTimeOffset.UtcNow);

        return new SuperGrokTokens(
            accessToken,
            ReadString(entry, "refresh_token"),
            expiry,
            ReadString(entry, "email") ?? SuperGrokTokenReader.ReadEmailClaim(accessToken),
            SuperGrokTokens.OriginGrokCli);
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

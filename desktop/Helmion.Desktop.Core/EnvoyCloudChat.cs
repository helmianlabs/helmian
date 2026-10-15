using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>A team chat channel from helmian.cloud (Envoy).</summary>
public sealed record EnvoyChannel(string Id, string Slug, string Title, string Kind);

/// <summary>A team chat message from helmian.cloud (Envoy).</summary>
public sealed record EnvoyMessage(string Id, string ChannelId, string AuthorSubject, string AuthorKind, string Body, DateTimeOffset? CreatedAt);

/// <summary>
/// Desktop link to helmian.cloud team chat. The user presses "Link desktop app" in
/// helmian.cloud/app (Settings), types the 8-character code here, and the cloud
/// returns a desktop token that only works on the Envoy chat routes. The token is
/// kept with Windows DPAPI (CurrentUser) and never written to .env files.
/// </summary>
public sealed partial class EnvoyCloudLinkStore
{
    private static readonly byte[] Entropy = "Helmion.EnvoyCloudLink.v1"u8.ToArray();
    private readonly string _path;

    public EnvoyCloudLinkStore(string? path = null) => _path = path ?? DefaultPath();

    public static string DefaultPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Helmion", "envoy-cloud-link.dat");

    public bool Exists => File.Exists(_path);

    public EnvoyCloudLink? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.CurrentUser);
            var link = JsonSerializer.Deserialize<EnvoyCloudLink>(plain);
            return link is { Token.Length: > 0 } && IsDesktopToken(link.Token) ? link : null;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Save(EnvoyCloudLink link)
    {
        ArgumentNullException.ThrowIfNull(link);
        if (!IsDesktopToken(link.Token)) throw new ArgumentException("Not a Helmian desktop token.", nameof(link));
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllBytes(_path, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(link), Entropy, DataProtectionScope.CurrentUser));
    }

    public void Clear()
    {
        try { if (File.Exists(_path)) File.Delete(_path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public static bool IsDesktopToken(string? value) => value is not null && DesktopTokenPattern().IsMatch(value);

    [GeneratedRegex("^hdt_[A-Za-z0-9_-]{40,80}$")]
    private static partial Regex DesktopTokenPattern();
}

public sealed record EnvoyCloudLink(string Token, string Origin, string? Organization, DateTimeOffset LinkedAt);

/// <summary>HTTP client for helmian.cloud Envoy team chat (same APIs as helmian.cloud/app).</summary>
public sealed partial class EnvoyCloudChatClient(HttpClient http, Uri origin)
{
    public static readonly Uri DefaultOrigin = new("https://helmian.cloud");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public Uri Origin { get; } = RequireOrigin(origin);

    public static Uri OriginFromEnvironment() =>
        Uri.TryCreate(Environment.GetEnvironmentVariable("HELMION_CLOUD_ORIGIN"), UriKind.Absolute, out var o) ? o : DefaultOrigin;

    /// <summary>Normalizes "abcd efgh" / "ABCD-EFGH" to "ABCD-EFGH"; null when not a valid link code.</summary>
    public static string? NormalizeLinkCode(string? input)
    {
        var raw = new string((input ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (raw.Length != 8) return null;
        var code = $"{raw[..4]}-{raw[4..]}";
        return LinkCodePattern().IsMatch(code) ? code : null;
    }

    public async Task<EnvoyCloudLink> LinkAsync(string code, CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeLinkCode(code) ?? throw new ArgumentException("That code doesn't look right. It has 8 letters and numbers, like ABCD-EFGH.");
        using var response = await http.PostAsJsonAsync(new Uri(Origin, "/api/admin/desktop/link/exchange"), new { code = normalized }, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Gone) throw new InvalidOperationException("That code expired or was already used. Make a new one in helmian.cloud/app → Settings.");
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"helmian.cloud could not link this desktop (HTTP {(int)response.StatusCode}).");
        var body = await response.Content.ReadFromJsonAsync<LinkReply>(Json, cancellationToken);
        if (body is null || !EnvoyCloudLinkStore.IsDesktopToken(body.Token)) throw new InvalidDataException("helmian.cloud returned no desktop token.");
        return new EnvoyCloudLink(body.Token, Origin.AbsoluteUri, body.TenantId, DateTimeOffset.UtcNow);
    }

    public async Task<IReadOnlyList<EnvoyChannel>> ListChannelsAsync(string token, CancellationToken cancellationToken = default)
    {
        var body = await SendAsync<ChannelsReply>(HttpMethod.Get, "/api/admin/envoy/channels", token, null, cancellationToken);
        return body.Channels ?? [];
    }

    public async Task<IReadOnlyList<EnvoyMessage>> ListMessagesAsync(string token, string channelId, string? afterId = null, CancellationToken cancellationToken = default)
    {
        var path = $"/api/admin/envoy/messages?channel_id={Uri.EscapeDataString(channelId)}" + (afterId is { Length: > 0 } ? $"&after_id={Uri.EscapeDataString(afterId)}" : string.Empty);
        var body = await SendAsync<MessagesReply>(HttpMethod.Get, path, token, null, cancellationToken);
        return body.Messages ?? [];
    }

    public async Task SendMessageAsync(string token, string channelId, string text, CancellationToken cancellationToken = default)
    {
        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length is 0 or > 4000) throw new ArgumentException("Messages must be 1–4000 characters.");
        await SendAsync<JsonElement>(HttpMethod.Post, "/api/admin/envoy/messages", token,
            new { channelId, body = trimmed, idempotencyKey = Guid.NewGuid().ToString("N") }, cancellationToken);
    }

    public async Task UnlinkAsync(string token, CancellationToken cancellationToken = default)
    {
        try { await SendAsync<JsonElement>(HttpMethod.Post, "/api/admin/desktop/link/revoke", token, new { }, cancellationToken); }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException) { /* best effort; local copy is cleared by the caller */ }
    }

    private async Task<T> SendAsync<T>(HttpMethod method, string path, string token, object? payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, new Uri(Origin, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (payload is not null) request.Content = JsonContent.Create(payload);
        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            throw new UnauthorizedAccessException("This desktop is no longer linked to your Helmian team. Link it again from helmian.cloud/app → Settings.");
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Team chat is unavailable right now (HTTP {(int)response.StatusCode}).");
        return (await response.Content.ReadFromJsonAsync<T>(Json, cancellationToken))!;
    }

    private static Uri RequireOrigin(Uri origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        if (!origin.IsAbsoluteUri || (origin.Scheme != Uri.UriSchemeHttps && !origin.IsLoopback))
            throw new ArgumentException("helmian.cloud origin must be HTTPS.", nameof(origin));
        return new Uri(origin.GetLeftPart(UriPartial.Authority));
    }

    [GeneratedRegex("^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")]
    private static partial Regex LinkCodePattern();

    private sealed record LinkReply(string Token, string? TenantId);
    private sealed record ChannelsReply(IReadOnlyList<EnvoyChannel>? Channels);
    private sealed record MessagesReply(IReadOnlyList<EnvoyMessage>? Messages);
}

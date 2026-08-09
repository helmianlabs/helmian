using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

public sealed record BrowserReferenceValidation(
    bool Allowed,
    Uri? Address,
    string Message);

public sealed record BrowserReferenceResult(
    Uri RequestedAddress,
    Uri FinalAddress,
    string DisplayAddress,
    string Title,
    string Text,
    string ContentType,
    int CharacterCount,
    bool WasTruncated,
    string EvidenceHash,
    DateTimeOffset LoadedAtUtc);

public sealed class BrowserReferenceException : Exception
{
    public BrowserReferenceException(string message) : base(message)
    {
    }

    public BrowserReferenceException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

public delegate Task<IPAddress[]> BrowserHostResolver(
    string host,
    CancellationToken cancellationToken);

/// <summary>
/// Reads a public HTTPS page as inert reference text. It sends no cookies or
/// credentials, executes no page code, writes no downloaded file, rejects
/// private/local network destinations, and revalidates every redirect.
/// </summary>
public sealed class BrowserReferenceReader : IDisposable
{
    public const int MaxResponseBytes = 1024 * 1024;
    public const int MaxTextCharacters = 120_000;
    public const int MaxAddressCharacters = 4096;
    public const int MaxTitleCharacters = 240;
    public const int MaxRedirects = 4;
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(20);

    private static readonly Regex TitlePattern = new(
        @"<title\b[^>]*>(.*?)</title\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private static readonly Regex CommentPattern = new(
        @"<!--.*?-->",
        RegexOptions.Singleline | RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private static readonly Regex InertBlockPattern = new(
        @"<(script|style|noscript|svg)\b[^>]*>.*?</\1\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private static readonly Regex LineBreakTagPattern = new(
        @"</?(?:br|p|div|li|tr|h[1-6]|section|article|blockquote|pre)\b[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private static readonly Regex TagPattern = new(
        @"<[^>]+>",
        RegexOptions.Singleline | RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private static readonly Regex HorizontalWhitespacePattern = new(
        @"[\t\f\v ]+",
        RegexOptions.CultureInvariant,
        TimeSpan.FromMilliseconds(250));

    private readonly BrowserHostResolver _resolveHost;
    private readonly HttpClient _http;
    private bool _disposed;

    public BrowserReferenceReader(
        HttpMessageHandler? handler = null,
        BrowserHostResolver? resolveHost = null)
    {
        _resolveHost = resolveHost ?? ResolveHostAsync;
        _http = new HttpClient(
            handler ?? CreateDefaultHandler(_resolveHost),
            disposeHandler: true)
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    public static BrowserReferenceValidation ValidateAddress(string? address)
    {
        var normalized = address?.Trim() ?? string.Empty;
        if (normalized.Length == 0)
        {
            return new BrowserReferenceValidation(false, null, "Enter an HTTPS address.");
        }

        if (normalized.Length > MaxAddressCharacters)
        {
            return new BrowserReferenceValidation(
                false,
                null,
                $"The address exceeds the {MaxAddressCharacters:N0}-character Browser limit.");
        }

        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        {
            return new BrowserReferenceValidation(false, null, "The address is not a valid absolute URL.");
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return new BrowserReferenceValidation(false, uri, "Browser references require HTTPS.");
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            return new BrowserReferenceValidation(
                false,
                uri,
                "Addresses containing a username or password are refused.");
        }

        if (uri.Port is <= 0 or > 65535)
        {
            return new BrowserReferenceValidation(false, uri, "The address has an invalid port.");
        }

        var host = uri.IdnHost.TrimEnd('.');
        if (host.Length == 0 || IsLocalHostName(host))
        {
            return new BrowserReferenceValidation(
                false,
                uri,
                "Local and private-network addresses are not available in Browser.");
        }

        if (IPAddress.TryParse(host, out var literal) && !IsPublicAddress(literal))
        {
            return new BrowserReferenceValidation(
                false,
                uri,
                "Local, private, reserved, and documentation network addresses are refused.");
        }

        return new BrowserReferenceValidation(
            true,
            uri,
            "Ready to read as inert text. No sign-in state or page code is used.");
    }

    public async Task<BrowserReferenceResult> ReadAsync(
        string? address,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var initial = ValidateAddress(address);
        if (!initial.Allowed || initial.Address is null)
        {
            throw new BrowserReferenceException(initial.Message);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(RequestTimeout);
        var token = timeout.Token;
        var current = initial.Address;

        for (var redirects = 0; ; redirects++)
        {
            await EnsurePublicDestinationAsync(current, token).ConfigureAwait(false);

            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/html"));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/plain", 0.9));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xhtml+xml", 0.8));
            request.Headers.UserAgent.ParseAdd("Helmian-Desktop-Reference-Reader/0.1");
            request.Headers.Referrer = null;

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new BrowserReferenceException("The page did not respond within 20 seconds.");
            }
            catch (HttpRequestException exception)
            {
                throw new BrowserReferenceException(
                    $"The page could not be read: {exception.Message}",
                    exception);
            }

            using (response)
            {
                if (IsRedirect(response.StatusCode))
                {
                    if (redirects >= MaxRedirects)
                    {
                        throw new BrowserReferenceException(
                            $"The page exceeded the {MaxRedirects}-redirect limit.");
                    }

                    var location = response.Headers.Location;
                    if (location is null)
                    {
                        throw new BrowserReferenceException("The page returned a redirect with no destination.");
                    }

                    current = location.IsAbsoluteUri ? location : new Uri(current, location);
                    var redirected = ValidateAddress(current.AbsoluteUri);
                    if (!redirected.Allowed || redirected.Address is null)
                    {
                        throw new BrowserReferenceException(
                            $"The page redirected to a refused address: {redirected.Message}");
                    }

                    current = redirected.Address;
                    continue;
                }

                if (!response.IsSuccessStatusCode)
                {
                    throw new BrowserReferenceException(
                        $"The page returned HTTP {(int)response.StatusCode} {response.ReasonPhrase}.".Trim());
                }

                var mediaType = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant();
                if (!IsSupportedTextType(mediaType))
                {
                    throw new BrowserReferenceException(
                        $"Browser reads text pages only; the server returned {mediaType ?? "an unknown content type"}.");
                }

                if (response.Content.Headers.ContentDisposition?.DispositionType
                    ?.Equals("attachment", StringComparison.OrdinalIgnoreCase) == true)
                {
                    throw new BrowserReferenceException(
                        "The server marked this response as a download. Browser does not download files.");
                }

                var declaredLength = response.Content.Headers.ContentLength;
                if (declaredLength > MaxResponseBytes)
                {
                    throw new BrowserReferenceException(
                        $"The text response is larger than the {MaxResponseBytes / 1024:N0} KB Browser limit.");
                }

                var bytes = await ReadResponseBytesAsync(response, token).ConfigureAwait(false);
                var raw = Encoding.UTF8.GetString(bytes);
                string title;
                string text;
                try
                {
                    title = ExtractTitle(raw, current.Host);
                    text = IsHtmlType(mediaType) ? HtmlToText(raw) : NormalizeText(raw);
                }
                catch (RegexMatchTimeoutException exception)
                {
                    throw new BrowserReferenceException(
                        "The page markup was too complex to render safely as text.",
                        exception);
                }

                var truncated = text.Length > MaxTextCharacters;
                if (truncated)
                {
                    text = text[..MaxTextCharacters].TrimEnd()
                           + Environment.NewLine
                           + Environment.NewLine
                           + $"[Text display stopped at {MaxTextCharacters:N0} characters.]";
                }

                return new BrowserReferenceResult(
                    initial.Address,
                    current,
                    DisplayAddress(current),
                    title,
                    text,
                    mediaType ?? "text",
                    Math.Min(text.Length, MaxTextCharacters),
                    truncated,
                    Convert.ToHexString(SHA256.HashData(bytes)),
                    DateTimeOffset.UtcNow);
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _http.Dispose();
    }

    public static bool IsPublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            return IsPublicAddress(address.MapToIPv4());
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            var first = bytes[0];
            var second = bytes[1];

            return first is not (0 or 10 or 127)
                   && !(first == 100 && second is >= 64 and <= 127)
                   && !(first == 169 && second == 254)
                   && !(first == 172 && second is >= 16 and <= 31)
                   && !(first == 192 && second is 0 or 168)
                   && !(first == 198 && second is 18 or 19 or 51)
                   && !(first == 203 && second == 0 && bytes[2] == 113)
                   && first < 224;
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6
            || IPAddress.IsLoopback(address)
            || address.IsIPv6LinkLocal
            || address.IsIPv6Multicast
            || address.IsIPv6SiteLocal
            || address.Equals(IPAddress.IPv6Any)
            || address.Equals(IPAddress.IPv6None))
        {
            return false;
        }

        var value = address.GetAddressBytes();
        var uniqueLocal = (value[0] & 0xFE) == 0xFC;
        var documentation = value[0] == 0x20
                            && value[1] == 0x01
                            && value[2] == 0x0D
                            && value[3] == 0xB8;
        return !uniqueLocal && !documentation;
    }

    private static HttpMessageHandler CreateDefaultHandler(BrowserHostResolver resolver)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.GZip
                                     | DecompressionMethods.Deflate
                                     | DecompressionMethods.Brotli,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2)
        };

        handler.ConnectCallback = async (context, cancellationToken) =>
        {
            var addresses = await resolver(context.DnsEndPoint.Host, cancellationToken)
                .ConfigureAwait(false);
            EnsurePublicAddresses(context.DnsEndPoint.Host, addresses);

            Exception? lastFailure = null;
            foreach (var address in addresses)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
                {
                    NoDelay = true
                };
                try
                {
                    await socket.ConnectAsync(
                        new IPEndPoint(address, context.DnsEndPoint.Port),
                        cancellationToken).ConfigureAwait(false);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (Exception exception) when (exception is SocketException
                                                   or OperationCanceledException)
                {
                    lastFailure = exception;
                    socket.Dispose();
                    if (exception is OperationCanceledException) throw;
                }
            }

            throw new HttpRequestException(
                $"No public address for {context.DnsEndPoint.Host} accepted the connection.",
                lastFailure);
        };

        return handler;
    }

    private async Task EnsurePublicDestinationAsync(Uri address, CancellationToken cancellationToken)
    {
        IPAddress[] addresses;
        try
        {
            addresses = await _resolveHost(address.IdnHost, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception) when (exception is SocketException or ArgumentException)
        {
            throw new BrowserReferenceException(
                $"The page host could not be resolved: {exception.Message}",
                exception);
        }

        EnsurePublicAddresses(address.IdnHost, addresses);
    }

    private static void EnsurePublicAddresses(string host, IReadOnlyCollection<IPAddress> addresses)
    {
        if (addresses.Count == 0)
        {
            throw new BrowserReferenceException($"The page host {host} has no network address.");
        }

        if (addresses.Any(address => !IsPublicAddress(address)))
        {
            throw new BrowserReferenceException(
                $"The page host {host} resolves to a local, private, reserved, or documentation network address.");
        }
    }

    private static async Task<byte[]> ReadResponseBytesAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var destination = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            if (destination.Length + read > MaxResponseBytes)
            {
                throw new BrowserReferenceException(
                    $"The text response is larger than the {MaxResponseBytes / 1024:N0} KB Browser limit.");
            }

            destination.Write(buffer, 0, read);
        }

        return destination.ToArray();
    }

    private static string ExtractTitle(string html, string fallback)
    {
        var match = TitlePattern.Match(html);
        if (!match.Success) return fallback;
        var title = NormalizeText(WebUtility.HtmlDecode(match.Groups[1].Value));
        if (title.Length == 0) return fallback;
        return title.Length <= MaxTitleCharacters
            ? title
            : title[..MaxTitleCharacters].TrimEnd() + "…";
    }

    private static string HtmlToText(string html)
    {
        var text = CommentPattern.Replace(html, string.Empty);
        text = InertBlockPattern.Replace(text, string.Empty);
        text = LineBreakTagPattern.Replace(text, Environment.NewLine);
        text = TagPattern.Replace(text, " ");
        return NormalizeText(WebUtility.HtmlDecode(text));
    }

    private static string NormalizeText(string text)
    {
        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');
        var output = new StringBuilder(Math.Min(normalized.Length, MaxTextCharacters));
        var blankLinePending = false;

        foreach (var rawLine in normalized.Split('\n'))
        {
            var line = HorizontalWhitespacePattern.Replace(rawLine, " ").Trim();
            if (line.Length == 0)
            {
                if (output.Length > 0) blankLinePending = true;
                continue;
            }

            if (blankLinePending)
            {
                output.AppendLine();
                blankLinePending = false;
            }

            if (output.Length > 0) output.AppendLine();
            output.Append(line);
        }

        return output.ToString().Trim();
    }

    private static bool IsLocalHostName(string host) =>
        host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".lan", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".home", StringComparison.OrdinalIgnoreCase)
        || host.EndsWith(".internal", StringComparison.OrdinalIgnoreCase);

    private static bool IsRedirect(HttpStatusCode statusCode) => statusCode is
        HttpStatusCode.MultipleChoices
        or HttpStatusCode.MovedPermanently
        or HttpStatusCode.Found
        or HttpStatusCode.SeeOther
        or HttpStatusCode.TemporaryRedirect
        or HttpStatusCode.PermanentRedirect;

    private static bool IsSupportedTextType(string? mediaType) =>
        mediaType?.StartsWith("text/", StringComparison.OrdinalIgnoreCase) == true
        || string.Equals(mediaType, "application/xhtml+xml", StringComparison.OrdinalIgnoreCase);

    private static bool IsHtmlType(string? mediaType) =>
        string.Equals(mediaType, "text/html", StringComparison.OrdinalIgnoreCase)
        || string.Equals(mediaType, "application/xhtml+xml", StringComparison.OrdinalIgnoreCase);

    private static string DisplayAddress(Uri address)
    {
        var builder = new UriBuilder(address)
        {
            Query = string.Empty,
            Fragment = string.Empty
        };
        return builder.Uri.AbsoluteUri.TrimEnd('/');
    }

    private static async Task<IPAddress[]> ResolveHostAsync(
        string host,
        CancellationToken cancellationToken) =>
        await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);
}

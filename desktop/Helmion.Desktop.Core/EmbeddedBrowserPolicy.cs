using System.Net;
using System.Net.Sockets;

namespace Helmion.Desktop.Core;

public sealed record EmbeddedBrowserAddressDecision(
    bool Allowed,
    Uri? Address,
    string Message);

/// <summary>
/// Network boundary for Helmian's rendered browser. Web content is allowed to
/// execute inside WebView2, but navigation is confined to public HTTPS hosts.
/// Local files, custom protocols, credentials-in-URLs, and private/local network
/// destinations are denied before WebView2 receives the address.
/// </summary>
public sealed class EmbeddedBrowserPolicy
{
    private readonly BrowserHostResolver _resolveHost;

    public EmbeddedBrowserPolicy(BrowserHostResolver? resolveHost = null)
    {
        _resolveHost = resolveHost ?? ResolveHostAsync;
    }

    public static EmbeddedBrowserAddressDecision ValidateSyntax(string? value)
    {
        var candidate = value?.Trim() ?? string.Empty;
        if (candidate.Length == 0)
        {
            return Denied("Enter a public HTTPS website address.");
        }

        if (candidate.Length > BrowserReferenceReader.MaxAddressCharacters)
        {
            return Denied("The website address is too long.");
        }

        if (!candidate.Contains("://", StringComparison.Ordinal))
        {
            candidate = "https://" + candidate;
        }

        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var address)
            || !string.Equals(address.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(address.Host))
        {
            return Denied("Helmian Browser opens public HTTPS websites only.");
        }

        if (!string.IsNullOrEmpty(address.UserInfo))
        {
            return Denied("Website addresses containing embedded credentials are refused.");
        }

        if (string.Equals(address.Host, "localhost", StringComparison.OrdinalIgnoreCase)
            || address.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase))
        {
            return Denied("Local and private-network websites are outside the Browser boundary.");
        }

        if (IPAddress.TryParse(address.Host, out var literalAddress)
            && !BrowserReferenceReader.IsPublicAddress(literalAddress))
        {
            return Denied("Local and private-network websites are outside the Browser boundary.");
        }

        return new EmbeddedBrowserAddressDecision(
            true,
            address,
            "Public HTTPS website is eligible for rendered browsing.");
    }

    public async Task<EmbeddedBrowserAddressDecision> ValidateAsync(
        string? value,
        CancellationToken cancellationToken = default)
    {
        var syntax = ValidateSyntax(value);
        if (!syntax.Allowed || syntax.Address is null)
        {
            return syntax;
        }

        if (IPAddress.TryParse(syntax.Address.Host, out _))
        {
            return syntax;
        }

        IPAddress[] addresses;
        try
        {
            addresses = await _resolveHost(syntax.Address.Host, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is SocketException or ArgumentException)
        {
            return Denied("The website host could not be resolved.");
        }

        if (addresses.Length == 0)
        {
            return Denied("The website host returned no usable network address.");
        }

        if (addresses.Any(address => !BrowserReferenceReader.IsPublicAddress(address)))
        {
            return Denied(
                "The website resolves to a local or private-network address, so Helmian blocked it.");
        }

        return syntax;
    }

    private static EmbeddedBrowserAddressDecision Denied(string message) =>
        new(false, null, message);

    private static async Task<IPAddress[]> ResolveHostAsync(
        string host,
        CancellationToken cancellationToken) =>
        await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);
}

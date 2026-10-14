namespace Helmion.Desktop.Core;

/// <summary>
/// Builds the URL that the Desktop renders as a phone pairing QR code.
/// Format v1 (mirrors src/herald/pairing-link.mjs):
///   enrollment: https://helmian.vercel.app/herald/#enroll=12345678
///   relay pair: https://helmian.vercel.app/herald/?channel=herald_…#pair=12345678
/// The one-time code lives only in the fragment, which browsers never send to a
/// server. The web endpoints still enforce single use, expiry and attempt limits.
/// </summary>
public static class HeraldPairingLink
{
    public const string EnrollKey = "enroll";
    public const string PairKey = "pair";
    public const string TrustedHost = "helmian.vercel.app";

    public static string? TryBuild(string? baseUrl, string? code, string key, string trustedHost = TrustedHost)
    {
        if (key != EnrollKey && key != PairKey) return null;
        if (!Uri.TryCreate(baseUrl?.Trim(), UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        if (!string.Equals(uri.Host, trustedHost, StringComparison.OrdinalIgnoreCase)) return null;
        if (!uri.AbsolutePath.StartsWith("/herald", StringComparison.Ordinal)) return null;
        var digits = new string((code ?? string.Empty).Where(char.IsAsciiDigit).ToArray());
        if (digits.Length != 8) return null;
        var builder = new UriBuilder(uri) { Fragment = $"{key}={digits}" };
        return builder.Uri.AbsoluteUri;
    }

    /// <summary>Parses "Pairing code: 12345678 (expires …)" from the Herald CLI.</summary>
    public static string? ParseCliPairingCode(string? line)
    {
        const string marker = "Pairing code:";
        if (line is null) return null;
        var start = line.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return null;
        var digits = new string(line[(start + marker.Length)..].TrimStart()
            .TakeWhile(char.IsAsciiDigit).ToArray());
        return digits.Length == 8 ? digits : null;
    }
}

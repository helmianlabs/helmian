namespace Helmion.LocalService.Protocol;

public static class RemoteControlContractValidation
{
    public const int MaxIdentifierLength = 128;
    public const int MaxDisplayNameLength = 80;
    public const int MaxDetailLength = 500;
    public const int MinSecretBytes = 32;
    public const int MaxSecretBytes = 4_096;

    public static string RequireIdentifier(string? value, string parameterName)
    {
        var normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length is < 8 or > MaxIdentifierLength
            || !normalized.All(character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or ':' or '-'))
        {
            throw new ArgumentException(
                "Remote Control identifiers must be 8–128 ASCII letters, numbers, dots, underscores, colons, or dashes.",
                parameterName);
        }
        return normalized;
    }

    public static string NormalizeDisplayName(string? value, string parameterName)
    {
        var normalized = string.Join(
            " ",
            (value ?? string.Empty).Split(
                (char[]?)null,
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (normalized.Length is < 1 or > MaxDisplayNameLength
            || normalized.Any(char.IsControl))
        {
            throw new ArgumentException(
                $"Remote Control display names must be 1–{MaxDisplayNameLength} visible characters.",
                parameterName);
        }
        return normalized;
    }

    public static string RequireDetail(string? value, string parameterName)
    {
        var normalized = (value ?? string.Empty).Trim();
        if (normalized.Length is < 1 or > MaxDetailLength || normalized.Any(char.IsControl))
        {
            throw new ArgumentException(
                $"Remote Control detail must be 1–{MaxDetailLength} visible characters.",
                parameterName);
        }
        return normalized;
    }

    public static string RequireHttpsUri(string? value, string parameterName)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new ArgumentException(
                "Remote Control verification requires an absolute HTTPS URL without embedded credentials.",
                parameterName);
        }
        return uri.AbsoluteUri;
    }

    public static byte[] RequireSecret(byte[]? value, string parameterName)
    {
        if (value is null || value.Length is < MinSecretBytes or > MaxSecretBytes)
        {
            throw new ArgumentException(
                $"Remote Control secret material must be {MinSecretBytes}–{MaxSecretBytes:N0} bytes.",
                parameterName);
        }
        return value;
    }

    public static DateTimeOffset RequireFutureExpiry(
        DateTimeOffset? expiry,
        DateTimeOffset now,
        string parameterName)
    {
        if (expiry is null || expiry.Value.ToUniversalTime() <= now.ToUniversalTime())
        {
            throw new ArgumentException("Remote Control credential or challenge is already expired.", parameterName);
        }
        return expiry.Value.ToUniversalTime();
    }
}

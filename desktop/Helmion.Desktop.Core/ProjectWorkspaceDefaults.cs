namespace Helmion.Desktop.Core;

/// <summary>
/// Chooses the customer-facing project shelf without treating the Helmian source
/// checkout as a new customer's workspace. Resolution is deliberately pure: it
/// never creates a directory. The desktop creates the default only after the
/// operator explicitly confirms project creation.
/// </summary>
public static class ProjectWorkspaceDefaults
{
    public const string CustomerFolderName = "Helmian Projects";

    public static string CustomerRoot(string documentsPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(documentsPath);
        return Path.GetFullPath(Path.Combine(documentsPath, CustomerFolderName));
    }

    public static string Resolve(
        string? registeredPath,
        string? environmentPath,
        string? savedPath,
        string documentsPath,
        Func<string, bool>? directoryExists = null)
    {
        directoryExists ??= Directory.Exists;
        foreach (var candidate in new[] { registeredPath, environmentPath, savedPath })
        {
            if (string.IsNullOrWhiteSpace(candidate)) continue;

            try
            {
                var fullPath = Path.GetFullPath(candidate);
                if (directoryExists(fullPath)) return fullPath;
            }
            catch
            {
                // A malformed/stale preference must not prevent the safe default.
            }
        }

        return CustomerRoot(documentsPath);
    }

    public static bool IsCustomerRoot(string? path, string documentsPath)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;

        try
        {
            return string.Equals(
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)),
                Path.TrimEndingDirectorySeparator(CustomerRoot(documentsPath)),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

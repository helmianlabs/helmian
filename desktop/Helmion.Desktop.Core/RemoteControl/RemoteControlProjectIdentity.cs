using System.Security.Cryptography;
using System.Text;

namespace Helmion.Desktop.Core;

/// <summary>
/// Produces a stable opaque project id without exposing the local workspace path
/// to the control plane. The human-readable project name is carried separately.
/// </summary>
public static class RemoteControlProjectIdentity
{
    public static string FromProjectRoot(string projectRoot, string installationId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectRoot);
        var installation = Helmion.LocalService.Protocol.RemoteControlContractValidation
            .RequireIdentifier(installationId, nameof(installationId));
        var normalized = Path.GetFullPath(projectRoot)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .ToUpperInvariant();
        var key = SHA256.HashData(Encoding.UTF8.GetBytes(installation));
        var hash = Convert.ToHexString(HMACSHA256.HashData(
            key,
            Encoding.UTF8.GetBytes(normalized)));
        CryptographicOperations.ZeroMemory(key);
        return $"project-{hash[..32].ToLowerInvariant()}";
    }
}

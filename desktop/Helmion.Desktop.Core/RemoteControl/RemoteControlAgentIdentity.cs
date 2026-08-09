using System.Security.Cryptography;
using System.Text;

namespace Helmion.Desktop.Core;

public static class RemoteControlAgentIdentity
{
    public static string FromDisplayName(string displayName)
    {
        var normalized = Helmion.LocalService.Protocol.RemoteControlContractValidation
            .NormalizeDisplayName(displayName, nameof(displayName));
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
        return $"agent-{hash[..24].ToLowerInvariant()}";
    }
}

using System;
using System.IO;

namespace Helmion.Desktop.Core.Herald;

/// <summary>Local half of "forget this pairing": remove the Herald owner enrollment secret.</summary>
public static class HeraldPairingReset
{
    /// <returns>true when the file is gone afterwards (removed now or never existed).</returns>
    public static bool ClearOwnerEnrollment(string ownerSecretPath, out string? error)
    {
        error = null;
        try
        {
            if (string.IsNullOrWhiteSpace(ownerSecretPath)) { error = "no path"; return false; }
            if (File.Exists(ownerSecretPath)) File.Delete(ownerSecretPath);
            var temp = ownerSecretPath + ".tmp";
            if (File.Exists(temp)) File.Delete(temp);
            return !File.Exists(ownerSecretPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            error = ex.Message;
            return false;
        }
    }
}

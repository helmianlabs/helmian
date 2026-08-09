using System.Security.Cryptography;
using System.Text;

namespace Helmion.LocalService.Security;

/// <summary>Stable, non-account installation identity owned by Local Service.</summary>
public static class RemoteControlInstallationIdentity
{
    public static string GetOrCreate()
    {
        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Helmion", "remote-control-desktop");
        var path = Path.Combine(directory, "installation.dpapi");
        Directory.CreateDirectory(directory);
        if (File.Exists(path)) return Unprotect(File.ReadAllBytes(path));

        var value = $"install_{Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant()}";
        var plaintext = Encoding.UTF8.GetBytes(value);
        try
        {
            var protectedValue = CurrentUserDataProtection.Protect(
                plaintext, Encoding.UTF8.GetBytes("Helmion/remote-installation/v1"));
            try
            {
                using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                stream.Write(protectedValue);
                stream.Flush(flushToDisk: true);
            }
            catch (IOException) when (File.Exists(path))
            {
                return Unprotect(File.ReadAllBytes(path));
            }
            finally { CryptographicOperations.ZeroMemory(protectedValue); }
            return value;
        }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }

    private static string Unprotect(byte[] ciphertext)
    {
        var plaintext = CurrentUserDataProtection.Unprotect(
            ciphertext, Encoding.UTF8.GetBytes("Helmion/remote-installation/v1"));
        try
        {
            var value = Encoding.UTF8.GetString(plaintext);
            return Helmion.LocalService.Protocol.RemoteControlContractValidation
                .RequireIdentifier(value, "installationId");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(ciphertext);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }
}

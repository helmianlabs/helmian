using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

public sealed record ProviderProfileManifest(
    int Version,
    string Id,
    string AdapterId,
    string DisplayName,
    string AuthenticationClass,
    string CredentialCustody,
    ConnectionTargetBinding? Target,
    bool HasProtectedMaterial,
    DateTimeOffset UpdatedAt);

public sealed record ProtectedProviderProfileDescriptor(
    ProviderProfileManifest Manifest,
    string Protection,
    string StorageBoundary,
    bool SecretMaterialReturned);

public static class BuiltInProviderProfiles
{
    public static ProviderProfileManifest NeonDevelopment(DateTimeOffset updatedAt)
    {
        return new ProviderProfileManifest(
            Version: 1,
            Id: "neon-development",
            AdapterId: "neon-postgresql-direct",
            DisplayName: NeonDevelopmentTarget.ProjectDisplayName,
            AuthenticationClass: "database-credential",
            CredentialCustody: "Windows CurrentUser DPAPI · local service only",
            Target: NeonDevelopmentTarget.CreateBinding(),
            HasProtectedMaterial: true,
            UpdatedAt: updatedAt);
    }
}

public sealed partial class ProtectedProviderProfileStore
{
    private const string ManifestFileName = "profile.json";
    private const string CiphertextFileName = "credential.dpapi";
    private static readonly byte[] EntropyPrefix =
        Encoding.UTF8.GetBytes("Helmion/provider-profile/v1/");

    private readonly string _rootDirectory;

    public ProtectedProviderProfileStore()
        : this(DefaultRootDirectory(), allowTestRoot: false)
    {
    }

    internal ProtectedProviderProfileStore(
        string rootDirectory,
        bool allowTestRoot)
    {
        var fullRoot = Path.GetFullPath(rootDirectory);
        if (!allowTestRoot)
        {
            var requiredRoot = Path.GetFullPath(DefaultRootDirectory());
            if (!string.Equals(
                    fullRoot,
                    requiredRoot,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Provider profiles must remain in Helmion current-user local storage");
            }
        }
        _rootDirectory = fullRoot;
    }

    public static string DefaultRootDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Helmion",
            "provider-profiles");
    }

    public async Task<ProtectedProviderProfileDescriptor> SaveAsync(
        ProviderProfileManifest manifest,
        ReadOnlyMemory<byte> sensitivePayload,
        CancellationToken cancellationToken = default)
    {
        ValidateManifest(manifest);
        if (sensitivePayload.IsEmpty)
        {
            throw new ArgumentException(
                "Protected provider material cannot be empty",
                nameof(sensitivePayload));
        }

        var profileDirectory = ProfileDirectory(manifest.Id);
        Directory.CreateDirectory(_rootDirectory);
        RejectReparsePoint(_rootDirectory);
        Directory.CreateDirectory(profileDirectory);
        RejectReparsePoint(profileDirectory);

        var plaintext = sensitivePayload.ToArray();
        byte[]? ciphertext = null;
        try
        {
            ciphertext = CurrentUserDataProtection.Protect(
                plaintext,
                EntropyFor(manifest.Id));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }

        var suffix = Guid.NewGuid().ToString("N");
        var cipherTemp = Path.Combine(profileDirectory, $".credential-{suffix}.tmp");
        var manifestTemp = Path.Combine(profileDirectory, $".profile-{suffix}.tmp");
        var cipherPath = ProfileFile(profileDirectory, CiphertextFileName);
        var manifestPath = ProfileFile(profileDirectory, ManifestFileName);
        try
        {
            await File.WriteAllBytesAsync(
                cipherTemp,
                ciphertext,
                cancellationToken);
            await File.WriteAllTextAsync(
                manifestTemp,
                JsonSerializer.Serialize(
                    manifest,
                    new JsonSerializerOptions { WriteIndented = true }),
                Encoding.UTF8,
                cancellationToken);
            File.Move(
                cipherTemp,
                cipherPath,
                overwrite: true);
            File.Move(
                manifestTemp,
                manifestPath,
                overwrite: true);
        }
        finally
        {
            if (ciphertext is not null)
            {
                CryptographicOperations.ZeroMemory(ciphertext);
            }
            TryDelete(cipherTemp);
            TryDelete(manifestTemp);
        }

        return RedactedDescriptor(manifest);
    }

    public async Task<byte[]> LoadProtectedMaterialForServiceAsync(
        string profileId,
        CancellationToken cancellationToken = default)
    {
        ValidateProfileId(profileId);
        var directory = ProfileDirectory(profileId);
        RejectReparsePoint(directory);
        var ciphertext = await File.ReadAllBytesAsync(
            ProfileFile(directory, CiphertextFileName),
            cancellationToken);
        try
        {
            return CurrentUserDataProtection.Unprotect(
                ciphertext,
                EntropyFor(profileId));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(ciphertext);
        }
    }

    public async Task<ProtectedProviderProfileDescriptor> ReadDescriptorAsync(
        string profileId,
        CancellationToken cancellationToken = default)
    {
        ValidateProfileId(profileId);
        var directory = ProfileDirectory(profileId);
        RejectReparsePoint(directory);
        var json = await File.ReadAllTextAsync(
            ProfileFile(directory, ManifestFileName),
            cancellationToken);
        var manifest = JsonSerializer.Deserialize<ProviderProfileManifest>(json)
            ?? throw new InvalidDataException("Provider profile manifest is empty");
        ValidateManifest(manifest);
        return RedactedDescriptor(manifest);
    }

    private static ProtectedProviderProfileDescriptor RedactedDescriptor(
        ProviderProfileManifest manifest)
    {
        return new ProtectedProviderProfileDescriptor(
            manifest,
            "Windows CurrentUser DPAPI",
            "Helmion local service only · never renderer, logs, arguments, source, or history",
            SecretMaterialReturned: false);
    }

    private string ProfileDirectory(string profileId)
    {
        ValidateProfileId(profileId);
        var path = Path.GetFullPath(Path.Combine(_rootDirectory, profileId));
        var rootWithSeparator = _rootDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(
                rootWithSeparator,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Provider profile path escaped Helmion local storage");
        }
        return path;
    }

    private static void ValidateManifest(ProviderProfileManifest manifest)
    {
        ValidateProfileId(manifest.Id);
        if (manifest.Version != 1
            || string.IsNullOrWhiteSpace(manifest.AdapterId)
            || string.IsNullOrWhiteSpace(manifest.DisplayName)
            || string.IsNullOrWhiteSpace(manifest.AuthenticationClass)
            || string.IsNullOrWhiteSpace(manifest.CredentialCustody)
            || !manifest.HasProtectedMaterial)
        {
            throw new InvalidDataException("Provider profile manifest is invalid");
        }

        if (string.Equals(
                manifest.Id,
                "neon-development",
                StringComparison.Ordinal)
            && (manifest.AdapterId != NeonDevelopmentTarget.AdapterId
                || manifest.AuthenticationClass != "database-credential"
                || manifest.Target != NeonDevelopmentTarget.CreateBinding()))
        {
            throw new InvalidDataException(
                "Neon Development profile target binding does not match the isolated development target");
        }
    }

    private static void ValidateProfileId(string profileId)
    {
        if (string.IsNullOrWhiteSpace(profileId)
            || !ProfileId().IsMatch(profileId))
        {
            throw new ArgumentException(
                "Provider profile ID must be a stable lowercase identifier",
                nameof(profileId));
        }
    }

    private static byte[] EntropyFor(string profileId)
    {
        return [.. EntropyPrefix, .. Encoding.UTF8.GetBytes(profileId)];
    }

    private static void RejectReparsePoint(string directory)
    {
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException(
                $"Provider profile directory does not exist: {directory}");
        }
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException(
                "Provider profile directory cannot be a reparse point");
        }
    }

    private static string ProfileFile(string directory, string fileName)
    {
        var path = Path.Combine(directory, fileName);
        if (File.Exists(path)
            && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException(
                "Provider profile files cannot be reparse points");
        }
        return path;
    }

    private static void TryDelete(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    [GeneratedRegex("^[a-z0-9]+(?:-[a-z0-9]+)*$")]
    private static partial Regex ProfileId();
}

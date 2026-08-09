using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

/// <summary>
/// Current-user-only custody for the account-bound Remote Control desktop
/// credential. Enrollment nonces, Clerk values and control-plane keys are never
/// accepted by this store. The manifest is redacted metadata; only the bearer
/// credential is persisted as DPAPI ciphertext.
/// </summary>
public sealed class ProtectedRemoteDesktopCredentialStore : IRemoteDesktopCredentialStore
{
    private const string ManifestFileName = "desktop.json";
    private const string CiphertextFileName = "credential.dpapi";
    private const int ManifestVersion = 1;
    private static readonly byte[] EntropyPrefix =
        Encoding.UTF8.GetBytes("Helmion/remote-control-desktop/v1/");

    private readonly string _directory;
    private readonly Func<DateTimeOffset> _clock;

    public ProtectedRemoteDesktopCredentialStore()
        : this(DefaultDirectory(), allowTestDirectory: false, null)
    {
    }

    internal ProtectedRemoteDesktopCredentialStore(
        string directory,
        bool allowTestDirectory,
        Func<DateTimeOffset>? clock = null)
    {
        _directory = Path.GetFullPath(directory);
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        if (!allowTestDirectory
            && !string.Equals(
                _directory,
                Path.GetFullPath(DefaultDirectory()),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Remote desktop credentials must remain in Helmion current-user local storage.");
        }
    }

    public static string DefaultDirectory() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helmion",
        "remote-control-desktop");

    public async Task<RemoteDesktopEnrollmentDescriptor> ReadDescriptorAsync(
        CancellationToken cancellationToken = default)
    {
        var manifestPath = Path.Combine(_directory, ManifestFileName);
        var ciphertextPath = Path.Combine(_directory, CiphertextFileName);
        if (!File.Exists(manifestPath) && !File.Exists(ciphertextPath))
        {
            return RemoteDesktopEnrollmentDescriptor.Unenrolled(_clock());
        }

        RejectReparsePoint(_directory);
        RejectReparseFile(manifestPath);
        var manifest = JsonSerializer.Deserialize<RemoteDesktopCredentialManifest>(
            await File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("Remote desktop credential manifest is empty.");
        ValidateManifest(manifest);
        if (manifest.State == "revoked")
        {
            if (File.Exists(ciphertextPath))
            {
                throw new InvalidDataException(
                    "A revoked remote desktop manifest still has credential ciphertext.");
            }
            return Descriptor(manifest, RemoteEnrollmentStage.Revoked,
                "This desktop credential was revoked and removed locally.");
        }
        if (manifest.ExpiresAtUtc is { } manifestExpiry
            && manifestExpiry <= _clock().ToUniversalTime())
        {
            return Descriptor(manifest, RemoteEnrollmentStage.Expired,
                "The remote desktop credential expired; remote use is disabled.");
        }

        if (manifest.State == "revoking")
        {
            RejectReparseFile(ciphertextPath);
            return Descriptor(manifest, RemoteEnrollmentStage.Revoking,
                "Desktop revocation is pending server confirmation; remote use is disabled.");
        }

        RejectReparseFile(ciphertextPath);
        var authentication = await LoadAuthenticationForServiceAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            RemoteControlContractValidation.RequireSecret(
                authentication.BearerCredential,
                nameof(authentication.BearerCredential));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(authentication.BearerCredential);
        }
        return Descriptor(manifest, RemoteEnrollmentStage.Enrolled,
            "Account-confirmed desktop enrollment is stored for the current Windows user.");
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> SaveRedeemedGrantAsync(
        RemoteDesktopCredentialGrant grant,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(grant);
        var now = _clock().ToUniversalTime();
        var installationId = RemoteControlContractValidation.RequireIdentifier(
            grant.InstallationId, nameof(grant.InstallationId));
        var desktopId = RemoteControlContractValidation.RequireIdentifier(
            grant.DesktopId, nameof(grant.DesktopId));
        RemoteControlContractValidation.RequireSecret(
            grant.BearerCredential, nameof(grant.BearerCredential));
        var issuedAt = grant.IssuedAtUtc.ToUniversalTime();
        if (issuedAt > now.AddMinutes(5))
        {
            throw new InvalidDataException("Remote desktop credential issue time is in the future.");
        }
        var expiresAt = grant.ExpiresAtUtc.ToUniversalTime();
        if (expiresAt <= now)
        {
            throw new InvalidDataException("Remote desktop credential is already expired.");
        }

        var existingManifest = Path.Combine(_directory, ManifestFileName);
        var existingCiphertext = Path.Combine(_directory, CiphertextFileName);
        if (File.Exists(existingManifest) || File.Exists(existingCiphertext))
        {
            var existing = await ReadDescriptorAsync(cancellationToken).ConfigureAwait(false);
            if (existing.Stage is not (RemoteEnrollmentStage.Revoked or RemoteEnrollmentStage.Expired))
            {
                throw new InvalidOperationException(
                    "An existing remote desktop credential must be server-revoked before replacement.");
            }
        }

        Directory.CreateDirectory(_directory);
        RejectReparsePoint(_directory);
        var plaintext = grant.BearerCredential.ToArray();
        byte[]? ciphertext = null;
        try
        {
            ciphertext = CurrentUserDataProtection.Protect(
                plaintext,
                EntropyFor(installationId, desktopId));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }

        var manifest = new RemoteDesktopCredentialManifest(
            ManifestVersion,
            installationId,
            desktopId,
            issuedAt,
            expiresAt,
            "enrolled",
            now);
        var suffix = Guid.NewGuid().ToString("N");
        var manifestTemp = Path.Combine(_directory, $".desktop-{suffix}.tmp");
        var ciphertextTemp = Path.Combine(_directory, $".credential-{suffix}.tmp");
        try
        {
            await File.WriteAllBytesAsync(ciphertextTemp, ciphertext, cancellationToken)
                .ConfigureAwait(false);
            await File.WriteAllTextAsync(
                manifestTemp,
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }),
                Encoding.UTF8,
                cancellationToken).ConfigureAwait(false);
            File.Move(ciphertextTemp, Path.Combine(_directory, CiphertextFileName), overwrite: true);
            File.Move(manifestTemp, Path.Combine(_directory, ManifestFileName), overwrite: true);
        }
        finally
        {
            if (ciphertext is not null) CryptographicOperations.ZeroMemory(ciphertext);
            TryDelete(ciphertextTemp);
            TryDelete(manifestTemp);
        }

        return Descriptor(manifest, RemoteEnrollmentStage.Enrolled,
            "Account-confirmed desktop enrollment is stored for the current Windows user.");
    }

    public async Task<RemoteDesktopAuthentication> LoadAuthenticationForServiceAsync(
        CancellationToken cancellationToken = default)
    {
        var manifestPath = Path.Combine(_directory, ManifestFileName);
        var ciphertextPath = Path.Combine(_directory, CiphertextFileName);
        RejectReparsePoint(_directory);
        RejectReparseFile(manifestPath);
        RejectReparseFile(ciphertextPath);
        var manifest = JsonSerializer.Deserialize<RemoteDesktopCredentialManifest>(
            await File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("Remote desktop credential manifest is empty.");
        ValidateManifest(manifest);
        if (manifest.State is not ("enrolled" or "revoking"))
        {
            throw new InvalidOperationException("The remote desktop credential is not enrolled.");
        }
        if (manifest.ExpiresAtUtc is { } expiry && expiry <= _clock().ToUniversalTime())
        {
            throw new InvalidOperationException("The remote desktop credential is expired.");
        }

        var ciphertext = await File.ReadAllBytesAsync(ciphertextPath, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var plaintext = CurrentUserDataProtection.Unprotect(
                ciphertext,
                EntropyFor(manifest.InstallationId, manifest.DesktopId));
            RemoteControlContractValidation.RequireSecret(
                plaintext, nameof(RemoteDesktopAuthentication.BearerCredential));
            return new RemoteDesktopAuthentication(
                manifest.DesktopId,
                plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(ciphertext);
        }
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> MarkRevocationPendingAsync(
        string desktopId,
        DateTimeOffset requestedAtUtc,
        CancellationToken cancellationToken = default)
    {
        var manifestPath = Path.Combine(_directory, ManifestFileName);
        RejectReparsePoint(_directory);
        RejectReparseFile(manifestPath);
        RejectReparseFile(Path.Combine(_directory, CiphertextFileName));
        var manifest = JsonSerializer.Deserialize<RemoteDesktopCredentialManifest>(
            await File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("Remote desktop credential manifest is empty.");
        ValidateManifest(manifest);
        if (manifest.State is not ("enrolled" or "revoking")
            || !string.Equals(manifest.DesktopId, desktopId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Revocation request does not match the stored desktop credential.");
        }
        var revoking = manifest with
        {
            State = "revoking",
            UpdatedAtUtc = requestedAtUtc.ToUniversalTime()
        };
        await WriteManifestAtomicallyAsync(revoking, cancellationToken).ConfigureAwait(false);
        return Descriptor(revoking, RemoteEnrollmentStage.Revoking,
            "Desktop revocation is pending server confirmation; remote use is disabled.");
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> RemoveAfterServerRevocationAsync(
        string desktopId,
        DateTimeOffset confirmedAtUtc,
        CancellationToken cancellationToken = default)
    {
        var authentication = await LoadAuthenticationForServiceAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            if (!string.Equals(authentication.DesktopId, desktopId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Server revocation does not match the stored desktop credential.");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(authentication.BearerCredential);
        }

        var manifestPath = Path.Combine(_directory, ManifestFileName);
        var manifest = JsonSerializer.Deserialize<RemoteDesktopCredentialManifest>(
            await File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false))
            ?? throw new InvalidDataException("Remote desktop credential manifest is empty.");
        ValidateManifest(manifest);
        var revoked = manifest with
        {
            State = "revoked",
            UpdatedAtUtc = confirmedAtUtc.ToUniversalTime()
        };
        TryDelete(Path.Combine(_directory, CiphertextFileName));
        await WriteManifestAtomicallyAsync(revoked, cancellationToken).ConfigureAwait(false);
        return Descriptor(revoked, RemoteEnrollmentStage.Revoked,
            "Server-confirmed revocation removed the protected desktop credential.");
    }

    private static RemoteDesktopEnrollmentDescriptor Descriptor(
        RemoteDesktopCredentialManifest manifest,
        RemoteEnrollmentStage stage,
        string detail) => new(
            stage,
            manifest.InstallationId,
            null,
            manifest.DesktopId,
            manifest.ExpiresAtUtc,
            detail,
            manifest.UpdatedAtUtc);

    private static void ValidateManifest(RemoteDesktopCredentialManifest manifest)
    {
        if (manifest.Version != ManifestVersion
            || manifest.State is not ("enrolled" or "revoking" or "revoked"))
        {
            throw new InvalidDataException("Remote desktop credential manifest is invalid.");
        }
        RemoteControlContractValidation.RequireIdentifier(
            manifest.InstallationId, nameof(manifest.InstallationId));
        RemoteControlContractValidation.RequireIdentifier(manifest.DesktopId, nameof(manifest.DesktopId));
    }

    private static byte[] EntropyFor(string installationId, string desktopId) =>
        [.. EntropyPrefix, .. Encoding.UTF8.GetBytes($"{installationId}/{desktopId}")];

    private static void RejectReparsePoint(string directory)
    {
        if (!Directory.Exists(directory))
        {
            throw new DirectoryNotFoundException("Remote desktop credential directory does not exist.");
        }
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("Remote desktop credential directory cannot be a reparse point.");
        }
    }

    private static void RejectReparseFile(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("Remote desktop credential state is incomplete.", path);
        }
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("Remote desktop credential files cannot be reparse points.");
        }
    }

    private static void TryDelete(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }

    private async Task WriteManifestAtomicallyAsync(
        RemoteDesktopCredentialManifest manifest,
        CancellationToken cancellationToken)
    {
        var temp = Path.Combine(_directory, $".desktop-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllTextAsync(
                temp,
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }),
                Encoding.UTF8,
                cancellationToken).ConfigureAwait(false);
            File.Move(temp, Path.Combine(_directory, ManifestFileName), overwrite: true);
        }
        finally
        {
            TryDelete(temp);
        }
    }

    private sealed record RemoteDesktopCredentialManifest(
        int Version,
        string InstallationId,
        string DesktopId,
        DateTimeOffset IssuedAtUtc,
        DateTimeOffset ExpiresAtUtc,
        string State,
        DateTimeOffset UpdatedAtUtc);
}

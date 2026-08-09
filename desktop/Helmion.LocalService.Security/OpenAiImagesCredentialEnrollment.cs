using System.Security.Cryptography;

namespace Helmion.LocalService.Security;

public static class OpenAiImagesCredentialEnrollment
{
    public static async Task EnrollFromRedirectedInputAsync(
        Stream input,
        ProtectedProviderProfileStore profiles,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(profiles);
        if (!input.CanRead)
        {
            throw new InvalidOperationException("Credential enrollment input is not readable.");
        }

        var buffer = new byte[513];
        var length = 0;
        try
        {
            while (length < buffer.Length)
            {
                var read = await input.ReadAsync(
                    buffer.AsMemory(length, 1),
                    cancellationToken).ConfigureAwait(false);
                if (read == 0 || buffer[length] is (byte)'\r' or (byte)'\n') break;
                length += read;
            }
            if (length > 512)
            {
                throw new InvalidDataException("The OpenAI API credential is too long.");
            }

            var credential = buffer.AsMemory(0, length);
            OpenAiImagesArtifactStudioAdapter.ValidateCredential(credential.Span);
            await profiles.SaveAsync(
                BuiltInProviderProfiles.OpenAiImages(DateTimeOffset.UtcNow),
                credential,
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
        }
    }
}

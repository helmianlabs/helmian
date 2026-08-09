using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

/// <summary>
/// Official OpenAI Images HTTPS adapter. Credential material is loaded from
/// the service-owned DPAPI store only for the duration of a provider request.
/// </summary>
public sealed class OpenAiImagesArtifactStudioAdapter : IArtifactStudioProviderAdapter
{
    public const string AdapterId = "openai-images";
    public const string Model = "gpt-image-2";
    public static readonly Uri Endpoint = new("https://api.openai.com/v1/images/generations");
    public const int MaximumDecodedImageBytes = 20 * 1024 * 1024;
    public const int MaximumProviderResponseBytes = 32 * 1024 * 1024;

    private readonly ProtectedProviderProfileStore _profiles;
    private readonly HttpClient _httpClient;

    public OpenAiImagesArtifactStudioAdapter(
        ProtectedProviderProfileStore profiles,
        HttpClient httpClient)
    {
        _profiles = profiles ?? throw new ArgumentNullException(nameof(profiles));
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
    }

    public string ProviderId => AdapterId;

    public bool IsConfigured
    {
        get
        {
            if (!_profiles.IsConfigured(
                    BuiltInProviderProfiles.OpenAiImagesProfileId,
                    AdapterId))
            {
                return false;
            }

            byte[]? credential = null;
            try
            {
                credential = _profiles.LoadProtectedMaterialForServiceAsync(
                        BuiltInProviderProfiles.OpenAiImagesProfileId)
                    .GetAwaiter().GetResult();
                ValidateCredential(credential);
                return true;
            }
            catch (Exception error) when (error is IOException
                                          or UnauthorizedAccessException
                                          or InvalidDataException
                                          or System.ComponentModel.Win32Exception
                                          or CryptographicException)
            {
                return false;
            }
            finally
            {
                if (credential is not null)
                {
                    CryptographicOperations.ZeroMemory(credential);
                }
            }
        }
    }

    public bool Supports(string kind) => kind is "image" or "design-asset";

    public static HttpClient CreateHttpClient()
    {
        return new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            PooledConnectionLifetime = TimeSpan.FromMinutes(10)
        })
        {
            Timeout = TimeSpan.FromSeconds(150)
        };
    }

    public async Task<ArtifactStudioDelivery> GenerateAsync(
        ApprovedArtifactGenerationRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateRequest(request);

        var credential = await _profiles.LoadProtectedMaterialForServiceAsync(
            BuiltInProviderProfiles.OpenAiImagesProfileId,
            cancellationToken).ConfigureAwait(false);
        try
        {
            ValidateCredential(credential);
            var outputFormat = OutputFormat(request.Destination);
            var payload = JsonSerializer.SerializeToUtf8Bytes(new
            {
                model = Model,
                prompt = request.Instructions,
                n = 1,
                size = "1024x1024",
                quality = "low",
                output_format = outputFormat,
                moderation = "auto"
            });

            using var message = new HttpRequestMessage(HttpMethod.Post, Endpoint);
            message.Headers.Authorization = new AuthenticationHeaderValue(
                "Bearer",
                Encoding.UTF8.GetString(credential));
            message.Headers.UserAgent.ParseAdd("Helmion-LocalService/0.1");
            message.Content = new ByteArrayContent(payload);
            message.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

            using var response = await _httpClient.SendAsync(
                message,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            var responseBytes = await ReadBoundedAsync(
                response.Content,
                MaximumProviderResponseBytes,
                cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(
                    $"OpenAI Images returned {(int)response.StatusCode} ({response.StatusCode}): {ReadSafeProviderError(responseBytes)}");
            }

            var imageBytes = ReadImageBytes(responseBytes);
            var contentType = outputFormat == "jpeg" ? "image/jpeg" : "image/png";
            return new ArtifactStudioDelivery(
                Path.GetFileName(request.Destination),
                contentType,
                imageBytes,
                ProviderRequestId(response),
                Model);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(credential);
        }
    }

    public static void ValidateCredential(ReadOnlySpan<byte> credential)
    {
        if (credential.Length is < 20 or > 512)
        {
            throw new InvalidDataException("The protected OpenAI API credential has an invalid length.");
        }
        foreach (var value in credential)
        {
            if (value is < 0x21 or > 0x7e)
            {
                throw new InvalidDataException("The protected OpenAI API credential contains invalid characters.");
            }
        }
    }

    private static void ValidateRequest(ApprovedArtifactGenerationRequest request)
    {
        if (request.ProviderId != AdapterId || !new OpenAiRequestShape(request).IsValid)
        {
            throw new InvalidOperationException("The approved request does not match the OpenAI Images adapter contract.");
        }
    }

    private sealed record OpenAiRequestShape(ApprovedArtifactGenerationRequest Request)
    {
        public bool IsValid =>
            Request.Kind is "image" or "design-asset"
            && !string.IsNullOrWhiteSpace(Request.Id)
            && !string.IsNullOrWhiteSpace(Request.Instructions)
            && Request.Instructions.Length <= 16_000
            && Request.EvidenceHash.Length == 64
            && Request.EvidenceHash.All(Uri.IsHexDigit)
            && Path.GetFileName(Request.Destination) == Request.Destination.Split('/').Last()
            && Request.Destination.StartsWith(".helmion/artifacts/", StringComparison.Ordinal)
            && new[] { ".png", ".jpg", ".jpeg" }.Contains(
                Path.GetExtension(Request.Destination),
                StringComparer.OrdinalIgnoreCase);
    }

    private static string OutputFormat(string destination)
    {
        return Path.GetExtension(destination).Equals(".png", StringComparison.OrdinalIgnoreCase)
            ? "png"
            : "jpeg";
    }

    private static async Task<byte[]> ReadBoundedAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength > maximumBytes)
        {
            throw new InvalidOperationException("OpenAI Images returned an oversized response.");
        }

        await using var input = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            if (output.Length + read > maximumBytes)
            {
                throw new InvalidOperationException("OpenAI Images returned an oversized response.");
            }
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    private static byte[] ReadImageBytes(byte[] responseBytes)
    {
        try
        {
            using var document = JsonDocument.Parse(responseBytes);
            var encoded = document.RootElement
                .GetProperty("data")[0]
                .GetProperty("b64_json")
                .GetString();
            if (string.IsNullOrWhiteSpace(encoded)
                || encoded.Length > ((MaximumDecodedImageBytes + 2) / 3) * 4 + 4)
            {
                throw new InvalidDataException("OpenAI Images returned no bounded image payload.");
            }
            var bytes = Convert.FromBase64String(encoded);
            if (bytes.Length == 0 || bytes.Length > MaximumDecodedImageBytes)
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw new InvalidDataException("OpenAI Images returned no bounded image payload.");
            }
            return bytes;
        }
        catch (Exception error) when (error is JsonException
                                      or KeyNotFoundException
                                      or InvalidOperationException
                                      or FormatException
                                      or IndexOutOfRangeException)
        {
            throw new InvalidDataException("OpenAI Images returned an invalid image response.", error);
        }
    }

    private static string? ProviderRequestId(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("x-request-id", out var values)) return null;
        var value = values.FirstOrDefault()?.Trim();
        if (string.IsNullOrWhiteSpace(value)) return null;
        return value.Length <= 200 ? value : value[..200];
    }

    private static string ReadSafeProviderError(byte[] responseBytes)
    {
        try
        {
            using var document = JsonDocument.Parse(responseBytes);
            var message = document.RootElement.GetProperty("error").GetProperty("message").GetString();
            return SafeText(message);
        }
        catch
        {
            return "The provider did not return a readable error message.";
        }
    }

    private static string SafeText(string? value)
    {
        var normalized = string.IsNullOrWhiteSpace(value)
            ? "The provider did not return an error message."
            : value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return normalized.Length <= 300 ? normalized : normalized[..300];
    }
}

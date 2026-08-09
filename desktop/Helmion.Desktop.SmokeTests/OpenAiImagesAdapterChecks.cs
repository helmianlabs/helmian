using System.Net;
using System.Text;
using Helmion.Desktop.Core;
using Helmion.LocalService;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

internal static class OpenAiImagesAdapterChecks
{
    public static void Run()
    {
        var root = Path.Combine(Path.GetTempPath(), $"helmion-openai-images-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var profiles = new ProtectedProviderProfileStore(root, allowTestRoot: true);
            var fixtureCredential = Encoding.ASCII.GetBytes("sk-test-only-not-a-real-provider-key-123456");
            profiles.SaveAsync(
                    BuiltInProviderProfiles.OpenAiImages(DateTimeOffset.UtcNow),
                    fixtureCredential)
                .GetAwaiter().GetResult();
            Array.Clear(fixtureCredential);

            var png = Convert.FromBase64String(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
            var handler = new FixtureHandler(png);
            using var http = new HttpClient(handler);
            var unconfiguredProfiles = new ProtectedProviderProfileStore(
                Path.Combine(root, "unconfigured"),
                allowTestRoot: true);
            var unconfiguredStatus = new ArtifactStudioLocalGenerationService(
                    new OpenAiImagesArtifactStudioAdapter(unconfiguredProfiles, http))
                .GetProviderStatusAsync(CancellationToken.None)
                .GetAwaiter().GetResult();
            var unconfiguredImage = unconfiguredStatus.Capabilities.Single(item =>
                item.Kind == MediaProviderCapabilityKinds.ImageGeneration);
            Check(!unconfiguredImage.CredentialConfigured
                  && !unconfiguredImage.ProviderAccessTested
                  && !unconfiguredImage.ProviderAvailable
                  && !unconfiguredImage.CanAttemptAfterApproval
                  && unconfiguredImage.Availability == MediaProviderAvailability.ConfigurationRequired
                  && handler.Calls == 0,
                "status inspection reports configuration required without calling the provider");

            var adapter = new OpenAiImagesArtifactStudioAdapter(profiles, http);
            Check(adapter.IsConfigured, "DPAPI profile presence controls readiness without environment settings");

            var providerStatus = new ArtifactStudioLocalGenerationService(adapter)
                .GetProviderStatusAsync(CancellationToken.None)
                .GetAwaiter().GetResult();
            var imageCapability = providerStatus.Capabilities.Single(item =>
                item.Kind == MediaProviderCapabilityKinds.ImageGeneration);
            var videoCapability = providerStatus.Capabilities.Single(item =>
                item.Kind == MediaProviderCapabilityKinds.VideoGeneration);
            Check(imageCapability.CredentialConfigured
                  && imageCapability.AdapterInstalled
                  && !imageCapability.ProviderAccessTested
                  && !imageCapability.ProviderAvailable
                  && imageCapability.CanAttemptAfterApproval
                  && imageCapability.Availability == MediaProviderAvailability.ConfiguredNotTested,
                "image readiness keeps configured, approved-call, and provider-tested states distinct");
            Check(videoCapability.ProviderId is null
                  && !videoCapability.AdapterInstalled
                  && !videoCapability.CredentialConfigured
                  && !videoCapability.ProviderAccessTested
                  && !videoCapability.ProviderAvailable
                  && !videoCapability.CanAttemptAfterApproval
                  && videoCapability.Availability == MediaProviderAvailability.ProviderNotSelected,
                "video remains a separate unavailable capability until a provider is selected and tested");

            var rejectedAvailabilityClaim = false;
            try
            {
                MediaProviderCapabilityValidation.Validate(
                [
                    imageCapability with
                    {
                        Availability = MediaProviderAvailability.Available,
                        ProviderAvailable = true
                    },
                    videoCapability
                ]);
            }
            catch (InvalidDataException)
            {
                rejectedAvailabilityClaim = true;
            }
            Check(rejectedAvailabilityClaim,
                "capability validation rejects availability without provider-test evidence");

            var result = adapter.GenerateAsync(
                    new ApprovedArtifactGenerationRequest(
                        "artifact-test",
                        OpenAiImagesArtifactStudioAdapter.AdapterId,
                        "image",
                        "Create one harmless blue test pixel.",
                        ".helmion/artifacts/test.png",
                        new string('A', 64)),
                    CancellationToken.None)
                .GetAwaiter().GetResult();

            Check(handler.Calls == 1
                  && handler.Uri == OpenAiImagesArtifactStudioAdapter.Endpoint
                  && handler.AuthorizationScheme == "Bearer",
                "adapter uses the fixed official endpoint and bearer boundary exactly once");
            Check(handler.Body.Contains("\"model\":\"gpt-image-2\"", StringComparison.Ordinal)
                  && handler.Body.Contains("\"quality\":\"low\"", StringComparison.Ordinal)
                  && handler.Body.Contains("\"size\":\"1024x1024\"", StringComparison.Ordinal)
                  && !handler.Body.Contains("sk-test", StringComparison.Ordinal),
                "request is bounded and contains no credential in its JSON payload");
            Check(result.ContentType == "image/png"
                  && result.Bytes.SequenceEqual(png)
                  && result.ProviderRequestId == "req-fixture"
                  && result.ProviderModel == OpenAiImagesArtifactStudioAdapter.Model,
                "typed provider output carries validated bytes and redacted receipt identity");

            var project = Path.Combine(root, "project");
            Directory.CreateDirectory(project);
            var request = ArtifactStudioWorkflow.CreateRequest(
                project,
                OpenAiImagesArtifactStudioAdapter.AdapterId,
                ArtifactStudioKinds.Image,
                "Service proof",
                "Create one harmless service proof image.",
                "Prompt text only.",
                "service-proof.png");
            request = ArtifactStudioWorkflow.Decide(
                project,
                request.Id,
                approve: true,
                new ArtifactStudioProviderReadiness(true, true));
            var serviceAdapter = new ServiceFixtureAdapter(png);
            var generationService = new ArtifactStudioLocalGenerationService(serviceAdapter);
            var receipt = generationService.GenerateApprovedAsync(
                    project,
                    request.Id,
                    request.EvidenceHash,
                    CancellationToken.None)
                .GetAwaiter().GetResult();
            var repeatedReceipt = generationService.GenerateApprovedAsync(
                    project,
                    request.Id,
                    request.EvidenceHash,
                    CancellationToken.None)
                .GetAwaiter().GetResult();
            Check(receipt.DeliveryState == ArtifactStudioStates.Delivered
                  && repeatedReceipt.ArtifactSha256 == receipt.ArtifactSha256
                  && serviceAdapter.Calls == 1
                  && File.Exists(Path.Combine(project, ".helmion", "artifacts", "service-proof.png")),
                "local service rechecks approval, delivers atomically, and returns the durable receipt idempotently");

            Console.WriteLine("Helmion OpenAI Images adapter checks passed (9 checks; fixture HTTP only). ");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class ServiceFixtureAdapter(byte[] png) : IArtifactStudioProviderAdapter
    {
        public string ProviderId => OpenAiImagesArtifactStudioAdapter.AdapterId;
        public bool IsConfigured => true;
        public int Calls { get; private set; }
        public bool Supports(string kind) => kind is "image" or "design-asset";

        public Task<ArtifactStudioDelivery> GenerateAsync(
            ApprovedArtifactGenerationRequest request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            return Task.FromResult(new ArtifactStudioDelivery(
                Path.GetFileName(request.Destination),
                "image/png",
                png.ToArray(),
                "req-service-fixture",
                OpenAiImagesArtifactStudioAdapter.Model));
        }
    }

    private sealed class FixtureHandler(byte[] png) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public Uri? Uri { get; private set; }
        public string? AuthorizationScheme { get; private set; }
        public string Body { get; private set; } = string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            Uri = request.RequestUri;
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    $"{{\"data\":[{{\"b64_json\":\"{Convert.ToBase64String(png)}\"}}]}}",
                    Encoding.UTF8,
                    "application/json")
            };
            response.Headers.Add("x-request-id", "req-fixture");
            return response;
        }
    }

    private static void Check(bool condition, string description)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"OpenAI Images adapter check failed: {description}");
        }
    }
}

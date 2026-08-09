using System.Collections.Concurrent;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Helmion.LocalService.Security;

namespace Helmion.LocalService;

public sealed class ArtifactStudioLocalGenerationService : IArtifactGenerationService
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> RequestLocks =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly IArtifactStudioProviderAdapter _adapter;

    public ArtifactStudioLocalGenerationService(IArtifactStudioProviderAdapter adapter)
    {
        _adapter = adapter ?? throw new ArgumentNullException(nameof(adapter));
    }

    public Task<ArtifactProviderStatus> GetProviderStatusAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var configured = _adapter.IsConfigured;
        var capabilities = MediaProviderCapabilityValidation.Validate(
        [
            new MediaProviderCapabilityStatus(
                MediaProviderCapabilityKinds.ImageGeneration,
                "Still images",
                OpenAiImagesArtifactStudioAdapter.AdapterId,
                "OpenAI Images API",
                "Official HTTPS Images API",
                OpenAiImagesArtifactStudioAdapter.Model,
                AdapterInstalled: true,
                CredentialConfigured: configured,
                ProviderAccessTested: false,
                ProviderAvailable: false,
                ApprovalRequired: true,
                "The exact prompt, destination, and evidence hash must be approved locally before a request can leave Helmion.",
                "One low-quality 1024×1024 image per approved request. Provider input and output charges may apply.",
                configured
                    ? MediaProviderAvailability.ConfiguredNotTested
                    : MediaProviderAvailability.ConfigurationRequired,
                configured
                    ? "Protected credential configured. Provider access has not been tested; organization verification, model access, quota, or billing can still block generation."
                    : "Local adapter installed. Enroll one OpenAI API key into the protected local-service profile; no provider request or charge has been made."),
            new MediaProviderCapabilityStatus(
                MediaProviderCapabilityKinds.VideoGeneration,
                "Video",
                ProviderId: null,
                ProviderName: null,
                ProviderInterface: null,
                Model: null,
                AdapterInstalled: false,
                CredentialConfigured: false,
                ProviderAccessTested: false,
                ProviderAvailable: false,
                ApprovalRequired: true,
                "A future video request must show its provider, model, cost boundary, output destination, and exact approval before dispatch.",
                "No provider is selected, so Helmion cannot quote or incur video cost.",
                MediaProviderAvailability.ProviderNotSelected,
                "No video provider has been selected, configured, or tested. Video generation is unavailable in this build.")
        ]);
        return Task.FromResult(new ArtifactProviderStatus(
            OpenAiImagesArtifactStudioAdapter.AdapterId,
            "OpenAI Images API",
            "Official HTTPS Images API",
            OpenAiImagesArtifactStudioAdapter.Model,
            configured,
            AdapterInstalled: true,
            "Windows CurrentUser DPAPI · Helmion Local Service only",
            configured
                ? "OpenAI Images credential configured; provider access has not been tested. Cost can occur only after an exact approved generation action."
                : "One-time OpenAI Images credential enrollment is required. Nothing will be sent until enrollment and explicit approval.",
            capabilities));
    }

    public async Task<ArtifactGenerationResult> GenerateApprovedAsync(
        string projectRoot,
        string requestId,
        string evidenceHash,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (evidenceHash.Length != 64 || !evidenceHash.All(Uri.IsHexDigit))
        {
            throw new ArgumentException("A valid approved request evidence hash is required.", nameof(evidenceHash));
        }

        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(projectRoot));
        var lockKey = $"{root}\n{requestId}";
        var gate = RequestLocks.GetOrAdd(lockKey, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var result = await ArtifactStudioWorkflow.DispatchApprovedAsync(
                root,
                requestId,
                _adapter,
                cancellationToken,
                expectedEvidenceHash: evidenceHash).ConfigureAwait(false);
            return new ArtifactGenerationResult(
                result.Id,
                result.ApprovalState,
                result.DeliveryState,
                result.StatusDetail,
                result.Destination,
                result.EvidenceHash,
                result.ArtifactSha256,
                result.ProviderRequestId,
                result.ProviderModel,
                result.ContentType,
                result.SizeBytes);
        }
        finally
        {
            gate.Release();
        }
    }
}

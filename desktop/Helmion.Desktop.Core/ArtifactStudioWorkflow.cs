using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop.Core;

public static class ArtifactStudioKinds
{
    public const string Image = "image";
    public const string Pdf = "pdf";
    public const string Document = "document";
    public const string Slides = "slides";
    public const string Spreadsheet = "spreadsheet";
    public const string DesignAsset = "design-asset";

    public static IReadOnlyList<string> All { get; } =
        [Image, Pdf, Document, Slides, Spreadsheet, DesignAsset];

    public static string Label(string kind) => kind switch
    {
        Image => "Image",
        Pdf => "PDF",
        Document => "Document",
        Slides => "Slides",
        Spreadsheet => "Spreadsheet",
        DesignAsset => "Design asset",
        _ => "Unknown"
    };
}

public sealed record ArtifactStudioProvider(
    string Id,
    string Name,
    string Interface,
    IReadOnlyList<string> SupportedKinds,
    string CredentialSetting,
    bool AdapterInstalled,
    string Boundary)
{
    public string AvailabilityLabel => AdapterInstalled
        ? "Local adapter installed"
        : "Provider adapter not installed";
}

/// <summary>
/// Provider routes that have an explicit official-API boundary. A provider is
/// not added merely because it has a general chat API. Unsupported artifact
/// kinds remain visible in the request model but cannot be dispatched through
/// a route that has not been implemented and tested.
/// </summary>
public static class ArtifactStudioProviderCatalog
{
    public static IReadOnlyList<ArtifactStudioProvider> All { get; } =
    [
        new(
            "openai-images",
            "OpenAI Images API",
            "Official HTTPS Images API",
            [ArtifactStudioKinds.Image, ArtifactStudioKinds.DesignAsset],
            "openai-images protected provider profile",
            AdapterInstalled: true,
            "The Helmion Local Service retrieves a CurrentUser-DPAPI protected credential. The credential never enters the desktop UI, client protocol, project, artifacts, logs, or request ledger.")
    ];

    public static ArtifactStudioProvider Require(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.Ordinal))
        ?? throw new ArgumentException("Select a supported official provider route.", nameof(id));
}

public static class ArtifactStudioStates
{
    public const string WaitingApproval = "waiting-approval";
    public const string Approved = "approved";
    public const string Denied = "denied";

    public const string NotSent = "not-sent";
    public const string ConfigurationRequired = "configuration-required";
    public const string AdapterRequired = "adapter-required";
    public const string Ready = "ready";
    public const string Sending = "sending";
    public const string Delivered = "delivered";
    public const string Failed = "failed";
}

public sealed record ArtifactStudioRequest(
    string Id,
    DateTimeOffset UpdatedAtUtc,
    string ProviderId,
    string ProviderName,
    string ProviderInterface,
    string Kind,
    string Title,
    string Instructions,
    string DataScope,
    string Destination,
    string ApprovalState,
    string DeliveryState,
    string StatusDetail,
    string EvidenceHash,
    string? ArtifactSha256 = null,
    string? ProviderRequestId = null,
    string? ProviderModel = null,
    string? ContentType = null,
    long? SizeBytes = null)
{
    public string KindLabel => ArtifactStudioKinds.Label(Kind);
    public string UpdatedLabel => UpdatedAtUtc.ToLocalTime().ToString("g");
    public string StateLabel => $"{ApprovalState.Replace('-', ' ')} · {DeliveryState.Replace('-', ' ')}";
    public bool CanDecide => ApprovalState == ArtifactStudioStates.WaitingApproval;
}

public sealed record ArtifactStudioProviderReadiness(
    bool CredentialConfigured,
    bool AdapterInstalled)
{
    public string Label => !CredentialConfigured
        ? "Provider credential is not configured"
        : !AdapterInstalled
            ? "Credential is configured; approved API adapter is not installed"
            : "Provider route is configured and ready";
}

/// <summary>
/// Append-only, project-local Artifact Studio request history. Creating and
/// approving a request never contacts a provider. Only DispatchApprovedAsync
/// can cross the provider seam, and it first rechecks approval, provider id,
/// configuration, supported kind, and the fixed project destination.
/// </summary>
public static class ArtifactStudioWorkflow
{
    public const string RequestHistoryRelativePath = ".helmion/artifact-studio/requests.jsonl";
    public const int MaxTitleChars = 160;
    public const int MaxInstructionsChars = 16_000;
    public const int MaxDataScopeChars = 1_000;
    public const int MaxDeliveryBytes = 50 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static ArtifactStudioRequest CreateRequest(
        string projectRoot,
        string providerId,
        string kind,
        string title,
        string instructions,
        string dataScope,
        string destinationFileName,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        var provider = ArtifactStudioProviderCatalog.Require(providerId);
        var normalizedKind = RequireKind(kind);
        var normalizedTitle = RequireText(title, MaxTitleChars, "A request title is required.");
        var normalizedInstructions = RequireText(
            instructions,
            MaxInstructionsChars,
            "Generation instructions are required.");
        var normalizedScope = RequireText(
            dataScope,
            MaxDataScopeChars,
            "A precise data scope is required.");
        var destination = NormalizeDestination(destinationFileName, normalizedKind);
        var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var id = $"artifact-{at:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}";
        var evidence = EvidenceHash(
            id, provider.Id, normalizedKind, normalizedTitle,
            normalizedInstructions, normalizedScope, destination);
        var supportsKind = provider.SupportedKinds.Contains(normalizedKind, StringComparer.Ordinal);
        var detail = supportsKind
            ? "Waiting for explicit approval. Nothing has been sent or created."
            : $"{provider.Name} has no approved {ArtifactStudioKinds.Label(normalizedKind)} adapter in this build. Review may be recorded, but delivery remains blocked.";

        var request = new ArtifactStudioRequest(
            id,
            at,
            provider.Id,
            provider.Name,
            provider.Interface,
            normalizedKind,
            normalizedTitle,
            normalizedInstructions,
            normalizedScope,
            destination,
            ArtifactStudioStates.WaitingApproval,
            ArtifactStudioStates.NotSent,
            detail,
            evidence);
        Append(root, request);
        ProjectWorkbenchStore.RecordArtifactStudioEvent(
            root,
            request.Id,
            "Artifact request prepared",
            $"{request.ProviderName} · {request.KindLabel} · {request.Destination}. Nothing sent.",
            request.DeliveryState,
            request.EvidenceHash,
            at);
        return request;
    }

    public static ArtifactStudioRequest Decide(
        string projectRoot,
        string requestId,
        bool approve,
        ArtifactStudioProviderReadiness readiness,
        DateTimeOffset? now = null)
    {
        var root = RequireProjectRoot(projectRoot);
        var current = RequireCurrent(root, requestId);
        if (!current.CanDecide)
        {
            throw new InvalidOperationException("This Artifact Studio request has already been decided.");
        }

        var provider = ArtifactStudioProviderCatalog.Require(current.ProviderId);
        var supportsKind = provider.SupportedKinds.Contains(current.Kind, StringComparer.Ordinal);
        var at = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        ArtifactStudioRequest next;
        if (!approve)
        {
            next = current with
            {
                UpdatedAtUtc = at,
                ApprovalState = ArtifactStudioStates.Denied,
                DeliveryState = ArtifactStudioStates.NotSent,
                StatusDetail = "Denied locally. Nothing was sent or created."
            };
        }
        else
        {
            var (delivery, detail) = !supportsKind
                ? (ArtifactStudioStates.AdapterRequired,
                    $"Approved, but no approved {current.KindLabel} adapter exists for {current.ProviderName}. Nothing was sent.")
                : !readiness.CredentialConfigured
                    ? (ArtifactStudioStates.ConfigurationRequired,
                        "Approved, but the provider credential is not configured. Nothing was sent.")
                    : !readiness.AdapterInstalled
                        ? (ArtifactStudioStates.AdapterRequired,
                            "Approved, but the official provider API adapter is not installed in this build. Nothing was sent.")
                        : (ArtifactStudioStates.Ready,
                            "Approved and ready for an explicit provider delivery action.");
            next = current with
            {
                UpdatedAtUtc = at,
                ApprovalState = ArtifactStudioStates.Approved,
                DeliveryState = delivery,
                StatusDetail = detail
            };
        }

        Append(root, next);
        ProjectWorkbenchStore.RecordArtifactStudioEvent(
            root,
            next.Id,
            approve ? "Artifact request approved" : "Artifact request denied",
            $"{next.ProviderName} · {next.KindLabel} · {next.StatusDetail}",
            next.DeliveryState,
            next.EvidenceHash,
            at);
        return next;
    }

    public static async Task<ArtifactStudioRequest> DispatchApprovedAsync(
        string projectRoot,
        string requestId,
        IArtifactStudioProviderAdapter adapter,
        CancellationToken cancellationToken = default,
        DateTimeOffset? now = null,
        string? expectedEvidenceHash = null)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        var root = RequireProjectRoot(projectRoot);
        EnsureSafeExistingProjectBoundary(root);
        var current = RequireCurrent(root, requestId);
        var recomputedEvidence = EvidenceHash(
            current.Id,
            current.ProviderId,
            current.Kind,
            current.Title,
            current.Instructions,
            current.DataScope,
            current.Destination);
        if (!FixedHashEquals(current.EvidenceHash, recomputedEvidence))
        {
            throw new InvalidOperationException("The Artifact Studio request changed after it was prepared and cannot be generated.");
        }
        if (!string.IsNullOrWhiteSpace(expectedEvidenceHash)
            && !FixedHashEquals(current.EvidenceHash, expectedEvidenceHash))
        {
            throw new InvalidOperationException("The approved request evidence no longer matches the generation action.");
        }
        if (current.ApprovalState != ArtifactStudioStates.Approved)
        {
            throw new InvalidOperationException("Provider delivery requires an explicitly approved request.");
        }
        if (current.DeliveryState == ArtifactStudioStates.Delivered)
        {
            return current;
        }
        if (current.DeliveryState == ArtifactStudioStates.Sending)
        {
            throw new InvalidOperationException("This request is already sending or delivered and cannot be dispatched again.");
        }
        if (!string.Equals(current.ProviderId, adapter.ProviderId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The provider adapter does not match the approved request.");
        }
        if (!adapter.IsConfigured)
        {
            return AppendDeliveryState(
                root,
                current,
                ArtifactStudioStates.ConfigurationRequired,
                "Provider delivery was not attempted because its credential/configuration is unavailable.",
                now);
        }
        if (!adapter.Supports(current.Kind))
        {
            return AppendDeliveryState(
                root,
                current,
                ArtifactStudioStates.AdapterRequired,
                $"Provider delivery was not attempted because this adapter does not support {current.KindLabel} output.",
                now);
        }

        EnsureSafeArtifactDestination(root, ResolveInside(root, current.Destination));

        var sending = AppendDeliveryState(
            root,
            current,
            ArtifactStudioStates.Sending,
            "Approved request is being delivered through the named provider adapter.",
            now);
        try
        {
            var delivery = await adapter.GenerateAsync(
                new ApprovedArtifactGenerationRequest(
                    sending.Id,
                    sending.ProviderId,
                    sending.Kind,
                    sending.Instructions,
                    sending.Destination,
                    sending.EvidenceHash),
                cancellationToken).ConfigureAwait(false);
            ValidateDelivery(sending, delivery);
            var destination = ResolveInside(root, sending.Destination);
            EnsureSafeArtifactDestination(root, destination);
            WriteAtomically(destination, delivery.Bytes);
            var hash = Convert.ToHexString(SHA256.HashData(delivery.Bytes));
            var delivered = sending with
            {
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                DeliveryState = ArtifactStudioStates.Delivered,
                StatusDetail = $"Delivered to {sending.Destination} and added to project artifact history.",
                ArtifactSha256 = hash,
                ProviderRequestId = delivery.ProviderRequestId,
                ProviderModel = delivery.ProviderModel,
                ContentType = delivery.ContentType,
                SizeBytes = delivery.Bytes.LongLength
            };
            Append(root, delivered);
            try
            {
                ProjectWorkbenchStore.RecordArtifactStudioEvent(
                    root,
                    delivered.Id,
                    "Artifact delivered",
                    $"{delivered.ProviderName} · {delivered.KindLabel} · {delivered.Destination}.",
                    delivered.DeliveryState,
                    hash,
                    delivered.UpdatedAtUtc);
            }
            catch
            {
                // The authoritative request ledger and artifact are already
                // durable. A secondary activity-feed failure must not relabel
                // successful provider delivery as failed or cause a retry.
            }
            return delivered;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            return AppendDeliveryState(
                root,
                sending,
                ArtifactStudioStates.Failed,
                $"Provider delivery failed without creating an artifact: {SafeError(error.Message)}",
                DateTimeOffset.UtcNow);
        }
    }

    public static IReadOnlyList<ArtifactStudioRequest> ReadHistory(
        string projectRoot,
        int limit = 100)
    {
        var root = RequireProjectRoot(projectRoot);
        if (limit is < 1 or > 500)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
        var path = ResolveInside(root, RequestHistoryRelativePath);
        if (!File.Exists(path)) return [];

        var latest = new Dictionary<string, ArtifactStudioRequest>(StringComparer.Ordinal);
        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var request = JsonSerializer.Deserialize<ArtifactStudioRequest>(line, JsonOptions);
                if (request is not null && !string.IsNullOrWhiteSpace(request.Id))
                {
                    latest[request.Id] = request;
                }
            }
            catch (JsonException)
            {
                // A partial append cannot hide the valid request history.
            }
        }

        return latest.Values
            .OrderByDescending(item => item.UpdatedAtUtc)
            .ThenByDescending(item => item.Id, StringComparer.Ordinal)
            .Take(limit)
            .ToArray();
    }

    private static ArtifactStudioRequest AppendDeliveryState(
        string root,
        ArtifactStudioRequest current,
        string deliveryState,
        string detail,
        DateTimeOffset? now)
    {
        var next = current with
        {
            UpdatedAtUtc = (now ?? DateTimeOffset.UtcNow).ToUniversalTime(),
            DeliveryState = deliveryState,
            StatusDetail = detail
        };
        Append(root, next);
        ProjectWorkbenchStore.RecordArtifactStudioEvent(
            root,
            next.Id,
            "Artifact delivery state",
            $"{next.ProviderName} · {next.KindLabel} · {detail}",
            deliveryState,
            next.EvidenceHash,
            next.UpdatedAtUtc);
        return next;
    }

    private static ArtifactStudioRequest RequireCurrent(string root, string? requestId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        return ReadHistory(root, 500).FirstOrDefault(item => item.Id == requestId)
            ?? throw new InvalidOperationException("Artifact Studio request was not found in this project.");
    }

    private static void ValidateDelivery(
        ArtifactStudioRequest request,
        ArtifactStudioDelivery? delivery)
    {
        if (delivery is null || delivery.Bytes is null || delivery.Bytes.Length == 0)
        {
            throw new InvalidOperationException("The provider returned no artifact bytes.");
        }
        if (delivery.Bytes.Length > MaxDeliveryBytes)
        {
            throw new InvalidOperationException($"The provider output exceeds {MaxDeliveryBytes / (1024 * 1024)} MB.");
        }
        var expectedName = Path.GetFileName(request.Destination);
        if (!string.Equals(delivery.FileName, expectedName, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The provider output name does not match the approved destination.");
        }
        var allowedContentTypes = request.Kind switch
        {
            ArtifactStudioKinds.Image => new[] { "image/png", "image/jpeg" },
            ArtifactStudioKinds.DesignAsset => new[] { "image/png", "image/svg+xml" },
            ArtifactStudioKinds.Pdf => new[] { "application/pdf" },
            ArtifactStudioKinds.Document => new[]
            {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "text/markdown",
                "text/plain"
            },
            ArtifactStudioKinds.Slides => new[]
            {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            },
            ArtifactStudioKinds.Spreadsheet => new[]
            {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "text/csv"
            },
            _ => []
        };
        if (!allowedContentTypes.Contains(delivery.ContentType, StringComparer.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The provider output type does not match the approved artifact type.");
        }
        if (delivery.ContentType.Equals("image/png", StringComparison.OrdinalIgnoreCase)
            && (delivery.Bytes.Length < 8
                || !delivery.Bytes.AsSpan(0, 8).SequenceEqual(
                    new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })))
        {
            throw new InvalidOperationException("The provider output did not contain a valid PNG signature.");
        }
        if (delivery.ContentType.Equals("image/jpeg", StringComparison.OrdinalIgnoreCase)
            && (delivery.Bytes.Length < 3
                || delivery.Bytes[0] != 0xFF
                || delivery.Bytes[1] != 0xD8
                || delivery.Bytes[2] != 0xFF))
        {
            throw new InvalidOperationException("The provider output did not contain a valid JPEG signature.");
        }
        if (delivery.ContentType.Equals("image/png", StringComparison.OrdinalIgnoreCase))
        {
            if (delivery.Bytes.Length < 24)
            {
                throw new InvalidOperationException("The provider PNG did not contain bounded dimensions.");
            }
            ValidateImageDimensions(
                BinaryPrimitives.ReadUInt32BigEndian(delivery.Bytes.AsSpan(16, 4)),
                BinaryPrimitives.ReadUInt32BigEndian(delivery.Bytes.AsSpan(20, 4)));
        }
        else if (delivery.ContentType.Equals("image/jpeg", StringComparison.OrdinalIgnoreCase))
        {
            var dimensions = ReadJpegDimensions(delivery.Bytes);
            ValidateImageDimensions(dimensions.Width, dimensions.Height);
        }
    }

    private static string NormalizeDestination(string? fileName, string kind)
    {
        var requested = fileName?.Trim() ?? string.Empty;
        var normalized = Path.GetFileName(requested);
        if (string.IsNullOrWhiteSpace(normalized)
            || normalized is "." or ".."
            || !string.Equals(requested, normalized, StringComparison.Ordinal)
            || normalized.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw new ArgumentException("Enter a valid artifact file name.", nameof(fileName));
        }
        var extension = Path.GetExtension(normalized);
        var allowed = kind switch
        {
            ArtifactStudioKinds.Image => new[] { ".png", ".jpg", ".jpeg" },
            ArtifactStudioKinds.Pdf => new[] { ".pdf" },
            ArtifactStudioKinds.Document => new[] { ".docx", ".md", ".txt" },
            ArtifactStudioKinds.Slides => new[] { ".pptx" },
            ArtifactStudioKinds.Spreadsheet => new[] { ".xlsx", ".csv" },
            ArtifactStudioKinds.DesignAsset => new[] { ".png", ".svg" },
            _ => []
        };
        if (!allowed.Contains(extension, StringComparer.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"{ArtifactStudioKinds.Label(kind)} destination must use: {string.Join(", ", allowed)}.",
                nameof(fileName));
        }
        return $"{ProjectArtifactStore.ArtifactRelativeDirectory}/{normalized}";
    }

    private static void ValidateImageDimensions(uint width, uint height)
    {
        if (width == 0 || height == 0 || width > 4_096 || height > 4_096
            || (ulong)width * height > 8_294_400)
        {
            throw new InvalidOperationException("The provider image dimensions exceed the approved media boundary.");
        }
    }

    private static (uint Width, uint Height) ReadJpegDimensions(byte[] bytes)
    {
        var offset = 2;
        while (offset + 8 < bytes.Length)
        {
            if (bytes[offset] != 0xFF)
            {
                offset++;
                continue;
            }
            while (offset < bytes.Length && bytes[offset] == 0xFF) offset++;
            if (offset >= bytes.Length) break;
            var marker = bytes[offset++];
            if (marker is 0xD8 or 0xD9) continue;
            if (offset + 2 > bytes.Length) break;
            var segmentLength = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset, 2));
            if (segmentLength < 2 || offset + segmentLength > bytes.Length) break;
            if (marker is 0xC0 or 0xC1 or 0xC2 or 0xC3
                or 0xC5 or 0xC6 or 0xC7 or 0xC9 or 0xCA or 0xCB
                or 0xCD or 0xCE or 0xCF)
            {
                if (segmentLength < 7) break;
                return (
                    BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset + 5, 2)),
                    BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(offset + 3, 2)));
            }
            offset += segmentLength;
        }
        throw new InvalidOperationException("The provider JPEG did not contain bounded dimensions.");
    }

    private static string RequireKind(string? kind)
    {
        var normalized = kind?.Trim().ToLowerInvariant() ?? string.Empty;
        if (!ArtifactStudioKinds.All.Contains(normalized, StringComparer.Ordinal))
        {
            throw new ArgumentException("Select a supported artifact type.", nameof(kind));
        }
        return normalized;
    }

    private static string RequireText(string? text, int max, string emptyMessage)
    {
        var normalized = text?.Trim() ?? string.Empty;
        if (normalized.Length == 0) throw new ArgumentException(emptyMessage);
        if (normalized.Length > max)
        {
            throw new ArgumentException($"Text exceeds the {max:N0}-character limit.");
        }
        return normalized;
    }

    private static string EvidenceHash(params string[] values)
    {
        var bytes = Encoding.UTF8.GetBytes(string.Join("\n", values));
        return Convert.ToHexString(SHA256.HashData(bytes));
    }

    private static bool FixedHashEquals(string? left, string? right)
    {
        if (left?.Length != 64 || right?.Length != 64) return false;
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(left),
            Encoding.ASCII.GetBytes(right));
    }

    private static void EnsureSafeArtifactDestination(string root, string destination)
    {
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException("The selected project cannot be a filesystem link.");
        }

        var artifactDirectory = ResolveInside(root, ProjectArtifactStore.ArtifactRelativeDirectory);
        var current = new DirectoryInfo(root);
        foreach (var component in new[] { ".helmion", "artifacts" })
        {
            current = new DirectoryInfo(Path.Combine(current.FullName, component));
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("The project artifact destination cannot traverse a filesystem link.");
            }
        }

        if (File.Exists(destination)
            && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException("The approved artifact destination cannot be a filesystem link.");
        }

        Directory.CreateDirectory(artifactDirectory);
        var helmionDirectory = ResolveInside(root, ".helmion");
        if ((File.GetAttributes(helmionDirectory) & FileAttributes.ReparsePoint) != 0
            || (File.GetAttributes(artifactDirectory) & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException("The project artifact destination cannot be a filesystem link.");
        }
    }

    private static void EnsureSafeExistingProjectBoundary(string root)
    {
        var paths = new[]
        {
            root,
            ResolveInside(root, ".helmion"),
            ResolveInside(root, ".helmion/artifact-studio"),
            ResolveInside(root, RequestHistoryRelativePath),
            ResolveInside(root, ProjectArtifactStore.ArtifactRelativeDirectory)
        };
        foreach (var path in paths)
        {
            if ((File.Exists(path) || Directory.Exists(path))
                && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(
                    "Artifact Studio cannot read or write through a filesystem link.");
            }
        }
    }

    private static string SafeError(string? message)
    {
        var value = string.IsNullOrWhiteSpace(message) ? "Unknown provider error." : message.Trim();
        return value.Length <= 500 ? value : value[..500];
    }

    private static string RequireProjectRoot(string? projectRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectRoot);
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(projectRoot));
        if (!Directory.Exists(root))
        {
            throw new DirectoryNotFoundException($"Selected project does not exist: {root}");
        }
        return root;
    }

    private static string ResolveInside(string root, string relativePath)
    {
        var full = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = root + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Artifact Studio path escaped the selected project.");
        }
        return full;
    }

    private static void Append(string root, ArtifactStudioRequest request)
    {
        var path = ResolveInside(root, RequestHistoryRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(
            path,
            JsonSerializer.Serialize(request, JsonOptions) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static void WriteAtomically(string path, byte[] bytes)
    {
        var temporary = path + $".{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllBytes(temporary, bytes);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); }
            catch { /* best-effort cleanup after the intended write */ }
        }
    }
}

using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Helmion.Desktop.Core;

public enum ExternalItemKind
{
    WebsiteDownload,
    GitHubContent,
    Attachment,
    McpServer,
    PluginOrExtension,
    SkillOrAddon,
    AiIntegration,
    WindowsSandboxConfiguration
}

public enum ExternalItemReviewDecision
{
    Block,
    NeedsReview,
    ReadyToApprove
}

public enum ExternalEvidenceState
{
    Verified,
    PresentUnverified,
    Missing,
    NotApplicable
}

public enum ExternalItemFindingLevel
{
    Information,
    Review,
    Block
}

public sealed record ExternalItemFinding(
    ExternalItemFindingLevel Level,
    string Category,
    string Message);

public sealed record ExternalItemEvidence(
    ExternalItemKind Kind,
    string Name,
    string Scope,
    string Source,
    ExternalEvidenceState ProvenanceState,
    string Provenance,
    string? Sha256,
    string FileType,
    ExternalEvidenceState SignatureState,
    string Signature,
    ExternalEvidenceState ManifestState,
    string Manifest,
    ExternalEvidenceState CapabilityState,
    IReadOnlyList<string> RequestedCapabilities,
    IReadOnlyList<ExternalItemFinding> Findings);

public sealed record ExternalItemReview(
    ExternalItemReviewDecision Decision,
    string DecisionLabel,
    string Explanation,
    ExternalItemEvidence Evidence,
    IReadOnlyList<string> Unknowns,
    bool RequiresSeparateApproval)
{
    public bool CanRequestApproval => Decision == ExternalItemReviewDecision.ReadyToApprove;
}

/// <summary>
/// One evidence-first rule for every kind of outside item that can enter Helmian.
/// This is an inspection and planning gate, not a malware scanner or a guarantee.
/// It never downloads, installs, activates, enables, or executes the reviewed item.
/// </summary>
public static class ExternalItemReviewPolicy
{
    public static ExternalItemReview Evaluate(ExternalItemEvidence evidence)
    {
        ArgumentNullException.ThrowIfNull(evidence);

        var blocking = evidence.Findings
            .Where(finding => finding.Level == ExternalItemFindingLevel.Block)
            .ToList();
        if (blocking.Count > 0)
        {
            return new ExternalItemReview(
                ExternalItemReviewDecision.Block,
                "BLOCK",
                "The item has a blocking policy finding. Helmian will not offer an install, activation, attachment, or sandbox approval path.",
                evidence,
                FindUnknowns(evidence),
                RequiresSeparateApproval(evidence.Kind));
        }

        var unknowns = FindUnknowns(evidence);
        var reviewFindings = evidence.Findings
            .Where(finding => finding.Level == ExternalItemFindingLevel.Review)
            .ToList();
        if (unknowns.Count > 0 || reviewFindings.Count > 0)
        {
            return new ExternalItemReview(
                ExternalItemReviewDecision.NeedsReview,
                "NEEDS REVIEW",
                "Evidence is missing, unverified, or needs a person to interpret it. Unknown never means safe, so approval remains unavailable.",
                evidence,
                unknowns,
                RequiresSeparateApproval(evidence.Kind));
        }

        return new ExternalItemReview(
            ExternalItemReviewDecision.ReadyToApprove,
            "READY TO APPROVE",
            "The required evidence is present and no configured rule blocked it. This is not a malware-free or safe guarantee; the next action still requires explicit user approval.",
            evidence,
            [],
            RequiresSeparateApproval(evidence.Kind));
    }

    private static List<string> FindUnknowns(ExternalItemEvidence evidence)
    {
        var unknowns = new List<string>();

        if (evidence.ProvenanceState is ExternalEvidenceState.Missing
            or ExternalEvidenceState.PresentUnverified)
        {
            unknowns.Add("Source provenance is missing or unverified.");
        }

        if (string.IsNullOrWhiteSpace(evidence.Sha256))
        {
            unknowns.Add("A SHA-256 content identity is unavailable.");
        }

        if (evidence.SignatureState is ExternalEvidenceState.Missing
            or ExternalEvidenceState.PresentUnverified)
        {
            unknowns.Add("Publisher signature evidence is missing or unverified.");
        }

        if (evidence.ManifestState is ExternalEvidenceState.Missing
            or ExternalEvidenceState.PresentUnverified)
        {
            unknowns.Add("Package or capability manifest evidence is missing or unverified.");
        }

        if (evidence.CapabilityState is ExternalEvidenceState.Missing
            or ExternalEvidenceState.PresentUnverified)
        {
            unknowns.Add("Requested permissions and capabilities are missing or unverified.");
        }

        return unknowns;
    }

    private static bool RequiresSeparateApproval(ExternalItemKind kind) => kind != ExternalItemKind.Attachment;
}

public sealed class ExternalItemPreflightInspector
{
    private static readonly IReadOnlySet<string> ExecutablePackageExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".exe", ".dll", ".msi", ".msix", ".appx", ".appxbundle",
            ".crx", ".xpi", ".vsix", ".nupkg", ".zip"
        };

    private static readonly IReadOnlySet<string> ScriptExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".js", ".mjs", ".cjs", ".sh"
        };

    private static readonly IReadOnlySet<string> ArchiveExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".zip", ".nupkg", ".vsix"
        };

    public ExternalItemReview ReviewLocalFile(
        string? path,
        ExternalItemKind kind,
        string? assertedSource = null)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return ExternalItemReviewPolicy.Evaluate(MissingFileEvidence(
                kind,
                "No file selected",
                "No local file was selected."));
        }

        FileInfo info;
        try
        {
            info = new FileInfo(path);
        }
        catch (Exception exception) when (exception is ArgumentException
                                           or NotSupportedException
                                           or PathTooLongException)
        {
            return ExternalItemReviewPolicy.Evaluate(MissingFileEvidence(
                kind,
                Path.GetFileName(path),
                $"The path could not be parsed: {exception.Message}"));
        }

        if (!info.Exists)
        {
            return ExternalItemReviewPolicy.Evaluate(MissingFileEvidence(
                kind,
                info.Name,
                "The selected file no longer exists."));
        }

        var findings = new List<ExternalItemFinding>();
        if (kind == ExternalItemKind.Attachment)
        {
            var attachment = AttachmentPolicy.Validate(info.FullName);
            if (!attachment.Accepted)
            {
                findings.Add(new ExternalItemFinding(
                    ExternalItemFindingLevel.Block,
                    "Attachment policy",
                    attachment.Message));
            }
        }

        var extension = info.Extension.Length > 0 ? info.Extension.ToLowerInvariant() : "(none)";
        var sourceIsAsserted = IsHttpSource(assertedSource);
        var provenanceState = kind == ExternalItemKind.Attachment
            ? ExternalEvidenceState.Verified
            : sourceIsAsserted
                ? ExternalEvidenceState.PresentUnverified
                : ExternalEvidenceState.Missing;
        var provenance = kind == ExternalItemKind.Attachment
            ? "User selected this exact local file for attachment; its wider origin was not inferred."
            : sourceIsAsserted
                ? $"User supplied source: {assertedSource!.Trim()} (not fetched or independently verified)."
                : "Original website, repository, publisher, and download chain were not supplied.";

        string? hash = null;
        try
        {
            using var stream = new FileStream(
                info.FullName,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read);
            hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            findings.Add(new ExternalItemFinding(
                ExternalItemFindingLevel.Block,
                "Content identity",
                $"The file could not be read for hashing: {exception.Message}"));
        }

        ManifestEvidence manifest;
        try
        {
            manifest = kind == ExternalItemKind.Attachment
                ? new ManifestEvidence(
                    ExternalEvidenceState.NotApplicable,
                    "Attachments are read as text; no installation manifest is applied.",
                    ExternalEvidenceState.NotApplicable,
                    [])
                : InspectManifest(info, extension, findings);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            findings.Add(new ExternalItemFinding(
                ExternalItemFindingLevel.Block,
                "Manifest evidence",
                $"Manifest evidence could not be read: {exception.Message}"));
            manifest = new ManifestEvidence(
                ExternalEvidenceState.Missing,
                "Manifest evidence is unavailable.",
                ExternalEvidenceState.Missing,
                []);
        }

        var signature = SignatureEvidence(kind, extension);

        if (ScriptExtensions.Contains(extension))
        {
            findings.Add(new ExternalItemFinding(
                kind == ExternalItemKind.Attachment
                    ? ExternalItemFindingLevel.Information
                    : ExternalItemFindingLevel.Review,
                "Executable content",
                kind == ExternalItemKind.Attachment
                    ? "The script will be attached as text only; this review does not execute it."
                    : "The item contains executable script content and needs a human code review before approval."));
        }

        if (LooksLikeDoubleExtension(info.Name))
        {
            findings.Add(new ExternalItemFinding(
                ExternalItemFindingLevel.Block,
                "Misleading filename",
                "The filename combines a document-looking suffix with an executable/package suffix."));
        }

        var evidence = new ExternalItemEvidence(
            kind,
            info.Name,
            ScopeFor(kind),
            string.IsNullOrWhiteSpace(assertedSource) ? info.FullName : assertedSource.Trim(),
            provenanceState,
            provenance,
            hash,
            $"{extension} · {AttachmentPolicy.DescribeSize(info.Length)}",
            signature.State,
            signature.Description,
            manifest.State,
            manifest.Description,
            manifest.CapabilityState,
            manifest.Capabilities,
            findings);

        return ExternalItemReviewPolicy.Evaluate(evidence);
    }

    public static ExternalItemKind InferKind(string path)
    {
        var extension = Path.GetExtension(path);
        return extension.ToLowerInvariant() switch
        {
            ".crx" or ".xpi" or ".vsix" => ExternalItemKind.PluginOrExtension,
            ".wsb" => ExternalItemKind.WindowsSandboxConfiguration,
            _ => ExternalItemKind.WebsiteDownload
        };
    }

    private static ExternalItemEvidence MissingFileEvidence(
        ExternalItemKind kind,
        string name,
        string message) =>
        new(
            kind,
            name,
            ScopeFor(kind),
            "Unknown",
            ExternalEvidenceState.Missing,
            "No source provenance is available.",
            null,
            "Unknown",
            ExternalEvidenceState.Missing,
            "No publisher signature evidence is available.",
            ExternalEvidenceState.Missing,
            "No package manifest evidence is available.",
            ExternalEvidenceState.Missing,
            [],
            [new ExternalItemFinding(ExternalItemFindingLevel.Block, "Local file", message)]);

    private static (ExternalEvidenceState State, string Description) SignatureEvidence(
        ExternalItemKind kind,
        string extension)
    {
        if (kind == ExternalItemKind.Attachment || !ExecutablePackageExtensions.Contains(extension))
        {
            return (ExternalEvidenceState.NotApplicable,
                "Not applicable to this text/source review.");
        }

        return (ExternalEvidenceState.Missing,
            "Publisher signature evidence is not available from this non-executing local preflight.");
    }

    private static ManifestEvidence InspectManifest(
        FileInfo info,
        string extension,
        List<ExternalItemFinding> findings)
    {
        if (ArchiveExtensions.Contains(extension))
        {
            return InspectArchiveManifest(info, findings);
        }

        var manifestName = info.Name.ToLowerInvariant();
        if (manifestName is "package.json" or "manifest.json" or "helmion-candidate.json")
        {
            return InspectJsonManifest(File.ReadAllText(info.FullName), info.Name, findings);
        }

        if (manifestName == "skill.md")
        {
            return new ManifestEvidence(
                ExternalEvidenceState.Verified,
                "SKILL.md source document present; it is not a machine-enforced permission manifest.",
                ExternalEvidenceState.Missing,
                []);
        }

        if (ExecutablePackageExtensions.Contains(extension))
        {
            return new ManifestEvidence(
                ExternalEvidenceState.Missing,
                "No supported package manifest was available without extracting or executing the item.",
                ExternalEvidenceState.Missing,
                []);
        }

        return new ManifestEvidence(
            ExternalEvidenceState.NotApplicable,
            "No package manifest is required for this standalone text/source file.",
            ExternalEvidenceState.NotApplicable,
            []);
    }

    private static ManifestEvidence InspectArchiveManifest(
        FileInfo info,
        List<ExternalItemFinding> findings)
    {
        try
        {
            using var archive = ZipFile.OpenRead(info.FullName);
            foreach (var entry in archive.Entries)
            {
                if (HasUnsafeArchivePath(entry.FullName))
                {
                    findings.Add(new ExternalItemFinding(
                        ExternalItemFindingLevel.Block,
                        "Archive path",
                        $"Archive entry \"{entry.FullName}\" can escape an extraction folder."));
                }
            }

            var manifestEntry = archive.Entries.FirstOrDefault(entry =>
                entry.FullName.EndsWith("package.json", StringComparison.OrdinalIgnoreCase)
                || entry.FullName.EndsWith("manifest.json", StringComparison.OrdinalIgnoreCase)
                || entry.FullName.EndsWith("helmion-candidate.json", StringComparison.OrdinalIgnoreCase));
            if (manifestEntry is null)
            {
                return new ManifestEvidence(
                    ExternalEvidenceState.Missing,
                    $"Archive contains {archive.Entries.Count} entries but no supported manifest.",
                    ExternalEvidenceState.Missing,
                    []);
            }

            if (manifestEntry.Length > 1024 * 1024)
            {
                findings.Add(new ExternalItemFinding(
                    ExternalItemFindingLevel.Review,
                    "Package manifest",
                    "The package manifest exceeds the 1 MB inspection limit."));
                return new ManifestEvidence(
                    ExternalEvidenceState.PresentUnverified,
                    $"{manifestEntry.FullName} is present but was not parsed.",
                    ExternalEvidenceState.Missing,
                    []);
            }

            using var reader = new StreamReader(manifestEntry.Open());
            return InspectJsonManifest(reader.ReadToEnd(), manifestEntry.FullName, findings);
        }
        catch (Exception exception) when (exception is InvalidDataException
                                           or IOException
                                           or UnauthorizedAccessException)
        {
            findings.Add(new ExternalItemFinding(
                ExternalItemFindingLevel.Review,
                "Package archive",
                $"The archive could not be inspected safely: {exception.Message}"));
            return new ManifestEvidence(
                ExternalEvidenceState.Missing,
                "Archive manifest evidence is unavailable.",
                ExternalEvidenceState.Missing,
                []);
        }
    }

    private static ManifestEvidence InspectJsonManifest(
        string json,
        string manifestName,
        List<ExternalItemFinding> findings)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var name = ReadString(root, "name") ?? "unnamed";
            var version = ReadString(root, "version") ?? "version unknown";
            var capabilities = new List<string>();

            AddStringArray(root, "permissions", "permission", capabilities);
            AddStringArray(root, "host_permissions", "host", capabilities);
            AddStringArray(root, "allowedHosts", "network host", capabilities);
            AddStringArray(root, "allowedEnv", "environment variable", capabilities);
            AddStringArray(root, "tools", "tool", capabilities);

            if (root.TryGetProperty("scripts", out var scripts)
                && scripts.ValueKind == JsonValueKind.Object)
            {
                foreach (var script in scripts.EnumerateObject())
                {
                    capabilities.Add($"package script: {script.Name}");
                    if (script.Name.Contains("install", StringComparison.OrdinalIgnoreCase))
                    {
                        findings.Add(new ExternalItemFinding(
                            ExternalItemFindingLevel.Review,
                            "Install script",
                            $"Manifest declares the package script \"{script.Name}\". It was not executed."));
                    }
                }
            }

            var capabilityState = capabilities.Count > 0
                ? ExternalEvidenceState.Verified
                : ExplicitlyDeclaresNoCapabilities(root)
                    ? ExternalEvidenceState.Verified
                    : ExternalEvidenceState.Missing;
            var description = $"{manifestName}: {name} · {version}";
            return new ManifestEvidence(
                ExternalEvidenceState.Verified,
                description,
                capabilityState,
                capabilities);
        }
        catch (JsonException exception)
        {
            findings.Add(new ExternalItemFinding(
                ExternalItemFindingLevel.Review,
                "Package manifest",
                $"{manifestName} is not valid JSON: {exception.Message}"));
            return new ManifestEvidence(
                ExternalEvidenceState.PresentUnverified,
                $"{manifestName} is present but invalid.",
                ExternalEvidenceState.Missing,
                []);
        }
    }

    private static bool ExplicitlyDeclaresNoCapabilities(JsonElement root)
    {
        var keys = new[] { "permissions", "host_permissions", "allowedHosts", "allowedEnv", "tools" };
        return keys.Any(key => root.TryGetProperty(key, out var value)
                               && value.ValueKind == JsonValueKind.Array
                               && value.GetArrayLength() == 0);
    }

    private static void AddStringArray(
        JsonElement root,
        string property,
        string label,
        List<string> output)
    {
        if (!root.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var entry in value.EnumerateArray())
        {
            if (entry.ValueKind == JsonValueKind.String && entry.GetString() is { Length: > 0 } text)
            {
                output.Add($"{label}: {text}");
            }
        }
    }

    private static string? ReadString(JsonElement root, string property) =>
        root.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool HasUnsafeArchivePath(string path) =>
        path.StartsWith('/')
        || path.StartsWith('\\')
        || path.Contains("../", StringComparison.Ordinal)
        || path.Contains("..\\", StringComparison.Ordinal)
        || (path.Length >= 2 && char.IsLetter(path[0]) && path[1] == ':');

    private static bool LooksLikeDoubleExtension(string name)
    {
        var executable = new[] { ".exe", ".msi", ".scr", ".bat", ".cmd", ".ps1" };
        var document = new[] { ".pdf", ".doc", ".docx", ".txt", ".jpg", ".png" };
        return executable.Any(suffix => name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
               && document.Any(marker => name[..^Path.GetExtension(name).Length]
                   .EndsWith(marker, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsHttpSource(string? source) =>
        Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);

    private static string ScopeFor(ExternalItemKind kind) => kind switch
    {
        ExternalItemKind.WebsiteDownload => "Website or local download proposed for installation or use",
        ExternalItemKind.GitHubContent => "GitHub-sourced repository content",
        ExternalItemKind.Attachment => "File selected for prompt attachment; read as text, never executed",
        ExternalItemKind.McpServer => "MCP server proposed for review before terminal approval",
        ExternalItemKind.PluginOrExtension => "Plugin or extension proposed for installation or activation",
        ExternalItemKind.SkillOrAddon => "Skill or add-on proposed for installation or activation",
        ExternalItemKind.AiIntegration => "AI-related provider or tool integration",
        ExternalItemKind.WindowsSandboxConfiguration => "Windows Sandbox configuration proposed for launch",
        _ => "External item"
    };

    private sealed record ManifestEvidence(
        ExternalEvidenceState State,
        string Description,
        ExternalEvidenceState CapabilityState,
        IReadOnlyList<string> Capabilities);
}

/// <summary>
/// Testable coverage contract. A future install/activation path must name one of
/// these kinds and pass an <see cref="ExternalItemEvidence"/> record through the
/// shared policy before it can ask for approval.
/// </summary>
public static class ExternalItemReviewCoverage
{
    public static IReadOnlyList<ExternalItemKind> RequiredKinds { get; } =
    [
        ExternalItemKind.WebsiteDownload,
        ExternalItemKind.GitHubContent,
        ExternalItemKind.Attachment,
        ExternalItemKind.McpServer,
        ExternalItemKind.PluginOrExtension,
        ExternalItemKind.SkillOrAddon,
        ExternalItemKind.AiIntegration,
        ExternalItemKind.WindowsSandboxConfiguration
    ];

    public static ExternalItemKind ForPlusMenu(PlusMenuKind kind) => kind switch
    {
        PlusMenuKind.Upload => ExternalItemKind.Attachment,
        PlusMenuKind.Connector => ExternalItemKind.McpServer,
        PlusMenuKind.Plugin => ExternalItemKind.PluginOrExtension,
        PlusMenuKind.Skill => ExternalItemKind.SkillOrAddon,
        PlusMenuKind.Permission => ExternalItemKind.Attachment,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown external item kind.")
    };
}

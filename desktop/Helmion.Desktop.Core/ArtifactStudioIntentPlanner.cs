using System.Text;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

public sealed record ArtifactStudioIntentPlan(
    string ProviderId,
    string Kind,
    string Title,
    string Instructions,
    string DataScope,
    string DestinationFileName,
    bool ProviderSupportsKind);

/// <summary>
/// Converts the one user-authored description into the typed, auditable request
/// required by ArtifactStudioWorkflow. The provider route, title, destination,
/// scope and identifiers remain policy-owned metadata rather than form fields.
/// This planner performs no provider call and reads no project content.
/// </summary>
public static partial class ArtifactStudioIntentPlanner
{
    public const string AutoKind = "auto";
    public const string PromptOnlyDataScope =
        "User-authored description only; no project files, Canvas notes, artifacts, credentials, hidden context, or browser data.";

    public static ArtifactStudioIntentPlan Plan(
        string? description,
        string? requestedKind = AutoKind,
        DateTimeOffset? now = null)
    {
        var instructions = NormalizeDescription(description);
        var kind = ResolveKind(requestedKind, instructions);
        var provider = ArtifactStudioProviderCatalog.All.FirstOrDefault(item =>
                           item.SupportedKinds.Contains(kind, StringComparer.Ordinal))
                       ?? ArtifactStudioProviderCatalog.All.First();
        var title = CreateTitle(instructions, kind);
        var destination = CreateDestination(title, kind, now ?? DateTimeOffset.UtcNow);

        return new ArtifactStudioIntentPlan(
            provider.Id,
            kind,
            title,
            instructions,
            PromptOnlyDataScope,
            destination,
            provider.SupportedKinds.Contains(kind, StringComparer.Ordinal));
    }

    public static ArtifactStudioRequest CreateRequest(
        string projectRoot,
        string? description,
        string? requestedKind = AutoKind,
        DateTimeOffset? now = null)
    {
        var plan = Plan(description, requestedKind, now);
        return ArtifactStudioWorkflow.CreateRequest(
            projectRoot,
            plan.ProviderId,
            plan.Kind,
            plan.Title,
            plan.Instructions,
            plan.DataScope,
            plan.DestinationFileName,
            now);
    }

    private static string NormalizeDescription(string? description)
    {
        var normalized = WhitespacePattern().Replace(description?.Trim() ?? string.Empty, " ");
        if (normalized.Length == 0)
        {
            throw new ArgumentException("Describe what you want Helmian to create.", nameof(description));
        }
        if (normalized.Length > ArtifactStudioWorkflow.MaxInstructionsChars)
        {
            throw new ArgumentException(
                $"Keep the description under {ArtifactStudioWorkflow.MaxInstructionsChars:N0} characters.",
                nameof(description));
        }
        return normalized;
    }

    private static string ResolveKind(string? requestedKind, string instructions)
    {
        var requested = requestedKind?.Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(requested) && requested != AutoKind)
        {
            if (!ArtifactStudioKinds.All.Contains(requested, StringComparer.Ordinal))
            {
                throw new ArgumentException("Choose a supported output type.", nameof(requestedKind));
            }
            return requested;
        }

        if (ContainsAny(instructions, "spreadsheet", "workbook", "xlsx", "csv"))
            return ArtifactStudioKinds.Spreadsheet;
        if (ContainsAny(instructions, "slide deck", "slides", "presentation", "powerpoint", "pptx"))
            return ArtifactStudioKinds.Slides;
        if (ContainsAny(instructions, "pdf"))
            return ArtifactStudioKinds.Pdf;
        if (ContainsAny(instructions, "document", "memo", "brief", "report", "docx"))
            return ArtifactStudioKinds.Document;
        if (ContainsAny(instructions, "logo", "icon", "badge", "design asset", "svg"))
            return ArtifactStudioKinds.DesignAsset;
        return ArtifactStudioKinds.Image;
    }

    private static bool ContainsAny(string value, params string[] terms) =>
        terms.Any(term => value.Contains(term, StringComparison.OrdinalIgnoreCase));

    private static string CreateTitle(string instructions, string kind)
    {
        var sentence = instructions.Split(['.', '!', '?', '\n', '\r'], 2)[0].Trim();
        var words = sentence.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(8);
        var title = string.Join(' ', words).Trim(' ', '-', '_', ',', ':', ';');
        if (title.Length == 0)
        {
            title = $"{ArtifactStudioKinds.Label(kind)} request";
        }
        if (title.Length > 72)
        {
            title = title[..71].TrimEnd() + "…";
        }
        return title;
    }

    private static string CreateDestination(string title, string kind, DateTimeOffset now)
    {
        var slugBuilder = new StringBuilder();
        foreach (var character in title.ToLowerInvariant())
        {
            if (char.IsAsciiLetterOrDigit(character))
            {
                slugBuilder.Append(character);
            }
            else if (slugBuilder.Length > 0 && slugBuilder[^1] != '-')
            {
                slugBuilder.Append('-');
            }
            if (slugBuilder.Length >= 42) break;
        }
        var slug = slugBuilder.ToString().Trim('-');
        if (slug.Length == 0) slug = "artifact";
        var extension = kind switch
        {
            ArtifactStudioKinds.Image => ".png",
            ArtifactStudioKinds.DesignAsset => ".png",
            ArtifactStudioKinds.Pdf => ".pdf",
            ArtifactStudioKinds.Document => ".docx",
            ArtifactStudioKinds.Slides => ".pptx",
            ArtifactStudioKinds.Spreadsheet => ".xlsx",
            _ => ".bin"
        };
        return $"{now.ToUniversalTime():yyyyMMdd-HHmmss}-{slug}{extension}";
    }

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespacePattern();
}

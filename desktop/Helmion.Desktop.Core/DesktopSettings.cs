using System.Text.Json;

namespace Helmion.Desktop.Core;

public sealed record ColorThemeOption(
    string Id,
    string Name,
    string Description);

public static class ColorThemeCatalog
{
    public const string DefaultThemeId = "helmion-green";

    public static IReadOnlyList<ColorThemeOption> All { get; } =
    [
        new(
            DefaultThemeId,
            "Helmion green",
            "Deep forest surfaces with a clear mint accent."),
        new(
            "ocean-blue",
            "Ocean blue",
            "Cool navy surfaces with an accessible cyan-blue accent."),
        new(
            "clean-light",
            "Clean light",
            "Bright white surfaces with crisp evergreen contrast."),
        new(
            "warm-earth",
            "Warm earth",
            "Grounded brown surfaces with a warm sand accent."),
        new(
            "solar-yellow",
            "Solar yellow",
            "Warm charcoal surfaces with a bright golden-yellow accent."),
        new(
            "crimson-red",
            "Crimson red",
            "Dark charcoal surfaces with a vivid crimson accent.")
    ];

    public static bool IsKnown(string? id)
    {
        return All.Any(option => string.Equals(option.Id, id, StringComparison.Ordinal));
    }

    public static ColorThemeOption Get(string? id)
    {
        return All.FirstOrDefault(option =>
                string.Equals(option.Id, id, StringComparison.Ordinal))
            ?? All[0];
    }
}

/// <summary>
/// A user-defined OpenAI-compatible endpoint. <paramref name="Model"/> is optional;
/// when blank the profile name is sent as the model id (the Ollama/vLLM convention).
/// </summary>
public sealed record CustomProviderProfile(
    string Name,
    string EndpointUrl,
    string ApiKey,
    string? Model = null);

public sealed record DesktopSettings(
    int Version,
    string ColorTheme,
    string? LastWorkspacePath = null,
    IReadOnlyList<CustomProviderProfile>? CustomProviders = null,
    string? PermissionMode = null,
    /// <summary>
    /// Slugs of projects pinned to the top of the left panel.
    ///
    /// A PREFERENCE, not a registry. The project list itself is still read from
    /// disk every time — see ProjectShelf — so a pin that names a folder which has
    /// since been renamed or deleted simply never matches anything and costs
    /// nothing. That is why this can live in settings while the project list
    /// deliberately cannot.
    /// </summary>
    IReadOnlyList<string>? PinnedProjects = null)
{
    public static DesktopSettings Default { get; } =
        new(1, ColorThemeCatalog.DefaultThemeId, null, [], AgentPermission.ReadOnly, []);

    /// <summary>Normalized console permission mode (read-only | read-tools | full).</summary>
    public string ResolvedPermissionMode => AgentPermission.Normalize(PermissionMode);
}

public static class DesktopSettingsStore
{
    public static string DefaultPath =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Helmion",
            "desktop-settings.json");

    public static DesktopSettings Load(string? path = null)
    {
        var target = Path.GetFullPath(path ?? DefaultPath);
        if (!File.Exists(target))
        {
            return DesktopSettings.Default;
        }

        try
        {
            var settings = JsonSerializer.Deserialize<DesktopSettings>(
                File.ReadAllText(target));
            return settings is { Version: 1 }
                && ColorThemeCatalog.IsKnown(settings.ColorTheme)
                    ? settings
                    : DesktopSettings.Default;
        }
        catch (JsonException)
        {
            return DesktopSettings.Default;
        }
        catch (IOException)
        {
            return DesktopSettings.Default;
        }
        catch (UnauthorizedAccessException)
        {
            return DesktopSettings.Default;
        }
    }

    public static void Save(DesktopSettings settings, string? path = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (settings.Version != 1 || !ColorThemeCatalog.IsKnown(settings.ColorTheme))
        {
            throw new ArgumentException("Unsupported desktop settings", nameof(settings));
        }

        var target = Path.GetFullPath(path ?? DefaultPath);
        var parent = Path.GetDirectoryName(target)
            ?? throw new InvalidOperationException("Desktop settings path has no parent");
        Directory.CreateDirectory(parent);
        var temporary = $"{target}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(
                temporary,
                $"{JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true })}{Environment.NewLine}");
            File.Move(temporary, target, true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }
}

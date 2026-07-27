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
            "Grounded brown surfaces with a warm sand accent.")
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

public sealed record DesktopSettings(
    int Version,
    string ColorTheme,
    string? LastWorkspacePath = null)
{
    public static DesktopSettings Default { get; } =
        new(1, ColorThemeCatalog.DefaultThemeId);
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

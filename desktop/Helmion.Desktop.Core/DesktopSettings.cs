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
/// The app-wide text scale, as a multiplier applied to the entire shell.
///
/// A LADDER, NOT A FREE SLIDER. The stops are fixed so Ctrl+= and Ctrl+- land on
/// the same values every time, and so the number written to disk is always one a
/// later build still recognises.
///
/// CLAMPING IS TOTAL. Every number that reaches <see cref="Clamp"/> — a
/// hand-edited settings file, a NaN, an infinity — resolves to a value inside the
/// ladder. The failure this prevents is not cosmetic: a shell scaled to 0 renders
/// nothing at all, and a user who cannot read the screen also cannot navigate to
/// the control that would fix it.
/// </summary>
public static class TextScaleRange
{
    public const double Default = 1.0;
    public const double Min = 0.9;
    public const double Max = 2.0;

    private const double Tolerance = 0.001;

    /// <summary>The stops Ctrl+= and Ctrl+- walk through, smallest first.</summary>
    public static IReadOnlyList<double> Steps { get; } =
        [0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];

    public static double Clamp(double scale) =>
        double.IsNaN(scale) ? Default : Math.Clamp(scale, Min, Max);

    /// <summary>The next stop up, or the largest when already there.</summary>
    public static double Larger(double scale)
    {
        var current = Clamp(scale);
        foreach (var step in Steps)
        {
            if (step > current + Tolerance)
            {
                return step;
            }
        }

        return Max;
    }

    /// <summary>The next stop down, or the smallest when already there.</summary>
    public static double Smaller(double scale)
    {
        var current = Clamp(scale);
        for (var i = Steps.Count - 1; i >= 0; i--)
        {
            if (Steps[i] < current - Tolerance)
            {
                return Steps[i];
            }
        }

        return Min;
    }

    /// <summary>What the control on screen reads, e.g. "125%".</summary>
    public static string Describe(double scale) =>
        $"{Math.Round(Clamp(scale) * 100)}%";
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
    IReadOnlyList<string>? PinnedProjects = null,
    /// <summary>
    /// App-wide text scale. Last in the parameter list on purpose: a settings file
    /// written by an earlier build has no such property, and System.Text.Json fills
    /// the gap with this default rather than refusing the whole file.
    /// </summary>
    double TextScale = TextScaleRange.Default)
{
    public static DesktopSettings Default { get; } =
        new(1, ColorThemeCatalog.DefaultThemeId, null, [], AgentPermission.ReadOnly, [],
            TextScaleRange.Default);

    /// <summary>Normalized console permission mode (read-only | read-tools | full).</summary>
    public string ResolvedPermissionMode => AgentPermission.Normalize(PermissionMode);

    /// <summary>
    /// The scale actually safe to apply. Always read this, never <see cref="TextScale"/>
    /// directly — the raw value came off disk and nothing validated it there.
    /// </summary>
    public double ResolvedTextScale => TextScaleRange.Clamp(TextScale);
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

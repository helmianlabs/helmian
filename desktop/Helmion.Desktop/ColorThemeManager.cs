using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

internal static class ColorThemeManager
{
    // Midnight's primary ink is intentionally the same accent used by the
    // "Escalation rule and retention" label. Keeping one constant prevents the
    // menu/header text from drifting to a competing near-white or cyan.
    private const string MidnightPrimary = "#65D5F5";

    private sealed record Palette(
        IReadOnlyDictionary<string, string> Brushes,
        IReadOnlyDictionary<string, string> Colors);

    private static readonly IReadOnlyDictionary<string, Palette> Palettes =
        new Dictionary<string, Palette>(StringComparer.Ordinal)
        {
            ["helmion-green"] = Create(
                canvas: "#08100F", sidebar: "#0B1513", header: "#0B1412", footer: "#0A1211",
                surface: "#101B19", raised: "#152421", panel: "#101D1A", subtle: "#111C1A",
                inset: "#14231F", stroke: "#243633", text: "#F2F7F5", soft: "#C3D2CE",
                muted: "#91A5A0", faint: "#60746F", accent: "#73E6B1", accentInk: "#092019",
                accentDark: "#173E32", accentPanel: "#172925", accentStrong: "#16382F",
                accentStroke: "#31584D", accentStrokeStrong: "#356B5B", amber: "#F2C879",
                warning: "#362D1B", warningSoft: "#2A2418", warningStroke: "#554725",
                blue: "#79AFFF", avatar: "#20302D",
                heroStart: "#173F34", heroMiddle: "#122924", heroEnd: "#101B19"),
            ["ocean-blue"] = Create(
                canvas: "#07111D", sidebar: "#091725", header: "#081522", footer: "#07111A",
                surface: "#0E1D2B", raised: "#14293B", panel: "#102333", subtle: "#122635",
                inset: "#172C3D", stroke: "#274154", text: MidnightPrimary, soft: "#B9D3E0",
                muted: "#829EB0", faint: "#587184", accent: MidnightPrimary, accentInk: "#05202A",
                accentDark: "#123B4D", accentPanel: "#123247", accentStrong: "#103D51",
                accentStroke: "#2C6076", accentStrokeStrong: "#39778D", amber: "#F2C879",
                warning: "#372E1C", warningSoft: "#2B251A", warningStroke: "#5A4A29",
                blue: "#86B7FF", avatar: "#1B3447",
                heroStart: "#123E52", heroMiddle: "#102B3D", heroEnd: "#0E1D2B"),
            // Cool graphite only — no warm brown/amber accents on black (Troy: no black+brown).
            ["buzz-black"] = Create(
                canvas: "#050507", sidebar: "#0A0A0E", header: "#09090D", footer: "#08080C",
                surface: "#0E0E14", raised: "#16161F", panel: "#12121A", subtle: "#15151E",
                inset: "#1A1A24", stroke: "#2E2E3A", text: "#F2F2F6", soft: "#C4C4CE",
                muted: "#8A8A98", faint: "#5E5E6C", accent: "#8EC5FF", accentInk: "#0A121C",
                accentDark: "#1A2A3C", accentPanel: "#141C28", accentStrong: "#182432",
                accentStroke: "#3A5570", accentStrokeStrong: "#4A6A8A", amber: "#C8D0E0",
                warning: "#1E2430", warningSoft: "#161A22", warningStroke: "#3A4558",
                blue: "#8EC5FF", avatar: "#1C1C26",
                heroStart: "#1A2434", heroMiddle: "#12121A", heroEnd: "#0A0A0E"),
            ["clean-light"] = Create(
                canvas: "#F4F7F6", sidebar: "#FFFFFF", header: "#FFFFFF", footer: "#EDF2F0",
                surface: "#FFFFFF", raised: "#F1F5F3", panel: "#F7FAF9", subtle: "#EFF4F2",
                inset: "#E8F0ED", stroke: "#D1DDD9", text: "#17221F", soft: "#324A43",
                muted: "#607871", faint: "#7B8E88", accent: "#087A5B", accentInk: "#FFFFFF",
                accentDark: "#DDF3EA", accentPanel: "#E7F4EF", accentStrong: "#D8EEE6",
                accentStroke: "#9ACAB9", accentStrokeStrong: "#6FB79F", amber: "#95600B",
                warning: "#FFF3DB", warningSoft: "#FFF8EA", warningStroke: "#DFC483",
                blue: "#2F69C9", avatar: "#E3EDEA",
                heroStart: "#DDF3EA", heroMiddle: "#EDF7F3", heroEnd: "#FFFFFF"),
            // Warm brown family throughout — secondary “blue” is warm slate, not purple.
            ["warm-earth"] = Create(
                canvas: "#17100B", sidebar: "#1D140E", header: "#1B130E", footer: "#140E0A",
                surface: "#251A13", raised: "#302219", panel: "#2B1E16", subtle: "#2A1D16",
                inset: "#35251B", stroke: "#49372B", text: "#FFF7EE", soft: "#E5D2BF",
                muted: "#B59C87", faint: "#887263", accent: "#E9AD6B", accentInk: "#2A1608",
                accentDark: "#50301C", accentPanel: "#3C291C", accentStrong: "#4A2F1B",
                accentStroke: "#6D4A31", accentStrokeStrong: "#8B5E3A", amber: "#F3C96F",
                warning: "#46331E", warningSoft: "#38291A", warningStroke: "#735630",
                blue: "#A89880", avatar: "#3D2B20",
                heroStart: "#50311E", heroMiddle: "#38251A", heroEnd: "#251A13"),
            // Graphite + gold only (no cool purple secondary).
            ["solar-yellow"] = Create(
                canvas: "#141109", sidebar: "#1A160C", header: "#18140B", footer: "#12100A",
                surface: "#221C10", raised: "#2C2414", panel: "#261F12", subtle: "#241E11",
                inset: "#322914", stroke: "#4A4024", text: "#FFF9E8", soft: "#E6D9B0",
                muted: "#B8A878", faint: "#8A7D55", accent: "#F5D000", accentInk: "#2A2200",
                accentDark: "#5A4A10", accentPanel: "#3A3214", accentStrong: "#4A3E12",
                accentStroke: "#7A6A28", accentStrokeStrong: "#9A8530", amber: "#FFC94A",
                warning: "#46381C", warningSoft: "#382E16", warningStroke: "#736028",
                blue: "#C4B070", avatar: "#3A3218",
                heroStart: "#5A4A14", heroMiddle: "#3A3014", heroEnd: "#221C10"),
            // Red family only — cool steel secondary, never lavender/purple on crimson.
            ["crimson-red"] = Create(
                canvas: "#14090A", sidebar: "#1A0C0E", header: "#180B0D", footer: "#120A0B",
                surface: "#221012", raised: "#2C1418", panel: "#261214", subtle: "#241113",
                inset: "#32161A", stroke: "#4A242A", text: "#FFF0F2", soft: "#E6B8BE",
                muted: "#B87882", faint: "#8A555D", accent: "#E53945", accentInk: "#2A060A",
                accentDark: "#5A141C", accentPanel: "#3A141A", accentStrong: "#4A1218",
                accentStroke: "#7A2834", accentStrokeStrong: "#9A3040", amber: "#E8A070",
                warning: "#46301C", warningSoft: "#382616", warningStroke: "#735028",
                blue: "#8A7078", avatar: "#3A181C",
                heroStart: "#5A1820", heroMiddle: "#3A1418", heroEnd: "#221012")
        };

    public static void Apply(string? themeId)
    {
        var selected = ColorThemeCatalog.Get(themeId);
        var palette = Palettes[selected.Id];
        var resources = Application.Current.Resources;

        foreach (var (key, value) in palette.Brushes)
        {
            var color = (Color)ColorConverter.ConvertFromString(value);
            if (resources[key] is SolidColorBrush { IsFrozen: false } brush)
            {
                brush.Color = color;
            }
            else
            {
                resources[key] = new SolidColorBrush(color);
            }
        }

        foreach (var (key, value) in palette.Colors)
        {
            resources[key] = (Color)ColorConverter.ConvertFromString(value);
        }

        // Glass body is tinted from this theme's surface/raised/canvas — never a fixed
        // cool blue-black that reads as purple on crimson or brown-clash on black.
        var surface = palette.Brushes["SurfaceBrush"];
        var raised = palette.Brushes["SurfaceRaisedBrush"];
        var canvas = palette.Brushes["CanvasBrush"];
        ApplyGlassShine(
            resources,
            isLight: string.Equals(selected.Id, "clean-light", StringComparison.Ordinal),
            surface,
            raised,
            canvas);
    }

    /// <summary>
    /// Frosted glass with a bright top edge (specular) fading into body tint
    /// sampled from the active theme (color-matched, not a universal cool gray).
    /// </summary>
    private static void ApplyGlassShine(
        ResourceDictionary resources,
        bool isLight,
        string surfaceHex,
        string raisedHex,
        string canvasHex)
    {
        if (isLight)
        {
            resources["GlassPanelBrush"] = VerticalGlass(
                ("#55FFFFFF", 0),
                (WithAlpha(surfaceHex, 0xDC), 0.1),
                (WithAlpha(surfaceHex, 0xE6), 0.55),
                (WithAlpha(canvasHex, 0xF0), 1));
            resources["GlassRaisedBrush"] = VerticalGlass(
                ("#66FFFFFF", 0),
                (WithAlpha(raisedHex, 0xF0), 0.08),
                (WithAlpha(surfaceHex, 0xE8), 0.5),
                (WithAlpha(canvasHex, 0xDC), 1));
            resources["GlassStrokeBrush"] = SolidGlass("#66A0B0AA");
            resources["GlassHoverBrush"] = SolidGlass("#33FFFFFF");
            resources["GlassInsetBrush"] = VerticalGlass(
                ("#14000000", 0),
                (WithAlpha(surfaceHex, 0x14), 0.25),
                (WithAlpha(canvasHex, 0x28), 1));
            resources["GlassShineBrush"] = DiagonalGlass(
                ("#44FFFFFF", 0),
                ("#18FFFFFF", 0.4),
                ("#00FFFFFF", 1));
            return;
        }

        // Soft rim light + theme-tinted body (matches brown / red / green / graphite).
        resources["GlassPanelBrush"] = VerticalGlass(
            ("#38FFFFFF", 0),
            (WithAlpha(surfaceHex, 0x99), 0.08),
            (WithAlpha(surfaceHex, 0xAA), 0.55),
            (WithAlpha(canvasHex, 0xBB), 1));
        resources["GlassRaisedBrush"] = VerticalGlass(
            ("#48FFFFFF", 0),
            (WithAlpha(raisedHex, 0xB3), 0.07),
            (WithAlpha(surfaceHex, 0xC2), 0.5),
            (WithAlpha(canvasHex, 0xD0), 1));
        resources["GlassStrokeBrush"] = SolidGlass("#44FFFFFF");
        resources["GlassHoverBrush"] = SolidGlass("#28FFFFFF");
        resources["GlassInsetBrush"] = VerticalGlass(
            ("#22000000", 0),
            (WithAlpha(canvasHex, 0x88), 0.2),
            (WithAlpha(canvasHex, 0xAA), 1));
        resources["GlassShineBrush"] = DiagonalGlass(
            ("#33FFFFFF", 0),
            ("#10FFFFFF", 0.45),
            ("#00FFFFFF", 1));
    }

    /// <summary>Replace alpha on a #RRGGBB (or #AARRGGBB) hex with the given byte.</summary>
    private static string WithAlpha(string hex, byte alpha)
    {
        var c = (Color)ColorConverter.ConvertFromString(hex);
        return $"#{alpha:X2}{c.R:X2}{c.G:X2}{c.B:X2}";
    }

    private static SolidColorBrush SolidGlass(string hex)
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        return brush;
    }

    private static LinearGradientBrush VerticalGlass(params (string hex, double offset)[] stops)
    {
        var brush = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(0, 1)
        };
        foreach (var (hex, offset) in stops)
        {
            brush.GradientStops.Add(new GradientStop(
                (Color)ColorConverter.ConvertFromString(hex),
                offset));
        }
        brush.Freeze();
        return brush;
    }

    private static LinearGradientBrush DiagonalGlass(params (string hex, double offset)[] stops)
    {
        var brush = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(1, 1)
        };
        foreach (var (hex, offset) in stops)
        {
            brush.GradientStops.Add(new GradientStop(
                (Color)ColorConverter.ConvertFromString(hex),
                offset));
        }
        brush.Freeze();
        return brush;
    }

    private static Palette Create(
        string canvas, string sidebar, string header, string footer,
        string surface, string raised, string panel, string subtle, string inset,
        string stroke, string text, string soft, string muted, string faint,
        string accent, string accentInk, string accentDark, string accentPanel,
        string accentStrong, string accentStroke, string accentStrokeStrong,
        string amber, string warning, string warningSoft, string warningStroke,
        string blue, string avatar, string heroStart, string heroMiddle, string heroEnd)
    {
        return new Palette(
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["CanvasBrush"] = canvas,
                ["SidebarBrush"] = sidebar,
                ["HeaderBrush"] = header,
                ["FooterBrush"] = footer,
                ["SurfaceBrush"] = surface,
                ["SurfaceRaisedBrush"] = raised,
                ["PanelBrush"] = panel,
                ["PanelSubtleBrush"] = subtle,
                ["PanelInsetBrush"] = inset,
                ["StrokeBrush"] = stroke,
                // Glass fills are gradient shine brushes applied in ApplyGlassShine —
                // not solid hex here (would kill the specular top edge).
                ["TextBrush"] = text,
                ["SoftTextBrush"] = soft,
                ["MutedTextBrush"] = muted,
                ["FaintTextBrush"] = faint,
                ["AccentBrush"] = accent,
                ["AccentInkBrush"] = accentInk,
                ["AccentDarkBrush"] = accentDark,
                ["AccentPanelBrush"] = accentPanel,
                ["AccentStrongBrush"] = accentStrong,
                ["AccentStrokeBrush"] = accentStroke,
                ["AccentStrokeStrongBrush"] = accentStrokeStrong,
                ["AmberBrush"] = amber,
                ["WarningPanelBrush"] = warning,
                ["WarningSoftBrush"] = warningSoft,
                ["WarningStrokeBrush"] = warningStroke,
                ["BlueBrush"] = blue,
                ["AvatarBrush"] = avatar
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["HeroStartColor"] = heroStart,
                ["HeroMiddleColor"] = heroMiddle,
                ["HeroEndColor"] = heroEnd
            });
    }
}

using System.Windows;
using System.Windows.Media;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

internal static class ColorThemeManager
{
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
                inset: "#172C3D", stroke: "#274154", text: "#F3F8FC", soft: "#C5D7E4",
                muted: "#91A9BA", faint: "#61798B", accent: "#65D5F5", accentInk: "#05202A",
                accentDark: "#123B4D", accentPanel: "#123247", accentStrong: "#103D51",
                accentStroke: "#2C6076", accentStrokeStrong: "#39778D", amber: "#F2C879",
                warning: "#372E1C", warningSoft: "#2B251A", warningStroke: "#5A4A29",
                blue: "#86B7FF", avatar: "#1B3447",
                heroStart: "#123E52", heroMiddle: "#102B3D", heroEnd: "#0E1D2B"),
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
            ["warm-earth"] = Create(
                canvas: "#17100B", sidebar: "#1D140E", header: "#1B130E", footer: "#140E0A",
                surface: "#251A13", raised: "#302219", panel: "#2B1E16", subtle: "#2A1D16",
                inset: "#35251B", stroke: "#49372B", text: "#FFF7EE", soft: "#E5D2BF",
                muted: "#B59C87", faint: "#887263", accent: "#E9AD6B", accentInk: "#2A1608",
                accentDark: "#50301C", accentPanel: "#3C291C", accentStrong: "#4A2F1B",
                accentStroke: "#6D4A31", accentStrokeStrong: "#8B5E3A", amber: "#F3C96F",
                warning: "#46331E", warningSoft: "#38291A", warningStroke: "#735630",
                blue: "#91B9E8", avatar: "#3D2B20",
                heroStart: "#50311E", heroMiddle: "#38251A", heroEnd: "#251A13"),
            ["solar-yellow"] = Create(
                canvas: "#141109", sidebar: "#1A160C", header: "#18140B", footer: "#12100A",
                surface: "#221C10", raised: "#2C2414", panel: "#261F12", subtle: "#241E11",
                inset: "#322914", stroke: "#4A4024", text: "#FFF9E8", soft: "#E6D9B0",
                muted: "#B8A878", faint: "#8A7D55", accent: "#F5D000", accentInk: "#2A2200",
                accentDark: "#5A4A10", accentPanel: "#3A3214", accentStrong: "#4A3E12",
                accentStroke: "#7A6A28", accentStrokeStrong: "#9A8530", amber: "#FFC94A",
                warning: "#46381C", warningSoft: "#382E16", warningStroke: "#736028",
                blue: "#8BB8F0", avatar: "#3A3218",
                heroStart: "#5A4A14", heroMiddle: "#3A3014", heroEnd: "#221C10"),
            ["crimson-red"] = Create(
                canvas: "#14090A", sidebar: "#1A0C0E", header: "#180B0D", footer: "#120A0B",
                surface: "#221012", raised: "#2C1418", panel: "#261214", subtle: "#241113",
                inset: "#32161A", stroke: "#4A242A", text: "#FFF0F2", soft: "#E6B8BE",
                muted: "#B87882", faint: "#8A555D", accent: "#E53945", accentInk: "#2A060A",
                accentDark: "#5A141C", accentPanel: "#3A141A", accentStrong: "#4A1218",
                accentStroke: "#7A2834", accentStrokeStrong: "#9A3040", amber: "#FFB34A",
                warning: "#46301C", warningSoft: "#382616", warningStroke: "#735028",
                blue: "#8BB0F0", avatar: "#3A181C",
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

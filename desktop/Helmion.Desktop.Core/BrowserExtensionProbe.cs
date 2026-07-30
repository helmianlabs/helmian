using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>What was found about the browser guard, and where.</summary>
public sealed record BrowserExtensionState(
    GuardLevel Level,
    string Title,
    string Detail,
    bool Installed,
    bool Enabled,
    string? ProfilePath);

/// <summary>
/// Answers "is the browser guard installed and switched on" by reading Chrome's
/// own record of it.
///
/// WHY THIS IS AS FAR AS IT GOES, STATED UP FRONT. The extension deliberately has
/// no network access and no filesystem access — extension/test/package.test.mjs
/// fails the build if it ever reaches the network. That is a feature, and it
/// means there is no channel from Chrome back to this window. So this CANNOT
/// report "the guard is watching that tab right now".
///
/// What it CAN report as fact: Chrome writes every loaded extension into its
/// profile Preferences file, including unpacked ones, with the folder it was
/// loaded from and whether it is enabled. Reading that turns three genuinely
/// different states into facts —
///
///   loaded and enabled   -> the guard will run on the matched sites
///   loaded but disabled  -> it is installed and switched OFF, which is worth
///                           knowing and is NOT the same as absent
///   not loaded           -> it is not installed in any profile found
///
/// and leaves Unknown for the one case that really is unknown: no Chrome profile
/// could be read at all.
///
/// The card's wording says "installed and enabled", never "watching". Reporting
/// more certainty than the method supports is how a status panel starts lying,
/// and this panel's whole value is that it does not.
/// </summary>
public static class BrowserExtensionProbe
{
    /// <summary>Chromium-family user-data roots, in the order they are tried.</summary>
    public static IReadOnlyList<string> DefaultUserDataRoots()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return
        [
            Path.Combine(local, "Google", "Chrome", "User Data"),
            Path.Combine(local, "Microsoft", "Edge", "User Data"),
            Path.Combine(local, "BraveSoftware", "Brave-Browser", "User Data"),
            Path.Combine(local, "Chromium", "User Data"),
        ];
    }

    /// <summary>
    /// Looks for an unpacked extension loaded from <paramref name="extensionDirectory"/>.
    /// </summary>
    public static BrowserExtensionState Inspect(
        string extensionDirectory,
        IReadOnlyList<string>? userDataRoots = null)
    {
        var target = Normalize(extensionDirectory);
        if (target.Length == 0)
        {
            return new BrowserExtensionState(
                GuardLevel.Unknown,
                "Browser guard location not known",
                "No extension folder was given, so Chrome's records could not be searched. "
                + "Could not compute — not an all-clear.",
                false, false, null);
        }

        var roots = userDataRoots ?? DefaultUserDataRoots();
        var profilesRead = 0;
        var found = false;
        var enabled = false;
        string? where = null;

        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;

            foreach (var preferences in PreferenceFiles(root))
            {
                profilesRead += 1;
                var hit = FindInPreferences(preferences, target);
                if (hit is null) continue;

                found = true;
                where = preferences;
                if (hit.Value) { enabled = true; break; }
            }

            if (enabled) break;
        }

        if (profilesRead == 0)
        {
            return new BrowserExtensionState(
                GuardLevel.Unknown,
                "Browser layer could not be checked",
                "No Chrome, Edge, Brave or Chromium profile could be read on this machine, so "
                + "whether the browser guard is installed cannot be determined. This is a "
                + "could-not-compute, not an all-clear.",
                false, false, null);
        }

        if (!found)
        {
            return new BrowserExtensionState(
                GuardLevel.Warning,
                "Browser guard is NOT installed",
                $"{profilesRead} browser profile(s) were read and none has an extension loaded from "
                + $"{extensionDirectory}. Nothing is checking AI chat replies in the browser. "
                + "Load it: chrome://extensions → Developer mode → Load unpacked.",
                false, false, null);
        }

        if (!enabled)
        {
            return new BrowserExtensionState(
                GuardLevel.Warning,
                "Browser guard is installed but SWITCHED OFF",
                $"Chrome has it loaded from {extensionDirectory} and it is disabled. That is not "
                + "the same as missing — turn it back on at chrome://extensions.",
                true, false, where);
        }

        return new BrowserExtensionState(
            GuardLevel.Normal,
            "Browser guard is installed and enabled",
            $"Loaded from {extensionDirectory} and enabled in Chrome's own profile record. "
            + "It runs on claude.ai, chatgpt.com, gemini.google.com and grok.com. "
            + "This says it is installed and switched on — the extension has no channel back to "
            + "this window, so it cannot say a specific tab is being watched right now.",
            true, true, where);
    }

    /// <summary>Every Preferences file under a user-data root, default profile first.</summary>
    private static IEnumerable<string> PreferenceFiles(string root)
    {
        var names = new List<string>();
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(root))
            {
                var leaf = Path.GetFileName(dir);
                if (leaf is null) continue;
                if (!leaf.Equals("Default", StringComparison.OrdinalIgnoreCase)
                    && !leaf.StartsWith("Profile", StringComparison.OrdinalIgnoreCase)) continue;

                var preferences = Path.Combine(dir, "Preferences");
                if (File.Exists(preferences)) names.Add(preferences);
            }
        }
        catch (Exception)
        {
            // An unreadable user-data root contributes nothing rather than throwing.
        }

        return names.OrderByDescending(p => p.Contains("Default", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// True/false = found, and whether enabled. Null = not in this profile.
    ///
    /// Chrome's Preferences is a large JSON document; extensions live under
    /// extensions.settings keyed by id, each with a `path` and a `state`
    /// (1 = enabled). For an unpacked extension `path` is the absolute folder it
    /// was loaded from, which is what makes this identifiable at all.
    /// </summary>
    internal static bool? FindInPreferences(string preferencesPath, string normalizedTarget)
    {
        try
        {
            using var stream = File.Open(preferencesPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var document = JsonDocument.Parse(stream);

            if (!document.RootElement.TryGetProperty("extensions", out var extensions)) return null;
            if (!extensions.TryGetProperty("settings", out var settings)) return null;
            if (settings.ValueKind != JsonValueKind.Object) return null;

            foreach (var entry in settings.EnumerateObject())
            {
                if (entry.Value.ValueKind != JsonValueKind.Object) continue;
                if (!entry.Value.TryGetProperty("path", out var pathValue)) continue;
                var path = Normalize(pathValue.GetString());
                if (path.Length == 0 || path != normalizedTarget) continue;

                var enabled = entry.Value.TryGetProperty("state", out var state)
                    && state.ValueKind == JsonValueKind.Number
                    && state.GetInt32() == 1;
                return enabled;
            }

            return null;
        }
        catch (Exception)
        {
            // A locked or malformed Preferences file is skipped, not fatal. Chrome
            // holds this file open while running, which is why it is opened with
            // FileShare.ReadWrite above.
            return null;
        }
    }

    /// <summary>Case- and separator-insensitive, trailing slash removed.</summary>
    internal static string Normalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return string.Empty;
        try
        {
            return Path.GetFullPath(path.Trim())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .Replace('/', '\\')
                .ToLowerInvariant();
        }
        catch (Exception)
        {
            return path.Trim().TrimEnd('\\', '/').Replace('/', '\\').ToLowerInvariant();
        }
    }
}

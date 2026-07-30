using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Whether Chrome's own record says the extension is switched on.
///
/// THREE VALUES, NOT A BOOL, and that is the whole point of this type. A bool
/// forces "we could not tell" to be spelled the same as "it is switched off",
/// and those are different facts that deserve different words on the card.
/// </summary>
public enum BrowserExtensionEnablement
{
    /// <summary>No key in the profile record answers the question.</summary>
    NotRecorded = 0,

    /// <summary>Chrome affirmatively records it as on.</summary>
    Enabled = 1,

    /// <summary>Chrome affirmatively records it as off.</summary>
    Disabled = 2,
}

/// <summary>What was found about the browser guard, and where.</summary>
/// <param name="RecordFile">
/// Which of Chrome's two preference files the record was actually read from, e.g.
/// "Secure Preferences". Null when nothing was found. This is surfaced on the card
/// because WHICH FILE ANSWERED is the difference between a store install and a
/// developer-mode one, and a probe that read the wrong file for months looked
/// exactly as confident as one that read the right one.
/// </param>
public sealed record BrowserExtensionState(
    GuardLevel Level,
    string Title,
    string Detail,
    bool Installed,
    BrowserExtensionEnablement Enablement,
    string? ProfilePath,
    string? RecordFile = null)
{
    /// <summary>
    /// Convenience for the common question. NOTE THE ASYMMETRY: false means "not
    /// affirmatively enabled", which covers both Disabled and NotRecorded. Anything
    /// that must tell those apart has to read <see cref="Enablement"/>.
    /// </summary>
    public bool Enabled => Enablement == BrowserExtensionEnablement.Enabled;
}

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
/// ── TWO FILES, NOT ONE. THIS IS THE BUG THAT WAS HERE FOR MONTHS. ──
///
/// Chromium splits its extension records across two files in the same profile
/// folder, and which one holds a given extension depends on how it was installed:
///
///   Preferences         — the plain file. Store installs.
///   Secure Preferences  — MAC-protected. This is where UNPACKED, developer-mode
///                         extensions land.
///
/// This probe read only Preferences. Measured on the author's machine
/// 2026-07-30, Chrome 150.0.7871.100, profile "Default": the `extensions.settings`
/// key IS ABSENT ENTIRELY from Preferences, and present in Secure Preferences with
/// 24 records — including this one, `"path":"E:\\Helmion\\extension"`. So the
/// extension was correctly loaded, and the card said CRITICAL with total
/// confidence. It worked for the install path nobody here uses and failed for the
/// one everybody developing this uses. Both files are read now, and a hit in
/// either counts.
///
/// ── AND `state` IS NOT WRITTEN ANY MORE. ──
///
/// The old code decided enabled-ness with `state == 1`. In that same measurement
/// `state` was absent from ALL 24 records — Chrome does not write it. Fixing only
/// the filename would therefore have reported "installed but SWITCHED OFF" for a
/// correctly enabled extension: a new false red replacing the old one.
///
/// Chrome 150 records it in `disable_reasons`, a JSON array. Raw bytes from that
/// file, and note the positive control — one known-off extension in the same file
/// is what makes the empty array meaningful rather than merely blank:
///
///     this extension:  "disable_reasons":[]     → no reason to disable it
///     Adblock Plus:    "disable_reasons":[1]    → a reason is recorded
///
/// So an EMPTY array is a present, affirmative value, not a missing one, and it is
/// read as enabled. When NEITHER key exists the answer is NotRecorded and the card
/// says so in words rather than guessing — a missing value is never defaulted to
/// enabled, because "we did not find a reason to worry" is not evidence of health.
///
/// What this can report as fact:
///
///   loaded, recorded on    -> the guard will run on the matched sites
///   loaded, recorded off   -> installed and switched OFF, which is worth knowing
///                             and is NOT the same as absent
///   loaded, not recorded   -> installed; whether it is on is genuinely unknown
///   not loaded             -> not installed in any profile found
///
/// and leaves Unknown for the case that really is unknown: no profile readable.
///
/// The card's wording says "installed and enabled", never "watching". Reporting
/// more certainty than the method supports is how a status panel starts lying,
/// and this panel's whole value is that it does not.
/// </summary>
public static class BrowserExtensionProbe
{
    /// <summary>
    /// The two files Chromium keeps extension records in, most likely first.
    ///
    /// Secure Preferences leads because this product's own extension is loaded
    /// unpacked, so that is where it lives — but both are always read.
    /// </summary>
    public static IReadOnlyList<string> PreferenceFileNames { get; } =
        ["Secure Preferences", "Preferences"];

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
                false, BrowserExtensionEnablement.NotRecorded, null);
        }

        var roots = userDataRoots ?? DefaultUserDataRoots();
        var profilesRead = 0;
        var filesRead = 0;
        Hit? best = null;

        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;

            foreach (var profileDirectory in ProfileDirectories(root))
            {
                var readAnyFileHere = false;

                foreach (var fileName in PreferenceFileNames)
                {
                    var file = Path.Combine(profileDirectory, fileName);
                    if (!File.Exists(file)) continue;

                    readAnyFileHere = true;
                    filesRead += 1;

                    var enablement = FindInPreferences(file, target);
                    if (enablement is null) continue;

                    var hit = new Hit(enablement.Value, profileDirectory, fileName);

                    // A definite answer beats an indefinite one, and ENABLED beats
                    // DISABLED: the guard genuinely is running if any profile has it
                    // on, and the card names which profile so that is checkable.
                    if (best is null || Preference(hit.Enablement) > Preference(best.Enablement))
                    {
                        best = hit;
                    }
                }

                if (readAnyFileHere) profilesRead += 1;
            }
        }

        if (profilesRead == 0 || filesRead == 0)
        {
            return new BrowserExtensionState(
                GuardLevel.Unknown,
                "Browser layer could not be checked",
                "No Chrome, Edge, Brave or Chromium profile could be read on this machine, so "
                + "whether the browser guard is installed cannot be determined. This is a "
                + "could-not-compute, not an all-clear.",
                false, BrowserExtensionEnablement.NotRecorded, null);
        }

        if (best is null)
        {
            return new BrowserExtensionState(
                GuardLevel.Warning,
                "Browser guard is NOT installed",
                $"{profilesRead} browser profile(s) were read — both the Preferences and the "
                + $"Secure Preferences file in each, {filesRead} file(s) in total — and none has an "
                + $"extension loaded from {extensionDirectory}. Nothing is checking AI chat replies "
                + "in the browser. Load it: chrome://extensions → Developer mode → Load unpacked.",
                false, BrowserExtensionEnablement.NotRecorded, null);
        }

        return best.Enablement switch
        {
            BrowserExtensionEnablement.Enabled => new BrowserExtensionState(
                GuardLevel.Normal,
                "Browser guard is installed and enabled",
                $"Loaded from {extensionDirectory} and recorded as enabled in Chrome's own "
                + $"\"{best.RecordFile}\" file for profile {Path.GetFileName(best.ProfileDirectory)}. "
                + "It runs on claude.ai, chatgpt.com, gemini.google.com and grok.com. "
                + "This says it is installed and switched on — the extension has no channel back to "
                + "this window, so it cannot say a specific tab is being watched right now.",
                true, BrowserExtensionEnablement.Enabled, best.ProfileDirectory, best.RecordFile),

            BrowserExtensionEnablement.Disabled => new BrowserExtensionState(
                GuardLevel.Warning,
                "Browser guard is installed but SWITCHED OFF",
                $"Chrome has it loaded from {extensionDirectory} and its \"{best.RecordFile}\" file "
                + $"for profile {Path.GetFileName(best.ProfileDirectory)} records it as disabled. "
                + "That is not the same as missing — turn it back on at chrome://extensions.",
                true, BrowserExtensionEnablement.Disabled, best.ProfileDirectory, best.RecordFile),

            // Installed, but the profile record contains neither of the two keys that
            // answer "is it on". Deliberately NOT reported as enabled: this panel does
            // not convert an absent value into good news. Unknown rather than Warning
            // because nothing here is known to be wrong — only unknown — and GuardFeed
            // already ranks Unknown above OK so it cannot render as an all-clear.
            _ => new BrowserExtensionState(
                GuardLevel.Unknown,
                "Browser guard is installed; whether it is ON is not recorded",
                $"Chrome has it loaded from {extensionDirectory}, recorded in its "
                + $"\"{best.RecordFile}\" file for profile {Path.GetFileName(best.ProfileDirectory)}. "
                + "Whether it is enabled is NOT recorded in that profile — neither the "
                + "\"disable_reasons\" nor the \"state\" key is present — so this cannot say. "
                + "It is installed; check the switch at chrome://extensions. "
                + "Could not compute — not an all-clear.",
                true, BrowserExtensionEnablement.NotRecorded, best.ProfileDirectory, best.RecordFile),
        };
    }

    /// <summary>Which answer wins when profiles disagree. Higher is more authoritative.</summary>
    private static int Preference(BrowserExtensionEnablement enablement) => enablement switch
    {
        BrowserExtensionEnablement.Enabled => 3,
        BrowserExtensionEnablement.Disabled => 2,
        _ => 1,
    };

    private sealed record Hit(
        BrowserExtensionEnablement Enablement,
        string ProfileDirectory,
        string RecordFile);

    /// <summary>Every profile directory under a user-data root, default profile first.</summary>
    private static IEnumerable<string> ProfileDirectories(string root)
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

                names.Add(dir);
            }
        }
        catch (Exception)
        {
            // An unreadable user-data root contributes nothing rather than throwing.
        }

        return names.OrderByDescending(p => p.EndsWith("Default", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The enablement recorded for our extension in one preference file, or null
    /// when this file has no record of it.
    ///
    /// Chrome's preference files are large JSON documents; extensions live under
    /// extensions.settings keyed by id, each with a `path`. For an unpacked
    /// extension `path` is the absolute folder it was loaded from, which is what
    /// makes this identifiable at all.
    /// </summary>
    internal static BrowserExtensionEnablement? FindInPreferences(
        string preferencesPath,
        string normalizedTarget)
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

                return ReadEnablement(entry.Value);
            }

            return null;
        }
        catch (Exception)
        {
            // A locked or malformed preferences file is skipped, not fatal. Chrome
            // holds these files open while running, which is why they are opened
            // with FileShare.ReadWrite above.
            return null;
        }
    }

    /// <summary>
    /// Reads enabled-ness out of one extension record, newest convention first.
    ///
    /// DISABLED WINS OVER ENABLED when both keys are present and disagree, because
    /// between "something recorded a reason to disable this" and "an older field
    /// says it is on", the safe reading for a security panel is the pessimistic one.
    /// </summary>
    internal static BrowserExtensionEnablement ReadEnablement(JsonElement record)
    {
        var sawAnswer = false;

        // Current Chrome (measured on 150.x): a JSON array. Empty means no reason
        // to disable it is recorded, which is an affirmative "on".
        if (record.TryGetProperty("disable_reasons", out var reasons))
        {
            switch (reasons.ValueKind)
            {
                case JsonValueKind.Array:
                    if (reasons.GetArrayLength() > 0) return BrowserExtensionEnablement.Disabled;
                    sawAnswer = true;
                    break;

                // Older builds wrote the same information as an integer bitmask.
                case JsonValueKind.Number:
                    if (reasons.TryGetInt64(out var mask))
                    {
                        if (mask != 0) return BrowserExtensionEnablement.Disabled;
                        sawAnswer = true;
                    }

                    break;
            }
        }

        // Legacy Chrome. Extension::State — 0 disabled, 1 enabled, 2 external
        // uninstalled. Only 1 is treated as on; anything else present is not-on.
        if (record.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.Number)
        {
            if (!state.TryGetInt32(out var value) || value != 1) return BrowserExtensionEnablement.Disabled;
            sawAnswer = true;
        }

        return sawAnswer
            ? BrowserExtensionEnablement.Enabled
            : BrowserExtensionEnablement.NotRecorded;
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

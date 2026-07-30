using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>One parsed line of the block ledger.</summary>
public sealed record GuardAuditEntry(
    DateTimeOffset? Timestamp,
    string Layer,
    string MatchedPattern,
    string Text,
    string Source,
    string Outcome,
    bool Redacted,
    int? LineNumber);

/// <summary>
/// The result of one read. <see cref="Malformed"/> and <see cref="UnreadableFiles"/>
/// are reported rather than folded into zero, for the same reason
/// <c>inspectLease</c> reports UNREADABLE instead of NONE: "I cannot tell" is not
/// "nothing happened" (src/core/audit-log.mjs:221-224).
/// </summary>
public sealed record GuardAuditRead(
    string Directory,
    IReadOnlyList<string> Files,
    IReadOnlyList<GuardAuditEntry> Entries,
    int Malformed,
    IReadOnlyList<string> UnreadableFiles,
    bool DirectoryExists,
    string? DirectoryError);

/// <summary>
/// Reads the block ledger that <c>src/core/audit-log.mjs</c> writes:
/// <c>&lt;workspace&gt;\.helmion\audit\blocks-YYYY-MM-DD.jsonl</c>, one JSON object
/// per line, from the two detection layers Helmion actually has —
/// <c>browser</c> (the extension's pattern match, extension/background/scan.js:156)
/// and <c>execution</c> (the governance gate, src/core/governance-gate.mjs:226).
///
/// This is the whole reason the side panel can be a dashboard rather than a
/// decoration: every card it shows for those two layers came out of this file. It
/// invents nothing, and where the file cannot be read it says UNREADABLE rather
/// than showing an empty, reassuring list.
/// </summary>
public static partial class GuardAuditLog
{
    /// <summary>Mirrors <c>AUDIT_DIR</c> in src/core/audit-log.mjs:42.</summary>
    public const string AuditRelativeDirectory = @".helmion\audit";

    /// <summary>
    /// Written when the ledger folder is first created, so an empty ledger can
    /// say WHEN it started recording. Without it, "no blocks" and "nobody was
    /// recording" look identical, which is the ambiguity that made this card
    /// report Unknown in the first place.
    /// </summary>
    public const string LedgerMarkerFile = "ledger-started.json";

    /// <summary>
    /// Creates the ledger folder if it is absent, and stamps when it began.
    ///
    /// Idempotent: an existing ledger is never touched, and an existing marker is
    /// never rewritten — overwriting the start date would erase the one fact the
    /// marker exists to carry. Returns false when the folder could not be made,
    /// so the caller reports it rather than assuming success.
    /// </summary>
    public static bool EnsureLedger(string workspacePath)
    {
        if (string.IsNullOrWhiteSpace(workspacePath)) return false;

        try
        {
            var directory = DirectoryFor(workspacePath);
            var existed = System.IO.Directory.Exists(directory);
            System.IO.Directory.CreateDirectory(directory);

            var marker = Path.Combine(directory, LedgerMarkerFile);
            if (!existed && !File.Exists(marker))
            {
                // Serialized, not hand-built. The first version of this line
                // concatenated an interpolated string with a plain one, so the
                // trailing "}}" was escaped in the first half and taken literally
                // in the second — the marker shipped with an extra closing brace
                // and every read of it threw. Caught by the smoke suite, not by
                // reading it back.
                File.WriteAllText(marker, System.Text.Json.JsonSerializer.Serialize(new
                {
                    startedAt = DateTimeOffset.UtcNow.ToString("O"),
                    note = "Block ledger created by Helmion. An empty ledger from this date forward "
                        + "means nothing was blocked, not that nobody was watching.",
                }));
            }

            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>When the ledger began recording, or null if that is not knowable.</summary>
    public static DateTimeOffset? LedgerStartedAt(string auditDirectory)
    {
        // The marker is the best answer. Its own try/catch, NOT a shared one:
        // an earlier version wrapped both attempts together, so a malformed
        // marker threw straight past the directory fallback and returned null —
        // a working ledger reporting that it did not know when it started.
        // A failing better answer must fall back to the worse one, not to none.
        try
        {
            var marker = Path.Combine(auditDirectory, LedgerMarkerFile);
            if (File.Exists(marker))
            {
                using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(marker));
                if (document.RootElement.TryGetProperty("startedAt", out var value)
                    && DateTimeOffset.TryParse(value.GetString(), out var parsed))
                {
                    return parsed;
                }
            }
        }
        catch (Exception)
        {
            // Unreadable or malformed marker. Fall through to the folder date.
        }

        // No usable marker (an older ledger, or a corrupt one): the folder's own
        // creation time is the next best fact, and it is still a fact.
        try
        {
            if (System.IO.Directory.Exists(auditDirectory))
            {
                return new DirectoryInfo(auditDirectory).CreationTimeUtc;
            }
        }
        catch (Exception)
        {
            // Genuinely unknowable now.
        }

        return null;
    }

    public const string LayerBrowser = "browser";
    public const string LayerExecution = "execution";

    public static string DirectoryFor(string workspacePath) =>
        Path.Combine(workspacePath, ".helmion", "audit");

    public static GuardAuditRead Read(string workspacePath, int maxEntries = 500)
    {
        var directory = DirectoryFor(workspacePath);
        if (!System.IO.Directory.Exists(directory))
        {
            return new GuardAuditRead(directory, [], [], 0, [], false, null);
        }

        string[] files;
        try
        {
            files = System.IO.Directory
                .EnumerateFiles(directory, "blocks-*.jsonl", SearchOption.TopDirectoryOnly)
                .Where(path => LedgerName().IsMatch(Path.GetFileName(path)))
                .OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal)
                .ToArray();
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException)
        {
            return new GuardAuditRead(directory, [], [], 0, [], true, error.Message);
        }

        var entries = new List<GuardAuditEntry>();
        var unreadable = new List<string>();
        var malformed = 0;

        foreach (var file in files)
        {
            string[] lines;
            try
            {
                lines = File.ReadAllLines(file);
            }
            catch (Exception error) when (
                error is IOException or UnauthorizedAccessException)
            {
                unreadable.Add($"{Path.GetFileName(file)} ({error.Message})");
                continue;
            }

            for (var index = 0; index < lines.Length; index++)
            {
                var line = lines[index];
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                var parsed = TryParse(line);
                if (parsed is null)
                {
                    malformed++;
                    continue;
                }

                entries.Add(parsed);
            }
        }

        var ordered = entries
            .OrderByDescending(entry => entry.Timestamp ?? DateTimeOffset.MinValue)
            .Take(maxEntries)
            .ToList();

        return new GuardAuditRead(directory, files, ordered, malformed, unreadable, true, null);
    }

    /// <summary>
    /// Turn ledger entries into feed observations. The mapping is deliberately dull:
    /// a <c>blocked</c> outcome is critical because something destructive was
    /// actually stopped, a warning outcome is yellow, and <b>an outcome this code
    /// does not recognise is Unknown, not Normal</b> — an unclassifiable safety
    /// event must never render as reassuring.
    /// </summary>
    public static IReadOnlyList<GuardObservation> ToObservations(GuardAuditRead read)
    {
        ArgumentNullException.ThrowIfNull(read);
        var observations = new List<GuardObservation>();

        foreach (var entry in read.Entries.OrderBy(entry => entry.Timestamp ?? DateTimeOffset.MinValue))
        {
            var level = LevelFor(entry.Outcome);
            var pattern = string.IsNullOrWhiteSpace(entry.MatchedPattern)
                ? "unnamed pattern"
                : entry.MatchedPattern;
            var sourceLabel = LayerLabel(entry.Layer);
            var detail = new List<string>
            {
                $"outcome: {(string.IsNullOrWhiteSpace(entry.Outcome) ? "not recorded" : entry.Outcome)}",
                $"from: {(string.IsNullOrWhiteSpace(entry.Source) ? "source not recorded" : entry.Source)}"
            };
            if (entry.LineNumber is { } lineNumber)
            {
                detail.Add($"line {lineNumber}");
            }

            if (entry.Redacted)
            {
                detail.Add("credential-shaped text was masked before it was written");
            }

            if (!string.IsNullOrWhiteSpace(entry.Text))
            {
                detail.Add($"text: {Clip(entry.Text)}");
            }

            observations.Add(new GuardObservation(
                Provider: ProviderFor(entry),
                Source: sourceLabel,
                // Same layer + same pattern + same origin is the same flag, so a
                // repeat groups onto one card and drives the escalation counter.
                Signature: $"{entry.Layer}|{pattern}|{entry.Source}",
                Title: pattern,
                Detail: string.Join(" · ", detail),
                Level: level,
                Options: null,
                ActionKind: string.Empty));
        }

        return observations;
    }

    /// <summary>
    /// The ledger's own health, as an observation. A log that cannot be read, or
    /// that holds lines nobody can parse, is itself a flag — a silent one would let
    /// the panel look clean while the evidence rotted.
    /// </summary>
    public static GuardObservation LedgerHealth(GuardAuditRead read)
    {
        ArgumentNullException.ThrowIfNull(read);

        if (read.DirectoryError is not null)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "Block ledger unreadable",
                $"{read.Directory} could not be listed ({read.DirectoryError}). "
                + "Blocks may have happened that this panel cannot show.",
                GuardLevel.Critical);
        }

        if (!read.DirectoryExists)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "Block ledger not created yet",
                $"{read.Directory} does not exist. Nothing has been blocked on this workspace "
                + "since the ledger was added, or no guard has run here. This is not proof that "
                + "nothing was blocked before it existed.",
                GuardLevel.Unknown);
        }

        // An EXISTING ledger with no entries is a computable fact, not an unknown:
        // it says "recording since <date>, nothing blocked yet". The Unknown above
        // is reserved for the case where the ledger has never been started, where
        // the panel genuinely cannot distinguish "nothing happened" from "nobody
        // was recording".
        if (read.Entries.Count == 0)
        {
            var since = LedgerStartedAt(read.Directory);
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "Block ledger is recording · nothing blocked yet",
                $"{read.Directory} exists and is readable"
                + (since is null ? "" : $", recording since {since:yyyy-MM-dd HH:mm}")
                + ". No block has been written, which here means none has happened — not that "
                + "nobody was watching.",
                GuardLevel.Normal);
        }

        if (read.UnreadableFiles.Count > 0)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                $"{read.UnreadableFiles.Count} ledger file(s) unreadable",
                string.Join("; ", read.UnreadableFiles),
                GuardLevel.Critical);
        }

        if (read.Malformed > 0)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                $"{read.Malformed} unparseable ledger line(s)",
                $"{read.Malformed} line(s) across {read.Files.Count} file(s) in {read.Directory} "
                + "are not valid JSON. They are counted, not skipped: a log that quietly drops "
                + "what it cannot parse is not evidence.",
                GuardLevel.Warning);
        }

        return new GuardObservation(
            "Local",
            "Block ledger",
            "ledger-health",
            "Block ledger readable",
            $"{read.Entries.Count} event(s) across {read.Files.Count} file(s) in {read.Directory}, "
            + "no unparseable lines.",
            GuardLevel.Normal);
    }

    public static GuardLevel LevelFor(string? outcome)
    {
        if (string.IsNullOrWhiteSpace(outcome))
        {
            return GuardLevel.Unknown;
        }

        if (outcome.Equals("blocked", StringComparison.OrdinalIgnoreCase))
        {
            return GuardLevel.Critical;
        }

        if (outcome.Contains("warning", StringComparison.OrdinalIgnoreCase)
            || outcome.Equals("allowed-with-warning", StringComparison.OrdinalIgnoreCase))
        {
            return GuardLevel.Warning;
        }

        // An outcome this build has never seen. Grey and labelled UNKNOWN — the one
        // thing it must not be is green.
        return GuardLevel.Unknown;
    }

    public static string LayerLabel(string? layer) => layer switch
    {
        LayerBrowser => "Browser pattern match",
        LayerExecution => "Execution guard",
        null or "" => "Unrecorded layer",
        _ => $"Unrecognised layer \"{layer}\""
    };

    /// <summary>
    /// Which tab a card sits under. Browser events carry a site in
    /// <c>source</c>, so the site becomes the tab; anything else is local.
    /// </summary>
    public static string ProviderFor(GuardAuditEntry entry)
    {
        if (!string.Equals(entry.Layer, LayerBrowser, StringComparison.Ordinal))
        {
            return "Local";
        }

        var source = entry.Source ?? string.Empty;
        if (source.Contains("claude.ai", StringComparison.OrdinalIgnoreCase))
        {
            return "Claude";
        }

        if (source.Contains("chatgpt.com", StringComparison.OrdinalIgnoreCase)
            || source.Contains("openai.com", StringComparison.OrdinalIgnoreCase))
        {
            return "ChatGPT";
        }

        if (source.Contains("gemini.google.com", StringComparison.OrdinalIgnoreCase))
        {
            return "Gemini";
        }

        // A browser event from a host this build does not know. Named as unknown
        // rather than filed under a provider it might not be from.
        return "Browser · unrecognised site";
    }

    private static GuardAuditEntry? TryParse(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            // The six keys src/core/audit-log.mjs:52 declares REQUIRED. A line
            // missing any of them is malformed, and is counted as such.
            foreach (var key in new[] { "timestamp", "layer", "matchedPattern", "text", "source", "outcome" })
            {
                if (!root.TryGetProperty(key, out var probe)
                    || probe.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                {
                    return null;
                }
            }

            DateTimeOffset? timestamp = DateTimeOffset.TryParse(
                root.GetProperty("timestamp").ToString(),
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var parsedTimestamp)
                ? parsedTimestamp
                : null;

            int? lineNumber = root.TryGetProperty("lineNumber", out var lineElement)
                && lineElement.ValueKind == JsonValueKind.Number
                && lineElement.TryGetInt32(out var parsedLine)
                    ? parsedLine
                    : null;

            var redacted = root.TryGetProperty("redacted", out var redactedElement)
                && redactedElement.ValueKind == JsonValueKind.True;

            return new GuardAuditEntry(
                timestamp,
                root.GetProperty("layer").ToString(),
                root.GetProperty("matchedPattern").ToString(),
                root.GetProperty("text").ToString(),
                root.GetProperty("source").ToString(),
                root.GetProperty("outcome").ToString(),
                redacted,
                lineNumber);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Clip(string text)
    {
        var flattened = text.ReplaceLineEndings(" ⏎ ").Trim();
        return flattened.Length <= 180 ? flattened : flattened[..180] + "…";
    }

    [GeneratedRegex(@"^blocks-\d{4}-\d{2}-\d{2}\.jsonl$")]
    private static partial Regex LedgerName();
}

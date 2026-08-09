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
/// per line. It invents nothing, and where the file cannot be read it says so
/// rather than showing an empty, reassuring list.
///
/// ── WHAT ACTUALLY WRITES TO THIS FILE, MEASURED RATHER THAN ASSUMED ──
///
/// This comment used to say the ledger carried blocks from BOTH of Helmion's
/// detection layers, browser and execution. Traced 2026-07-30, it has never
/// carried a browser row and cannot:
///
///   · The only production caller of <c>recordBlockEvent</c> with a browser layer
///     is none. <c>LAYER.BROWSER</c> appears outside <c>test/</c> only inside
///     recordBlockEvent's own argument validation (audit-log.mjs:126,131).
///   · The extension has no way to write a file or reach the network — its own
///     package test fails the build if <c>fetch</c> or <c>XMLHttpRequest</c>
///     appears anywhere in it (extension/test/package.test.mjs:151,192).
///   · Even the execution half is narrower than it looks. The gate running inside
///     the agent records nothing: src/agent/tools.mjs:522 is its only production
///     caller and it passes no <c>auditWorkspace</c>, so governance-gate.mjs:276
///     returns before recording. The one writer left is the
///     <c>helmion guard</c> hook (bin/helmion.mjs:784), and it writes to its own
///     working directory, which is not necessarily the project the Pilot has
///     registered.
///
/// The browser-layer parsing below is kept anyway — the file format declares that
/// layer, the Node tests write rows in it, and a reader that choked on a valid row
/// would be a worse bug than one that never sees it. What is NOT kept is the claim
/// that an empty ledger means nothing was blocked. See <see cref="LedgerHealth"/>.
/// </summary>
public static partial class GuardAuditLog
{
    /// <summary>Mirrors <c>AUDIT_DIR</c> in src/core/audit-log.mjs:42.</summary>
    public const string AuditRelativeDirectory = @".helmion\audit";

    /// <summary>
    /// Written when the ledger folder is first created, recording WHEN the folder
    /// was made.
    ///
    /// It was introduced to resolve the ambiguity between "no blocks" and "nobody
    /// was recording", and it does not resolve it — a folder with a date on it is
    /// still not a recorder, and <see cref="LedgerHealth"/> no longer treats it as
    /// one. It is kept because the creation date is a real fact worth having when
    /// rows DO start arriving.
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
                    note = "Folder created by Helmion on this date. This records when the folder "
                        + "was made and nothing more — an empty folder is NOT evidence that "
                        + "nothing was blocked, because nothing may ever have been writing here.",
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
    public static IReadOnlyList<GuardObservation> ToObservations(GuardAuditRead read, string? projectName = null)
    {
        ArgumentNullException.ThrowIfNull(read);
        var observations = new List<GuardObservation>();

        foreach (var entry in read.Entries.OrderBy(entry => entry.Timestamp ?? DateTimeOffset.MinValue))
        {
            var level = LevelFor(entry.Outcome);
            var pattern = string.IsNullOrWhiteSpace(entry.MatchedPattern)
                ? "an unnamed rule"
                : entry.MatchedPattern;
            var sourceLabel = LayerLabel(entry.Layer);

            // PLAIN SENTENCES, NOT A KEY-VALUE DUMP. This used to render as
            // "outcome: blocked · from: governance-gate · line 12 · text: rm -rf /"
            // — the field names of a log format, printed at the person reading the
            // panel. He does not need the field names. He needs to know what was
            // about to run and whether it ran.
            var title = level switch
            {
                GuardLevel.Critical => $"Blocked: {pattern}",
                GuardLevel.Warning => $"Allowed, with a warning: {pattern}",
                _ => $"Recorded, but I cannot tell what happened: {pattern}",
            };

            var detail = new List<string>
            {
                level switch
                {
                    GuardLevel.Critical => "This was stopped before it ran.",
                    GuardLevel.Warning => "This was allowed to run, but it was flagged.",
                    _ => "Whether this ran was not written down, so I cannot tell you.",
                },
            };

            if (!string.IsNullOrWhiteSpace(entry.Text))
            {
                detail.Add($"What was about to run: {Clip(entry.Text)}");
            }

            if (!string.IsNullOrWhiteSpace(entry.Source))
            {
                detail.Add($"Reported by {entry.Source}.");
            }

            if (entry.Redacted)
            {
                detail.Add("Anything that looked like a password or a key was hidden before this was written down.");
            }

            // WHAT THIS CARD CANNOT TELL HIM, ON THE CARD. Troy asked that every
            // card name the agent it belongs to. This one cannot: the recorded
            // schema (src/core/audit-log.mjs:52) has no session identity in it, so
            // the honest subject is the project and the sentence below is the rest
            // of the answer. Guessing an agent here would be worse than useless —
            // he would act on it.
            detail.Add("The log does not record which agent ran it, only that it was stopped.");

            observations.Add(new GuardObservation(
                Provider: ProviderFor(entry),
                Source: sourceLabel,
                // Same layer + same pattern + same origin is the same flag, so a
                // repeat groups onto one card and drives the escalation counter.
                Signature: $"{entry.Layer}|{pattern}|{entry.Source}",
                Title: title,
                Detail: string.Join(" ", detail),
                Level: level,
                Options: null,
                ActionKind: string.Empty,
                Subject: LedgerSubject(projectName)));
        }

        return observations;
    }

    /// <summary>
    /// The ledger's own health, as an observation. A log that cannot be read, or
    /// that holds lines nobody can parse, is itself a flag — a silent one would let
    /// the panel look clean while the evidence rotted.
    /// </summary>
    public static GuardObservation LedgerHealth(GuardAuditRead read, string? projectName = null)
    {
        ArgumentNullException.ThrowIfNull(read);

        // NO FILE PATHS AND NO RAW ERROR TEXT ON THESE CARDS. Every one of these
        // sentences is read in a truck cab or next to a buyer, and a card that
        // reads like a stack trace is a card that gets skipped. The directory, the
        // file names and the exact operating-system error are all printed by the
        // "View quarantine log" button at the bottom of the panel
        // (MainWindow.GuardPanel.cs:558), which is where somebody who needs them
        // goes looking. They are not deleted, they are just not the headline.
        if (read.DirectoryError is not null)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "I cannot read the log of blocked commands",
                "Something is stopping me from opening the folder where blocked commands get "
                + "written down. Commands may have been stopped that I cannot show you. "
                + "Use \"View quarantine log\" at the bottom of this panel for the exact reason.",
                GuardLevel.Critical,
                Subject: LedgerSubject(projectName));
        }

        if (!read.DirectoryExists)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "This project has no log of blocked commands",
                "There is no file here for recording blocked commands, so there is nothing for me "
                + "to read. That does not mean nothing was ever blocked — it means nothing has "
                + "ever written it down in this project.",
                GuardLevel.Unknown,
                Subject: LedgerSubject(projectName));
        }

        // A FILE I CANNOT OPEN OUTRANKS AN EMPTY ONE, AND THIS ORDER IS THE FIX.
        //
        // These two branches used to sit BELOW the empty-ledger branch. A ledger
        // whose only file could not be read has zero entries, so it took the empty
        // branch and rendered as the reassuring card — the unreadable-file and
        // damaged-line branches were unreachable in exactly the case they exist
        // for. A log I cannot read is the loudest thing here, not the quietest.
        if (read.UnreadableFiles.Count > 0)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                $"There are {read.UnreadableFiles.Count} record file(s) here I cannot open",
                "Blocked commands were written down and I cannot read them back, so anything in "
                + "them is invisible to you. Use \"View quarantine log\" at the bottom of this "
                + "panel to see which ones.",
                GuardLevel.Critical,
                Subject: LedgerSubject(projectName));
        }

        if (read.Malformed > 0)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                $"{read.Malformed} line(s) in the log are damaged",
                "Some of what was written down is damaged and I cannot read it. I am counting "
                + "those lines rather than skipping them, because a log that quietly drops what "
                + "it cannot read is not evidence of anything.",
                GuardLevel.Warning,
                Subject: LedgerSubject(projectName));
        }

        // AN EMPTY LOG IS AN UNKNOWN, AND THIS IS THE CORRECTION THAT MATTERS MOST
        // IN THIS FILE.
        //
        // This branch used to be GuardLevel.Normal, titled "Block ledger is
        // recording · nothing blocked yet", and it said "No block has been written,
        // which here means none has happened". Every word of that was wrong:
        //
        //   · The panel creates this folder itself. MainWindow.GuardPanel.cs:353
        //     calls EnsureLedger immediately before reading, so the card was
        //     reading back evidence the panel had manufactured one line earlier and
        //     reporting it as an all-clear.
        //   · Nothing is "recording". A folder is not a recorder. Traced
        //     2026-07-30: the only production writer of a block row is
        //     bin/helmion.mjs:784 and it writes to its own working directory, not
        //     to the registered project; the in-agent execution gate writes nothing
        //     at all, because src/agent/tools.mjs:522 is its only production caller
        //     and it passes no auditWorkspace, so governance-gate.mjs:276 returns
        //     before recording; and the browser half cannot write anywhere, because
        //     the extension is forbidden network and file access
        //     (extension/test/package.test.mjs:151).
        //   · Measured the same day, after a full day of use, E:\Helmion's own
        //     ledger folder held the start marker and no block file at all — while
        //     the card on screen read green.
        //
        // "Nothing was blocked" and "nothing is writing here" are opposite facts
        // and an empty file cannot tell them apart. So this says so, in the words
        // it would use out loud, and stays grey.
        if (read.Entries.Count == 0)
        {
            return new GuardObservation(
                "Local",
                "Block ledger",
                "ledger-health",
                "Nothing has ever been written to the blocked-command log",
                "The folder is here and I can read it, but no blocked command has ever been "
                + "recorded in this project. I cannot tell you whether that means nothing was "
                + "ever blocked, or that nothing is writing here. Treat it as unknown rather "
                + "than as all clear.",
                GuardLevel.Unknown,
                Subject: LedgerSubject(projectName));
        }

        return new GuardObservation(
            "Local",
            "Block ledger",
            "ledger-health",
            $"{read.Entries.Count} blocked command(s) recorded",
            $"I read {read.Entries.Count} recorded block(s) and every line came back readable. "
            + "This is the record you can hand to somebody else.",
            GuardLevel.Normal,
            Subject: LedgerSubject(projectName));
    }

    /// <summary>
    /// Whose the block log is: the project, by name.
    ///
    /// THE PROJECT IS THE MOST SPECIFIC HONEST ANSWER, and it is deliberately not
    /// dressed up as an agent. The recorded schema is timestamp, layer, pattern,
    /// text, source, outcome (src/core/audit-log.mjs:52) — there is no session
    /// identity anywhere in it, so no card built from this file can say WHICH of
    /// Troy's agents ran the command that got stopped. The cards say that out loud
    /// rather than letting the project name quietly stand in for a session.
    /// </summary>
    private static string LedgerSubject(string? projectName) =>
        string.IsNullOrWhiteSpace(projectName) ? "This project" : projectName.Trim();

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

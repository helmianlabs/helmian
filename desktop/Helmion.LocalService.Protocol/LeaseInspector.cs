using System.Diagnostics;
using System.Text.Json;

namespace Helmion.LocalService.Protocol;

/// <summary>
/// Reads the real write lease off disk. A C# port of <c>inspectLease</c> in
/// <c>src/core/lease.mjs</c>, deliberately kept line-for-line comparable to it.
///
/// WHY THIS FILE EXISTS. Until 2026-07-29 the desktop built its lease status from
/// a hardcoded string: <c>WorkspaceInspector.cs:56-60</c> returned
/// <c>Status: "UNAVAILABLE"</c> with the label "Durable lease not connected" no
/// matter what was on disk. It was a literal dressed as live state — the UI could
/// not have told you the lease was held, stale, absent or corrupt, because it
/// never looked.
///
/// <c>src/core/lease.mjs</c> now owns the mechanism, writes
/// <c>&lt;workspace&gt;\.helmion\lease.json</c>, and reports FOUR states through
/// <c>inspectLease</c>: ACTIVE, STALE, NONE, UNREADABLE. This reads the same file
/// with the same rules and returns the same four.
///
/// THE ONE RULE THAT MATTERS MOST HERE: <b>UNREADABLE is never laundered into
/// NONE.</b> "There is no lease" and "there is a lease and I cannot understand it"
/// are opposite facts — the first means nobody is writing, the second means
/// somebody may be. Collapsing them is how a guard becomes decoration
/// (lease.mjs:41-45, "FAILURE POSTURE: CLOSED").
/// </summary>
public static class LeaseInspector
{
    /// <summary>Mirrors <c>LEASE_DIR</c> in src/core/lease.mjs:52.</summary>
    public const string LeaseDirectoryName = ".helmion";

    /// <summary>Mirrors <c>LEASE_FILE</c> in src/core/lease.mjs:51.</summary>
    public const string LeaseFileName = "lease.json";

    public const string StatusActive = "ACTIVE";
    public const string StatusStale = "STALE";
    public const string StatusNone = "NONE";
    public const string StatusUnreadable = "UNREADABLE";

    /// <summary>Every field lease.mjs:110 refuses to guess about (parseRecord).</summary>
    private static readonly string[] RequiredFields =
        ["leaseToken", "projectSlug", "expiresAt", "pid", "host"];

    public static string LeaseFilePath(string workspacePath) =>
        Path.Combine(workspacePath, LeaseDirectoryName, LeaseFileName);

    /// <summary>
    /// Read-only posture for the UI. Never throws: a caller that renders a status
    /// cannot be handed an exception instead of one.
    /// </summary>
    public static LeasePosture Inspect(string workspacePath, DateTimeOffset? asOf = null)
    {
        var now = asOf ?? DateTimeOffset.Now;
        var file = LeaseFilePath(workspacePath);

        string raw;
        try
        {
            raw = File.ReadAllText(file);
        }
        catch (Exception error) when (
            error is FileNotFoundException or DirectoryNotFoundException)
        {
            // lease.mjs:151 — ENOENT, and only ENOENT, means "no lease".
            return new LeasePosture(
                StatusNone,
                "No active write lease",
                $"No session holds the write lease for this project. Looked at {file}.",
                IsLive: false);
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException or NotSupportedException
                or ArgumentException or System.Security.SecurityException)
        {
            // lease.mjs:152-156 — anything else is UNREADABLE, not "none".
            return Unreadable(
                $"The lease file at {file} could not be read ({error.Message}). "
                + "This is not the same as having no lease: a writer may hold it.");
        }

        JsonElement root;
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(raw);
        }
        catch (JsonException error)
        {
            return Unreadable(
                $"The lease file at {file} is not valid JSON ({error.Message}).");
        }

        using (document)
        {
            root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Unreadable($"The lease file at {file} is not an object.");
            }

            foreach (var field in RequiredFields)
            {
                if (!root.TryGetProperty(field, out var value)
                    || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                {
                    return Unreadable(
                        $"The lease file at {file} is missing \"{field}\"; "
                        + "refusing to guess who holds it.");
                }
            }

            var expiresAtText = root.GetProperty("expiresAt").ToString();
            if (!DateTimeOffset.TryParse(
                    expiresAtText,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out var expiresAt))
            {
                return Unreadable(
                    $"The lease file at {file} has an unparseable expiresAt ({expiresAtText}).");
            }

            var host = root.GetProperty("host").ToString();
            var projectSlug = root.GetProperty("projectSlug").ToString();
            var coordinatorId = root.TryGetProperty("coordinatorId", out var coordinator)
                ? coordinator.ToString()
                : "unknown coordinator";
            var instanceId = root.TryGetProperty("instanceId", out var instance)
                ? instance.ToString()
                : "unknown instance";

            if (!TryReadPid(root.GetProperty("pid"), out var pid))
            {
                return Unreadable(
                    $"The lease file at {file} has a pid that is not a positive integer.");
            }

            // lease.mjs:163-166. Liveness is only meaningful for a pid on this
            // machine; a record from another host is judged purely on its expiry.
            var expired = expiresAt <= now;
            var sameHost = string.Equals(
                host,
                Environment.MachineName,
                StringComparison.OrdinalIgnoreCase);

            bool holderAlive;
            if (sameHost)
            {
                var liveness = ProbePid(pid);
                if (liveness is null)
                {
                    // The file parsed, but whether its holder is running cannot be
                    // determined. Reporting STALE would understate an active writer
                    // and reporting ACTIVE would invent one, so this is UNREADABLE:
                    // the posture genuinely cannot be computed.
                    return Unreadable(
                        $"The lease file at {file} was read, but whether its holder "
                        + $"(pid {pid} on {host}) is still running could not be determined.");
                }

                holderAlive = liveness.Value;
            }
            else
            {
                holderAlive = !expired;
            }

            var takeable = expired || (sameHost && !holderAlive);
            if (takeable)
            {
                // PLAIN ENGLISH, 2026-07-30. "Write lease stale / Held by troy:21332
                // on Helmion but expired at 2026-07-30 23:27:06 +00:00" told Troy
                // nothing he could act on - he had to ask what a lease even was. The
                // card now says what happened and whether it matters, and the ids and
                // timestamps come after, for whoever needs them.
                return new LeasePosture(
                    StatusStale,
                    "An old lock was left behind",
                    expired
                        ? "Only one agent at a time is allowed to write files here. One took "
                          + "the lock and never gave it back, and the lock has now run out. "
                          + "Nothing is holding it, so the next agent can just take it. "
                          + $"Nothing is wrong. (Was {instanceId} on {projectSlug}, ran out at "
                          + $"{expiresAt:HH:mm:ss}.)"
                        : "Only one agent at a time is allowed to write files here. One took "
                          + "the lock and then died without giving it back. Nothing is holding "
                          + "it, so the next agent can just take it. Nothing is wrong. "
                          + $"(Was {instanceId} on {projectSlug}, process {pid} is gone.)",
                    IsLive: false);
            }

            return new LeasePosture(
                StatusActive,
                "Write lease active",
                $"Held by {coordinatorId}/{instanceId} (pid {pid} on {host}) on {projectSlug} "
                + $"until {expiresAt:yyyy-MM-dd HH:mm:ss zzz}.",
                IsLive: true);
        }
    }

    /// <summary>
    /// The posture when no workspace has been registered at all. Not NONE — this
    /// window has not been pointed at a project, so there is no lease file whose
    /// absence could be reported. Grey, and it says so.
    /// </summary>
    public static LeasePosture NoWorkspace() =>
        new(
            "UNKNOWN",
            "Write lease unknown",
            "No workspace is registered, so there is no lease file to read. "
            + "Register a project to see its real lease posture.",
            IsLive: false);

    private static LeasePosture Unreadable(string detail) =>
        new(StatusUnreadable, "Write lease unreadable", detail, IsLive: false);

    private static bool TryReadPid(JsonElement element, out int pid)
    {
        pid = 0;
        if (element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var numeric))
        {
            pid = numeric;
            return pid > 0;
        }

        if (element.ValueKind == JsonValueKind.String
            && int.TryParse(element.GetString(), out var parsed))
        {
            pid = parsed;
            return pid > 0;
        }

        return false;
    }

    /// <summary>
    /// The C# equivalent of lease.mjs:96-105 (<c>process.kill(pid, 0)</c>): asks the
    /// kernel whether a pid exists without signalling it.
    ///
    /// Returns true (running), false (gone) or <c>null</c> — the caller must not be
    /// allowed to read "I could not check" as either answer.
    ///
    /// Shares one limitation with the Node version, stated rather than hidden:
    /// Windows recycles pids, so a pid that now belongs to an unrelated process
    /// reads as alive. Both implementations are wrong in the same direction (they
    /// keep a lease alive slightly too long), which is the safe direction.
    /// </summary>
    private static bool? ProbePid(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            // Documented signal for "no process with that id is running".
            return false;
        }
        catch (InvalidOperationException)
        {
            // The process exited between lookup and the HasExited read.
            return false;
        }
        catch (Exception error) when (
            error is System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return null;
        }
    }
}

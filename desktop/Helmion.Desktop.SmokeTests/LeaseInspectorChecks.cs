using Helmion.LocalService.Protocol;

/// <summary>
/// The tripwire under <see cref="LeaseInspector"/> — the reader behind the lease
/// status the desktop shows.
///
/// WHY THIS EXISTS. README.md advertises "a database-enforced single active write
/// lease per project", and the desktop is where a buyer looks to see it. Until
/// 2026-07-29 WorkspaceInspector returned four hardcoded literals — Status
/// "UNAVAILABLE", "Durable lease not connected" — regardless of what was on disk, and
/// the smoke suite asserted those literals, so the suite was pinning the lie in place.
/// The literals are gone and this reads the real file; nothing tested the reader.
///
/// THE INVARIANT THAT MATTERS MOST. UNREADABLE must never be laundered into NONE.
/// "No lease" means the next writer may proceed. "I could not read the lease" means a
/// writer may be holding it right now. Collapsing the second into the first is how two
/// sessions end up writing the same project — the exact failure the lease exists to
/// prevent. Every malformed shape below is therefore asserted to be UNREADABLE AND
/// asserted not to be NONE.
///
/// Every case pins the clock with the <c>asOf</c> parameter, so no check depends on
/// how long the suite takes to run.
/// </summary>
internal static class LeaseInspectorChecks
{
    public static void Run()
    {
        var checks = 0;
        var now = new DateTimeOffset(2026, 7, 29, 20, 0, 0, TimeSpan.Zero);
        var root = Path.Combine(Path.GetTempPath(), $"helmion-lease-inspect-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);

        try
        {
            // --- 1. NO FILE IS "NONE", AND IT NAMES WHERE IT LOOKED -------------
            var none = LeaseInspector.Inspect(root, now);
            Assert(none.Status == LeaseInspector.StatusNone, "an absent lease file reports NONE");
            Assert(!none.IsLive, "an absent lease is not live");
            Assert(none.Detail.Contains(LeaseInspector.LeaseFilePath(root), StringComparison.Ordinal),
                "the NONE posture names the path it looked at, proving it looked");
            checks += 3;

            // A workspace path that does not exist at all is still NONE, not a throw.
            // A caller rendering a status cannot be handed an exception instead of one.
            var missingRoot = LeaseInspector.Inspect(
                Path.Combine(root, "no-such-directory-here"), now);
            Assert(missingRoot.Status == LeaseInspector.StatusNone,
                "a workspace directory that does not exist reports NONE without throwing");
            checks += 1;

            // --- 2. A LIVE HOLDER ON THIS MACHINE IS ACTIVE ---------------------
            Write(root, Lease(now.AddMinutes(10), Environment.ProcessId, Environment.MachineName));
            var active = LeaseInspector.Inspect(root, now);
            Assert(active.Status == LeaseInspector.StatusActive,
                "an unexpired lease held by a running process on this host is ACTIVE");
            Assert(active.IsLive, "an ACTIVE lease is the only posture that reports live");
            Assert(active.Detail.Contains(Environment.ProcessId.ToString(), StringComparison.Ordinal),
                "the ACTIVE detail names the pid holding it");
            checks += 3;

            // --- 3. EXPIRY MAKES IT STALE EVEN THOUGH THE HOLDER IS ALIVE -------
            Write(root, Lease(now.AddMinutes(-1), Environment.ProcessId, Environment.MachineName));
            var expired = LeaseInspector.Inspect(root, now);
            Assert(expired.Status == LeaseInspector.StatusStale,
                "an expired lease is STALE even when its holder is still running");
            Assert(!expired.IsLive, "a STALE lease is not live");
            // The REQUIREMENT is that the card explains itself instead of being a
            // colour with an id next to it. It is NOT that the card contains the
            // word "expired" — that word is jargon, and pinning it here is what made
            // the panel read like a stack trace. Troy, 2026-07-30, on the old text:
            // he had to ask what a lease even was before he could tell whether
            // anything was wrong.
            //
            // So this now asserts what the reader actually needs: that the lock ran
            // out or was dropped, that someone else can take it, and - critically -
            // whether he has to do anything. The wording is free to be human.
            Assert(expired.Detail.Contains("run out", StringComparison.OrdinalIgnoreCase)
                || expired.Detail.Contains("ran out", StringComparison.OrdinalIgnoreCase)
                || expired.Detail.Contains("expired", StringComparison.OrdinalIgnoreCase),
                "the STALE detail says the lock is no longer held, rather than only showing a colour");
            Assert(expired.Detail.Contains("take it", StringComparison.OrdinalIgnoreCase),
                "and says the next agent can take it, so the reader knows it resolves itself");
            Assert(expired.Detail.Contains("Nothing is wrong", StringComparison.OrdinalIgnoreCase),
                "and says plainly whether this needs the reader to act");
            checks += 5;

            // The boundary: expiry is <=, so a lease expiring exactly now is already
            // takeable. Tested on the instant and one tick either side.
            Write(root, Lease(now, Environment.ProcessId, Environment.MachineName));
            Assert(LeaseInspector.Inspect(root, now).Status == LeaseInspector.StatusStale,
                "a lease whose expiry is exactly now is already stale");
            Write(root, Lease(now.AddTicks(1), Environment.ProcessId, Environment.MachineName));
            Assert(LeaseInspector.Inspect(root, now).Status == LeaseInspector.StatusActive,
                "a lease expiring one tick from now is still active");
            checks += 2;

            // --- 4. A DEAD HOLDER FREES THE PROJECT -----------------------------
            // A hard crash must not park a project for the full TTL.
            Write(root, Lease(now.AddMinutes(10), DeadPid, Environment.MachineName));
            var dead = LeaseInspector.Inspect(root, now);
            Assert(dead.Status == LeaseInspector.StatusStale,
                "an unexpired lease whose holder process is gone is STALE, so a crash does not park the project");
            // Same reasoning as the expiry check above: the REQUIREMENT is that the
            // card explains the holder is gone, not that it uses one particular
            // phrase. "no longer running" was the old wording; it now says "died
            // without giving it back" and "process N is gone", which is plainer and
            // still says the same fact. Pinning the exact sentence is what turned
            // this panel into something Troy had to decode.
            Assert(dead.Detail.Contains("is gone", StringComparison.OrdinalIgnoreCase)
                || dead.Detail.Contains("died", StringComparison.OrdinalIgnoreCase)
                || dead.Detail.Contains("no longer running", StringComparison.OrdinalIgnoreCase),
                "the STALE detail says the holder is gone");
            Assert(dead.Detail.Contains("take it", StringComparison.OrdinalIgnoreCase),
                "and says the next agent can take the lock, so a crash reads as self-healing");
            checks += 3;

            // --- 5. ANOTHER MACHINE IS JUDGED ON EXPIRY ALONE -------------------
            // A pid on another host says nothing about liveness here, so probing it
            // would be inventing an answer.
            Write(root, Lease(now.AddMinutes(10), DeadPid, "some-other-machine"));
            Assert(LeaseInspector.Inspect(root, now).Status == LeaseInspector.StatusActive,
                "an unexpired lease from another host is ACTIVE — its pid is not probed here");
            Write(root, Lease(now.AddMinutes(-10), Environment.ProcessId, "some-other-machine"));
            Assert(LeaseInspector.Inspect(root, now).Status == LeaseInspector.StatusStale,
                "an expired lease from another host is STALE on expiry alone");
            checks += 2;

            // --- 6. EVERY MALFORMED SHAPE IS UNREADABLE, NEVER NONE -------------
            var malformed = new (string Body, string What)[]
            {
                ("{not json at all", "a lease file that is not JSON"),
                ("[]", "a lease file that is a JSON array rather than an object"),
                ("\"a string\"", "a lease file that is a bare JSON string"),
                ("{\"leaseToken\":\"t\",\"projectSlug\":\"p\",\"expiresAt\":\"tomorrow-ish\",\"pid\":1,\"host\":\"h\"}",
                    "a lease file whose expiresAt cannot be parsed"),
                ("{\"leaseToken\":\"t\",\"projectSlug\":\"p\",\"expiresAt\":\"2026-07-29T21:00:00+00:00\",\"pid\":0,\"host\":\"h\"}",
                    "a lease file whose pid is zero"),
                ("{\"leaseToken\":\"t\",\"projectSlug\":\"p\",\"expiresAt\":\"2026-07-29T21:00:00+00:00\",\"pid\":-4,\"host\":\"h\"}",
                    "a lease file whose pid is negative"),
                ("{\"leaseToken\":\"t\",\"projectSlug\":\"p\",\"expiresAt\":\"2026-07-29T21:00:00+00:00\",\"pid\":\"not-a-number\",\"host\":\"h\"}",
                    "a lease file whose pid is not a number"),
                ("{\"leaseToken\":null,\"projectSlug\":\"p\",\"expiresAt\":\"2026-07-29T21:00:00+00:00\",\"pid\":1,\"host\":\"h\"}",
                    "a lease file whose leaseToken is null"),
            };

            foreach (var (body, what) in malformed)
            {
                Write(root, body);
                var posture = LeaseInspector.Inspect(root, now);
                Assert(posture.Status == LeaseInspector.StatusUnreadable, $"{what} is UNREADABLE");
                Assert(posture.Status != LeaseInspector.StatusNone,
                    $"{what} is NOT laundered into NONE — a writer may still hold it");
                Assert(!posture.IsLive, $"{what} does not report live");
                Assert(!string.IsNullOrWhiteSpace(posture.Detail), $"{what} explains why it could not be read");
                checks += 4;
            }

            // --- 7. EVERY REQUIRED FIELD IS REQUIRED, AND NAMED WHEN MISSING ----
            // Guessing a holder is worse than admitting the file is unreadable.
            var required = new[] { "leaseToken", "projectSlug", "expiresAt", "pid", "host" };
            foreach (var field in required)
            {
                Write(root, LeaseWithout(field, now.AddMinutes(10)));
                var posture = LeaseInspector.Inspect(root, now);
                Assert(posture.Status == LeaseInspector.StatusUnreadable,
                    $"a lease file missing \"{field}\" is UNREADABLE rather than guessed at");
                Assert(posture.Status != LeaseInspector.StatusNone,
                    $"a lease file missing \"{field}\" is not laundered into NONE");
                Assert(posture.Detail.Contains(field, StringComparison.Ordinal),
                    $"the UNREADABLE detail names the missing field \"{field}\"");
                checks += 3;
            }

            // --- 8. OPTIONAL FIELDS ARE GENUINELY OPTIONAL ----------------------
            // coordinatorId and instanceId are absent from the record above; their
            // absence must not make an otherwise valid lease unreadable.
            Write(root, Lease(now.AddMinutes(10), Environment.ProcessId, Environment.MachineName));
            Assert(LeaseInspector.Inspect(root, now).Status == LeaseInspector.StatusActive,
                "a valid lease without coordinatorId or instanceId is still readable");
            checks += 1;

            // --- 9. NO WORKSPACE IS UNKNOWN, NOT NONE --------------------------
            // "This window is not pointed at a project" and "this project has no
            // lease" are different facts and must not render the same.
            var unregistered = LeaseInspector.NoWorkspace();
            Assert(unregistered.Status == "UNKNOWN", "an unregistered workspace reports UNKNOWN");
            Assert(unregistered.Status != LeaseInspector.StatusNone,
                "an unregistered workspace is NOT reported as having no lease");
            Assert(!unregistered.IsLive, "an unregistered workspace is not live");
            checks += 3;

            // --- 10. THE FOUR STATUS CONSTANTS ARE DISTINCT --------------------
            var statuses = new[]
            {
                LeaseInspector.StatusActive, LeaseInspector.StatusStale,
                LeaseInspector.StatusNone, LeaseInspector.StatusUnreadable
            };
            Assert(statuses.Distinct(StringComparer.Ordinal).Count() == statuses.Length,
                "the four lease statuses are four distinct strings, so no two can render alike");
            checks += 1;

            Console.WriteLine($"Helmion lease inspector checks passed ({checks} checks).");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp dir */ }
        }
    }

    /// <summary>
    /// A pid chosen to be absent. Windows pids are allocated far below this, and
    /// Process.GetProcessById throws ArgumentException for an id that is not running,
    /// which LeaseInspector reads as "gone" rather than "cannot tell".
    /// </summary>
    private const int DeadPid = 1_999_999_996;

    private static string Lease(DateTimeOffset expiresAt, int pid, string host) =>
        $"{{\"leaseToken\":\"tok-1\",\"projectSlug\":\"demo\","
        + $"\"expiresAt\":\"{expiresAt:o}\",\"pid\":{pid},\"host\":\"{host}\"}}";

    private static string LeaseWithout(string field, DateTimeOffset expiresAt)
    {
        var fields = new Dictionary<string, string>
        {
            ["leaseToken"] = "\"tok-1\"",
            ["projectSlug"] = "\"demo\"",
            ["expiresAt"] = $"\"{expiresAt:o}\"",
            ["pid"] = Environment.ProcessId.ToString(),
            ["host"] = $"\"{Environment.MachineName}\""
        };
        fields.Remove(field);
        return "{" + string.Join(",", fields.Select(pair => $"\"{pair.Key}\":{pair.Value}")) + "}";
    }

    private static void Write(string workspaceRoot, string body)
    {
        var file = LeaseInspector.LeaseFilePath(workspaceRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, body);
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Lease inspector failed: {what}");
        }
    }
}

using Helmion.Desktop.Core;

/// <summary>
/// The three cards that used to say UNKNOWN.
///
/// Troy's instruction, 2026-07-30: "Reporting UNKNOWN instead of guessing is
/// correct and I do not want that behavior changed or softened. What I want is
/// for the status to actually be computable."
///
/// So these checks work in both directions. They prove each state is now
/// computed — AND they prove Unknown is still returned when the check genuinely
/// cannot run. A probe that answered "fine" when it could not reach the thing it
/// was probing would be worse than the Unknown it replaced.
/// </summary>
internal static class GuardLivenessChecks
{
    public static void Run()
    {
        var checks = 0;

        // --- 1. EXECUTION GUARD: the verdict parser -----------------------------
        //
        // The single most dangerous line in the probe. `helmion guard` exits 2 on
        // a block — but node also exits non-zero when it CRASHES. Reading the exit
        // code as the signal would report a dead guard as a live one. Only the
        // verdict body distinguishes them, and this pins that.
        var blocked = ExecutionGuardProbe.ParseVerdict("{\"allowed\":false,\"destructive\":{\"blocked\":true}}");
        Assert(blocked.Allowed == false && !blocked.Failed, "a refusal is read as allowed:false");

        var permitted = ExecutionGuardProbe.ParseVerdict("{\"allowed\":true}");
        Assert(permitted.Allowed == true && !permitted.Failed, "an allow is read as allowed:true");
        checks += 2;

        foreach (var crash in new[]
                 {
                     "",
                     "   ",
                     "node:internal/errors Error: Cannot find module",
                     "{\"error\":\"boom\"}",
                     "not json at all",
                 })
        {
            var answer = ExecutionGuardProbe.ParseVerdict(crash);
            Assert(answer.Failed, $"a crash or junk answer ({crash[..Math.Min(20, crash.Length)]}) is a FAILURE, never a block");
            Assert(answer.Allowed is null, "a failed probe has no verdict, rather than a false one");
            Assert(answer.Error.Length > 0, "a failed probe says why");
            checks += 3;
        }

        // Noise before the verdict must not hide it — the CLI can print warnings.
        var noisy = ExecutionGuardProbe.ParseVerdict("some warning line\n{\"allowed\":false}\n");
        Assert(noisy.Allowed == false && !noisy.Failed, "the verdict is found even after other output");
        checks += 1;

        // --- 2. EXECUTION GUARD: the probe, against the REAL CLI ---------------
        //
        // This actually runs `helmion guard` twice. It is the positive control for
        // the whole card: if this passes, the panel's "LIVE" is earned.
        var repoRoot = FindRepoRoot();
        if (repoRoot is not null)
        {
            var probe = ExecutionGuardProbe.RunAsync(repoRoot).GetAwaiter().GetResult();
            Assert(probe.Level == GuardLevel.Normal,
                $"the execution guard probes LIVE against the real CLI (got: {probe.Title} — {probe.Detail})");
            Assert(probe.RefusedDestructive, "it REFUSED the known-destructive probe");
            Assert(probe.AllowedHarmless, "and ALLOWED the known-harmless one — both directions, not just one");
            Assert(probe.Title.Contains("LIVE", StringComparison.Ordinal), "the card says LIVE in words");
            checks += 4;

            // THE LEDGER MUST NOT SEE PROBE ROWS. `helmion guard` writes a block
            // event on every refusal; a probe on every panel refresh would bury
            // real evidence under thousands of fabricated blocks.
            var repoLedger = GuardAuditLog.DirectoryFor(repoRoot);
            var before = CountLedgerLines(repoLedger);
            ExecutionGuardProbe.RunAsync(repoRoot).GetAwaiter().GetResult();
            Assert(CountLedgerLines(repoLedger) == before,
                "probing the guard wrote NOTHING to the real block ledger");
            checks += 1;
        }

        // A missing CLI is UNKNOWN, never "fine".
        var noCli = ExecutionGuardProbe.RunAsync(Path.GetTempPath()).GetAwaiter().GetResult();
        Assert(noCli.Level == GuardLevel.Unknown, "a probe that cannot run reports Unknown, not Normal");
        Assert(noCli.Detail.Contains("not an all-clear", StringComparison.Ordinal),
            "and says out loud that Unknown is not an all-clear");
        checks += 2;

        // --- 3. BLOCK LEDGER: empty is a FACT once the ledger has been started --
        var workspace = Path.Combine(Path.GetTempPath(), $"helmion-ledger-{Guid.NewGuid():N}");
        Directory.CreateDirectory(workspace);
        try
        {
            // Before: never started. That genuinely cannot tell "nothing was
            // blocked" from "nobody was recording", so it stays Unknown.
            var cold = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(workspace));
            Assert(cold.Level == GuardLevel.Unknown, "a ledger that was never started is Unknown, correctly");
            checks += 1;

            Assert(GuardAuditLog.EnsureLedger(workspace), "the ledger can be started");
            Assert(Directory.Exists(GuardAuditLog.DirectoryFor(workspace)), "the audit folder now exists");
            Assert(File.Exists(Path.Combine(GuardAuditLog.DirectoryFor(workspace), GuardAuditLog.LedgerMarkerFile)),
                "and it stamped WHEN it started, which is the fact that removes the ambiguity");
            checks += 3;

            // After: empty now MEANS something.
            var warm = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(workspace));
            Assert(warm.Level == GuardLevel.Normal,
                "an empty but RUNNING ledger is Normal — 'nothing blocked' is now a computed fact");
            Assert(warm.Title.Contains("recording", StringComparison.OrdinalIgnoreCase),
                "the card says it is recording");
            Assert(warm.Detail.Contains("not that nobody was watching", StringComparison.Ordinal),
                "and still refuses to let 'no blocks' be misread as 'nobody watching'");
            checks += 3;

            Assert(GuardAuditLog.LedgerStartedAt(GuardAuditLog.DirectoryFor(workspace)) is not null,
                "the start date is readable back");

            // The marker must be valid JSON. The first version of EnsureLedger
            // built it by concatenating an interpolated string with a plain one,
            // so the closing "}}" was escaped in one half and literal in the
            // other — it shipped with an extra brace and every read threw. This
            // is what caught it.
            var markerText = File.ReadAllText(
                Path.Combine(GuardAuditLog.DirectoryFor(workspace), GuardAuditLog.LedgerMarkerFile));
            using (var parsed = System.Text.Json.JsonDocument.Parse(markerText))
            {
                Assert(parsed.RootElement.TryGetProperty("startedAt", out _),
                    "the marker is valid JSON carrying startedAt");
            }

            // A CORRUPT marker must degrade to the folder date, not to null. A
            // shared try/catch used to send a parse failure straight past the
            // fallback, so a working ledger reported that it did not know when it
            // began.
            File.WriteAllText(
                Path.Combine(GuardAuditLog.DirectoryFor(workspace), GuardAuditLog.LedgerMarkerFile),
                "{not json at all");
            Assert(GuardAuditLog.LedgerStartedAt(GuardAuditLog.DirectoryFor(workspace)) is not null,
                "a corrupt marker falls back to the folder's creation date rather than returning nothing");
            checks += 2;

            // Idempotent: a second call must not reset the start date.
            var first = GuardAuditLog.LedgerStartedAt(GuardAuditLog.DirectoryFor(workspace));
            GuardAuditLog.EnsureLedger(workspace);
            Assert(GuardAuditLog.LedgerStartedAt(GuardAuditLog.DirectoryFor(workspace)) == first,
                "starting an already-started ledger does not rewrite when it began");
            checks += 2;
        }
        finally
        {
            try { Directory.Delete(workspace, recursive: true); } catch { /* temp */ }
        }

        Assert(!GuardAuditLog.EnsureLedger(""), "an empty workspace path reports failure rather than pretending");
        checks += 1;

        // --- 4. BROWSER LAYER: read Chrome's own record ------------------------
        var profileRoot = Path.Combine(Path.GetTempPath(), $"helmion-chrome-{Guid.NewGuid():N}");
        var extensionDir = Path.Combine(Path.GetTempPath(), $"helmion-ext-{Guid.NewGuid():N}");
        Directory.CreateDirectory(extensionDir);
        try
        {
            // No profile at all -> Unknown. This is the case that MUST stay Unknown.
            var blind = BrowserExtensionProbe.Inspect(extensionDir, [Path.Combine(profileRoot, "nope")]);
            Assert(blind.Level == GuardLevel.Unknown, "with no readable browser profile, the answer is Unknown");
            Assert(blind.Detail.Contains("not an all-clear", StringComparison.Ordinal), "and it says so");
            checks += 2;

            WritePreferences(profileRoot, "Default", extensionDir, state: 1);

            var live = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(live.Level == GuardLevel.Normal && live.Installed && live.Enabled,
                $"an enabled unpacked extension reads as installed and enabled (got: {live.Title})");
            Assert(!live.Detail.Contains("watching right now", StringComparison.OrdinalIgnoreCase),
                "the card does NOT claim it is watching a tab — it cannot know that");
            Assert(live.Detail.Contains("installed and switched on", StringComparison.OrdinalIgnoreCase)
                || live.Title.Contains("installed and enabled", StringComparison.OrdinalIgnoreCase),
                "it claims exactly what it can prove: installed and enabled");
            checks += 3;

            // Disabled is its own state, NOT the same as absent.
            WritePreferences(profileRoot, "Default", extensionDir, state: 0);
            var off = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(off.Installed && !off.Enabled && off.Level == GuardLevel.Warning,
                "an installed-but-disabled extension is its own state, not 'missing'");
            Assert(off.Title.Contains("SWITCHED OFF", StringComparison.Ordinal), "and the card says switched off");
            checks += 2;

            // A profile that has extensions, but not ours.
            WritePreferences(profileRoot, "Default", Path.Combine(Path.GetTempPath(), "someone-elses-ext"), state: 1);
            var absent = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(!absent.Installed && absent.Level == GuardLevel.Warning,
                "an extension that is not loaded reads as NOT installed — a warning, not an unknown");
            Assert(absent.Detail.Contains("chrome://extensions", StringComparison.Ordinal),
                "and tells the operator how to fix it");
            checks += 2;

            // Path comparison must survive separators and case.
            WritePreferences(profileRoot, "Default", extensionDir.Replace('\\', '/').ToUpperInvariant(), state: 1);
            var normalized = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(normalized.Installed,
                "the path match survives forward slashes and different casing, as Chrome writes them");
            checks += 1;
        }
        finally
        {
            try { Directory.Delete(profileRoot, recursive: true); } catch { /* temp */ }
            try { Directory.Delete(extensionDir, recursive: true); } catch { /* temp */ }
        }

        Console.WriteLine($"Helmion guard liveness checks passed ({checks} checks).");
    }

    /// <summary>
    /// A minimal stand-in for Chrome's Preferences file.
    ///
    /// SERIALIZED, not hand-built. The first version concatenated an interpolated
    /// string and miscounted the escaped closing braces, producing JSON one brace
    /// short — so the probe correctly found nothing and the test blamed the
    /// probe. Exactly the same mistake as the ledger marker, twenty lines away,
    /// in the same hour. Hand-assembling JSON in an interpolated string is the
    /// bug; the serializer is the fix, in both places.
    /// </summary>
    private static void WritePreferences(string root, string profile, string extensionPath, int state)
    {
        var dir = Path.Combine(root, profile);
        Directory.CreateDirectory(dir);

        var document = new Dictionary<string, object>
        {
            ["extensions"] = new Dictionary<string, object>
            {
                ["settings"] = new Dictionary<string, object>
                {
                    ["abcdefghijklmnopabcdefghijklmnop"] = new Dictionary<string, object>
                    {
                        ["path"] = extensionPath,
                        ["state"] = state,
                    },
                },
            },
        };

        File.WriteAllText(Path.Combine(dir, "Preferences"), System.Text.Json.JsonSerializer.Serialize(document));
    }

    private static int CountLedgerLines(string auditDirectory)
    {
        if (!Directory.Exists(auditDirectory)) return 0;
        var total = 0;
        foreach (var file in Directory.EnumerateFiles(auditDirectory, "*.jsonl"))
        {
            try { total += File.ReadAllLines(file).Length; } catch { /* locked */ }
        }
        return total;
    }

    /// <summary>Walks up from the test binary to the repo root that holds bin/helmion.mjs.</summary>
    private static string? FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "bin", "helmion.mjs"))) return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Guard liveness failed: {what}");
        }
    }
}

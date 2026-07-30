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

            // ── HOW TO RUN A NEGATIVE CONTROL IN A TREE OTHERS ARE WORKING IN ──
            //
            // The fixtures below were proven real by breaking the probe on purpose
            // — reverting BrowserExtensionProbe.PreferenceFileNames to
            // ["Preferences"], watching the Secure-Preferences fixture fail, then
            // reverting. A test that passes on both the broken and the fixed code
            // proves nothing, so that step is not optional.
            //
            // BUT DO IT ON A SCRATCH COPY, NOT IN THE SHARED TREE. While that
            // deliberate break was live on disk, another session read the file,
            // found the single-file bug sitting there under a comment promising it
            // was temporary, and escalated it as a shipping defect. They were right
            // to: the file genuinely was broken at the moment they looked.
            //
            // IN A SHARED TREE, A READ OF ANOTHER SESSION'S FILE IS A READ OF A
            // MOMENT, NOT OF A STATE. Nothing distinguishes a half-finished edit
            // from a finished one, and "temporary, reverted below" is a promise to
            // your future self that everyone else's tooling will believe literally.
            // The same trap runs in both directions: a session that reported this
            // work missing was reading a moment too, minutes before it reappeared.
            //
            // So: run the break in a throwaway worktree or a copy, and if it must
            // happen in place, say so out loud before you start and confirm the
            // revert with git rather than memory.

            // ── THE RECORD LIVES IN ONE OF TWO FILES, AND EITHER COUNTS. ───────
            //
            // This is the bug that shipped: the probe read only "Preferences", and
            // Chrome writes UNPACKED developer-mode extensions to "Secure
            // Preferences" instead. Measured on the author's machine 2026-07-30
            // (Chrome 150.0.7871.100, profile "Default"): extensions.settings is
            // ABSENT from Preferences and present in Secure Preferences carrying
            // "path":"E:\\Helmion\\extension". The extension was loaded correctly
            // and the card said CRITICAL. Both fixtures below exist so neither
            // file can quietly stop being read again.

            // ONLY in Secure Preferences — the developer-mode case, the one that
            // used to fail. This is the single most important assertion here.
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences", extensionDir, disableReasons: []);
            var secureOnly = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(secureOnly.Installed,
                $"an extension recorded ONLY in Secure Preferences reads as INSTALLED (got: {secureOnly.Title})");
            Assert(secureOnly.Level == GuardLevel.Normal
                && secureOnly.Enablement == BrowserExtensionEnablement.Enabled,
                "and an empty disable_reasons array is read as enabled, not as a missing value");
            Assert(secureOnly.RecordFile == "Secure Preferences"
                && secureOnly.Detail.Contains("Secure Preferences", StringComparison.Ordinal),
                "and the card names WHICH file the record came from");
            checks += 3;

            // ONLY in plain Preferences — the store-install case, kept so the fix
            // for one file cannot break the other.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, disableReasons: []);
            var plainOnly = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(plainOnly.Installed && plainOnly.Level == GuardLevel.Normal,
                $"an extension recorded ONLY in plain Preferences still reads as installed (got: {plainOnly.Title})");
            Assert(plainOnly.RecordFile == "Preferences"
                && plainOnly.Detail.Contains("\"Preferences\"", StringComparison.Ordinal),
                "and that card names Preferences as the file that answered");
            checks += 2;

            // The legacy key still works where a browser still writes it.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, state: 1);

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
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, state: 0);
            var off = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(off.Installed && !off.Enabled && off.Level == GuardLevel.Warning,
                "an installed-but-disabled extension is its own state, not 'missing'");
            Assert(off.Title.Contains("SWITCHED OFF", StringComparison.Ordinal), "and the card says switched off");
            checks += 2;

            // A NON-EMPTY disable_reasons array is the modern way of saying off.
            // The empty-array case above is only meaningful because this one is
            // distinguishable from it — that is the positive control, and it comes
            // straight from the measured file (Adblock Plus carried [1] while every
            // enabled extension carried []).
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences", extensionDir, disableReasons: [1]);
            var reasoned = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(reasoned.Installed && reasoned.Enablement == BrowserExtensionEnablement.Disabled,
                "a non-empty disable_reasons array reads as switched off");
            Assert(reasoned.Level == GuardLevel.Warning,
                "and that is a warning, because something IS known to be wrong");
            checks += 2;

            // NEITHER key present: installed, but enabled-ness genuinely unknown.
            // The value of this case is what it must NOT do — a missing value is
            // never rounded up to enabled just because nothing said otherwise.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences", extensionDir);
            var silent = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(silent.Installed && silent.Enablement == BrowserExtensionEnablement.NotRecorded,
                "with neither disable_reasons nor state, the extension is installed and enabled-ness is NOT recorded");
            Assert(!silent.Enabled && silent.Level == GuardLevel.Unknown,
                "an unrecorded switch is never reported as enabled, and never renders as an all-clear");
            Assert(silent.Detail.Contains("not recorded", StringComparison.OrdinalIgnoreCase)
                && silent.Detail.Contains("not an all-clear", StringComparison.Ordinal),
                "and the card says in words that it could not tell");
            checks += 3;

            // Both files present and disagreeing: enabled wins, and the card says
            // which file it believed, so the operator can check it.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, disableReasons: [1]);
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences", extensionDir, disableReasons: []);
            var disagree = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(disagree.Enablement == BrowserExtensionEnablement.Enabled
                && disagree.RecordFile == "Secure Preferences",
                "when the two files disagree the enabled record wins and the card names it");
            checks += 1;

            // A profile that has extensions, but not ours.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences",
                Path.Combine(Path.GetTempPath(), "someone-elses-ext"), state: 1);
            var absent = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(!absent.Installed && absent.Level == GuardLevel.Warning,
                "an extension that is not loaded reads as NOT installed — a warning, not an unknown");
            Assert(absent.Detail.Contains("chrome://extensions", StringComparison.Ordinal),
                "and tells the operator how to fix it");
            Assert(absent.Detail.Contains("Secure Preferences", StringComparison.Ordinal),
                "and the not-installed message states that BOTH files were searched, not just one");
            checks += 3;

            // Path comparison must survive separators and case.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences",
                extensionDir.Replace('\\', '/').ToUpperInvariant(), disableReasons: []);
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
    /// <param name="fileName">
    /// "Preferences" or "Secure Preferences". WHICH FILE IS THE POINT of several of
    /// these fixtures, so it is a required argument with no default — a caller must
    /// state it and cannot drift back into testing only one of them.
    /// </param>
    /// <param name="state">Legacy Extension::State. Omit to leave the key absent.</param>
    /// <param name="disableReasons">
    /// Modern Chrome's array. Empty array = recorded as enabled; non-empty =
    /// recorded as disabled; omit entirely to leave the key absent, which is the
    /// third case the probe has to be able to say "not recorded" about.
    /// </param>
    private static void WriteChromeProfile(
        string root,
        string profile,
        string fileName,
        string extensionPath,
        int? state = null,
        int[]? disableReasons = null)
    {
        var dir = Path.Combine(root, profile);
        Directory.CreateDirectory(dir);

        var record = new Dictionary<string, object>
        {
            ["path"] = extensionPath,
        };

        // Written only when asked. A fixture for "the key is absent" is worthless if
        // the helper helpfully supplies a default.
        if (state is not null) record["state"] = state.Value;
        if (disableReasons is not null) record["disable_reasons"] = disableReasons;

        var document = new Dictionary<string, object>
        {
            ["extensions"] = new Dictionary<string, object>
            {
                ["settings"] = new Dictionary<string, object>
                {
                    ["abcdefghijklmnopabcdefghijklmnop"] = record,
                },
            },
        };

        File.WriteAllText(Path.Combine(dir, fileName), System.Text.Json.JsonSerializer.Serialize(document));
    }

    /// <summary>
    /// Deletes BOTH preference files for a profile.
    ///
    /// Necessary because these fixtures reuse one profile folder: without it, a file
    /// written by an earlier case survives into the next one and the probe answers
    /// from the leftover. A test that passes because of a stale file is worse than
    /// no test — it would report the two-file fix as working while reading one file.
    /// </summary>
    private static void ResetChromeProfile(string root, string profile)
    {
        var dir = Path.Combine(root, profile);
        if (!Directory.Exists(dir)) return;

        foreach (var name in BrowserExtensionProbe.PreferenceFileNames)
        {
            var file = Path.Combine(dir, name);
            if (File.Exists(file)) File.Delete(file);
        }
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

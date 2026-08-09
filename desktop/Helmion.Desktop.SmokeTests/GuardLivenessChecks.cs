using Helmion.LocalService.Protocol;
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
            // The card used to be titled "Execution guard is LIVE", which requires
            // knowing what an execution guard is before it tells you anything.
            Assert(probe.Title.Contains("blocked", StringComparison.OrdinalIgnoreCase),
                "the card says in plain words that dangerous commands are being blocked");
            AssertPlainEnglish(probe.Title, probe.Detail, "the command-guard card when the guard is working");
            checks += 5;

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

        // --- 3. BLOCK LEDGER: AN EMPTY LOG IS NOT AN ALL-CLEAR -----------------
        //
        // THIS SECTION USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE WAS A LIE.
        //
        // It required an empty-but-created ledger to be GuardLevel.Normal, on the
        // reasoning that the folder plus a start-date marker turned "no rows" into
        // the computed fact "nothing was blocked". The panel creates that folder
        // ITSELF (MainWindow.GuardPanel.cs:353 calls EnsureLedger before every
        // read), so the card was reading back evidence the panel had just
        // manufactured, and reporting it green.
        //
        // A folder is not a recorder. Traced 2026-07-30:
        //   · the only production writer of a block row is bin/helmion.mjs:784,
        //     and it writes to process.cwd(), not to the registered workspace;
        //   · the in-agent execution gate never writes one — src/agent/tools.mjs:522
        //     is the only production caller of evaluateToolCall and it passes no
        //     auditWorkspace, so governance-gate.mjs:276 returns before recording;
        //   · the browser half cannot write anywhere: the extension is forbidden
        //     network and file access (extension/test/package.test.mjs:151).
        // Measured the same day, after a full day of use: E:\Helmion\.helmion\audit
        // held the marker and no blocks-*.jsonl at all, while the card read green.
        //
        // So an empty ledger genuinely CANNOT distinguish "nothing was blocked"
        // from "nothing was ever writing here", and Unknown is the only honest
        // answer. Green is reserved for a log that has actually been written to.
        var workspace = Path.Combine(Path.GetTempPath(), $"helmion-ledger-{Guid.NewGuid():N}");
        Directory.CreateDirectory(workspace);
        try
        {
            // Never started: unknown, and that was always right.
            var cold = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(workspace));
            Assert(cold.Level == GuardLevel.Unknown, "a ledger that was never started is Unknown, correctly");
            checks += 1;

            Assert(GuardAuditLog.EnsureLedger(workspace), "the ledger can be started");
            Assert(Directory.Exists(GuardAuditLog.DirectoryFor(workspace)), "the audit folder now exists");
            Assert(File.Exists(Path.Combine(GuardAuditLog.DirectoryFor(workspace), GuardAuditLog.LedgerMarkerFile)),
                "and it stamped when the folder was made");
            checks += 3;

            // Created, but nothing has ever written to it. STILL UNKNOWN.
            var warm = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(workspace));
            Assert(warm.Level == GuardLevel.Unknown,
                "a ledger that exists but has never been written to is UNKNOWN — creating a folder "
                + "is not evidence that anything was watching");
            Assert(!warm.Detail.Contains("none has happened", StringComparison.OrdinalIgnoreCase),
                "and it must NOT claim nothing was blocked, which it cannot know");
            Assert(warm.Detail.Contains("cannot tell", StringComparison.OrdinalIgnoreCase),
                "it says out loud that it cannot tell the two apart");
            checks += 3;

            // A log that HAS been written to is a real measurement, and green.
            File.WriteAllText(
                Path.Combine(GuardAuditLog.DirectoryFor(workspace), "blocks-2026-07-30.jsonl"),
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    timestamp = "2026-07-30T21:00:00.000Z",
                    layer = "execution",
                    matchedPattern = "rm -rf",
                    text = "rm -rf /",
                    source = "governance-gate",
                    outcome = "blocked",
                }) + Environment.NewLine);
            var written = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(workspace));
            Assert(written.Level == GuardLevel.Normal,
                "once something has actually been recorded, the log is a real measurement and reads OK");
            checks += 1;

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
            // WHICH FILE ANSWERED is carried on the record, not in the sentence he
            // reads. It is a real and important fact — it separates a store install
            // from a developer one, and reading the wrong file is the bug that made
            // this card say CRITICAL for months — but it is a fact for us, not for
            // him, so it lives here where a check can hold it.
            Assert(secureOnly.RecordFile == "Secure Preferences",
                "and the record says WHICH file the answer came from");
            checks += 3;

            // ONLY in plain Preferences — the store-install case, kept so the fix
            // for one file cannot break the other.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, disableReasons: []);
            var plainOnly = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(plainOnly.Installed && plainOnly.Level == GuardLevel.Normal,
                $"an extension recorded ONLY in plain Preferences still reads as installed (got: {plainOnly.Title})");
            Assert(plainOnly.RecordFile == "Preferences",
                "and that record names the plain file as the one that answered");
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

            // THIS ASSERTION USED TO PIN THE WORDING AND NOT THE MEANING. It
            // required the literal phrases "not recorded" and "not an all-clear",
            // so when the card was rewritten in plain English on 2026-07-30 the
            // check went red while the card was, if anything, better. Pinning a
            // phrase makes every honest rewrite look like a regression, and the
            // suite then gets ignored. What matters is that the card SAYS it could
            // not tell, and that it tells him what to do about it.
            Assert(silent.Detail.Contains("cannot tell", StringComparison.OrdinalIgnoreCase)
                || silent.Detail.Contains("could not tell", StringComparison.OrdinalIgnoreCase)
                || silent.Title.Contains("cannot tell", StringComparison.OrdinalIgnoreCase),
                "the card says in words that it could not tell");
            Assert(silent.Detail.Contains("chrome://extensions", StringComparison.Ordinal),
                "and it tells him where to look instead of leaving him with a shrug");
            AssertPlainEnglish(silent.Title, silent.Detail, "the browser card, when the switch is not recorded");
            checks += 5;

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
            // BOTH files really were searched — the fact that used to be spelled out
            // in the card text, kept here where it belongs.
            Assert(BrowserExtensionProbe.PreferenceFileNames.Count == 2,
                "and both of Chrome's record files are still in the search list");
            checks += 3;

            // Path comparison must survive separators and case.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences",
                extensionDir.Replace('\\', '/').ToUpperInvariant(), disableReasons: []);
            var normalized = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(normalized.Installed,
                "the path match survives forward slashes and different casing, as Chrome writes them");
            checks += 1;

            // A PROFILE THAT CANNOT BE PARSED IS NOT A PROFILE WITHOUT OUR
            // EXTENSION. FindInPreferences swallowed every exception and returned
            // the same null for "this file has no record of us" and "this file is
            // corrupt", while the file-existence counter had already been bumped —
            // so a machine whose Chrome records were unreadable was told, with
            // total confidence, that the browser guard is NOT INSTALLED. Wrong in
            // the alarming direction is still wrong, and it sends him to
            // chrome://extensions to fix something that is not broken.
            ResetChromeProfile(profileRoot, "Default");
            Directory.CreateDirectory(Path.Combine(profileRoot, "Default"));
            File.WriteAllText(Path.Combine(profileRoot, "Default", "Secure Preferences"), "{ this is not json");
            var corrupt = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(corrupt.Level == GuardLevel.Unknown,
                $"a profile whose records cannot be read is UNKNOWN, not 'not installed' (got: {corrupt.Title})");
            Assert(!corrupt.Title.Contains("NOT installed", StringComparison.OrdinalIgnoreCase),
                "and it never states as a fact that the extension is absent");
            AssertPlainEnglish(corrupt.Title, corrupt.Detail, "the browser card when Chrome's records are unreadable");
            checks += 3;

            // One unreadable file must not poison a good answer from the other.
            File.WriteAllText(Path.Combine(profileRoot, "Default", "Preferences"),
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    extensions = new { settings = new Dictionary<string, object>
                    {
                        ["abcdefghijklmnopabcdefghijklmnop"] = new Dictionary<string, object>
                        {
                            ["path"] = extensionDir,
                            ["disable_reasons"] = Array.Empty<int>(),
                        },
                    } },
                }));
            var oneGood = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            Assert(oneGood.Installed && oneGood.Level == GuardLevel.Normal,
                "a readable file still answers even when its neighbour is corrupt");
            checks += 1;

            // THE CARDS HE READS ARE IN PLAIN ENGLISH. Troy, 2026-07-30, on the
            // old wording: "That wording is still stupid and I don't know what the
            // fuck any of that shit is." A card naming a Chrome internal filename,
            // a JSON key and an absolute path is a card he skips, and a skipped
            // card is worse than no card. WHICH FILE ANSWERED still matters — it is
            // the difference between a store install and a developer one — so it
            // stays on the record as RecordFile, where the checks below read it,
            // rather than in the sentence he has to read.
            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Secure Preferences", extensionDir, disableReasons: []);
            var readable = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            AssertPlainEnglish(readable.Title, readable.Detail, "the browser card when the guard is on");

            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences", extensionDir, disableReasons: [1]);
            var readableOff = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            AssertPlainEnglish(readableOff.Title, readableOff.Detail, "the browser card when the guard is switched off");

            ResetChromeProfile(profileRoot, "Default");
            WriteChromeProfile(profileRoot, "Default", "Preferences",
                Path.Combine(Path.GetTempPath(), "someone-elses-ext"), state: 1);
            var readableGone = BrowserExtensionProbe.Inspect(extensionDir, [profileRoot]);
            AssertPlainEnglish(readableGone.Title, readableGone.Detail, "the browser card when the guard is missing");
            checks += 3;
        }
        finally
        {
            try { Directory.Delete(profileRoot, recursive: true); } catch { /* temp */ }
            try { Directory.Delete(extensionDir, recursive: true); } catch { /* temp */ }
        }

        // --- 5. A CARD MEASURED ONCE MUST NOT SPEAK IN THE PRESENT TENSE -------
        //
        // The browser card and the execution-guard card are published exactly once
        // each, from PublishStaticPostureCards (MainWindow.GuardPanel.cs:157-158),
        // and nothing calls either again. The execution card then says "Execution
        // guard is LIVE ... Probed just now" for the rest of the day. Six hours
        // later that is a green all-clear for a check that has not run since, which
        // is the same defect as an unknown rendering as OK, only slower.
        var measured = GuardFreshness.MeasuredAt(
            new DateTimeOffset(2026, 7, 30, 22, 37, 0, TimeSpan.Zero));
        Assert(measured.Contains("10:37", StringComparison.Ordinal),
            "the freshness sentence names the clock time the check actually ran");
        Assert(measured.Contains("not", StringComparison.OrdinalIgnoreCase)
            && measured.Contains("again", StringComparison.OrdinalIgnoreCase),
            "and says plainly that it is not checked again");
        AssertPlainEnglish("Checked once", measured, "the freshness sentence");
        checks += 3;

        // --- 6. NOBODY HAS ASKED YET IS NOT THE SAME AS NOT ANSWERING ----------
        //
        // The local-service card was published from a plain bool that defaults to
        // false (MainWindow.xaml.cs:43), inside the window constructor — and
        // App.xaml.cs:122-124 only starts the named-pipe hello AFTER the window is
        // shown. So the first thing on the panel was "Local service not connected ·
        // The read-only named-pipe service is not answering", stated about a check
        // that had not been attempted. Nothing had asked it anything.
        var unasked = LocalServicePosture.Describe(null);
        Assert(unasked.Level == GuardLevel.Unknown,
            "before anything has tried the service, the card is Unknown");
        Assert(!unasked.Detail.Contains("not answering", StringComparison.OrdinalIgnoreCase)
            && !unasked.Title.Contains("not connected", StringComparison.OrdinalIgnoreCase),
            "and it never claims a check failed when no check was made");
        AssertPlainEnglish(unasked.Title, unasked.Detail, "the local service card before anything asked");

        var answering = LocalServicePosture.Describe(true);
        Assert(answering.Level == GuardLevel.Normal, "a service that answered is OK");
        AssertPlainEnglish(answering.Title, answering.Detail, "the local service card when it answered");

        var silentService = LocalServicePosture.Describe(false);
        Assert(silentService.Level == GuardLevel.Warning, "a service that was asked and did not answer is a warning");
        Assert(silentService.Detail.Contains("keeps working", StringComparison.OrdinalIgnoreCase)
            || silentService.Detail.Contains("still works", StringComparison.OrdinalIgnoreCase),
            "and it says whether he needs to do anything about it");
        AssertPlainEnglish(silentService.Title, silentService.Detail, "the local service card when it did not answer");
        checks += 7;

        // --- 7. THE LEDGER CARDS ARE READABLE TOO ------------------------------
        var ledgerWorkspace = Path.Combine(Path.GetTempPath(), $"helmion-ledger-words-{Guid.NewGuid():N}");
        Directory.CreateDirectory(ledgerWorkspace);
        try
        {
            GuardAuditLog.EnsureLedger(ledgerWorkspace);
            var quietLedger = GuardAuditLog.LedgerHealth(GuardAuditLog.Read(ledgerWorkspace));
            AssertPlainEnglish(quietLedger.Title, quietLedger.Detail, "the block-log card when nothing has written to it");

            File.WriteAllText(
                Path.Combine(GuardAuditLog.DirectoryFor(ledgerWorkspace), "blocks-2026-07-30.jsonl"),
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    timestamp = "2026-07-30T21:00:00.000Z",
                    layer = "execution",
                    matchedPattern = "rm -rf",
                    text = "rm -rf /",
                    source = "governance-gate",
                    outcome = "blocked",
                }) + Environment.NewLine);

            var read = GuardAuditLog.Read(ledgerWorkspace);
            var busyLedger = GuardAuditLog.LedgerHealth(read, "Helmion");
            AssertPlainEnglish(busyLedger.Title, busyLedger.Detail, "the block-log card when it holds events");

            var rows = GuardAuditLog.ToObservations(read, "Helmion");
            Assert(rows.Count == 1, "the recorded block becomes exactly one card");
            Assert(rows[0].Level == GuardLevel.Critical, "a blocked command is red");
            AssertPlainEnglish(rows[0].Title, rows[0].Detail, "a blocked-command card");
            Assert(rows[0].Detail.Contains("rm -rf /", StringComparison.Ordinal),
                "and it still shows him what was about to run");
            checks += 6;

            // EVERY CARD NAMES WHOSE IT IS, INCLUDING THESE. Both of these used to
            // come out with no subject at all, so the panel showed a red card about
            // a blocked command and nothing on it said where the command had come
            // from or which project it belonged to.
            Assert(busyLedger.Subject == "Helmion" && rows[0].Subject == "Helmion",
                "the block-log cards name the project they belong to");

            // AND THEY SAY WHAT THEY CANNOT NAME. The recorded schema is timestamp,
            // layer, pattern, text, source, outcome (src/core/audit-log.mjs:52).
            // There is no session identity in it, so a blocked command genuinely
            // cannot be attributed to one of Troy's named agents, and the card has
            // to admit that rather than let the project name stand in for an agent.
            Assert(rows[0].Detail.Contains("does not record which agent", StringComparison.OrdinalIgnoreCase),
                "and a blocked-command card says out loud that the log cannot tell him which agent ran it");
            checks += 2;
        }
        finally
        {
            try { Directory.Delete(ledgerWorkspace, recursive: true); } catch { /* temp */ }
        }

        // --- 8. THE ONE BUTTON THAT CHANGES SOMETHING --------------------------
        //
        // Every other action on this panel is "check it again", which is safe by
        // construction. This one deletes a file, so it is the one that has to be
        // proven in both directions: it clears a lock nobody holds, and it REFUSES
        // in every other state rather than tidying away a live writer's claim.
        var lockRoot = Path.Combine(Path.GetTempPath(), $"helmion-lock-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(lockRoot, LeaseInspector.LeaseDirectoryName));
        try
        {
            var now = DateTimeOffset.Now;
            var leaseFile = LeaseInspector.LeaseFilePath(lockRoot);

            // Nothing there at all.
            Assert(!StaleLockRelease.Run(lockRoot, now).Cleared, "with no lock there is nothing to clear");
            Assert(StaleLockRelease.Run(lockRoot, now).Message.Contains("already gone", StringComparison.OrdinalIgnoreCase),
                "and it says so rather than reporting a success it did not have");
            Assert(!StaleLockRelease.Run(null, now).Cleared, "with no project open there is nothing to clear");
            checks += 3;

            // A LIVE lock, held by a process that really is running — this one.
            WriteLease(leaseFile, Environment.ProcessId, now.AddMinutes(30));
            var live = StaleLockRelease.Run(lockRoot, now);
            Assert(!live.Cleared, "a lock something is actually holding is NOT cleared");
            Assert(File.Exists(leaseFile), "and the file is still there afterwards");
            Assert(live.Message.Contains("two agents", StringComparison.OrdinalIgnoreCase),
                "and it says why in terms of what would go wrong");
            checks += 3;

            // Unreadable: refuse. "I cannot understand this" is never a reason to
            // delete it.
            File.WriteAllText(leaseFile, "{not json");
            var unreadable = StaleLockRelease.Run(lockRoot, now);
            Assert(!unreadable.Cleared && File.Exists(leaseFile),
                "a lock I cannot read is not cleared either");
            checks += 1;

            // EXPIRED: this is the one it exists for.
            WriteLease(leaseFile, Environment.ProcessId, now.AddMinutes(-1));
            var stale = StaleLockRelease.Run(lockRoot, now);
            Assert(stale.Cleared, $"an expired lock IS cleared (got: {stale.Message})");
            Assert(!File.Exists(leaseFile), "and the file is really gone, not just reported gone");
            AssertPlainEnglish("Cleared", stale.Message, "the cleared-lock message");
            checks += 3;
        }
        finally
        {
            try { Directory.Delete(lockRoot, recursive: true); } catch { /* temp */ }
        }

        Console.WriteLine($"Helmion guard liveness checks passed ({checks} checks).");
    }

    /// <summary>
    /// A lease file with every field src/core/lease.mjs:118 requires. Serialized,
    /// for the same reason the other two fixtures in this file are.
    /// </summary>
    private static void WriteLease(string path, int pid, DateTimeOffset expiresAt) =>
        File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(new
        {
            leaseToken = "token-for-the-check",
            projectSlug = "helmion",
            expiresAt = expiresAt.ToString("O"),
            pid,
            host = Environment.MachineName,
            coordinatorId = "claude-code",
            instanceId = $"{Environment.MachineName}:{pid}",
        }));

    /// <summary>
    /// Fails when a card says something only this codebase could understand.
    ///
    /// Troy reads these cards in a truck cab, on a phone, next to a buyer. A
    /// sentence naming a JSON key, a Chrome internal filename or an absolute
    /// Windows path is one he skips, and a card he skips is worse than no card at
    /// all because it takes up the space a readable one would have had.
    ///
    /// This bans the specific things that were actually ON the cards, not
    /// "technical words" in general — "extension", "Chrome" and "lease" are fine
    /// and necessary. The banned list grows only when a real card breaks the rule.
    /// </summary>
    private static void AssertPlainEnglish(string title, string detail, string what)
    {
        var text = $"{title} {detail}";

        foreach (var jargon in new[]
                 {
                     "disable_reasons", "extensions.settings", "Secure Preferences",
                     "JSON", "jsonl", ".helmion", "named pipe", "named-pipe",
                     "could not compute", "GuardLevel", "stdout", "exit code",
                     // "not an all-clear" is deliberately NOT banned. It is plain
                     // English, it is the single most important sentence on a grey
                     // card, and several checks require it verbatim.
                 })
        {
            Assert(!text.Contains(jargon, StringComparison.OrdinalIgnoreCase),
                $"{what} must not say \"{jargon}\" — plain English only. Got: {text}");
        }

        // An absolute Windows path, e.g. E:\Helmion\extension. He does not need a
        // path to act on any of these cards, and a path is the single most common
        // way one of these sentences turns into a stack trace.
        Assert(!System.Text.RegularExpressions.Regex.IsMatch(text, @"[A-Za-z]:\\"),
            $"{what} must not print a file path. Got: {text}");

        Assert(title.Length > 0 && detail.Length > 0, $"{what} has both a title and a detail");
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

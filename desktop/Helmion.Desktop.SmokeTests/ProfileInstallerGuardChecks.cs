using Helmion.Desktop.Core;

/// <summary>
/// Guards the promise that <see cref="ClaudeProfileInstaller"/> never destroys a
/// living user document.
///
/// WHY THIS EXISTS. On 2026-07-28 this installer overwrote Troy's
/// ~/.claude/BASE_RULES.md — 5,512 bytes / 105 lines of his own writing, his
/// supreme-rules file — with a 1,635-byte template. No backup was produced,
/// because the backup branch only runs when overwriting is explicitly requested.
/// The content was eventually recovered byte-exact from Claude Code session
/// transcripts, but nothing on disk survived. The same write hit LEARNINGS.md and
/// LESSONS.md; LEARNINGS.md happened to hold only the template already, so nothing
/// was lost there, but LESSONS.md lost real entries.
///
/// The preserve-existing default was added the same day. NOTHING TESTED IT. A
/// future edit flipping that default back would silently destroy the file again
/// and every suite would stay green. These checks are that missing tripwire, and
/// they run against a temp directory — never the real ~/.claude.
/// </summary>
internal static class ProfileInstallerGuardChecks
{
    public static void Run()
    {
        var checks = 0;

        var sandbox = Path.Combine(
            Path.GetTempPath(),
            $"helmion-installer-guard-{Guid.NewGuid():N}");
        Directory.CreateDirectory(sandbox);

        try
        {
            // Every template file the installer can write. If a new living document
            // is ever added to the template set, it is covered automatically.
            var approved = new HashSet<string>
            {
                "HELMION_CLAUDE.md",
                "BASE_RULES.md",
                "LEARNINGS.md",
                "LESSONS.md",
            };

            // --- 1. A file that already exists is NEVER replaced by default -------
            var userAuthored = new Dictionary<string, string>
            {
                ["BASE_RULES.md"] = "# MY OWN RULES\nDo not clobber me.\n",
                ["LESSONS.md"] = "# MY LESSONS\nHard-won.\n",
                ["LEARNINGS.md"] = "# MY LEARNINGS\nAlso mine.\n",
            };

            foreach (var (name, body) in userAuthored)
            {
                File.WriteAllText(Path.Combine(sandbox, name), body);
            }

            var result = ClaudeProfileInstaller
                .InstallAsync(approved, CancellationToken.None, targetDirectory: sandbox)
                .GetAwaiter().GetResult();

            Assert(result.Success, "installer reports success against a temp directory");
            checks++;

            foreach (var (name, body) in userAuthored)
            {
                var onDisk = File.ReadAllText(Path.Combine(sandbox, name));
                Assert(
                    onDisk == body,
                    $"{name} survived the installer byte-for-byte (this is the check that "
                    + "would have caught the 2026-07-28 destruction)");
                checks++;
            }

            // --- 2. A file that does NOT exist is still created -------------------
            // The guard must not break first-run setup for a new user.
            var freshPath = Path.Combine(sandbox, "HELMION_CLAUDE.md");
            Assert(File.Exists(freshPath), "an absent template file is still installed");
            Assert(
                new FileInfo(freshPath).Length > 0,
                "the newly installed template is not empty");
            checks += 2;

            // --- 3. overwriteExisting=true STILL cannot touch a living document ---
            //
            // REWRITTEN 2026-07-29 on Troy's instruction. This check used to assert
            // the opposite: that an explicit overwrite DOES replace BASE_RULES.md as
            // long as it takes a .bak first. That was the loaded gun — on 2026-07-29
            // the shipped binary re-templated BASE_RULES.md and LESSONS.md again.
            // His instruction: "No deletion, no reset, just a straight copy." So the
            // flag no longer reaches a living document at all, and this proves it.
            var explicitResult = ClaudeProfileInstaller
                .InstallAsync(approved, CancellationToken.None, overwriteExisting: true, targetDirectory: sandbox)
                .GetAwaiter().GetResult();

            Assert(explicitResult.Success, "explicit overwrite reports success");
            checks++;

            foreach (var (name, body) in userAuthored)
            {
                var onDisk = File.ReadAllText(Path.Combine(sandbox, name));
                Assert(
                    onDisk == body,
                    $"{name} survived even overwriteExisting:true — a living document has no "
                    + "overwrite path, by flag or otherwise");
                checks++;
            }

            Assert(
                Directory.GetFiles(sandbox, "BASE_RULES.md.*.bak").Length == 0,
                "no .bak was needed for BASE_RULES.md because nothing was replaced");
            checks++;

            // A Helmion-OWNED file is still replaceable on explicit opt-in, and still
            // gets a backup first. The guarantee is scoped to the operator's
            // documents, not a blanket refusal to ever write anything.
            var ownedBackups = Directory.GetFiles(sandbox, "HELMION_CLAUDE.md.*.bak");
            Assert(
                ownedBackups.Length > 0,
                "an explicit overwrite of a Helmion-owned file still wrote a timestamped .bak");
            checks++;

            // --- 4. A NEW profile CARRIES the operator's content forward ----------
            //
            // Troy's instruction: "copies your existing content forward as-is into
            // the new profile ... so the new client starts with the same accumulated
            // rules and lessons you've already built." Not the template. His bytes.
            var newProfile = Path.Combine(
                Path.GetTempPath(),
                $"helmion-newprofile-{Guid.NewGuid():N}");
            Directory.CreateDirectory(newProfile);
            try
            {
                var carryResult = ClaudeProfileInstaller
                    .InstallAsync(
                        approved,
                        CancellationToken.None,
                        targetDirectory: newProfile,
                        carryForwardFrom: sandbox)
                    .GetAwaiter().GetResult();

                Assert(carryResult.Success, "installing into a brand-new profile succeeds");
                checks++;

                foreach (var (name, body) in userAuthored)
                {
                    var seeded = File.ReadAllText(Path.Combine(newProfile, name));
                    Assert(
                        seeded == body,
                        $"the new profile's {name} is the operator's accumulated content, "
                        + "copied forward byte-for-byte, NOT a blank template");
                    checks++;
                }

                // And the fallback still works: a living document with nothing to
                // carry gets the starter template rather than an empty file.
                var bare = Path.Combine(Path.GetTempPath(), $"helmion-bare-{Guid.NewGuid():N}");
                var emptySource = Path.Combine(Path.GetTempPath(), $"helmion-empty-{Guid.NewGuid():N}");
                Directory.CreateDirectory(bare);
                Directory.CreateDirectory(emptySource);
                try
                {
                    ClaudeProfileInstaller
                        .InstallAsync(
                            approved,
                            CancellationToken.None,
                            targetDirectory: bare,
                            carryForwardFrom: emptySource)
                        .GetAwaiter().GetResult();

                    var seededFresh = Path.Combine(bare, "BASE_RULES.md");
                    Assert(File.Exists(seededFresh), "a first-run machine still gets BASE_RULES.md");
                    Assert(
                        new FileInfo(seededFresh).Length > 0,
                        "the first-run BASE_RULES.md is the template, not an empty file");
                    checks += 2;
                }
                finally
                {
                    try { Directory.Delete(bare, recursive: true); } catch { /* temp dir */ }
                    try { Directory.Delete(emptySource, recursive: true); } catch { /* temp dir */ }
                }
            }
            finally
            {
                try { Directory.Delete(newProfile, recursive: true); } catch { /* temp dir */ }
            }
        }
        finally
        {
            try { Directory.Delete(sandbox, recursive: true); } catch { /* temp dir */ }
        }

        Console.WriteLine($"Helmion profile installer guard checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Profile installer guard failed: {what}");
        }
    }
}

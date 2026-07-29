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

            // --- 3. Opting IN to overwrite takes a backup FIRST -------------------
            var explicitResult = ClaudeProfileInstaller
                .InstallAsync(approved, CancellationToken.None, overwriteExisting: true, targetDirectory: sandbox)
                .GetAwaiter().GetResult();

            Assert(explicitResult.Success, "explicit overwrite reports success");
            checks++;

            var backups = Directory.GetFiles(sandbox, "BASE_RULES.md.*.bak");
            Assert(
                backups.Length > 0,
                "an explicit overwrite wrote a timestamped .bak before replacing the file");
            checks++;

            var backedUp = File.ReadAllText(backups[0]);
            Assert(
                backedUp == userAuthored["BASE_RULES.md"],
                "the .bak holds the user's original content, not the template");
            checks++;
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

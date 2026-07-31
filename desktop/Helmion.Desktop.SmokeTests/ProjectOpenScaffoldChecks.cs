using Helmion.Desktop.Core;

/// <summary>
/// Opening a project must LAY DOWN THE PROJECT STRUCTURE, and must be safe to do
/// every single time it is opened.
///
/// WHY THIS EXISTS. Until 2026-07-30 `MainWindow.ProjectShelf.cs:141-150` — the
/// whole of "open a project" — was two statements: assign a field, navigate. It
/// created nothing. The scaffolder had existed and worked for days; nothing on
/// the open path called it, so Troy's requirement that opening a project lays
/// down its folder structure had no implementation at all, and no test could
/// have failed to tell anyone.
///
/// The second half matters as much as the first: opening is not a once-per-life
/// event, it happens every time he clicks the shelf. So the interesting
/// assertion is not "files appear" but "files appear the first time and NOT ONE
/// BYTE moves on every open after that". `src/core/project-scaffold.mjs:189-193`
/// only ever emits create or preserve, and `:213-218` writes with flag 'wx' so a
/// file appearing mid-run is downgraded to preserve rather than overwritten.
/// These checks prove that guarantee survives the trip through the desktop, with
/// a sentinel read back byte-for-byte — the same way the repo proved it in
/// `test/project-scaffold.test.mjs`, because this repo destroyed a real
/// 5,512-byte rules file twice by templating over it.
/// </summary>
internal static class ProjectOpenScaffoldChecks
{
    public static void Run()
    {
        var checks = 0;
        var helmionRoot = FindHelmionRoot();
        if (helmionRoot is null)
        {
            // Honest skip, printed. The scaffolder is Helmion's own CLI; without
            // the repo there is nothing to shell out to, and asserting anyway
            // would be a statement about the machine, not the code.
            Console.WriteLine(
                "  SKIPPED (5 checks): project-open scaffold — bin/helmion.mjs not found "
                + "from this build. Not a pass.");
            return;
        }

        var sandbox = Path.Combine(
            Path.GetTempPath(),
            $"helmion-open-scaffold-{Guid.NewGuid():N}");
        var projectDir = Path.Combine(sandbox, "invoice-importer");
        Directory.CreateDirectory(projectDir);

        try
        {
            // --- 1. A folder with no structure gets one -------------------------
            Assert(
                ProjectOpenScaffold.ShouldScaffold(projectDir, out _),
                "a project folder with no PROJECT.md is scaffolded on open");

            var first = ProjectOpenScaffold
                .EnsureStructureAsync(helmionRoot, projectDir)
                .GetAwaiter().GetResult();

            Assert(
                first.Attempted && first.Ok,
                $"opening a project lays down its structure ({first.Summary})");

            // Assert on DISK, not on the report. A report is a claim; the files
            // are the fact, and it is the files a coding session actually reads.
            string[] required =
            [
                "PROJECT.md",
                Path.Combine("planning", "requirements.md"),
                Path.Combine("planning", "blueprint.md"),
                Path.Combine("planning", "acceptance-criteria.md"),
                Path.Combine("docs", "ARCHITECTURE.md"),
                Path.Combine("sprints", "sprint-001", "handoff-prompt.md"),
            ];
            var missing = required
                .Where(rel => !File.Exists(Path.Combine(projectDir, rel)))
                .ToList();
            Assert(
                missing.Count == 0,
                missing.Count == 0
                    ? "every planning file a zero-context session reads is on disk"
                    : $"MISSING after open: {string.Join(", ", missing)}");
            checks += 3;

            // --- 2. Re-opening preserves the operator's own writing -------------
            // The whole point: he opens the same project tomorrow, having filled
            // requirements.md in with hours of his own reasoning.
            var sentinelPath = Path.Combine(projectDir, "planning", "requirements.md");
            const string sentinel =
                "# MY OWN REQUIREMENTS\n\nsentinel-alpha — hours of reasoning no template can rebuild\n";
            File.WriteAllText(sentinelPath, sentinel);
            var before = File.ReadAllBytes(sentinelPath);

            var second = ProjectOpenScaffold
                .EnsureStructureAsync(helmionRoot, projectDir)
                .GetAwaiter().GetResult();

            Assert(second.Ok, "re-opening an already-structured project still succeeds");

            Assert(
                File.ReadAllBytes(sentinelPath).SequenceEqual(before),
                "re-opening leaves an edited planning file BYTE-FOR-BYTE untouched");
            checks += 2;
        }
        finally
        {
            try { Directory.Delete(sandbox, recursive: true); } catch { /* temp dir */ }
        }

        Console.WriteLine($"Helmion project-open scaffold smoke tests passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Project-open scaffold check failed: {what}");
        }
    }

    /// <summary>
    /// Walk up for bin/helmion.mjs, the same way <c>AgentBridge</c> does, but
    /// WITHOUT any hardcoded drive letter — a test that only passes on one
    /// machine is not a test.
    /// </summary>
    private static string? FindHelmionRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 10 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "bin", "helmion.mjs")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        return null;
    }
}

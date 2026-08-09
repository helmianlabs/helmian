using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under the left panel's project shelf.
///
/// The shelf reads the DISK, not a saved list, and that choice is the thing worth
/// protecting: a registry file kept in settings goes stale the moment a folder is
/// renamed, moved or deleted outside the app, and then the panel offers projects
/// that are not there. These checks run against real temp directories so the
/// discovery rules are proven against actual folders rather than a stub that
/// answers yes to whatever it is asked.
/// </summary>
internal static class ProjectShelfChecks
{
    public static void Run()
    {
        var checks = 0;

        // --- 0. CUSTOMER DEFAULT IS PURE AND PRESERVES EXPLICIT WORKSPACES ---
        var documents = Path.Combine(Path.GetTempPath(), $"helmian-documents-{Guid.NewGuid():N}");
        var expectedCustomerRoot = Path.Combine(documents, "Helmian Projects");
        var existingExplicit = Path.Combine(Path.GetTempPath(), $"helmian-existing-{Guid.NewGuid():N}");
        var knownExisting = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            Path.GetFullPath(existingExplicit)
        };
        bool Exists(string path) => knownExisting.Contains(Path.GetFullPath(path));

        Assert(ProjectWorkspaceDefaults.Resolve(null, null, null, documents, Exists)
                == Path.GetFullPath(expectedCustomerRoot),
            "a new customer defaults to Documents\\Helmian Projects");
        Assert(ProjectWorkspaceDefaults.Resolve(existingExplicit, null, null, documents, Exists)
                == Path.GetFullPath(existingExplicit),
            "an existing registered workspace such as E:\\Helmion is preserved");
        Assert(ProjectWorkspaceDefaults.Resolve(null, "Z:\\stale", existingExplicit, documents, Exists)
                == Path.GetFullPath(existingExplicit),
            "a stale higher-priority preference falls through to an existing saved workspace");
        Assert(ProjectWorkspaceDefaults.IsCustomerRoot(
                expectedCustomerRoot.ToUpperInvariant(), documents),
            "the customer-default identity is case-insensitive on Windows");
        Assert(!Directory.Exists(expectedCustomerRoot),
            "resolving the default is read-only and creates no folder");
        checks += 5;

        Assert(WorkbenchSurfaceCatalog.All.Select(item => item.Label)
                .SequenceEqual(new[] { "Guard", "Browser", "Canvas", "Preview", "Create" }),
            "the right workbench exposes the five approved surfaces in order");
        Assert(WorkbenchSurfaceCatalog.All.All(item => !item.CanExecute),
            "the first workbench slice invents no hidden execution path");
        Assert(WorkbenchSurfaceCatalog.Find("create")?.Boundary.Contains(
                "approval before any API call", StringComparison.OrdinalIgnoreCase) == true,
            "Create states that approval precedes a provider call");
        checks += 3;

        var root = Path.Combine(Path.GetTempPath(), $"helmion-shelf-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            // --- 1. PROJECT.md IS THE MARKER, NOT THE FOLDER NAME --------------
            var real = Path.Combine(root, "invoice-importer");
            Directory.CreateDirectory(Path.Combine(real, "planning"));
            Directory.CreateDirectory(Path.Combine(real, "docs"));
            Directory.CreateDirectory(Path.Combine(real, "prompts"));
            Directory.CreateDirectory(Path.Combine(real, "sprints", "sprint-001"));
            Directory.CreateDirectory(Path.Combine(real, "sprints", "sprint-002"));
            File.WriteAllText(Path.Combine(real, "PROJECT.md"), "# Invoice Importer\n\nA real project.\n");

            // A folder that looks like a project but has no marker.
            var impostor = Path.Combine(root, "not-a-project");
            Directory.CreateDirectory(Path.Combine(impostor, "planning"));

            var found = ProjectShelf.Discover(root);
            Assert(found.Count == 1, "only the folder carrying PROJECT.md is a project");
            Assert(found[0].Slug == "invoice-importer", "the slug is the folder name");
            checks += 2;

            // --- 2. THE TITLE COMES FROM THE FILE, NOT THE SLUG ---------------
            // The operator typed "Invoice Importer"; showing them "invoice-importer"
            // back is a small daily insult a panel does not need to commit.
            Assert(found[0].Name == "Invoice Importer",
                "the display name is the H1 inside PROJECT.md, not the hyphenated folder");
            checks += 1;

            // --- 3. THE STRUCTURE IS REPORTED, SO HALF-BUILT READS AS HALF-BUILT
            Assert(found[0].Parts.SequenceEqual(new[] { "planning", "sprints", "docs", "prompts" }),
                "every structured folder present is listed, in a fixed order");
            Assert(found[0].SprintCount == 2, "sprints are counted");
            Assert(found[0].PartsText.Contains("2 sprints", StringComparison.Ordinal),
                "the second line states the sprint count in words");
            checks += 3;

            var bare = Path.Combine(root, "bare-project");
            Directory.CreateDirectory(bare);
            File.WriteAllText(Path.Combine(bare, "PROJECT.md"), "# Bare\n");
            var bareSummary = ProjectShelf.Describe(bare)!;
            Assert(bareSummary.Parts.Count == 0, "a project with no structured folders reports none");
            Assert(bareSummary.PartsText.Contains("no planning folder yet", StringComparison.Ordinal),
                "a bare project SAYS it is bare rather than showing an empty line");
            checks += 2;

            // --- 4. NEWEST FIRST ----------------------------------------------
            File.SetLastWriteTimeUtc(Path.Combine(real, "PROJECT.md"), DateTime.UtcNow.AddHours(-3));
            File.SetLastWriteTimeUtc(Path.Combine(bare, "PROJECT.md"), DateTime.UtcNow);
            var ordered = ProjectShelf.Discover(root);
            Assert(ordered.Count == 2 && ordered[0].Slug == "bare-project",
                "the most recently touched project is first — it is the one being worked on");
            checks += 1;

            // --- 5. NOISE FOLDERS ARE SKIPPED ---------------------------------
            foreach (var noise in new[] { "node_modules", "bin", "obj", "artifacts", ".git" })
            {
                var dir = Path.Combine(root, noise);
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "PROJECT.md"), "# Should not appear\n");
            }
            var afterNoise = ProjectShelf.Discover(root);
            Assert(afterNoise.Count == 2,
                "node_modules, bin, obj, artifacts and dot-folders are never offered as projects");
            checks += 1;

            // --- 6. THE ROOT ITSELF COUNTS WHEN IT IS A PROJECT ----------------
            File.WriteAllText(Path.Combine(root, "PROJECT.md"), "# The Root Itself\n");
            var withRoot = ProjectShelf.Discover(root);
            Assert(withRoot.Any(p => p.Name == "The Root Itself"),
                "a workspace that is itself a project appears in its own shelf");
            checks += 1;

            // --- 6b. PINS SORT, THEY DO NOT FILTER ----------------------------
            // Claude, ChatGPT and Gemini all put pinned items above recents. A pin
            // is a deliberate choice and outranks recency, which is only a guess.
            File.SetLastWriteTimeUtc(Path.Combine(real, "PROJECT.md"), DateTime.UtcNow.AddHours(-5));
            var pinnedFirst = ProjectShelf.Discover(root, new[] { "invoice-importer" });
            Assert(pinnedFirst[0].Slug == "invoice-importer",
                "a pinned project sorts above a more recently touched one");
            Assert(pinnedFirst[0].IsPinned && pinnedFirst[0].PinGlyph == "★",
                "a pinned project says so with a filled star");
            Assert(pinnedFirst.Count == withRoot.Count,
                "pinning SORTS the shelf; it never removes anything from it");
            Assert(pinnedFirst.Skip(1).All(p => !p.IsPinned && p.PinGlyph == "☆"),
                "everything else stays unpinned with a hollow star");
            // A pin naming a folder that is gone is harmless - that is why a pin
            // may live in settings while the project list may not.
            var ghostPin = ProjectShelf.Discover(root, new[] { "deleted-last-week" });
            Assert(ghostPin.Count == withRoot.Count && ghostPin.All(p => !p.IsPinned),
                "a pin for a project that no longer exists matches nothing and breaks nothing");
            checks += 5;

            // --- 6c. THE ACTIVE PROJECT IS EXPLICIT ---------------------------
            var active = ProjectShelf.Discover(root, null, null, real);
            Assert(active.Single(project => project.Slug == "invoice-importer").IsActive,
                "the registered project is marked active on the shelf");
            Assert(active.Where(project => project.Slug != "invoice-importer").All(project => !project.IsActive),
                "only the registered project is active");
            Assert(active.Single(project => project.Slug == "invoice-importer")
                    .AccessibleName.Contains("active project", StringComparison.OrdinalIgnoreCase),
                "the active state is spelled out for accessibility, not conveyed by color alone");
            Assert(ProjectShelf.Discover(root).All(project => !project.IsActive),
                "a shelf with no registered project invents no selection");
            checks += 4;

            // --- 6d. SEARCH MATCHES TITLE OR SLUG -----------------------------
            Assert(ProjectShelf.Discover(root, null, "Invoice").Single().Slug == "invoice-importer",
                "search matches the readable title");
            Assert(ProjectShelf.Discover(root, null, "invoice-imp").Single().Slug == "invoice-importer",
                "search matches the hyphenated slug too, so either way of typing it works");
            Assert(ProjectShelf.Discover(root, null, "INVOICE").Count == 1, "search is case-insensitive");
            Assert(ProjectShelf.Discover(root, null, "   ").Count == withRoot.Count,
                "a blank filter shows everything rather than nothing");
            Assert(ProjectShelf.Discover(root, null, "zzz-no-such-thing").Count == 0,
                "a filter that matches nothing returns nothing — the caller says so in words");
            checks += 5;

            // --- 7. DEGENERATE INPUT DOES NOT THROW ---------------------------
            // The panel must never blank because a path was missing. A new machine
            // with no workspace is a normal state, not an error.
            Assert(ProjectShelf.Discover(null).Count == 0, "a null root is an empty shelf, not a crash");
            Assert(ProjectShelf.Discover("   ").Count == 0, "a blank root is an empty shelf");
            Assert(ProjectShelf.Discover(Path.Combine(root, "does-not-exist")).Count == 0,
                "a missing root is an empty shelf");
            Assert(ProjectShelf.Describe(Path.Combine(root, "does-not-exist")) is null,
                "describing a folder that is not there returns null rather than throwing");
            Assert(ProjectShelf.Describe(impostor) is null, "a folder with no PROJECT.md is not describable");
            checks += 5;
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* temp dir */ }
        }

        // --- 8. THE SCAFFOLD RUNNER REFUSES BEFORE IT SPAWNS ANYTHING ---------
        // Each of these must fail with a sentence, not by launching node and
        // letting it error somewhere the operator cannot see.
        var noName = ProjectScaffoldRunner.InitAsync("E:\\Helmion", Path.GetTempPath(), "   ")
            .GetAwaiter().GetResult();
        Assert(!noName.Ok && noName.Summary.Contains("needs a name", StringComparison.Ordinal),
            "a nameless project is refused with a reason");

        var noRoot = ProjectScaffoldRunner.InitAsync("E:\\Helmion", Path.Combine(Path.GetTempPath(), "nope-" + Guid.NewGuid()), "X")
            .GetAwaiter().GetResult();
        Assert(!noRoot.Ok && noRoot.Summary.Contains("does not exist", StringComparison.Ordinal),
            "a missing project root is refused with the path named");

        var noCli = ProjectScaffoldRunner.InitAsync(Path.GetTempPath(), Path.GetTempPath(), "X")
            .GetAwaiter().GetResult();
        Assert(!noCli.Ok && noCli.Summary.Contains("helmion.mjs", StringComparison.Ordinal),
            "a missing CLI is named, and the message still tells the operator the command to run");
        checks += 3;

        // The runner reads the CLI's own --json report rather than parsing prose.
        Assert(ProjectScaffoldRunner.ExtractDirectory("{\"directory\":\"E:\\\\work\\\\thing\"}") == "E:\\work\\thing",
            "the created directory is taken from the CLI's json report");
        Assert(ProjectScaffoldRunner.ExtractDirectory("not json at all") is null,
            "unparseable output does not throw — the run still succeeded, the folder just is not named");
        Assert(ProjectScaffoldRunner.ExtractDirectory("{\"other\":1}") is null,
            "a report without a directory field returns null rather than inventing one");
        checks += 3;

        Console.WriteLine($"Helmion project shelf checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Project shelf failed: {what}");
        }
    }
}

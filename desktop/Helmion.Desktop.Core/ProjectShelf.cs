namespace Helmion.Desktop.Core;

/// <summary>
/// One scaffolded project, as the left panel shows it.
/// </summary>
/// <param name="Parts">
/// Which of the structured folders actually exist — "planning", "sprints",
/// "docs", "prompts". Shown under the name so a half-built project reads as
/// half-built instead of looking identical to a complete one.
/// </param>
public sealed record ProjectSummary(
    string Name,
    string Slug,
    string Directory,
    IReadOnlyList<string> Parts,
    int SprintCount,
    DateTime LastWriteUtc)
{
    /// <summary>The second line in the panel. Never empty.</summary>
    public string PartsText => Parts.Count == 0
        ? "PROJECT.md only — no planning folder yet"
        : string.Join(" · ", Parts) + (SprintCount > 0 ? $" · {SprintCount} sprint{(SprintCount == 1 ? "" : "s")}" : string.Empty);
}

/// <summary>
/// Finds the projects `helmion project init` has written, for the left panel.
///
/// WHAT MAKES A FOLDER A PROJECT. `scaffoldProject` writes PROJECT.md at the root
/// of `&lt;cwd&gt;/&lt;slug&gt;/` (src/core/project-scaffold.mjs:224 defaultProjectDirectory,
/// :248). PROJECT.md is therefore the marker — not the folder name, not a registry
/// file that could drift from the disk. If the file is there, the project is real;
/// if it is not, the folder is somebody else's and this leaves it alone.
///
/// NO REGISTRY ON PURPOSE. A list of projects kept in a settings file is a second
/// source of truth that goes stale the moment a folder is renamed, moved or
/// deleted outside the app — and then the panel shows projects that are not there.
/// The disk is the registry.
///
/// Filesystem reads only, one level deep, so it can be proven against temp
/// directories with no window open.
/// </summary>
public static class ProjectShelf
{
    public const string MarkerFile = "PROJECT.md";

    /// <summary>The structured folders the scaffold writes, in the order shown.</summary>
    private static readonly string[] StructuredParts = ["planning", "sprints", "docs", "prompts"];

    /// <summary>
    /// Projects directly under <paramref name="root"/>, plus the root itself when
    /// it is a project. Newest first, because the one you are working on is
    /// almost always the one you touched last.
    ///
    /// An unreadable root returns an empty list rather than throwing: a missing
    /// folder is a normal state for a new machine, and the panel says "no projects
    /// yet" rather than showing an error nobody can act on.
    /// </summary>
    public static IReadOnlyList<ProjectSummary> Discover(string? root)
    {
        if (string.IsNullOrWhiteSpace(root) || !System.IO.Directory.Exists(root))
        {
            return [];
        }

        var found = new List<ProjectSummary>();

        try
        {
            if (File.Exists(Path.Combine(root, MarkerFile)))
            {
                var self = Describe(root);
                if (self is not null) found.Add(self);
            }

            foreach (var dir in System.IO.Directory.EnumerateDirectories(root))
            {
                var name = Path.GetFileName(dir);
                // Skip the folders every repo has and no project lives in.
                if (name.StartsWith('.') || name is "node_modules" or "bin" or "obj" or "artifacts") continue;
                if (!File.Exists(Path.Combine(dir, MarkerFile))) continue;

                var summary = Describe(dir);
                if (summary is not null) found.Add(summary);
            }
        }
        catch (Exception)
        {
            // A permission error part-way through returns what was found rather
            // than nothing. A partial list is honest; an exception here would
            // blank the panel over one unreadable subfolder.
        }

        return found.OrderByDescending(project => project.LastWriteUtc).ToList();
    }

    /// <summary>Reads one project folder. Null when it cannot be read at all.</summary>
    public static ProjectSummary? Describe(string directory)
    {
        try
        {
            var marker = Path.Combine(directory, MarkerFile);
            if (!File.Exists(marker)) return null;

            var slug = Path.GetFileName(directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            var parts = StructuredParts
                .Where(part => System.IO.Directory.Exists(Path.Combine(directory, part)))
                .ToList();

            var sprintsDir = Path.Combine(directory, "sprints");
            var sprintCount = System.IO.Directory.Exists(sprintsDir)
                ? System.IO.Directory.EnumerateDirectories(sprintsDir).Count()
                : 0;

            return new ProjectSummary(
                ReadDisplayName(marker) ?? slug,
                slug,
                directory,
                parts,
                sprintCount,
                File.GetLastWriteTimeUtc(marker));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The project's own title, taken from the first markdown H1 in PROJECT.md.
    ///
    /// The folder slug is the fallback, never the first choice: the slug is
    /// lowercased and hyphenated ("invoice-importer") and the operator typed
    /// something readable ("Invoice Importer"). Showing them the slug back is a
    /// small daily insult a panel does not need to commit.
    /// </summary>
    private static string? ReadDisplayName(string markerPath)
    {
        try
        {
            foreach (var line in File.ReadLines(markerPath).Take(40))
            {
                var trimmed = line.TrimStart();
                if (!trimmed.StartsWith("# ", StringComparison.Ordinal)) continue;
                var title = trimmed[2..].Trim();
                if (title.Length > 0) return title;
            }
        }
        catch (Exception)
        {
            // Unreadable title is not a reason to hide a project that exists.
        }

        return null;
    }
}

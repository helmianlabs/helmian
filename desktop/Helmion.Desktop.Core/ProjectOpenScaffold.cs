namespace Helmion.Desktop.Core;

/// <summary>What happened when a project was opened.</summary>
/// <param name="Attempted">
/// False when nothing was tried. That is an EMPTY state, not a failure — the
/// same distinction <see cref="FirstRunStates"/> exists to hold.
/// </param>
/// <param name="Ok">True when the structure is on disk afterwards.</param>
/// <param name="Summary">A sentence safe to show. Never empty.</param>
public sealed record ProjectOpenOutcome(bool Attempted, bool Ok, string Summary)
{
    public static ProjectOpenOutcome NotAttempted(string why) => new(false, false, why);
}

/// <summary>
/// OPENING A PROJECT LAYS DOWN ITS STRUCTURE.
///
/// WHY THIS FILE EXISTS. Until 2026-07-30 the whole of "open a project" was two
/// statements in <c>MainWindow.ProjectShelf.cs</c> — assign a field, navigate —
/// and it created nothing. The scaffolder had been working for days; nothing on
/// the open path called it. Troy's requirement that opening a project lays down
/// the folder structure had no implementation at all.
///
/// IT DOES NOT WRITE A SECOND SCAFFOLDER. <see cref="ProjectScaffoldRunner"/>
/// shells out to <c>helmion project init</c>, and
/// <c>src/core/project-scaffold.mjs</c> is the single source of truth for what a
/// project contains. A C# reimplementation would drift, and the day it drifts is
/// the day opening a project stops producing what the CLI produces.
///
/// WHY RUNNING IT ON EVERY OPEN IS SAFE — verified in the code, not assumed:
/// <c>project-scaffold.mjs:189-193</c> emits only <c>create</c> or
/// <c>preserve</c>; there is no update, no append, no overwrite, and no flag
/// that adds one. <c>:213-218</c> writes with flag <c>'wx'</c>, so a file that
/// appears between the plan and the write is downgraded to <c>preserve</c>
/// rather than clobbered — the race is closed, not merely unlikely. That is what
/// makes this callable on a click Troy repeats twenty times a day, and it is
/// asserted end-to-end with a byte-for-byte sentinel in
/// <c>ProjectOpenScaffoldChecks</c>.
///
/// The decision lives in Core rather than in the window for the same reason
/// <see cref="FirstRunStates"/> does: the headless suite can assert it, and a
/// proof that needs a WPF window on screen is no proof at all.
/// </summary>
public static class ProjectOpenScaffold
{
    /// <summary>
    /// Whether opening this directory should lay the structure down, and why not
    /// when it should not.
    ///
    /// An already-scaffolded project still returns true. The run is a no-op that
    /// reports every file preserved, and it is what repairs a project that
    /// predates a template the tree has since grown — skipping on "PROJECT.md
    /// exists" would freeze every project at the shape it was created with.
    /// </summary>
    public static bool ShouldScaffold(string? directory, out string why)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            why = "No project directory was given, so there is nothing to set up.";
            return false;
        }

        try
        {
            if (!Directory.Exists(directory))
            {
                why = $"That project folder is not there any more: {directory}. "
                    + "The shelf reads the disk on every refresh, so it will drop out.";
                return false;
            }
        }
        catch (Exception ex)
        {
            why = $"Could not read that project folder: {ex.Message}";
            return false;
        }

        why = "Laying down the project structure.";
        return true;
    }

    /// <summary>
    /// Make sure the opened project has its structure, creating only what is
    /// missing. Never throws: opening a project must not be able to fail with an
    /// exception in the caller's face.
    /// </summary>
    public static async Task<ProjectOpenOutcome> EnsureStructureAsync(
        string helmionRoot,
        string directory,
        CancellationToken cancellationToken = default)
    {
        if (!ShouldScaffold(directory, out var why))
        {
            return ProjectOpenOutcome.NotAttempted(why);
        }

        try
        {
            // The folder is ALREADY named, so it is both the destination and the
            // project name. Passing it as --dir is what stops a folder whose name
            // is not slug-shaped ("My Project") from scaffolding into a second
            // folder beside it.
            var full = Path.GetFullPath(directory);
            var name = new DirectoryInfo(full).Name;

            var result = await ProjectScaffoldRunner.InitAsync(
                helmionRoot,
                projectRoot: full,
                projectName: name,
                directory: full,
                cancellationToken);

            return new ProjectOpenOutcome(true, result.Ok, result.Summary);
        }
        catch (Exception ex)
        {
            return new ProjectOpenOutcome(true, false, $"Could not set up the project: {ex.Message}");
        }
    }
}

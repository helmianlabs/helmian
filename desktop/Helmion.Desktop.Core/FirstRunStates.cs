using System.Diagnostics.CodeAnalysis;

namespace Helmion.Desktop.Core;

/// <summary>
/// How a + action settled, decided with no window in the room.
/// </summary>
/// <param name="State">
/// The level the row renders at. <see cref="PlusActionState.Failed"/> is the only
/// one that draws red, which is what makes <see cref="IsRed"/> assertable.
/// </param>
/// <param name="Message">The sentence shown under the row. Never empty.</param>
public sealed record PlusOutcome(PlusActionState State, string Message)
{
    /// <summary>True when this outcome puts red on the screen.</summary>
    public bool IsRed => State == PlusActionState.Failed;
}

/// <summary>
/// THE FIRST-RUN CLASSIFIER: whether a given starting condition is a FAILURE or
/// merely an EMPTY STATE, decided in one place with no UI attached.
///
/// WHY THIS LEFT THE WINDOW. Troy's requirement is that "a fresh empty workspace
/// must produce ZERO red banners", and the proof of that used to be a
/// `Helmion Pilot.exe --empty-workspace-audit` flag which constructs a real WPF
/// Window. That makes the proof unrunnable under the standing rule that nothing
/// may appear on screen — and unrunnable is not a weaker proof, it is no proof,
/// for this session and every future one. The decisions now live here, in a
/// console-reachable assembly, so the smoke suite can point them at a genuinely
/// empty temporary folder and assert the answer.
///
/// EVERY SENTENCE BELOW IS TROY'S, CARRIED OVER VERBATIM from
/// MainWindow.PlusMenu.cs and MainWindow.ProjectShelf.cs. The text was never the
/// problem — only the level it rendered at. Do not rewrite these while moving them.
///
/// THE DISTINCTION THIS FILE EXISTS TO HOLD:
///   FAILED  — something was attempted and it did not work. Red.
///   EMPTY   — nothing was attempted, and nothing is broken. A fresh workspace has
///             no plugins.json; an untyped box has no name in it. Grey.
/// Collapsing the two is what taught the operator to ignore red, in a product
/// whose entire pitch is honest state reporting. These functions do the real
/// filesystem check rather than accepting a caller's boolean, so a test exercises
/// the actual first-run condition instead of a claim about it.
/// </summary>
public static class FirstRunStates
{
    /// <summary>The registry path a workspace's plugins would be listed in.</summary>
    public static string PluginRegistryPath(string workspace) =>
        Path.Combine(workspace, ".helmion", "plugins.json");

    /// <summary>
    /// Reading the plugins registered for a workspace.
    ///
    /// Neither missing-workspace nor missing-registry is a failure: the first is a
    /// step the user has not taken, the second is what EVERY new workspace looks
    /// like. Drawing the normal first run in red made the one part of the screen
    /// that was working correctly look like the broken one.
    /// </summary>
    public static PlusOutcome Plugins(string? workspace)
    {
        if (string.IsNullOrWhiteSpace(workspace) || !SafeDirectoryExists(workspace))
        {
            return new PlusOutcome(
                PlusActionState.Empty,
                "No workspace is registered yet, so there is nowhere to read plugins from. "
                + "Pick a workspace on the Workspace tab first.");
        }

        var registry = PluginRegistryPath(workspace);
        if (!SafeFileExists(registry))
        {
            return new PlusOutcome(
                PlusActionState.Empty,
                "No plugins are registered in this workspace yet. This list is read-only; "
                + "add one from reviewed local source with: helmion plugin add <path>");
        }

        long bytes;
        try
        {
            bytes = new FileInfo(registry).Length;
        }
        catch (Exception ex)
        {
            // The file is THERE and unreadable. That genuinely is a failure — it is
            // the one branch in this function that has earned its red.
            return new PlusOutcome(
                PlusActionState.Failed,
                $"Could not read the plugin registry: {ex.Message}");
        }

        return new PlusOutcome(
            PlusActionState.Succeeded,
            $"Plugin registry read from {registry} ({AttachmentPolicy.DescribeSize(bytes)}). "
            + "Run: helmion plugin commands — to see what they add.");
    }

    /// <summary>
    /// The connector search, before it is run. An empty box is a step not taken
    /// yet, not a search that failed. Returns null when there IS a need typed and
    /// the caller should go and run the real discovery.
    /// </summary>
    public static PlusOutcome? ConnectorNeed(string? need)
    {
        if (!string.IsNullOrWhiteSpace(need))
        {
            return null;
        }

        return new PlusOutcome(
            PlusActionState.Empty,
            "Search cancelled. Type a need in the composer or MCP Discover box "
            + "(e.g. \"read local sqlite\"), then + › Connectors again — or click "
            + "Connectors and enter the need in the search dialog.");
    }

    /// <summary>
    /// Creating a project, before it is attempted. Returns null when both a
    /// workspace and a name are present and the caller should go and scaffold.
    ///
    /// NEITHER OF THESE IS A FAILURE. Nothing was attempted: one is a workspace the
    /// user has not picked yet, the other is a name they have not typed yet. Both
    /// are hints about the next step, and both used to come back in the same red as
    /// a scaffold that actually blew up.
    /// </summary>
    public static PlusOutcome? NewProject(string? projectRoot, string? projectName)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
        {
            return new PlusOutcome(
                PlusActionState.Empty,
                "No workspace is registered yet, so there is nowhere to create a project. "
                + "Pick one on the Workspace page first.");
        }

        if (string.IsNullOrWhiteSpace(projectName))
        {
            return new PlusOutcome(
                PlusActionState.Empty,
                "Type the project name into the box first, then press + New. "
                + "It becomes the folder name and the title inside PROJECT.md.");
        }

        return null;
    }

    /// <summary>
    /// The caller-facing form of <see cref="NewProject"/>: true when the project can
    /// actually be created, handing back the trimmed values.
    ///
    /// THIS EXISTS FOR THE COMPILER, and that is a real benefit rather than
    /// ceremony. Moving the blank checks into Core meant the window could no longer
    /// see that they had happened, and the honest choices were an `!` — a claim
    /// nothing verifies — or this, which teaches the nullable analysis the same
    /// fact the guard already established. If these preconditions ever stop
    /// matching, this breaks at compile time instead of at Troy's screen.
    /// </summary>
    public static bool CanCreateProject(
        string? projectRoot,
        string? projectName,
        [NotNullWhen(true)] out string? root,
        [NotNullWhen(true)] out string? name,
        [NotNullWhen(false)] out PlusOutcome? blocked)
    {
        blocked = NewProject(projectRoot, projectName);
        if (blocked is not null)
        {
            root = null;
            name = null;
            return false;
        }

        // NewProject returns null only when both are non-blank, so these are safe.
        root = projectRoot!.Trim();
        name = projectName!.Trim();
        return true;
    }

    /// <summary>
    /// EVERY first-run condition a completely fresh workspace presents, in one
    /// list, so the "zero red banners" rule can be asserted over all of them at
    /// once rather than one test per entry point — which is how the next entry
    /// point gets added without one.
    /// </summary>
    public static IReadOnlyList<PlusOutcome> FreshWorkspaceOutcomes(string? workspace)
    {
        var outcomes = new List<PlusOutcome> { Plugins(workspace) };

        // The boxes on a fresh screen are empty, which is the state being audited.
        var connector = ConnectorNeed(null);
        if (connector is not null) outcomes.Add(connector);

        var noWorkspace = NewProject(null, null);
        if (noWorkspace is not null) outcomes.Add(noWorkspace);

        var noName = NewProject(workspace, null);
        if (noName is not null) outcomes.Add(noName);

        return outcomes;
    }

    /// <summary>How many of a fresh workspace's first-run states draw red. Must be zero.</summary>
    public static int FreshWorkspaceRedCount(string? workspace) =>
        FreshWorkspaceOutcomes(workspace).Count(outcome => outcome.IsRed);

    private static bool SafeDirectoryExists(string path)
    {
        try { return Directory.Exists(path); }
        catch (Exception) { return false; }
    }

    private static bool SafeFileExists(string path)
    {
        try { return File.Exists(path); }
        catch (Exception) { return false; }
    }
}

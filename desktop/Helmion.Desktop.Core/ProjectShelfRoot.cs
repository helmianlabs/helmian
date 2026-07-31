namespace Helmion.Desktop.Core;

/// <summary>
/// Which folder the left panel's project shelf lists, as distinct from which
/// folder the agent's tools are confined to.
///
/// THE TWO ARE NOT THE SAME THING, and treating them as one is the defect this
/// exists to stop. Clicking a project on the shelf deliberately sets the agent
/// workspace to that project — "opening a project means working in it"
/// (MainWindow.ProjectShelf.cs ProjectShelfItem_Click). But the shelf resolved
/// its list from the agent workspace too, so the next refresh re-rooted
/// discovery INSIDE the project just opened and the shelf collapsed to that one
/// entry: every sibling project vanished the moment you opened one of them.
///
/// The rule is a drill-in keeps the shelf where it was. Registering a genuinely
/// different workspace still moves it. Pure path comparison — no disk access, so
/// the headless suite can prove it against paths that never existed.
/// </summary>
public static class ProjectShelfRoot
{
    /// <summary>
    /// The root the shelf should list after the agent workspace became
    /// <paramref name="workspace"/>.
    /// </summary>
    /// <param name="currentRoot">The folder the shelf is listing now; null on first load.</param>
    /// <param name="workspace">The agent workspace that was just resolved or registered.</param>
    /// <returns>
    /// <paramref name="currentRoot"/> when <paramref name="workspace"/> is at or
    /// beneath it — that is somebody drilling into a project the shelf is already
    /// showing. Otherwise <paramref name="workspace"/>.
    /// </returns>
    public static string? Resolve(string? currentRoot, string? workspace)
    {
        if (string.IsNullOrWhiteSpace(currentRoot)) return Normalize(workspace);
        if (string.IsNullOrWhiteSpace(workspace)) return Normalize(currentRoot);

        var root = Normalize(currentRoot);
        var next = Normalize(workspace);
        if (root is null || next is null) return next ?? root;

        return IsAtOrBeneath(next, root) ? root : next;
    }

    /// <summary>
    /// Whether <paramref name="candidate"/> is <paramref name="ancestor"/> itself
    /// or sits underneath it.
    ///
    /// Compares whole path SEGMENTS, not a raw string prefix: "C:\work\alpha-two"
    /// starts with "C:\work\alpha" as text while being a completely unrelated
    /// folder, and a prefix test would wrongly pin the shelf for it.
    /// </summary>
    public static bool IsAtOrBeneath(string? candidate, string? ancestor)
    {
        var child = Normalize(candidate);
        var parent = Normalize(ancestor);
        if (child is null || parent is null) return false;

        if (string.Equals(child, parent, StringComparison.OrdinalIgnoreCase)) return true;

        return child.Length > parent.Length
            && child.StartsWith(parent, StringComparison.OrdinalIgnoreCase)
            && child[parent.Length] == Path.DirectorySeparatorChar;
    }

    /// <summary>
    /// Full path, one separator flavour, no trailing separator. Returns null for
    /// anything unusable rather than throwing — a bad path must leave the shelf
    /// where it is, not blank it.
    /// </summary>
    private static string? Normalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;

        try
        {
            var full = Path.GetFullPath(path.Trim());
            var trimmed = Path.TrimEndingDirectorySeparator(full);
            return trimmed.Length == 0 ? full : trimmed;
        }
        catch (Exception error) when (
            error is ArgumentException
                or IOException
                or NotSupportedException
                or UnauthorizedAccessException)
        {
            return null;
        }
    }
}

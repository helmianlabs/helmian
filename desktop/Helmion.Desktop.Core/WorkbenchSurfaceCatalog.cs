namespace Helmion.Desktop.Core;

public sealed record WorkbenchSurface(
    string Id,
    string Label,
    bool CanExecute,
    string Boundary);

/// <summary>
/// The right-side workbench is project context, not a second command surface.
/// Browser renders normal public websites inside a WebView2 boundary; its optional
/// reference reader remains inert text. Preview renders local project artifacts
/// only; Canvas stores project notes; Create starts with an approval review.
/// </summary>
public static class WorkbenchSurfaceCatalog
{
    public static IReadOnlyList<WorkbenchSurface> All { get; } =
    [
        new("guard", "Guard", false, "Reviewable Guard evidence and state."),
        new("browser", "Browser", false, "Public HTTPS web rendering; no Helmian tools, project access, downloads, or browser permissions."),
        new("canvas", "Canvas", false, "Project notes and decisions; no provider call."),
        new("preview", "Preview", false, "Read-only artifact preview and history."),
        new("create", "Create", false, "Review provider, data scope, destination, and approval before any API call.")
    ];

    public static WorkbenchSurface? Find(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase));
}

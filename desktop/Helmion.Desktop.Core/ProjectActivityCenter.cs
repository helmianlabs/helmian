namespace Helmion.Desktop.Core;

public sealed record ProjectActivityFilter(string Id, string Label, string? Kind);

public static class ProjectActivityFilterCatalog
{
    public static IReadOnlyList<ProjectActivityFilter> All { get; } =
    [
        new("all", "All project activity", null),
        new("note", "Canvas notes", "note"),
        new("decision", "Decisions", "decision"),
        new("browser", "Browser reads", "browser"),
        new("connector", "Connector activity", "connector"),
        new("artifact", "Artifact Studio", "artifact"),
        new("approval", "Approval decisions", "approval")
    ];

    public static ProjectActivityFilter Require(string? id) =>
        All.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase))
        ?? throw new ArgumentException("Select a supported project activity filter.", nameof(id));
}

public sealed record ProjectActivityView(
    string Id,
    string KindLabel,
    string Title,
    string Detail,
    string StatusLabel,
    string Source,
    string TimeLabel,
    string EvidenceLabel);

public sealed record ProjectActivitySnapshot(
    string ProjectRoot,
    string FilterId,
    string FilterLabel,
    string SearchText,
    int TotalCount,
    int VisibleCount,
    bool LimitReached,
    IReadOnlyList<ProjectActivityView> Items)
{
    public string CountLabel => LimitReached
        ? $"{VisibleCount:N0} SHOWN · {TotalCount:N0} RECENT LIMIT"
        : FilterId == "all" && SearchText.Length == 0
        ? $"{TotalCount:N0} RECORDED"
        : $"{VisibleCount:N0} SHOWN · {TotalCount:N0} TOTAL";

    public string EmptyMessage => TotalCount == 0
        ? "No project activity has been recorded yet."
        : "No recorded activity matches this filter.";
}

/// <summary>
/// Read-only projection of the append-only project activity ledger. This is a
/// recorded history, not a live event stream, and it never synthesizes rows.
/// </summary>
public static class ProjectActivityCenter
{
    public static ProjectActivitySnapshot Load(
        string projectRoot,
        string? filterId = null,
        string? searchText = null,
        int limit = 500)
    {
        var root = ProjectConnectorStore.RequireProjectRoot(projectRoot);
        var filter = ProjectActivityFilterCatalog.Require(
            string.IsNullOrWhiteSpace(filterId) ? "all" : filterId);
        var search = (searchText ?? string.Empty).Trim();
        var all = ProjectWorkbenchStore.ReadActivity(root, limit);
        var visible = all
            .Where(entry => filter.Kind is null
                || string.Equals(entry.Kind, filter.Kind, StringComparison.OrdinalIgnoreCase))
            .Where(entry => SearchMatches(entry, search))
            .Select(ToView)
            .ToArray();

        return new ProjectActivitySnapshot(
            root,
            filter.Id,
            filter.Label,
            search,
            all.Count,
            visible.Length,
            all.Count == limit,
            visible);
    }

    private static bool SearchMatches(ProjectActivityEntry entry, string search) =>
        search.Length == 0
        || entry.Title.Contains(search, StringComparison.OrdinalIgnoreCase)
        || entry.Detail.Contains(search, StringComparison.OrdinalIgnoreCase)
        || entry.Status.Contains(search, StringComparison.OrdinalIgnoreCase)
        || entry.Source.Contains(search, StringComparison.OrdinalIgnoreCase)
        || entry.Kind.Contains(search, StringComparison.OrdinalIgnoreCase)
        || (entry.EvidenceHash?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false);

    private static ProjectActivityView ToView(ProjectActivityEntry entry) => new(
        entry.Id,
        entry.KindLabel,
        entry.Title,
        entry.Detail,
        entry.Status.ToUpperInvariant(),
        entry.Source,
        entry.TimeLabel,
        string.IsNullOrWhiteSpace(entry.EvidenceHash)
            ? "NO CONTENT HASH RECORDED"
            : $"SHA-256 · {entry.EvidenceHash}");
}

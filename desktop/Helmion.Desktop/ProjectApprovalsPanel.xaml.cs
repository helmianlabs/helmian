using System.IO;
using System.Windows;
using System.Windows.Controls;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

public partial class ProjectApprovalsPanel : UserControl
{
    private bool _ready;
    private string? _loadedProjectRoot;

    public ProjectApprovalsPanel()
    {
        InitializeComponent();
        ReviewFilterBox.ItemsSource = ProjectReviewFilterCatalog.All;
        ReviewFilterBox.SelectedValue = "all";
        _ready = true;
    }

    internal void RefreshFromWindow()
    {
        if (_ready && IsVisible) RefreshCurrentProject();
        else _loadedProjectRoot = null;
    }

    private void ProjectApprovalsPanel_IsVisibleChanged(
        object sender,
        DependencyPropertyChangedEventArgs e)
    {
        if (IsVisible) RefreshCurrentProject();
    }

    private void ReviewFilterBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_ready && IsVisible) RefreshCurrentProject();
    }

    private void ReviewRefreshButton_Click(object sender, RoutedEventArgs e) =>
        RefreshCurrentProject();

    private void RefreshCurrentProject()
    {
        var project = (Window.GetWindow(this) as MainWindow)?.ActiveProjectRootForReview;
        if (string.IsNullOrWhiteSpace(project) || !Directory.Exists(project))
        {
            _loadedProjectRoot = null;
            ReviewProjectText.Text = "Select a project to inspect its review queue.";
            ReviewCountText.Text = "0 ACTIONABLE";
            ReviewStatusText.Text = "No project records were read.";
            ClearLists("No project is selected.");
            return;
        }

        try
        {
            _loadedProjectRoot = Path.GetFullPath(project);
            var filterId = ReviewFilterBox.SelectedValue as string ?? "all";
            var snapshot = ProjectReviewQueue.Load(_loadedProjectRoot, filterId);
            ReviewProjectText.Text = $"Active project · {Path.GetFileName(_loadedProjectRoot)}";
            ReviewCountText.Text = snapshot.CountLabel;
            ReviewStatusText.Text =
                $"{snapshot.FilterLabel}. Decisions and reviews append to this project only; no provider operation is available here.";
            ArtifactApprovalItems.ItemsSource = snapshot.ArtifactApprovals;
            ConnectorReviewItems.ItemsSource = snapshot.ConnectorReviews;
            CompletedReviewItems.ItemsSource = snapshot.CompletedHistory;
            ArtifactApprovalSection.Visibility = snapshot.ArtifactApprovals.Count == 0
                ? Visibility.Collapsed : Visibility.Visible;
            ConnectorReviewSection.Visibility = snapshot.ConnectorReviews.Count == 0
                ? Visibility.Collapsed : Visibility.Visible;
            CompletedReviewSection.Visibility = snapshot.CompletedHistory.Count == 0
                ? Visibility.Collapsed : Visibility.Visible;
            ReviewEmptyText.Text = snapshot.EmptyMessage;
            ReviewEmptyText.Visibility = snapshot.TotalCount == 0
                ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            _loadedProjectRoot = null;
            ReviewStatusText.Text = $"Project review records could not be read: {ex.Message}";
            ReviewCountText.Text = "READ FAILED";
            ClearLists("The project review queue is unavailable.");
        }
    }

    private void ApproveArtifactButton_Click(object sender, RoutedEventArgs e) =>
        DecideArtifact(sender, approve: true);

    private void DenyArtifactButton_Click(object sender, RoutedEventArgs e) =>
        DecideArtifact(sender, approve: false);

    private void DecideArtifact(object sender, bool approve)
    {
        if (sender is not Button { Tag: string requestId } || !TryProject(out var project)) return;
        try
        {
            var result = ProjectReviewQueue.DecideArtifact(project, requestId, approve);
            RefreshRelatedPanels();
            ReviewStatusText.Text = approve
                ? $"Approved locally. Delivery is {result.DeliveryState}; nothing was sent."
                : "Denied locally. Nothing was sent or created.";
        }
        catch (Exception ex)
        {
            ReviewStatusText.Text = $"Artifact decision was not recorded: {ex.Message}";
        }
    }

    private void MarkConnectorReviewedButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string draftId } || !TryProject(out var project)) return;
        try
        {
            ProjectReviewQueue.MarkConnectorReviewed(project, draftId);
            RefreshRelatedPanels();
            ReviewStatusText.Text = "Marked reviewed locally. This is not approval and nothing was sent.";
        }
        catch (Exception ex)
        {
            ReviewStatusText.Text = $"Connector review was not recorded: {ex.Message}";
        }
    }

    private void WithdrawConnectorDraftButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string draftId } || !TryProject(out var project)) return;
        try
        {
            ProjectReviewQueue.WithdrawConnectorDraft(project, draftId);
            RefreshRelatedPanels();
            ReviewStatusText.Text = "Local connector draft withdrawn. Nothing was sent.";
        }
        catch (Exception ex)
        {
            ReviewStatusText.Text = $"Connector draft was not withdrawn: {ex.Message}";
        }
    }

    private void RefreshRelatedPanels()
    {
        if (Window.GetWindow(this) is MainWindow owner)
        {
            owner.NotifyProjectScopedPanelsChanged();
        }
        else
        {
            RefreshCurrentProject();
        }
    }

    private bool TryProject(out string project)
    {
        project = _loadedProjectRoot ?? string.Empty;
        if (project.Length > 0 && Directory.Exists(project)) return true;
        ReviewStatusText.Text = "Select and refresh a project first.";
        return false;
    }

    private void ClearLists(string message)
    {
        ArtifactApprovalItems.ItemsSource = null;
        ConnectorReviewItems.ItemsSource = null;
        CompletedReviewItems.ItemsSource = null;
        ArtifactApprovalSection.Visibility = Visibility.Collapsed;
        ConnectorReviewSection.Visibility = Visibility.Collapsed;
        CompletedReviewSection.Visibility = Visibility.Collapsed;
        ReviewEmptyText.Text = message;
        ReviewEmptyText.Visibility = Visibility.Visible;
    }
}

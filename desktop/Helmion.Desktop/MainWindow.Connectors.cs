namespace Helmion.Desktop;

public partial class MainWindow
{
    internal string? ActiveConnectorProjectRoot => _registeredWorkspacePath;
    internal string? ActiveProjectRootForReview => _registeredWorkspacePath;

    internal void NotifyProjectScopedPanelsChanged()
    {
        ProjectConnectorsPanel?.RefreshFromWindow();
        ProjectActivityPanel?.RefreshFromWindow();
        ProjectApprovalsPanel?.RefreshFromWindow();
        if (DataContext is Helmion.Desktop.Core.PilotSnapshot snapshot)
        {
            ApplyDerivedSnapshotLabels(snapshot);
        }
    }
}

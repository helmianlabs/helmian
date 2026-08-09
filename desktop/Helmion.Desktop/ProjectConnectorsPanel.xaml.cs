using System.IO;
using System.Windows;
using System.Windows.Controls;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

public partial class ProjectConnectorsPanel : UserControl
{
    private string? _loadedProjectRoot;

    public ProjectConnectorsPanel()
    {
        InitializeComponent();
        DraftConnectorBox.ItemsSource = ProjectConnectorCatalog.All;
        DraftConnectorBox.SelectedIndex = 0;
    }

    internal void RefreshFromWindow()
    {
        if (IsVisible) RefreshCurrentProject();
        else _loadedProjectRoot = null;
    }

    private void ProjectConnectorsPanel_IsVisibleChanged(
        object sender,
        DependencyPropertyChangedEventArgs e)
    {
        if (IsVisible) RefreshCurrentProject();
    }

    private void ConnectorRefreshButton_Click(object sender, RoutedEventArgs e) =>
        RefreshCurrentProject();

    private void RefreshCurrentProject()
    {
        var project = (Window.GetWindow(this) as MainWindow)?.ActiveConnectorProjectRoot;
        if (string.IsNullOrWhiteSpace(project) || !Directory.Exists(project))
        {
            _loadedProjectRoot = null;
            ConnectorProjectText.Text = "Select a project to inspect connector state.";
            ConnectorPanelStatusText.Text =
                "Slack and GitHub remain not connected. No project connector files were read or created.";
            ConnectorCardList.ItemsSource = null;
            ConnectorDraftList.ItemsSource = null;
            ConnectorAuditList.ItemsSource = null;
            ConnectorDraftEmptyText.Visibility = Visibility.Visible;
            ConnectorAuditEmptyText.Visibility = Visibility.Visible;
            SaveConnectorDraftButton.IsEnabled = false;
            return;
        }

        try
        {
            _loadedProjectRoot = Path.GetFullPath(project);
            ConnectorProjectText.Text = $"Active project · {Path.GetFileName(_loadedProjectRoot)}";
            var states = ProjectConnectorStore.LoadStates(_loadedProjectRoot);
            ConnectorCardList.ItemsSource = ProjectConnectorStore.GetViews(_loadedProjectRoot);
            var drafts = ConnectorActionDraftStore.Read(_loadedProjectRoot, limit: 100);
            ConnectorDraftList.ItemsSource = drafts.Select(draft =>
                ConnectorProtocolPolicy.ReviewLocalDraft(
                    draft,
                    states.Single(state => string.Equals(
                        state.ConnectorId,
                        draft.ConnectorId,
                        StringComparison.OrdinalIgnoreCase))));
            ConnectorDraftEmptyText.Visibility = drafts.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
            var audit = ProjectConnectorStore.ReadAudit(_loadedProjectRoot, limit: 50);
            ConnectorAuditList.ItemsSource = audit;
            ConnectorAuditEmptyText.Visibility = audit.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
            SaveConnectorDraftButton.IsEnabled = true;
            ConnectorPanelStatusText.Text =
                "State loaded from this project only. Preparing authorization remains local and cannot contact a provider.";
        }
        catch (Exception ex)
        {
            ConnectorPanelStatusText.Text = $"Project connector state could not be read: {ex.Message}";
            ConnectorCardList.ItemsSource = null;
            SaveConnectorDraftButton.IsEnabled = false;
        }
    }

    private void ConnectorPrimaryAction_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string connectorId }
            || !TryGetLoadedProject(out var project))
        {
            return;
        }

        try
        {
            var state = ProjectConnectorStore.LoadStates(project)
                .Single(item => string.Equals(
                    item.ConnectorId,
                    connectorId,
                    StringComparison.OrdinalIgnoreCase));
            if (state.Stage == ProjectConnectorStage.AuthorizationPrepared)
            {
                ProjectConnectorStore.CancelPreparedAuthorization(project, connectorId);
                RefreshRelatedProjectPanels();
                ConnectorPanelStatusText.Text =
                    "Local authorization request cancelled. No provider state changed.";
            }
            else
            {
                ProjectConnectorStore.PrepareAuthorization(project, connectorId);
                RefreshRelatedProjectPanels();
                ConnectorPanelStatusText.Text =
                    "Local authorization request prepared. No browser, OAuth, account, or API action started.";
            }
        }
        catch (Exception ex)
        {
            ConnectorPanelStatusText.Text = $"Connector state was not changed: {ex.Message}";
        }
    }

    private void DraftConnectorBox_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (DraftConnectorBox.SelectedItem is not ProjectConnectorDefinition connector)
        {
            DraftOperationBox.ItemsSource = null;
            return;
        }

        DraftOperationBox.ItemsSource = ConnectorOperationCatalog.ForConnector(connector.Id);
        DraftOperationBox.SelectedIndex = 0;
    }

    private void DraftOperationBox_SelectionChanged(
        object sender,
        SelectionChangedEventArgs e)
    {
        if (DraftOperationBox.SelectedItem is ConnectorOperationDefinition operation)
        {
            DraftDestinationLabelText.Text = operation.DestinationLabel;
        }
    }

    private void SaveConnectorDraftButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryGetLoadedProject(out var project)) return;
        if (DraftConnectorBox.SelectedItem is not ProjectConnectorDefinition connector
            || DraftOperationBox.SelectedItem is not ConnectorOperationDefinition operation)
        {
            ConnectorDraftStatusText.Text = "Select a connector and action.";
            return;
        }

        try
        {
            var result = ConnectorActionDraftStore.Create(
                project,
                connector.Id,
                operation.Id,
                DraftDestinationBox.Text,
                DraftBodyBox.Text);
            DraftDestinationBox.Text = string.Empty;
            DraftBodyBox.Text = string.Empty;
            RefreshRelatedProjectPanels();
            ConnectorDraftStatusText.Text =
                $"Saved {result.Draft.OperationLabel.ToLowerInvariant()} draft locally. Nothing was sent.";
        }
        catch (Exception ex)
        {
            ConnectorDraftStatusText.Text = $"Draft was not saved: {ex.Message}";
        }
    }

    private void WithdrawConnectorDraftButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string draftId }
            || !TryGetLoadedProject(out var project))
        {
            return;
        }

        try
        {
            ConnectorActionDraftStore.Withdraw(project, draftId);
            RefreshRelatedProjectPanels();
            ConnectorDraftStatusText.Text =
                "Local draft withdrawn. No provider state changed and nothing was sent.";
        }
        catch (Exception ex)
        {
            ConnectorDraftStatusText.Text = $"Draft was not withdrawn: {ex.Message}";
        }
    }

    private bool TryGetLoadedProject(out string project)
    {
        project = _loadedProjectRoot ?? string.Empty;
        if (project.Length > 0 && Directory.Exists(project)) return true;

        ConnectorPanelStatusText.Text = "Select and refresh a project first.";
        return false;
    }

    private void RefreshRelatedProjectPanels()
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
}

using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Microsoft.Win32;

namespace Helmion.Desktop;

public partial class MainWindow : Window
{
    private readonly Dictionary<string, FrameworkElement> _pages;
    private readonly Dictionary<string, Button> _navigationButtons;
    private readonly bool _persistTheme;
    private readonly LocalServiceConnector _serviceConnector;
    private IReadOnlyList<ProviderProfileSummary> _providerProfiles;
    private DesktopSettings _desktopSettings;
    private bool _themeSelectorReady;
    private string? _registeredWorkspacePath;

    public MainWindow(string? themeOverride = null, bool persistTheme = true)
    {
        _persistTheme = persistTheme;
        _desktopSettings = DesktopSettingsStore.Load();
        _providerProfiles = ProviderProfileCatalog.CreateUnconfigured();
        var initialTheme = ColorThemeCatalog.Get(themeOverride ?? _desktopSettings.ColorTheme);
        ColorThemeManager.Apply(initialTheme.Id);
        _serviceConnector = new LocalServiceConnector();

        InitializeComponent();
        DataContext = PilotSnapshot.CreateDemo(DateTimeOffset.Now);
        ThemeSelector.ItemsSource = ColorThemeCatalog.All;
        ThemeSelector.SelectedValue = initialTheme.Id;
        ThemeDescription.Text = initialTheme.Description;
        ThemePersistenceLabel.Text = persistTheme
            ? "Saved locally for this Windows user"
            : "Preview override · not saved";

        _pages = new Dictionary<string, FrameworkElement>(StringComparer.Ordinal)
        {
            ["Overview"] = OverviewPage,
            ["Workspace"] = WorkspacePage,
            ["Console"] = ConsolePage,
            ["Activity"] = ActivityPage,
            ["Evidence"] = EvidencePage,
            ["Approvals"] = ApprovalsPage,
            ["Integrations"] = IntegrationsPage,
            ["Release"] = ReleasePage,
            ["Settings"] = SettingsPage
        };
        _navigationButtons = new Dictionary<string, Button>(StringComparer.Ordinal)
        {
            ["Overview"] = OverviewNav,
            ["Workspace"] = WorkspaceNav,
            ["Console"] = ConsoleNav,
            ["Activity"] = ActivityNav,
            ["Evidence"] = EvidenceNav,
            ["Approvals"] = ApprovalsNav,
            ["Integrations"] = IntegrationsNav,
            ["Release"] = ReleaseNav,
            ["Settings"] = SettingsNav
        };
        ProviderRegistryList.ItemsSource = _providerProfiles;

        _themeSelectorReady = true;
        NavigateTo("Overview");
        if (persistTheme)
        {
            Loaded += MainWindow_Loaded;
        }
    }

    private void Navigation_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string pageName })
        {
            NavigateTo(pageName);
        }
    }

    public void NavigateTo(string pageName)
    {
        if (!_pages.ContainsKey(pageName))
        {
            throw new ArgumentOutOfRangeException(nameof(pageName), pageName, "Unknown desktop page");
        }

        foreach (var page in _pages.Values)
        {
            page.Visibility = Visibility.Collapsed;
        }

        foreach (var button in _navigationButtons.Values)
        {
            button.Background = Brushes.Transparent;
            button.Foreground = (Brush)FindResource("MutedTextBrush");
        }

        _pages[pageName].Visibility = Visibility.Visible;
        var activeButton = _navigationButtons[pageName];
        activeButton.Background = (Brush)FindResource("AccentDarkBrush");
        activeButton.Foreground = (Brush)FindResource("TextBrush");

        PageTitle.Text = pageName;
        PageContext.Text = pageName switch
        {
            "Overview" => "A calm view of the local pilot",
            "Workspace" => "Project and lease posture",
            "Console" => "Interaction modes and the future governed CLI",
            "Activity" => "Live Activity Stream · Orchestration Timeline",
            "Evidence" => "Handoffs, checkpoints, and durable proof",
            "Approvals" => "Optional advanced owner decisions",
            "Integrations" => "Safe connection boundaries",
            "Release" => "The path from pilot to multi-user product",
            "Settings" => "Personal pilot preferences",
            _ => "Helmion personal pilot"
        };
    }

    public void ApplyThemeForPreview(string themeId)
    {
        ApplyTheme(themeId, save: false);
        ThemeSelector.SelectedValue = ColorThemeCatalog.Get(themeId).Id;
    }

    private void ThemeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_themeSelectorReady || ThemeSelector.SelectedValue is not string themeId)
        {
            return;
        }

        ApplyTheme(themeId, _persistTheme);
    }

    private void ApplyTheme(string themeId, bool save)
    {
        var selected = ColorThemeCatalog.Get(themeId);
        ColorThemeManager.Apply(selected.Id);
        ThemeDescription.Text = selected.Description;

        if (save)
        {
            _desktopSettings = _desktopSettings with { ColorTheme = selected.Id };
            DesktopSettingsStore.Save(_desktopSettings);
            ThemePersistenceLabel.Text = "Saved locally for this Windows user";
        }
        else
        {
            ThemePersistenceLabel.Text = "Preview override · not saved";
        }
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        Loaded -= MainWindow_Loaded;
        await ConnectServiceAsync(restoreWorkspace: true);
    }

    private async void ConnectService_Click(object sender, RoutedEventArgs e)
    {
        await ConnectServiceAsync(restoreWorkspace: false);
    }

    private async void SelectWorkspace_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose a local Helmion project workspace",
            Multiselect = false
        };
        if (!string.IsNullOrWhiteSpace(_registeredWorkspacePath)
            && Directory.Exists(_registeredWorkspacePath))
        {
            dialog.InitialDirectory = _registeredWorkspacePath;
        }

        if (dialog.ShowDialog(this) != true)
        {
            return;
        }

        await InspectWorkspaceAsync(dialog.FolderName, persistSelection: true);
    }

    private async void RefreshWorkspace_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_registeredWorkspacePath))
        {
            await ConnectServiceAsync(restoreWorkspace: false);
            return;
        }

        await InspectWorkspaceAsync(_registeredWorkspacePath, persistSelection: false);
    }

    private async Task ConnectServiceAsync(bool restoreWorkspace)
    {
        SetServiceStatus(
            "Connecting…",
            "Starting authenticated read-only service",
            connected: false);
        try
        {
            var hello = await _serviceConnector.EnsureConnectedAsync();
            SetServiceStatus(
                "Connected · read-only",
                $"Protocol v{hello.ProtocolVersion} · current Windows user",
                connected: true);
            OverviewServiceStateText.Text = "Read-only";
            OverviewServiceStateText.Foreground = (Brush)FindResource("AccentBrush");
            WorkspaceConnectionSummary.Text = "Local service connected";
            WorkspaceConnectionDetail.Text =
                "Choose a local folder to register it for read-only inspection. No project files are changed.";
            ConnectServiceButton.Content = "Service connected";
            ConnectServiceButton.IsEnabled = false;
            SelectWorkspaceButton.IsEnabled = true;
            RefreshWorkspaceButton.IsEnabled = true;
            await RefreshCapabilitiesAsync();

            var savedWorkspacePath = _desktopSettings.LastWorkspacePath;
            if (restoreWorkspace
                && !string.IsNullOrWhiteSpace(savedWorkspacePath)
                && Directory.Exists(savedWorkspacePath))
            {
                await InspectWorkspaceAsync(
                    savedWorkspacePath,
                    persistSelection: false);
            }
        }
        catch (Exception error) when (
            error is IOException
                or TimeoutException
                or UnauthorizedAccessException
                or InvalidDataException
                or FileNotFoundException
                or InvalidOperationException
                or Win32Exception
                or OperationCanceledException)
        {
            SetServiceStatus(
                "Unavailable · demo fallback",
                "Read-only service did not connect",
                connected: false);
            OverviewServiceStateText.Text = "Offline";
            OverviewServiceStateText.Foreground = (Brush)FindResource("AmberBrush");
            WorkspaceConnectionSummary.Text = "Demo fallback is active";
            WorkspaceConnectionDetail.Text = error.Message;
            ConnectServiceButton.Content = "Retry local service";
            ConnectServiceButton.IsEnabled = true;
            SelectWorkspaceButton.IsEnabled = false;
            RefreshWorkspaceButton.IsEnabled = false;
        }
    }

    private async Task RefreshCapabilitiesAsync()
    {
        ProviderAvailabilitySummary.Text =
            "Detecting local command availability without launching tools…";
        try
        {
            var capabilities = await _serviceConnector.DetectCapabilitiesAsync();
            var capabilityMap = capabilities.ToDictionary(
                capability => capability.Id,
                StringComparer.Ordinal);
            _providerProfiles = _providerProfiles
                .Select(profile =>
                {
                    if (profile.LocalCapabilityId is null)
                    {
                        return profile;
                    }

                    return capabilityMap.TryGetValue(
                        profile.LocalCapabilityId,
                        out var capability)
                        ? profile with { Availability = capability.Status }
                        : profile with { Availability = "Detection unavailable" };
                })
                .ToArray();
            ProviderRegistryList.ItemsSource = null;
            ProviderRegistryList.ItemsSource = _providerProfiles;

            var availableCount = capabilities.Count(capability => capability.Available);
            ProviderAvailabilitySummary.Text =
                $"{availableCount} of {capabilities.Count} local CLI capabilities found on PATH · no command executed";
        }
        catch (Exception error) when (
            error is IOException
                or TimeoutException
                or UnauthorizedAccessException
                or InvalidDataException
                or LocalServiceResponseException)
        {
            ProviderAvailabilitySummary.Text =
                $"Capability check unavailable · {error.Message}";
        }
    }

    private async Task InspectWorkspaceAsync(
        string workspacePath,
        bool persistSelection)
    {
        WorkspaceConnectionSummary.Text = "Inspecting selected workspace…";
        WorkspaceConnectionDetail.Text = "Read-only local inventory in progress";
        try
        {
            await _serviceConnector.EnsureConnectedAsync();
            var inspection = await _serviceConnector.InspectWorkspaceAsync(workspacePath);
            ApplyWorkspaceInspection(inspection);
            _registeredWorkspacePath = inspection.ProjectPath;
            if (persistSelection)
            {
                _desktopSettings = _desktopSettings with
                {
                    LastWorkspacePath = inspection.ProjectPath
                };
                DesktopSettingsStore.Save(_desktopSettings);
            }
        }
        catch (Exception error) when (
            error is IOException
                or TimeoutException
                or UnauthorizedAccessException
                or InvalidDataException
                or LocalServiceResponseException)
        {
            WorkspaceConnectionSummary.Text = "Workspace inspection failed";
            WorkspaceConnectionDetail.Text = error.Message;
        }
    }

    public void ApplyWorkspaceInspectionForPreview(WorkspaceInspection inspection)
    {
        ApplyWorkspaceInspection(inspection);
    }

    private void ApplyWorkspaceInspection(WorkspaceInspection inspection)
    {
        SetServiceStatus(
            "Connected · live local",
            "Read-only workspace inspection",
            connected: true);
        GlobalDataBadgeText.Text = "LOCAL LIVE + DEMO";
        WorkspaceSourceBadgeText.Text = "LOCAL LIVE · READ ONLY";
        WorkspaceConnectionSummary.Text = $"{inspection.ProjectName} registered";
        WorkspaceConnectionDetail.Text =
            $"Inspected {inspection.InspectedAt:h:mm:ss tt} · project modified: no";
        ConnectServiceButton.Content = "Service connected";
        ConnectServiceButton.IsEnabled = false;
        SelectWorkspaceButton.IsEnabled = true;
        RefreshWorkspaceButton.IsEnabled = true;
        OverviewServiceStateText.Text = "Read-only";
        OverviewServiceStateText.Foreground = (Brush)FindResource("AccentBrush");
        OverviewDataSourceText.Text =
            $"Live local workspace inventory · {inspection.ProjectName}; demo evidence remains marked";

        WorkspacePageTitle.Text = inspection.ProjectName;
        WorkspacePagePath.Text = inspection.ProjectPath;
        WorkspaceBranchText.Text = inspection.Branch;
        WorkspaceDataSourceText.Text = "Authenticated local service";
        WorkspaceNextActionText.Text =
            "Local source inventory is live; durable handoff/lease provider remains disconnected.";
        WorkspaceLeaseStateText.Text = inspection.Lease.Label;
        WorkspaceLeaseDetailText.Text = inspection.Lease.Detail;
        WorkspaceCountText.Text = "1";
        WorkspaceMetricDetail.Text = inspection.ProjectName;
        LeaseMetricText.Text = "Unknown";
        LeaseMetricDetail.Text = "Durable state not queried";

        MigrationInventoryList.ItemsSource = inspection.Migrations;
        MigrationInventoryState.Text = inspection.MigrationStateLabel;
        EvidenceInventoryList.ItemsSource = inspection.Evidence;
        EvidenceInventoryState.Text = inspection.EvidenceStateLabel;
        EmptyMigrationMessage.Visibility = inspection.Migrations.Count == 0
            ? Visibility.Visible
            : Visibility.Collapsed;
        EmptyEvidenceMessage.Visibility = inspection.Evidence.Count == 0
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void SetServiceStatus(string label, string detail, bool connected)
    {
        LocalServiceSidebarStatus.Text = label;
        LocalServiceSidebarDetail.Text = detail;
        LocalServiceDot.Fill = connected
            ? (Brush)FindResource("AccentBrush")
            : (Brush)FindResource("MutedTextBrush");
    }
}

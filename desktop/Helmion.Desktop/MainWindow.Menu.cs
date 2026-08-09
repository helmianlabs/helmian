using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;
using Microsoft.Web.WebView2.Core;

namespace Helmion.Desktop;

public partial class MainWindow
{
    private bool _teamPickerLoading;
    private bool _teamDockCollapsed;
    private bool _agentsDockOpen;
    private GridLength _teamColumnWidthBeforeCollapse = new(300);
    private string _teamProviderFilter = "all";
    private IReadOnlyList<TeamScope> _teamScopesCache = Array.Empty<TeamScope>();
    private readonly RoomLocalStore _roomLocalStore = new();

    /// <summary>Real Discord web UI host (https://discord.com/app) in the Room dock.</summary>
    private bool _teamDiscordWebReady;
    private bool _teamDiscordWebInitializing;
    private string? _teamDiscordAuthorizedUri;
    private const string DiscordWebAppUrl = "https://discord.com/app";

    // Console tools rail removed: Workspace/Create/Review/Connect/Agents/Settings/Guard
    // live on the single left SidebarChrome (hover expand / pin). No second rail.

    private void TeamDockCollapseButton_Click(object sender, RoutedEventArgs e)
    {
        if (TeamColumnDef is null || TeamDockBorder is null) return;
        if (_teamDockCollapsed)
        {
            // Restore full Room column (Discord / Team) — not a 40px stub.
            var restored = _teamColumnWidthBeforeCollapse;
            if (restored.IsAbsolute && restored.Value < 180)
                restored = new GridLength(1.15, GridUnitType.Star);
            if (restored.IsStar && restored.Value < 0.2)
                restored = new GridLength(1.15, GridUnitType.Star);
            TeamColumnDef.MinWidth = 0;
            TeamColumnDef.Width = restored.Value > 0
                ? restored
                : new GridLength(1.15, GridUnitType.Star);
            if (TeamMaestroSplitColDef is not null)
                TeamMaestroSplitColDef.Width = new GridLength(10);
            if (TeamMaestroSplitter is not null)
                TeamMaestroSplitter.Visibility = Visibility.Visible;
            TeamDockBorder.Visibility = Visibility.Visible;
            if (TeamDockRestoreButton is not null)
                TeamDockRestoreButton.Visibility = Visibility.Collapsed;
            if (TeamDockCollapseButton is not null)
            {
                TeamDockCollapseButton.Content = "⟨";
                TeamDockCollapseButton.ToolTip = "Collapse Room fully so Maestro owns the width";
            }
            _teamDockCollapsed = false;
        }
        else
        {
            _teamColumnWidthBeforeCollapse = TeamColumnDef.Width;
            // Full slide-away: zero width (Agents-style), not a leftover strip of UI.
            TeamColumnDef.MinWidth = 0;
            TeamColumnDef.Width = new GridLength(36);
            if (TeamMaestroSplitColDef is not null)
                TeamMaestroSplitColDef.Width = new GridLength(0);
            if (TeamMaestroSplitter is not null)
                TeamMaestroSplitter.Visibility = Visibility.Collapsed;
            TeamDockBorder.Visibility = Visibility.Collapsed;
            if (TeamDockRestoreButton is not null)
                TeamDockRestoreButton.Visibility = Visibility.Visible;
            if (TeamDockCollapseButton is not null)
            {
                TeamDockCollapseButton.Content = "⟩";
                TeamDockCollapseButton.ToolTip = "Open Room";
            }
            _teamDockCollapsed = true;
        }
    }

    private void AgentsDockToggleButton_Click(object sender, RoutedEventArgs e)
    {
        if (AgentsColumnDef is null) return;
        if (_agentsDockOpen)
        {
            AgentsColumnDef.Width = new GridLength(0);
            AgentsColumnDef.MinWidth = 0;
            _agentsDockOpen = false;
        }
        else
        {
            // Star width so the Room|Maestro|Agents splitters can still drag.
            AgentsColumnDef.MinWidth = 160;
            AgentsColumnDef.Width = new GridLength(0.85, GridUnitType.Star);
            _agentsDockOpen = true;
        }
    }

    private async void MenuOpenProject_Click(object sender, RoutedEventArgs e) =>
        await ChooseWorkspaceAsync();

    private async void MenuNewProject_Click(object sender, RoutedEventArgs e)
    {
        var nameBox = new TextBox
        {
            MinWidth = 300,
            Margin = new Thickness(0, 8, 0, 14),
            Padding = new Thickness(8, 6, 8, 6)
        };
        var create = new Button
        {
            Content = "Create",
            IsDefault = true,
            MinWidth = 76,
            Padding = new Thickness(10, 5, 10, 5)
        };
        var cancel = new Button
        {
            Content = "Cancel",
            IsCancel = true,
            MinWidth = 76,
            Margin = new Thickness(8, 0, 0, 0),
            Padding = new Thickness(10, 5, 10, 5)
        };
        var dialog = new Window
        {
            Title = "New Project — Helmian",
            Owner = this,
            SizeToContent = SizeToContent.WidthAndHeight,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Thickness(18),
                Children =
                {
                    new TextBlock { Text = "Project name", FontWeight = FontWeights.SemiBold },
                    nameBox,
                    new StackPanel
                    {
                        Orientation = Orientation.Horizontal,
                        HorizontalAlignment = HorizontalAlignment.Right,
                        Children = { create, cancel }
                    }
                }
            }
        };
        create.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(nameBox.Text)) return;
            dialog.DialogResult = true;
        };
        dialog.Loaded += (_, _) => nameBox.Focus();

        if (dialog.ShowDialog() != true) return;

        NewProjectNameBox.Text = nameBox.Text.Trim();
        HideNewProjectValidation();
        await CreateProjectFromPanelAsync();
        if (NewProjectValidationText.Visibility == Visibility.Visible
            && !string.IsNullOrWhiteSpace(NewProjectValidationText.Text))
        {
            MessageBox.Show(this, NewProjectValidationText.Text, "New Project",
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }

    private void RecentProjectsMenu_SubmenuOpened(object sender, RoutedEventArgs e)
    {
        RecentProjectsMenu.Items.Clear();
        var projects = ProjectShelf.Discover(
            ResolveProjectRoot(),
            PinnedSlugs(),
            filter: null,
            activeDirectory: _registeredWorkspacePath)
            .Take(10)
            .ToArray();

        if (projects.Length == 0)
        {
            RecentProjectsMenu.Items.Add(new MenuItem
            {
                Header = "No recent projects",
                IsEnabled = false
            });
            return;
        }

        foreach (var project in projects)
        {
            var item = new MenuItem { Header = project.Name, Tag = project.Directory };
            item.Click += OpenRecentProject_Click;
            RecentProjectsMenu.Items.Add(item);
        }
    }

    private async void OpenRecentProject_Click(object sender, RoutedEventArgs e)
    {
        if (sender is MenuItem { Tag: string directory } && Directory.Exists(directory))
        {
            await ActivateProjectAsync(directory, ensureStructure: false);
            NavigateTo("Console");
        }
    }

    private void MenuExit_Click(object sender, RoutedEventArgs e) => Close();
    private void MenuSettings_Click(object sender, RoutedEventArgs e) => NavigateTo("Settings");

    private void MenuToggleSidebar_Click(object sender, RoutedEventArgs e)
    {
        LeftPanelToggleButton_Click(sender, e);
        ViewSidebarMenuItem.IsChecked = _shellLayout.LeftPanelVisible;
    }

    private void MenuToggleDetails_Click(object sender, RoutedEventArgs e)
    {
        RightPanelToggleButton_Click(sender, e);
        ViewDetailsMenuItem.IsChecked = _shellLayout.RightPanelVisible;
    }

    private void MenuToggleBottomPanel_Click(object sender, RoutedEventArgs e)
    {
        var show = FooterChrome.Visibility != Visibility.Visible;
        FooterChrome.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        FooterRow.Height = show ? new GridLength(38) : new GridLength(0);
        ViewBottomPanelMenuItem.IsChecked = show;
    }

    private void MenuFullScreen_Click(object sender, RoutedEventArgs e)
    {
        if (!_consoleFullScreen) NavigateTo("Console");
        SetConsoleFullScreen(!_consoleFullScreen);
    }

    private void ShowWorkbenchFromMenu(string id)
    {
        if (!_shellLayout.RightPanelVisible)
        {
            _shellLayout = _shellLayout.ToggleRightPanel();
            ApplyShellPanelVisibility();
        }
        ViewDetailsMenuItem.IsChecked = true;
        SelectWorkbenchSurface(id);
    }

    private void MenuShowBrowser_Click(object sender, RoutedEventArgs e) => ShowWorkbenchFromMenu("browser");
    private void MenuShowCanvas_Click(object sender, RoutedEventArgs e) => ShowWorkbenchFromMenu("canvas");
    private void MenuShowPreview_Click(object sender, RoutedEventArgs e) => ShowWorkbenchFromMenu("preview");
    private void MenuShowCreate_Click(object sender, RoutedEventArgs e) => ShowWorkbenchFromMenu("create");

    private void MenuDocumentation_Click(object sender, RoutedEventArgs e)
    {
        var documentation = Path.Combine(HelmionRootPath(), "README.md");
        if (File.Exists(documentation))
        {
            Process.Start(new ProcessStartInfo(documentation) { UseShellExecute = true });
        }
    }

    private void MenuShortcuts_Click(object sender, RoutedEventArgs e) =>
        MessageBox.Show(this,
            "Ctrl+N  New Project\nCtrl+O  Open Project\nCtrl+,  Settings\nCtrl+B  Sidebar\nCtrl+Shift+D  Details\nCtrl+J  Bottom Panel\nF11  Full Screen\nCtrl+= / Ctrl+-  Text size",
            "Keyboard Shortcuts", MessageBoxButton.OK, MessageBoxImage.Information);

    private void MenuWhatsNew_Click(object sender, RoutedEventArgs e) =>
        MessageBox.Show(this,
            "Compact navigation, Review & History, cleaner integrations, and the new Black theme are available in this build.",
            "What's New", MessageBoxButton.OK, MessageBoxImage.Information);

    private void MenuTroubleshooting_Click(object sender, RoutedEventArgs e)
    {
        NavigateTo("Settings");
        ShowWorkbenchFromMenu("guard");
    }

    private async void ConnectSlackFuture_Click(object sender, RoutedEventArgs e) =>
        await ConnectTeamProviderAsync(TeamConnectorContract.SlackProviderId, sender as Button);

    /// <summary>
    /// Discord button = load the real Discord web UI in Room (not bot OAuth first).
    /// Primary source: Troy 2026-08-02 — "just load the discord ui when i click the discord button".
    /// </summary>
    private async void ConnectDiscordFuture_Click(object sender, RoutedEventArgs e) =>
        await OpenTeamDiscordWebUiAsync();

    private void TeamDiscordCloseButton_Click(object sender, RoutedEventArgs e) =>
        CloseTeamDiscordWebUi();

    private void CloseTeamDiscordWebUi()
    {
        if (TeamDiscordWebHost is not null)
            TeamDiscordWebHost.Visibility = Visibility.Collapsed;
        if (TeamDiscordStatusText is not null)
            TeamDiscordStatusText.Visibility = Visibility.Collapsed;
    }

    private async Task OpenTeamDiscordWebUiAsync()
    {
        // Expand Room if collapsed so Discord has space.
        if (_teamDockCollapsed)
            TeamDockCollapseButton_Click(TeamDockCollapseButton!, new RoutedEventArgs());

        if (TeamDiscordWebHost is not null)
            TeamDiscordWebHost.Visibility = Visibility.Visible;

        if (TeamDiscordStatusText is not null)
        {
            TeamDiscordStatusText.Text = "Loading Discord…";
            TeamDiscordStatusText.Visibility = Visibility.Visible;
        }

        try
        {
            await EnsureTeamDiscordWebViewAsync();
            if (!_teamDiscordWebReady || TeamDiscordWebView?.CoreWebView2 is null)
            {
                if (TeamDiscordStatusText is not null)
                {
                    TeamDiscordStatusText.Text =
                        "Discord web UI needs Microsoft Edge WebView2 Runtime. Install it, then click Discord again.";
                    TeamDiscordStatusText.Visibility = Visibility.Visible;
                }
                return;
            }

            _teamDiscordAuthorizedUri = DiscordWebAppUrl;
            TeamDiscordWebView.CoreWebView2.Navigate(DiscordWebAppUrl);
            if (TeamConnectBadgeText is not null)
                TeamConnectBadgeText.Text = "DISCORD WEB";
            if (TeamRoomSubtitle is not null)
                TeamRoomSubtitle.Text = "Discord";
        }
        catch (Exception ex)
        {
            if (TeamDiscordStatusText is not null)
            {
                TeamDiscordStatusText.Text = $"Discord could not open: {ex.Message}";
                TeamDiscordStatusText.Visibility = Visibility.Visible;
            }
        }
    }

    private async Task EnsureTeamDiscordWebViewAsync()
    {
        if (_teamDiscordWebReady) return;
        if (_teamDiscordWebInitializing)
        {
            while (_teamDiscordWebInitializing)
                await Task.Delay(20);
            return;
        }

        if (TeamDiscordWebView is null) return;

        _teamDiscordWebInitializing = true;
        try
        {
            // Separate profile so Discord login cookies stay for this Room host.
            var profileFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Helmian",
                "DiscordWebProfile");
            Directory.CreateDirectory(profileFolder);
            var environment = await CoreWebView2Environment.CreateAsync(null, profileFolder);
            await TeamDiscordWebView.EnsureCoreWebView2Async(environment);

            var core = TeamDiscordWebView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            // Discord login needs password save + autofill in the embedded surface.
            core.Settings.IsGeneralAutofillEnabled = true;
            core.Settings.IsPasswordAutosaveEnabled = true;

            core.NewWindowRequested += (_, args) =>
            {
                // Keep popups (OAuth, gift, etc.) inside this WebView when possible.
                args.Handled = true;
                if (!string.IsNullOrWhiteSpace(args.Uri)
                    && Uri.TryCreate(args.Uri, UriKind.Absolute, out var u)
                    && u.Scheme == Uri.UriSchemeHttps)
                {
                    _teamDiscordAuthorizedUri = u.AbsoluteUri;
                    core.Navigate(u.AbsoluteUri);
                }
            };

            core.NavigationStarting += (_, args) =>
            {
                // Allow public HTTPS only (same boundary as Helmian Browser).
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
                    || uri.Scheme != Uri.UriSchemeHttps)
                {
                    if (!string.Equals(args.Uri, "about:blank", StringComparison.OrdinalIgnoreCase))
                        args.Cancel = true;
                    return;
                }

                // First hop / redirects from Discord login stay on HTTPS public hosts.
                var decision = EmbeddedBrowserPolicy.ValidateSyntax(uri.AbsoluteUri);
                if (!decision.Allowed)
                {
                    args.Cancel = true;
                    if (TeamDiscordStatusText is not null)
                    {
                        TeamDiscordStatusText.Text = decision.Message;
                        TeamDiscordStatusText.Visibility = Visibility.Visible;
                    }
                }
            };

            core.NavigationCompleted += (_, args) =>
            {
                if (TeamDiscordStatusText is null) return;
                if (args.IsSuccess)
                    TeamDiscordStatusText.Visibility = Visibility.Collapsed;
                else
                {
                    TeamDiscordStatusText.Text =
                        $"Discord page failed to load ({args.WebErrorStatus}). Check network and try again.";
                    TeamDiscordStatusText.Visibility = Visibility.Visible;
                }
            };

            _teamDiscordWebReady = true;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            _teamDiscordWebReady = false;
            if (TeamDiscordStatusText is not null)
            {
                TeamDiscordStatusText.Text =
                    "Microsoft Edge WebView2 Runtime is not installed. Install it, then click Discord again.";
                TeamDiscordStatusText.Visibility = Visibility.Visible;
            }
        }
        finally
        {
            _teamDiscordWebInitializing = false;
        }
    }

    private async void ConnectGitHubFuture_Click(object sender, RoutedEventArgs e) =>
        await ConnectTeamProviderAsync(TeamConnectorContract.GitHubProviderId, sender as Button);

    private async Task ConnectTeamProviderAsync(string providerId, Button? sourceButton)
    {
        var provider = TeamConnectorContract.LabelFor(providerId);
        if (sourceButton is not null) sourceButton.IsEnabled = false;
        try
        {
            var current = await _serviceConnector.GetTeamConnectionAsync(providerId);
            if (current.IsConnected)
            {
                // Clicking Connect when already linked used to look like a dead button.
                // Say it out loud so Troy is not left wondering why nothing opened.
                ApplyTeamConnectionState(current);
                ProviderConnectionStatusText.Text = current.Detail;
                TeamConnectionStatusText.Text = current.Detail;
                await RefreshTeamConversationAsync();
                MessageBox.Show(this,
                    $"{provider} is already connected.\n\n{current.Detail}\n\nNo browser opens because you are already signed in. Use the Team conversation panel to browse what this connection can show.",
                    $"{provider} already connected",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
                return;
            }

            var launch = await _serviceConnector.BeginTeamAuthorizationAsync(providerId);
            ApplyTeamConnectionState(launch.Connection);
            if (string.IsNullOrWhiteSpace(launch.AuthorizationUri))
            {
                // GitHub PAT connects without a browser; Slack/Discord return null only on setup/error.
                ProviderConnectionStatusText.Text = launch.Connection.Detail;
                if (launch.Connection.IsConnected)
                {
                    await RefreshTeamConversationAsync();
                }
                return;
            }
            if (!Uri.TryCreate(launch.AuthorizationUri, UriKind.Absolute, out var authorizationUri)
                || authorizationUri.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidDataException("The local service returned an invalid provider authorization address.");
            }

            Process.Start(new ProcessStartInfo(authorizationUri.AbsoluteUri)
            {
                UseShellExecute = true
            });
            TeamConnectionStatusText.Text = $"Finish {provider} authorization in your browser. Helmian will return here automatically.";
            for (var attempt = 0; attempt < 90; attempt += 1)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
                var state = await _serviceConnector.GetTeamConnectionAsync(providerId);
                ApplyTeamConnectionState(state);
                if (state.IsConnected)
                {
                    ProviderConnectionStatusText.Text = state.Detail;
                    await RefreshTeamConversationAsync();
                    return;
                }
                if (state.Stage is TeamConnectStage.AuthorizationFailed
                    or TeamConnectStage.CredentialExpired)
                {
                    ProviderConnectionStatusText.Text = state.Detail;
                    return;
                }
            }
            TeamConnectionStatusText.Text =
                $"{provider} authorization is still waiting. Complete it in the browser, then press Connect again to refresh.";
        }
        catch (Exception error) when (error is IOException
                                      or InvalidDataException
                                      or InvalidOperationException
                                      or LocalServiceResponseException
                                      or System.ComponentModel.Win32Exception)
        {
            var message = $"{provider} connection could not start: {error.Message}";
            TeamConnectionStatusText.Text = message;
            ProviderConnectionStatusText.Text = message;
            TeamConnectBadgeText.Text = "NOT CONNECTED";
        }
        finally
        {
            if (sourceButton is not null) sourceButton.IsEnabled = true;
        }
    }

    private void ApplyTeamConnectionState(TeamConnectionState state)
    {
        // No prose under Send — header badge carries state only.
        if (TeamConnectionStatusText is not null)
        {
            TeamConnectionStatusText.Text = state.Detail;
            TeamConnectionStatusText.Visibility = Visibility.Collapsed;
        }
        if (TeamConnectionSetupText is not null)
        {
            TeamConnectionSetupText.Text = string.Empty;
            TeamConnectionSetupText.Visibility = Visibility.Collapsed;
        }
        TeamConnectBadgeText.Text = state.IsConnected ? "CONNECTED" : state.Stage switch
        {
            TeamConnectStage.AwaitingCallback => "AUTHORIZING",
            TeamConnectStage.NotConfigured => "SETUP NEEDED",
            TeamConnectStage.ReadyToAuthorize => "READY TO CONNECT",
            TeamConnectStage.CredentialExpired => "RECONNECT NEEDED",
            _ => "NOT CONNECTED"
        };
        TeamConnectBadgeText.ToolTip = string.IsNullOrWhiteSpace(state.Detail) ? null : state.Detail;
    }

    private async Task RefreshTeamConversationAsync(
        string? providerId = null,
        string? scopeId = null,
        string? channelId = null)
    {
        var snapshot = await _serviceConnector.ReadTeamConversationAsync(
            providerId,
            scopeId,
            channelId);
        _teamPickerLoading = true;
        try
        {
            if (providerId is null)
            {
                _teamScopesCache = snapshot.Scopes;
                ApplyTeamScopeFilter();
                TeamChannelBox.ItemsSource = null;
            }
            else if (scopeId is not null && channelId is null)
            {
                TeamChannelBox.ItemsSource = snapshot.Channels;
            }

            TeamMessageList.ItemsSource = snapshot.Messages;
            TeamMessageEmptyCard.Visibility = snapshot.Messages.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;

            if (snapshot.Messages.Count == 0)
            {
                var scopeCount = providerId is null
                    ? FilteredTeamScopes().Count
                    : snapshot.Scopes.Count;
                TeamMessageEmptyTitle.Text = scopeCount == 0
                    ? "NO SOURCES YET"
                    : channelId is not null
                        ? "NO MESSAGES"
                        : scopeId is not null
                            ? "PICK A CHANNEL OR ISSUE"
                            : "PICK A SOURCE";
                TeamMessageEmptyBody.Text = scopeCount == 0
                    ? "Hit Discord or GitHub under this room to sign in. Sources show on the left. This is Helmian Room, not Discord's app."
                    : channelId is not null
                        ? "Nothing to show for this thread yet."
                        : scopeId is not null && snapshot.Channels.Count == 0
                            ? "No channels or issues on this source yet. Discord history needs the Helmian bot in that server. GitHub needs issues or pull requests on the repo."
                            : "Click a server or repo on the left, then a channel or issue under it. The thread fills this side.";
            }

            // Free local room (no Neon) fills the thread when bridges returned nothing.
            if (snapshot.Messages.Count == 0 && scopeId is null)
            {
                try
                {
                    _roomLocalStore.SeedDemoIfEmpty();
                    var local = _roomLocalStore.ReadRecent("demo");
                    if (local.Count > 0)
                    {
                        TeamMessageList.ItemsSource = local
                            .Select(item => new TeamMessage(
                                TeamConnectorContract.HelmianRoomProviderId,
                                item.RoomId,
                                "local",
                                item.MessageId,
                                item.AuthorId,
                                item.AuthorLabel,
                                item.Body,
                                item.SentAtUtc,
                                null,
                                null))
                            .ToArray();
                        TeamMessageEmptyCard.Visibility = Visibility.Collapsed;
                    }
                }
                catch
                {
                    // Local store is best-effort for broke-mode demos.
                }
            }

            if (TeamRoomSubtitle is not null)
            {
                TeamRoomSubtitle.Text = scopeId is null
                    ? "Project talk"
                    : snapshot.Detail.Length > 48
                        ? snapshot.Detail[..48] + "…"
                        : string.IsNullOrWhiteSpace(snapshot.Detail)
                            ? "Project talk"
                            : snapshot.Detail;
            }

            if (TeamRoomComposePlaceholder is not null
                && string.IsNullOrEmpty(TeamRoomComposeBox?.Text))
            {
                TeamRoomComposePlaceholder.Text = "Message the room…";
            }

            // Status/setup dump removed from Room UI — badge only. Keep sinks collapsed.
            if (TeamConnectionStatusText is not null)
            {
                TeamConnectionStatusText.Text = snapshot.Detail;
                TeamConnectionStatusText.Visibility = Visibility.Collapsed;
            }
            TeamConnectBadgeText.Text = TeamBadgeLabel(snapshot.Connections);
            if (TeamConnectionSetupText is not null)
            {
                TeamConnectionSetupText.Text = string.Empty;
                TeamConnectionSetupText.Visibility = Visibility.Collapsed;
            }
        }
        finally
        {
            _teamPickerLoading = false;
        }
    }

    private IReadOnlyList<TeamScope> FilteredTeamScopes()
    {
        if (_teamProviderFilter is "all") return _teamScopesCache;
        return _teamScopesCache
            .Where(item => string.Equals(item.ProviderId, _teamProviderFilter, StringComparison.Ordinal))
            .ToArray();
    }

    private void ApplyTeamScopeFilter()
    {
        TeamScopeBox.ItemsSource = FilteredTeamScopes();
    }

    private void TeamFilterAllButton_Click(object sender, RoutedEventArgs e)
    {
        _teamProviderFilter = "all";
        ApplyTeamScopeFilter();
    }

    private async void TeamFilterDiscordButton_Click(object sender, RoutedEventArgs e)
    {
        // Rail Discord icon opens live Discord web UI (same as Discord connect button).
        await OpenTeamDiscordWebUiAsync();
        _teamProviderFilter = TeamConnectorContract.DiscordProviderId;
        ApplyTeamScopeFilter();
    }

    private void TeamFilterGitHubButton_Click(object sender, RoutedEventArgs e)
    {
        _teamProviderFilter = TeamConnectorContract.GitHubProviderId;
        ApplyTeamScopeFilter();
    }

    private static string TeamBadgeLabel(IReadOnlyList<TeamConnectionState> connections)
    {
        if (connections.Any(item => item.IsConnected)) return "CONNECTED";
        if (connections.Any(item => item.Stage == TeamConnectStage.AwaitingCallback)) return "AUTHORIZING";
        if (connections.Any(item => item.Stage == TeamConnectStage.CredentialExpired)) return "RECONNECT NEEDED";
        if (connections.Any(item => item.Stage == TeamConnectStage.NotConfigured)) return "SETUP NEEDED";
        if (connections.Any(item => item.Stage == TeamConnectStage.ReadyToAuthorize)) return "READY TO CONNECT";
        return "NOT CONNECTED";
    }

    private async void TeamScopeBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_teamPickerLoading || TeamScopeBox.SelectedItem is not TeamScope scope) return;
        try
        {
            TeamChannelBox.SelectedItem = null;
            await RefreshTeamConversationAsync(scope.ProviderId, scope.Id);
        }
        catch (Exception error)
        {
            TeamConnectionStatusText.Text = $"Could not load channels or issues: {error.Message}";
        }
    }

    private async void TeamChannelBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_teamPickerLoading
            || TeamScopeBox.SelectedItem is not TeamScope scope
            || TeamChannelBox.SelectedItem is not TeamChannel channel)
        {
            return;
        }
        try
        {
            await RefreshTeamConversationAsync(scope.ProviderId, scope.Id, channel.Id);
        }
        catch (Exception error)
        {
            TeamConnectionStatusText.Text = $"Could not load messages: {error.Message}";
        }
    }

    private void TeamRoomComposeBox_TextChanged(object sender, System.Windows.Controls.TextChangedEventArgs e)
    {
        if (TeamRoomComposePlaceholder is null || TeamRoomComposeBox is null)
            return;
        TeamRoomComposePlaceholder.Visibility = string.IsNullOrEmpty(TeamRoomComposeBox.Text)
            ? System.Windows.Visibility.Visible
            : System.Windows.Visibility.Collapsed;
    }

    private void TeamRoomComposeBox_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Enter
            && (System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Shift) == 0)
        {
            e.Handled = true;
            TeamRoomSendButton_Click(sender, e);
        }
    }

    private void TeamRoomSendButton_Click(object sender, RoutedEventArgs e)
    {
        var text = TeamRoomComposeBox?.Text?.Trim() ?? string.Empty;
        if (text.Length == 0) return;
        if (text.Length > 4000)
        {
            TeamConnectionStatusText.Text = "Keep local room notes under 4000 characters.";
            return;
        }

        try
        {
            _roomLocalStore.Append(new RoomLocalMessage(
                "demo",
                Guid.NewGuid().ToString("N"),
                Environment.UserName,
                Environment.UserName,
                text,
                DateTimeOffset.UtcNow));
            if (TeamRoomComposeBox is not null) TeamRoomComposeBox.Text = string.Empty;
            var local = _roomLocalStore.ReadRecent("demo");
            TeamMessageList.ItemsSource = local
                .Select(item => new TeamMessage(
                    TeamConnectorContract.HelmianRoomProviderId,
                    item.RoomId,
                    "local",
                    item.MessageId,
                    item.AuthorId,
                    item.AuthorLabel,
                    item.Body,
                    item.SentAtUtc,
                    null,
                    null))
                .ToArray();
            TeamMessageEmptyCard.Visibility = Visibility.Collapsed;
            TeamConnectionStatusText.Text = "Posted to local Helmian Room (free on this PC).";
            TeamRoomSubtitle.Text = "Local room";
        }
        catch (Exception error)
        {
            TeamConnectionStatusText.Text = $"Could not post local note: {error.Message}";
        }
    }
}

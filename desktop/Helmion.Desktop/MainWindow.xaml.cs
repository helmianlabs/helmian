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

    /// <summary>
    /// Custom providers whose endpoint answered a real probe during this run. Deliberately
    /// not persisted: a verification from a previous run proves nothing about right now.
    /// </summary>
    private readonly HashSet<string> _verifiedCustomProviders =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The four coordinators with compiled-in endpoints; custom names may not shadow them.</summary>
    private static readonly string[] BuiltInCoordinators = ["OpenAI", "Claude", "Gemini", "Grok"];

    private bool _themeSelectorReady;
    private string? _registeredWorkspacePath;
    private ConsoleSession? _consoleSession;

    /// <summary>
    /// Chooses and owns the live speech backend. The session below is whatever it
    /// built — read it, never construct it.
    /// </summary>
    private VoiceBackendSelector? _voiceSelector;

    private VoiceSession? _voiceSession;
    private AgentBridge? _agentBridge;
    private bool _serviceConnected;
    private WorkspaceInspection? _currentWorkspaceInspection;
    private bool _choosingWorkspace;
    private bool _refreshingWorkspace;
    private bool _voiceTurnBusy;
    private bool _agentBusy;
    private bool _consoleFullScreen;
    private WindowState _restoreWindowState = WindowState.Normal;
    private double _restoreLeft;
    private double _restoreTop;
    private double _restoreWidth;
    private double _restoreHeight;

    private string CurrentPermissionMode
    {
        get
        {
            if (ConsolePermissionCombo?.SelectedItem is ComboBoxItem { Tag: string tag })
            {
                return AgentPermission.Normalize(tag);
            }

            return _consoleSession?.PermissionMode
                ?? _desktopSettings.ResolvedPermissionMode
                ?? AgentPermission.ReadOnly;
        }
    }

    private void UpdateConsoleExecutionState()
    {
        try
        {
            var mode = CurrentPermissionMode;
            if (_consoleSession is not null)
            {
                _consoleSession.PermissionMode = mode;
            }

            ConsoleExecutionBadgeText.Text = AgentPermission.BadgeLabel(mode);
            ConsoleExecutionBadgeText.Foreground = mode == AgentPermission.ReadOnly
                ? (Brush)FindResource("AmberBrush")
                : (Brush)FindResource("AccentBrush");

            var maestro = _consoleSession?.ActiveCoordinator ?? "?";
            ConsoleServiceSessionText.Text = mode switch
            {
                AgentPermission.Full =>
                    $"Full tools ON for every LLM · Maestro={maestro} · write_file + run_command allowed.",
                AgentPermission.Ask =>
                    $"Ask before each tool · Maestro={maestro} · every call waits for your approval; no answer = denied.",
                AgentPermission.ReadTools =>
                    $"Read tools ON for every LLM · Maestro={maestro} · writes/shell blocked.",
                _ =>
                    $"Read-only chat · Maestro={maestro} · no tools until you raise permissions."
            };
        }
        catch
        {
            // Ignore UI update exceptions
        }
    }

    private void ConsolePermissionCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_themeSelectorReady && ConsolePermissionCombo is null)
        {
            return;
        }

        // Avoid firing during InitializeComponent before fields exist.
        if (!IsLoaded)
        {
            return;
        }

        var mode = CurrentPermissionMode;
        if (_consoleSession is not null)
        {
            _consoleSession.PermissionMode = mode;
        }

        _desktopSettings = _desktopSettings with { PermissionMode = mode };
        if (_persistTheme)
        {
            try { DesktopSettingsStore.Save(_desktopSettings); } catch { /* ignore */ }
        }

        try
        {
            Environment.SetEnvironmentVariable("HELMION_PERMISSION_MODE", mode);
        }
        catch
        {
            // ignore
        }

        UpdateConsoleExecutionState();
        AppendConsoleLine($"[Permissions → {mode} · applies to OpenAI, Claude, Gemini, Grok]");
    }

    /// <summary>
    /// The approval question currently on screen (ask mode), or null.
    /// Completed by a button click, or cancelled when the agent decides for
    /// itself first — a timeout on the Node side, for instance.
    /// </summary>
    private TaskCompletionSource<string>? _pendingApproval;

    private string? _pendingApprovalId;

    /// <summary>
    /// Show the approval strip and wait for the user. Returns the decision, or
    /// null when the request was withdrawn before anyone clicked.
    /// </summary>
    private Task<string?> RequestToolApprovalAsync(AgentBridgeEvent request)
    {
        // Only one question at a time: the agent loop asks serially.
        CancelPendingApproval();

        _pendingApprovalId = request.Id;
        var completion = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _pendingApproval = completion;

        var tool = request.Tool ?? request.Name ?? "tool";
        ConsoleApprovalTitleText.Text = $"APPROVAL NEEDED · {tool}";
        ConsoleApprovalSummaryText.Text = request.Summary ?? tool;

        var seconds = request.TimeoutMs is > 0 ? request.TimeoutMs.Value / 1000 : 0;
        ConsoleApprovalDetailText.Text = seconds > 0
            ? $"workspace {request.Workspace ?? "?"} · denied automatically in {seconds}s if you do not answer"
            : $"workspace {request.Workspace ?? "?"}";

        ConsoleApprovalPanel.Visibility = Visibility.Visible;

        // Focus used to jump to "Allow once" unconditionally. Two problems with
        // that: it eats the characters of whoever was mid-sentence in the
        // composer, and the next stray Space or Enter APPROVES a tool call the
        // user never read. So leave a typist alone, and when we do take focus,
        // take it to Deny — the same direction every other unanswered path in
        // ask mode resolves. Both buttons stay Tab-reachable either way.
        if (ConsoleInputBox.IsKeyboardFocusWithin)
        {
            AppendConsoleLine(
                "  (still typing — approval buttons are below; press Tab to reach them)");
        }
        else
        {
            ConsoleApprovalDenyButton.Focus();
        }

        AppendConsoleLine($"  ⚠ APPROVAL NEEDED — {request.Summary ?? tool}");

        // The agent denies on its own clock. Stop waiting slightly after it does,
        // or this loop would still be blocked on a click while the turn has
        // already moved on — the permission_decision event sits unread behind us.
        var budget = request.TimeoutMs is > 0 ? request.TimeoutMs.Value : 300000;
        return WaitForApprovalAsync(completion, budget + 2000);
    }

    private static async Task<string?> WaitForApprovalAsync(
        TaskCompletionSource<string> completion,
        int abandonAfterMs)
    {
        var finished = await Task.WhenAny(
            completion.Task,
            Task.Delay(abandonAfterMs)).ConfigureAwait(true);

        if (finished != completion.Task)
        {
            // Nobody answered in time; the agent has already denied it.
            return null;
        }

        var decision = await completion.Task.ConfigureAwait(true);
        return string.IsNullOrEmpty(decision) ? null : decision;
    }

    /// <summary>Withdraw the on-screen question without answering it.</summary>
    private void CancelPendingApproval()
    {
        var pending = _pendingApproval;
        _pendingApproval = null;
        _pendingApprovalId = null;
        HideApprovalPanel();
        pending?.TrySetResult(string.Empty);
    }

    private void HideApprovalPanel()
    {
        if (ConsoleApprovalPanel is not null)
        {
            ConsoleApprovalPanel.Visibility = Visibility.Collapsed;
        }
    }

    private void CompleteApproval(string decision)
    {
        var pending = _pendingApproval;
        _pendingApproval = null;
        _pendingApprovalId = null;
        HideApprovalPanel();
        pending?.TrySetResult(decision);
    }

    private void ConsoleApprovalAllowOnce_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.AllowOnce);

    private void ConsoleApprovalAllowSession_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.AllowSession);

    private void ConsoleApprovalDeny_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.Deny);

    private void AppendConsoleLine(string line)
    {
        if (ConsoleOutputText is null)
        {
            return;
        }

        ConsoleOutputText.AppendText(line.EndsWith('\n') ? line : line + "\n");
        ConsoleOutputText.CaretIndex = ConsoleOutputText.Text.Length;
        ConsoleOutputText.ScrollToEnd();
    }

    private void SelectPermissionInCombo(string? mode)
    {
        var normalized = AgentPermission.Normalize(mode);
        foreach (var item in ConsolePermissionCombo.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Tag?.ToString(), normalized, StringComparison.OrdinalIgnoreCase))
            {
                ConsolePermissionCombo.SelectedItem = item;
                return;
            }
        }

        ConsolePermissionCombo.SelectedIndex = 0;
    }

    private void UpdateSnapshot()
    {
        try
        {
            var settings = EnvironmentSettingsStore.Load();
            DataContext = PilotSnapshot.CreateLive(
                _serviceConnected,
                _currentWorkspaceInspection,
                settings.DatabaseUrl ?? "",
                settings.GeminiApiKey ?? "",
                settings.GrokApiKey ?? "",
                settings.MaestroCoordinator ?? "Codex");
        }
        catch
        {
            DataContext = PilotSnapshot.CreateLive(
                _serviceConnected,
                _currentWorkspaceInspection,
                "",
                "",
                "",
                "Codex");
        }
        UpdateConsoleExecutionState();
    }

    public MainWindow(string? themeOverride = null, bool persistTheme = true)
    {
        _persistTheme = persistTheme;
        _desktopSettings = DesktopSettingsStore.Load();
        _providerProfiles = ProviderProfileCatalog.CreateUnconfigured(
            _desktopSettings.CustomProviders,
            _verifiedCustomProviders);
        var initialTheme = ColorThemeCatalog.Get(themeOverride ?? _desktopSettings.ColorTheme);
        ColorThemeManager.Apply(initialTheme.Id);
        // Share the process-wide host so App auto-start and this window do not race-kill the pipe.
        _serviceConnector = LocalServiceHost.Connector;

        InitializeComponent();
        SetServiceStatus("Starting…", "Waiting for local loopback service", connected: false);
        UpdateSnapshot();
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
        RepopulateMaestroCoordinators();

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

        // Leaving Console while immersive exits full screen so other pages keep chrome.
        if (_consoleFullScreen
            && !string.Equals(pageName, "Console", StringComparison.Ordinal))
        {
            SetConsoleFullScreen(false);
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
            "Console" => "Modern CLI · permissions · voice · full screen (F11)",
            "Activity" => "Live Activity Stream · Orchestration Timeline",
            "Evidence" => "Handoffs, checkpoints, and durable proof",
            "Approvals" => "Optional advanced owner decisions",
            "Integrations" => "Safe connection boundaries",
            "Release" => "The path from pilot to multi-user product",
            "Settings" => "Personal pilot preferences",
            _ => "Helmion personal pilot"
        };
    }

    private void ConsoleFullScreenButton_Click(object sender, RoutedEventArgs e)
    {
        SetConsoleFullScreen(!_consoleFullScreen);
    }

    private void MainWindow_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.F11)
        {
            // F11 toggles console immersive mode (navigates to Console if needed).
            if (!_consoleFullScreen)
            {
                NavigateTo("Console");
                SetConsoleFullScreen(true);
            }
            else
            {
                SetConsoleFullScreen(false);
            }

            e.Handled = true;
            return;
        }

        if (e.Key == System.Windows.Input.Key.Escape && _consoleFullScreen)
        {
            SetConsoleFullScreen(false);
            e.Handled = true;
        }
    }

    private void SetConsoleFullScreen(bool enabled)
    {
        if (_consoleFullScreen == enabled)
        {
            return;
        }

        if (enabled)
        {
            if (ConsolePage.Visibility != Visibility.Visible)
            {
                NavigateTo("Console");
            }

            _restoreWindowState = WindowState;
            _restoreLeft = Left;
            _restoreTop = Top;
            _restoreWidth = Width;
            _restoreHeight = Height;

            SidebarColumn.Width = new GridLength(0);
            SidebarChrome.Visibility = Visibility.Collapsed;
            HeaderChrome.Visibility = Visibility.Collapsed;
            FooterChrome.Visibility = Visibility.Collapsed;
            HeaderRow.Height = new GridLength(0);
            FooterRow.Height = new GridLength(0);

            WindowState = WindowState.Maximized;
            _consoleFullScreen = true;
            ConsoleFullScreenButton.Content = "⛶  Exit full screen";
            ConsoleFullScreenButton.ToolTip = "Exit full-screen console (Esc or F11)";
            if (ConsoleLiveLabel is not null)
            {
                ConsoleLiveLabel.Text = "FULL SCREEN";
            }

            AppendConsoleLine("[Full screen ON — Esc or F11 to exit]");
        }
        else
        {
            SidebarColumn.Width = new GridLength(248);
            SidebarChrome.Visibility = Visibility.Visible;
            HeaderChrome.Visibility = Visibility.Visible;
            FooterChrome.Visibility = Visibility.Visible;
            HeaderRow.Height = new GridLength(88);
            FooterRow.Height = new GridLength(38);

            WindowState = _restoreWindowState == WindowState.Minimized
                ? WindowState.Normal
                : _restoreWindowState;
            if (WindowState == WindowState.Normal
                && _restoreWidth > 0
                && _restoreHeight > 0)
            {
                Left = _restoreLeft;
                Top = _restoreTop;
                Width = _restoreWidth;
                Height = _restoreHeight;
            }

            _consoleFullScreen = false;
            ConsoleFullScreenButton.Content = "⛶  Full screen";
            ConsoleFullScreenButton.ToolTip = "Toggle full-screen console (F11). Esc exits.";
            if (ConsoleLiveLabel is not null)
            {
                ConsoleLiveLabel.Text = "LIVE";
            }

            AppendConsoleLine("[Full screen OFF]");
        }
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
        // Theme TextBrush changes must not make the dark console composer unreadable.
        ApplyConsoleInputContrast();
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

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        _consoleSession?.Dispose();
        // The selector disposes the session it built; disposing both is safe
        // (VoiceSession.Dispose is idempotent) and covers the pre-selector path.
        try { _voiceSelector?.Dispose(); } catch { /* audio never blocks close */ }
        _voiceSelector = null;
        _voiceSession?.Dispose();
        _voiceSession = null;
        try { _agentBridge?.Dispose(); } catch { /* ignore */ }
        _agentBridge = null;
        // Local service lifetime is owned by LocalServiceHost / App.OnExit.
    }

    /// <summary>Called from App auto-start when the named pipe hello succeeds.</summary>
    public void NotifyLocalServiceOnline(string detail)
    {
        _serviceConnected = true;
        SetServiceStatus("ONLINE", detail, connected: true);
        OverviewServiceStateText.Text = "Connected";
        OverviewServiceStateText.Foreground = (Brush)FindResource("AccentBrush");
        ConnectServiceButton.Content = "Service ONLINE";
        ConnectServiceButton.IsEnabled = true;
        SelectWorkspaceButton.IsEnabled = true;
        RefreshWorkspaceButton.IsEnabled = true;
        UpdateSnapshot();
    }

    /// <summary>Called from App auto-start when the named pipe did not come up.</summary>
    public void NotifyLocalServiceUnavailable(string detail)
    {
        _serviceConnected = false;
        SetServiceStatus("Unavailable", detail, connected: false);
        OverviewServiceStateText.Text = "Offline";
        OverviewServiceStateText.Foreground = (Brush)FindResource("AmberBrush");
        ConnectServiceButton.Content = "Retry local service";
        ConnectServiceButton.IsEnabled = true;
        SelectWorkspaceButton.IsEnabled = true;
        RefreshWorkspaceButton.IsEnabled = true;
        UpdateSnapshot();
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        Loaded -= MainWindow_Loaded;
        LoadApiKeysToInputs();

        _consoleSession = new ConsoleSession();
        _consoleSession.PermissionMode = _desktopSettings.ResolvedPermissionMode;
        SelectPermissionInCombo(_consoleSession.PermissionMode);
        try
        {
            Environment.SetEnvironmentVariable(
                "HELMION_PERMISSION_MODE",
                _consoleSession.PermissionMode);
        }
        catch
        {
            // ignore
        }

        // Voice goes through the backend selector rather than newing a VoiceSession
        // here, so the app can say which backend is live instead of assuming.
        // duplexFactory is deliberately null: Moshi needs ~14 GB of VRAM and this
        // box measured 6 GB, so the honest resolution is Whisper+Kokoro. A fake
        // duplex adapter would only move the lie into the UI.
        _voiceSelector = new VoiceBackendSelector(CreateVoiceSession);
        _voiceSelector.StatusChanged += (_, status) =>
            Dispatcher.Invoke(() => ApplyVoiceBackendStatus(status));
        _voiceSelector.Error += (_, msg) =>
            Dispatcher.Invoke(() =>
            {
                AppendConsoleLine($"\n[Voice] {msg}");
                ConsoleServiceSessionText.Text = msg;
            });
        var envSettings = EnvironmentSettingsStore.Load();
        _consoleSession.ConfigureMaestro(
            envSettings.MaestroCoordinator,
            envSettings,
            _desktopSettings.CustomProviders);
        UpdateConsoleExecutionState();
        AppendConsoleLine(
            "[Console ready · paste multi-line with Ctrl+V · permissions apply to every LLM]");
        UpdateConsoleWorkspaceLabel();
        ApplyConsoleInputContrast();

        // Full multi-line paste into the console composer (WPF single-line boxes drop lines).
        DataObject.AddPastingHandler(ConsoleInputBox, ConsoleInputBox_OnPaste);

        await ConnectServiceAsync(restoreWorkspace: true);
        UpdateConsoleWorkspaceLabel();
        ApplyConsoleInputContrast();
    }

    /// <summary>
    /// Keep composer text bright on the dark terminal chrome.
    /// Theme TextBrush is dark on clean-light — that made typed text invisible.
    /// </summary>
    private void ApplyConsoleInputContrast()
    {
        if (ConsoleInputBox is null)
        {
            return;
        }

        // Local brushes so theme swaps cannot repaint us dark-on-dark.
        ConsoleInputBox.Background = new SolidColorBrush(Color.FromRgb(0x0A, 0x12, 0x18));
        ConsoleInputBox.Foreground = new SolidColorBrush(Color.FromRgb(0xF2, 0xFB, 0xFF));
        ConsoleInputBox.CaretBrush = new SolidColorBrush(Color.FromRgb(0x7F, 0xE3, 0xFF));
        ConsoleInputBox.SelectionBrush = new SolidColorBrush(Color.FromRgb(0x2A, 0x6F, 0x8F));
        ConsoleInputBox.Opacity = 1.0;
        ConsoleInputBox.Visibility = Visibility.Visible;
    }

    private void LoadApiKeysToInputs()
    {
        try
        {
            var envSettings = EnvironmentSettingsStore.Load();
            OpenAiApiKeyInput.Password = envSettings.OpenAiApiKey;
            AnthropicApiKeyInput.Password = envSettings.AnthropicApiKey;
            GeminiApiKeyInput.Password = envSettings.GeminiApiKey;
            DatabaseUrlInput.Password = envSettings.DatabaseUrl;
            GrokApiKeyInput.Password = envSettings.GrokApiKey;
            EndpointIdInput.Text = string.IsNullOrWhiteSpace(envSettings.ExpectedEndpointId)
                ? EnvironmentSettingsStore.ExtractEndpointId(envSettings.DatabaseUrl)
                : envSettings.ExpectedEndpointId;

            foreach (ComboBoxItem item in CodexModeInput.Items)
            {
                if (string.Equals(item.Content?.ToString(), envSettings.CodexMode, StringComparison.OrdinalIgnoreCase))
                {
                    CodexModeInput.SelectedItem = item;
                    break;
                }
            }

            // Rebuild first so a saved custom coordinator is present to be selected.
            RepopulateMaestroCoordinators(envSettings.MaestroCoordinator);
        }
        catch
        {
            // Ignore settings loading errors
        }
    }

    private async void SaveApiKeys_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var openAiKey = OpenAiApiKeyInput.Password.Trim();
            var anthropicKey = AnthropicApiKeyInput.Password.Trim();
            var geminiKey = GeminiApiKeyInput.Password.Trim();
            var dbUrl = DatabaseUrlInput.Password.Trim();
            var grokKey = GrokApiKeyInput.Password.Trim();
            var endpointId = EndpointIdInput.Text.Trim();
            if (string.IsNullOrWhiteSpace(endpointId) && !string.IsNullOrWhiteSpace(dbUrl))
            {
                endpointId = EnvironmentSettingsStore.ExtractEndpointId(dbUrl);
                EndpointIdInput.Text = endpointId;
            }

            var codexMode = (CodexModeInput.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "read-only";
            var maestroCoordinator = (MaestroCoordinatorInput.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "Gemini";
            var currentSettings = EnvironmentSettingsStore.Load();
            var updatedSettings = new EnvironmentSettings(
                geminiKey,
                dbUrl,
                endpointId,
                codexMode,
                currentSettings.CodexInstanceId,
                grokKey,
                maestroCoordinator,
                openAiKey,
                anthropicKey);

            // Soft validation — wrong key shape is a common paste error, not a silent fake.
            var keyHints = new List<string>();
            if (!string.IsNullOrEmpty(anthropicKey) && !anthropicKey.StartsWith("sk-ant-", StringComparison.Ordinal))
            {
                keyHints.Add(
                    "Anthropic key must start with sk-ant- (Google AQ.… keys will get HTTP 401 invalid x-api-key)");
            }
            if (!string.IsNullOrEmpty(openAiKey) && !openAiKey.StartsWith("sk-", StringComparison.Ordinal))
            {
                keyHints.Add("OpenAI key usually starts with sk-");
            }
            if (!string.IsNullOrEmpty(grokKey) && grokKey.StartsWith("gsk_", StringComparison.Ordinal))
            {
                keyHints.Add("Grok field still looks like Groq (gsk_) — use xai- from console.x.ai");
            }
            if (!string.IsNullOrEmpty(grokKey)
                && !grokKey.StartsWith("xai-", StringComparison.OrdinalIgnoreCase)
                && !grokKey.StartsWith("gsk_", StringComparison.Ordinal))
            {
                // xAI has used multiple formats; only warn on empty/wrong known bad shapes above
            }

            EnvironmentSettingsStore.Save(updatedSettings);
            _consoleSession ??= new ConsoleSession();
            _consoleSession.ConfigureMaestro(
                maestroCoordinator,
                updatedSettings,
                _desktopSettings.CustomProviders);
            UpdateConsoleExecutionState();
            var hintText = keyHints.Count > 0 ? " · WARN: " + string.Join("; ", keyHints) : "";
            ApiKeysStatusLabel.Text =
                $"Saved · Maestro={_consoleSession.ActiveCoordinator} · endpoint={_consoleSession.ActiveEndpoint ?? "none"}{hintText}";
            ApiKeysStatusLabel.Foreground = keyHints.Count > 0
                ? (Brush)FindResource("AmberBrush")
                : (Brush)FindResource("AccentBrush");

            if (_registeredWorkspacePath != null && !string.IsNullOrWhiteSpace(dbUrl) && !string.IsNullOrWhiteSpace(endpointId))
            {
                SchemaStatusLabel.Text = "Provisioning schema...";
                SchemaStatusLabel.Foreground = (Brush)FindResource("MutedTextBrush");
                try
                {
                    var provisionResult = await _serviceConnector.ProvisionSchemaAsync(_registeredWorkspacePath, dbUrl, endpointId);
                    if (provisionResult.Success)
                    {
                        SchemaStatusLabel.Text = $"Schema provisioned: {provisionResult.MigrationCount} migrations applied.";
                        SchemaStatusLabel.Foreground = (Brush)FindResource("AccentBrush");
                    }
                    else
                    {
                        SchemaStatusLabel.Text = $"Schema error: {provisionResult.ErrorMessage}";
                        SchemaStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                    }
                }
                catch (Exception ex)
                {
                    SchemaStatusLabel.Text = $"Provision failed: {ex.Message}";
                    SchemaStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                }
            }

            UpdateSnapshot();
            await ConnectServiceAsync(restoreWorkspace: false);
            await RefreshCapabilitiesAsync();
        }
        catch (Exception error)
        {
            ApiKeysStatusLabel.Text = $"Save failed: {error.Message}";
            ApiKeysStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
        }
    }

    /// <summary>
    /// Rebuild the Maestro dropdown as the four built-ins plus every saved custom
    /// provider, preserving the current selection across a settings reload.
    /// </summary>
    private void RepopulateMaestroCoordinators(string? preferredSelection = null)
    {
        if (MaestroCoordinatorInput is null) return;

        var previous = preferredSelection
            ?? (MaestroCoordinatorInput.SelectedItem as ComboBoxItem)?.Content?.ToString();

        MaestroCoordinatorInput.Items.Clear();
        foreach (var builtIn in BuiltInCoordinators)
        {
            MaestroCoordinatorInput.Items.Add(new ComboBoxItem { Content = builtIn });
        }

        foreach (var custom in _desktopSettings.CustomProviders ?? [])
        {
            if (string.IsNullOrWhiteSpace(custom.Name)) continue;
            MaestroCoordinatorInput.Items.Add(new ComboBoxItem { Content = custom.Name.Trim() });
        }

        SelectMaestroCoordinator(previous);
    }

    /// <summary>Select a coordinator by name; falls back to Gemini when the name is gone.</summary>
    private void SelectMaestroCoordinator(string? name)
    {
        if (MaestroCoordinatorInput is null) return;

        if (!string.IsNullOrWhiteSpace(name))
        {
            foreach (ComboBoxItem item in MaestroCoordinatorInput.Items)
            {
                if (string.Equals(item.Content?.ToString(), name, StringComparison.OrdinalIgnoreCase))
                {
                    MaestroCoordinatorInput.SelectedItem = item;
                    return;
                }
            }
        }

        foreach (ComboBoxItem item in MaestroCoordinatorInput.Items)
        {
            if (string.Equals(item.Content?.ToString(), "Gemini", StringComparison.OrdinalIgnoreCase))
            {
                MaestroCoordinatorInput.SelectedItem = item;
                return;
            }
        }

        if (MaestroCoordinatorInput.Items.Count > 0) MaestroCoordinatorInput.SelectedIndex = 0;
    }

    /// <summary>Rebuild the provider registry rows from settings + this run's verified set.</summary>
    private void RefreshProviderRegistry()
    {
        _providerProfiles = ProviderProfileCatalog.CreateUnconfigured(
            _desktopSettings.CustomProviders,
            _verifiedCustomProviders);
        ProviderRegistryList.ItemsSource = null;
        ProviderRegistryList.ItemsSource = _providerProfiles;
    }

    private void AddCustomModel_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var name = CustomModelNameInput.Text.Trim();
            var endpoint = CustomModelEndpointInput.Text.Trim();
            var apiKey = CustomModelApiKeyInput.Text.Trim();

            if (string.IsNullOrWhiteSpace(name))
            {
                CustomModelStatusLabel.Text = "Error: Model name cannot be empty.";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                return;
            }

            if (string.IsNullOrWhiteSpace(endpoint))
            {
                CustomModelStatusLabel.Text = "Error: Endpoint URL cannot be empty.";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                return;
            }

            // Built-ins are resolved before custom names, so a shadowing name would
            // save fine and then silently never route.
            if (BuiltInCoordinators.Any(b => string.Equals(b, name, StringComparison.OrdinalIgnoreCase)))
            {
                CustomModelStatusLabel.Text =
                    $"Error: '{name}' is a built-in coordinator name. Pick a different name.";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                return;
            }

            var customList = _desktopSettings.CustomProviders != null
                ? new List<CustomProviderProfile>(_desktopSettings.CustomProviders)
                : new List<CustomProviderProfile>();

            var exists = customList.Any(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
            if (exists)
            {
                CustomModelStatusLabel.Text = "Error: A model with that name already exists.";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
                return;
            }

            var newProfile = new CustomProviderProfile(name, endpoint, apiKey);
            customList.Add(newProfile);

            _desktopSettings = _desktopSettings with { CustomProviders = customList };
            DesktopSettingsStore.Save(_desktopSettings);

            // Re-initialize and update snapshots/lists
            RefreshProviderRegistry();
            RepopulateMaestroCoordinators();
            UpdateSnapshot();

            CustomModelNameInput.Text = "";
            CustomModelEndpointInput.Text = "";
            CustomModelApiKeyInput.Text = "";

            CustomModelStatusLabel.Text =
                $"Saved '{name}' — unverified. Press Verify to contact the endpoint, "
                + "then pick it as Maestro coordinator.";
            CustomModelStatusLabel.Foreground = (Brush)FindResource("AccentBrush");
        }
        catch (Exception ex)
        {
            CustomModelStatusLabel.Text = $"Add failed: {ex.Message}";
            CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
        }
    }

    /// <summary>
    /// Contact every saved custom endpoint for real. Only a probe that comes back with an
    /// OpenAI-compatible completion promotes a row from "Saved · unverified" to verified.
    /// </summary>
    private async void VerifyCustomModels_Click(object sender, RoutedEventArgs e)
    {
        var providers = _desktopSettings.CustomProviders;
        if (providers is null || providers.Count == 0)
        {
            CustomModelStatusLabel.Text = "No custom providers saved yet.";
            CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
            return;
        }

        VerifyCustomModelsButton.IsEnabled = false;
        try
        {
            var failures = new List<string>();
            foreach (var provider in providers)
            {
                CustomModelStatusLabel.Text = $"Contacting {provider.Name}…";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("MutedTextBrush");

                var result = await CustomChatSession.ProbeAsync(provider);
                if (result.Ok)
                {
                    _verifiedCustomProviders.Add(provider.Name.Trim());
                }
                else
                {
                    _verifiedCustomProviders.Remove(provider.Name.Trim());
                    failures.Add($"{provider.Name}: {result.Detail}");
                }
            }

            RefreshProviderRegistry();

            if (failures.Count == 0)
            {
                CustomModelStatusLabel.Text =
                    $"Verified {providers.Count} custom endpoint(s) — each answered a live request.";
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AccentBrush");
            }
            else
            {
                CustomModelStatusLabel.Text = string.Join(" | ", failures);
                CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
            }
        }
        catch (Exception ex)
        {
            CustomModelStatusLabel.Text = $"Verify failed: {ex.Message}";
            CustomModelStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
        }
        finally
        {
            VerifyCustomModelsButton.IsEnabled = true;
        }
    }

    private async void SyncProfile_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SyncStatusLabel.Text = "Synchronizing profile...";
            SyncStatusLabel.Foreground = (Brush)FindResource("MutedTextBrush");

            var result = await ProfileSyncEngine.SyncProfileAsync();
            if (result.Success)
            {
                SyncStatusLabel.Text = "Success! " + string.Join(", ", result.SyncedItems);
                SyncStatusLabel.Foreground = (Brush)FindResource("AccentBrush");
            }
            else
            {
                SyncStatusLabel.Text = result.Message;
                SyncStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
            }
        }
        catch (Exception error)
        {
            SyncStatusLabel.Text = $"Sync failed: {error.Message}";
            SyncStatusLabel.Foreground = (Brush)FindResource("AmberBrush");
        }
    }

    private async void ConnectService_Click(object sender, RoutedEventArgs e)
    {
        await ConnectServiceAsync(restoreWorkspace: false);
    }

    private async void SelectWorkspace_Click(object sender, RoutedEventArgs e)
    {
        await ChooseWorkspaceAsync();
    }

    private async void RefreshWorkspace_Click(object sender, RoutedEventArgs e)
    {
        if (_refreshingWorkspace || _choosingWorkspace)
        {
            return;
        }

        _refreshingWorkspace = true;
        try
        {
            if (string.IsNullOrWhiteSpace(_registeredWorkspacePath))
            {
                // No path yet — open the chooser instead of a dead-end connect-only path.
                await ChooseWorkspaceAsync();
                return;
            }

            WorkspaceConnectionSummary.Text = "Refreshing workspace…";
            WorkspaceConnectionDetail.Text = "Local inventory in progress";
            await InspectWorkspaceAsync(_registeredWorkspacePath, persistSelection: false);
        }
        finally
        {
            _refreshingWorkspace = false;
        }
    }

    private async Task ChooseWorkspaceAsync()
    {
        // Do NOT disable the button or await the local service before the folder picker.
        // Disabling + EnsureConnectedAsync made the cursor flip to an arrow and hang,
        // so the user never saw the dialog.
        if (_choosingWorkspace)
        {
            return;
        }

        _choosingWorkspace = true;
        try
        {
            WorkspaceConnectionSummary.Text = "Choose a folder…";
            WorkspaceConnectionDetail.Text = "Opening folder picker";

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
            else if (!string.IsNullOrWhiteSpace(_desktopSettings.LastWorkspacePath)
                && Directory.Exists(_desktopSettings.LastWorkspacePath))
            {
                dialog.InitialDirectory = _desktopSettings.LastWorkspacePath;
            }
            else if (Directory.Exists(@"E:\Helmion"))
            {
                dialog.InitialDirectory = @"E:\Helmion";
            }

            // Show picker immediately on the UI thread — no awaits above this line.
            bool? accepted;
            try
            {
                accepted = dialog.ShowDialog(this);
            }
            catch (Exception dialogError)
            {
                WorkspaceConnectionSummary.Text = "Folder picker failed";
                WorkspaceConnectionDetail.Text = dialogError.Message;
                return;
            }

            if (accepted != true)
            {
                WorkspaceConnectionSummary.Text = "No workspace selected";
                WorkspaceConnectionDetail.Text =
                    "Folder picker cancelled — pick Choose workspace again when ready.";
                return;
            }

            var selected = dialog.FolderName;
            if (string.IsNullOrWhiteSpace(selected) || !Directory.Exists(selected))
            {
                WorkspaceConnectionSummary.Text = "Workspace selection failed";
                WorkspaceConnectionDetail.Text = "No valid folder was returned by the picker.";
                return;
            }

            if (EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(selected))
            {
                WorkspaceConnectionSummary.Text = "Drive root not allowed";
                WorkspaceConnectionDetail.Text =
                    "Pick a project folder (e.g. DairyForge), not D:\\ or C:\\. "
                    + "A whole drive makes the agent list recycle bins and everything else.";
                AppendConsoleLine(
                    "[Workspace rejected] Drive roots are not valid project workspaces.");
                return;
            }

            // Persist WORKSPACE_PATH to .env immediately — does not require loopback service.
            try
            {
                EnvironmentSettingsStore.SaveWorkspacePath(selected);
            }
            catch (Exception envError)
            {
                WorkspaceConnectionDetail.Text =
                    $"Folder selected, but .env WORKSPACE_PATH write failed: {envError.Message}";
            }

            WorkspaceConnectionSummary.Text = "Registering workspace…";
            WorkspaceConnectionDetail.Text = selected;
            await InspectWorkspaceAsync(selected, persistSelection: true);
        }
        finally
        {
            _choosingWorkspace = false;
            SelectWorkspaceButton.IsEnabled = true;
            RefreshWorkspaceButton.IsEnabled = true;
        }
    }

    private async Task ConnectServiceAsync(bool restoreWorkspace)
    {
        SetServiceStatus(
            "Connecting…",
            "Starting authenticated service",
            connected: false);
        // Workspace actions must stay available even when the pipe service is down.
        SelectWorkspaceButton.IsEnabled = true;
        RefreshWorkspaceButton.IsEnabled = true;
        try
        {
            var hello = await _serviceConnector.EnsureConnectedAsync();
            NotifyLocalServiceOnline(
                $"Protocol v{hello.ProtocolVersion} · named pipe connected");
            WorkspaceConnectionSummary.Text = "Local service ONLINE";
            WorkspaceConnectionDetail.Text =
                "Choose a local folder to register it for inspection.";
            await RefreshCapabilitiesAsync();

            var savedWorkspacePath = ResolveAgentWorkspace();
            if (restoreWorkspace
                && !string.IsNullOrWhiteSpace(savedWorkspacePath)
                && Directory.Exists(savedWorkspacePath)
                && !EnvironmentSettingsStore.IsUnsafeWorkspaceRoot(savedWorkspacePath))
            {
                await InspectWorkspaceAsync(
                    savedWorkspacePath,
                    persistSelection: true);
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
            NotifyLocalServiceUnavailable(error.Message);
            WorkspaceConnectionSummary.Text = "No active connection";
            WorkspaceConnectionDetail.Text =
                $"{error.Message} — Choose workspace still works (local inventory fallback).";

            // Still restore workspace from .env without the service.
            var savedWorkspacePath = ResolveAgentWorkspace();
            if (restoreWorkspace
                && !string.IsNullOrWhiteSpace(savedWorkspacePath)
                && Directory.Exists(savedWorkspacePath))
            {
                await InspectWorkspaceAsync(
                    savedWorkspacePath,
                    persistSelection: false);
            }
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
                or LocalServiceResponseException
                or OperationCanceledException)
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
        WorkspaceConnectionDetail.Text = workspacePath;
        try
        {
            WorkspaceInspection inspection;
            var usedFallback = false;

            // Prefer a fast local inventory so registration never hangs on the pipe service.
            // Optionally upgrade via service when it answers within a short budget.
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2.5));
                await _serviceConnector.EnsureConnectedAsync(timeout.Token);
                inspection = await _serviceConnector.InspectWorkspaceAsync(
                    workspacePath,
                    timeout.Token);
                _serviceConnected = true;
            }
            catch (Exception serviceError) when (
                serviceError is IOException
                    or TimeoutException
                    or UnauthorizedAccessException
                    or InvalidDataException
                    or LocalServiceResponseException
                    or FileNotFoundException
                    or InvalidOperationException
                    or Win32Exception
                    or OperationCanceledException)
            {
                inspection = await Task.Run(() => WorkspaceInspector.Inspect(workspacePath));
                usedFallback = true;
                _serviceConnected = false;
            }

            ApplyWorkspaceInspection(inspection);
            if (usedFallback)
            {
                WorkspaceSourceBadgeText.Text = "LOCAL FALLBACK";
                WorkspaceConnectionDetail.Text =
                    $"Inspected locally · {inspection.InspectedAt:h:mm:ss tt}";
                WorkspaceDataSourceText.Text = "Direct local inventory · service offline";
                SetServiceStatus(
                    "Offline · local inventory",
                    "Workspace registered without pipe service",
                    connected: false);
            }

            _registeredWorkspacePath = inspection.ProjectPath;
            UpdateConsoleWorkspaceLabel(_registeredWorkspacePath);
            if (persistSelection)
            {
                _desktopSettings = _desktopSettings with
                {
                    LastWorkspacePath = inspection.ProjectPath
                };
                DesktopSettingsStore.Save(_desktopSettings);
                try
                {
                    EnvironmentSettingsStore.SaveWorkspacePath(inspection.ProjectPath);
                }
                catch
                {
                    // Desktop settings already saved; .env write is best-effort.
                }
            }
        }
        catch (Exception error) when (
            error is IOException
                or TimeoutException
                or UnauthorizedAccessException
                or InvalidDataException
                or LocalServiceResponseException
                or DirectoryNotFoundException
                or ArgumentException)
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
        _currentWorkspaceInspection = inspection;
        UpdateSnapshot();

        SetServiceStatus(
            "Connected · live local",
            "Workspace inspection active",
            connected: true);
        GlobalDataBadgeText.Text = "LOCAL LIVE";
        WorkspaceSourceBadgeText.Text = "LOCAL LIVE";
        WorkspaceConnectionSummary.Text = $"{inspection.ProjectName} registered";
        WorkspaceConnectionDetail.Text =
            $"Inspected {inspection.InspectedAt:h:mm:ss tt}";
        ConnectServiceButton.Content = "Service connected";
        ConnectServiceButton.IsEnabled = true;
        SelectWorkspaceButton.IsEnabled = true;
        RefreshWorkspaceButton.IsEnabled = true;
        OverviewServiceStateText.Text = "Live Connected";
        OverviewServiceStateText.Foreground = (Brush)FindResource("AccentBrush");
        OverviewDataSourceText.Text =
            $"Live local workspace inventory · {inspection.ProjectName}";

        WorkspacePageTitle.Text = inspection.ProjectName;
        WorkspacePagePath.Text = inspection.ProjectPath;
        WorkspaceBranchText.Text = inspection.Branch;
        WorkspaceDataSourceText.Text = "Authenticated local service";
        WorkspaceNextActionText.Text =
            "Local source inventory is live.";
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
        LocalServiceSidebarStatus.Foreground = connected
            ? (Brush)FindResource("AccentBrush")
            : (Brush)FindResource("MutedTextBrush");
        LocalServiceSidebarDetail.Text = detail;
        LocalServiceDot.Fill = connected
            ? (Brush)FindResource("AccentBrush")
            : (Brush)FindResource("AmberBrush");
    }
    private async void ConsoleSendButton_Click(object sender, RoutedEventArgs e)
    {
        await SendConsoleInputAsync();
    }

    /// <summary>
    /// Enter sends. Shift+Enter inserts a newline so multi-line pastes stay editable.
    /// </summary>
    private async void ConsoleInputBox_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key != System.Windows.Input.Key.Enter)
        {
            return;
        }

        // Shift+Enter → keep default newline behavior (AcceptsReturn).
        if (System.Windows.Input.Keyboard.Modifiers.HasFlag(System.Windows.Input.ModifierKeys.Shift))
        {
            return;
        }

        e.Handled = true;
        await SendConsoleInputAsync();
    }

    /// <summary>
    /// Force full clipboard text into the composer. Default single-line paste only kept
    /// the first line; this handler always inserts the complete Unicode text block.
    /// </summary>
    private void ConsoleInputBox_OnPaste(object sender, DataObjectPastingEventArgs e)
    {
        if (sender is not System.Windows.Controls.TextBox box)
        {
            return;
        }

        string? pasted = null;
        if (e.SourceDataObject.GetDataPresent(DataFormats.UnicodeText))
        {
            pasted = e.SourceDataObject.GetData(DataFormats.UnicodeText) as string;
        }
        else if (e.SourceDataObject.GetDataPresent(DataFormats.Text))
        {
            pasted = e.SourceDataObject.GetData(DataFormats.Text) as string;
        }

        if (pasted is null)
        {
            return;
        }

        // Normalize rare clipboard line endings; keep every line.
        pasted = pasted.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n');

        e.CancelCommand();

        var text = box.Text ?? string.Empty;
        var start = box.SelectionStart;
        var length = box.SelectionLength;
        if (start < 0) start = 0;
        if (start > text.Length) start = text.Length;
        if (length < 0) length = 0;
        if (start + length > text.Length) length = text.Length - start;

        box.Text = string.Concat(
            text.AsSpan(0, start),
            pasted.AsSpan(),
            text.AsSpan(start + length));
        box.CaretIndex = start + pasted.Length;
        box.ScrollToEnd();
    }

    private async Task SendConsoleInputAsync(string? overrideText = null)
    {
        var text = (overrideText ?? ConsoleInputBox.Text).Trim();
        if (string.IsNullOrEmpty(text)) return;
        if (_agentBusy)
        {
            AppendConsoleLine("[Busy — wait for the current reply, then try again]");
            return;
        }

        if (_consoleSession is null)
        {
            // Nothing was dispatched, so the text stays in the composer to be retried.
            ConsoleInputBox.Text = text;
            ConsoleInputBox.CaretIndex = text.Length;
            AppendConsoleLine($"\n> {text}");
            AppendConsoleLine("[Console session not ready]");
            return;
        }

        // Dispatching now: clear the composer at send time so a second Enter cannot
        // resend the same text. The transcript line below is the record of what went out.
        //
        // Only when the text actually CAME from the composer. A spoken turn arrives as
        // overrideText, and clearing then would silently destroy a draft the user was
        // part-way through typing — text nobody asked to send and which the transcript
        // does not preserve. Nothing can double-send in that case either, since the box
        // was never the source. Dictation's "send it" passes no override, so it still clears.
        if (overrideText is null)
        {
            ConsoleInputBox.Clear();
        }

        AppendConsoleLine($"\n> {text}");

        // "/reset" is a console control, not a command file — handle it before anything else.
        if (text.Equals("/reset", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                if (_agentBridge is not null) await _agentBridge.ResetAsync();
                AppendConsoleLine("[Agent conversation reset]");
            }
            catch (Exception ex)
            {
                AppendConsoleLine($"[Agent reset failed: {ex.Message}]");
            }
            return;
        }

        // Explicit local shell escape. This WAS "/", which silently hijacked every
        // slash command: typing "/deploy staging" ran `deploy staging` in PowerShell
        // instead of expanding the /deploy command file — arbitrary shell execution
        // from what looks like a chat command. "/" now belongs to the command system
        // (expanded in bridge.mjs before the turn); "!" is the shell escape.
        if (text.StartsWith("!"))
        {
            var shellCommand = text.Substring(1).Trim();
            if (shellCommand.Length == 0)
            {
                AppendConsoleLine("[Shell escape: type ! followed by a command, e.g. !git status]");
                return;
            }

            await foreach (var line in _consoleSession.SendAsync(shellCommand))
            {
                AppendConsoleLine(line.Text);
            }
            return;
        }

        // A "/" line is a slash command: the bridge expands it before the turn
        // (src/agent/bridge.mjs:308-314). An unknown one is still sent as chat by
        // design, but the user should be told that is what happened rather than
        // wondering why nothing ran.
        if (text.StartsWith('/'))
        {
            if (!_commandsListed) await ListSlashCommandsAsync(quiet: true);

            var typed = text[1..].Split(' ', 2)[0];

            // Only say a command does not exist when the listing describes the SAME
            // folder this turn will run in. Listed from somewhere else, the registry
            // says nothing about /typed, and a confident "no such command" would be a
            // false accusation about a command that is really there. Staying quiet
            // costs nothing: the bridge expands whatever it finds either way.
            var sameWorkspace = _knownCommandsWorkspace is not null
                && string.Equals(
                    Path.TrimEndingDirectorySeparator(_knownCommandsWorkspace),
                    Path.TrimEndingDirectorySeparator(ResolveAgentWorkspace()),
                    StringComparison.OrdinalIgnoreCase);

            if (typed.Length > 0 && sameWorkspace && !_knownCommands.Contains(typed))
            {
                AppendConsoleLine(
                    $"[No command named /{typed} — sending it to the model as ordinary text. "
                    + "Click \"/ commands\" to see what exists.]");
            }
        }

        // Full coding agent (same engine as `helmion agent` CLI) via Node bridge.
        // Permissions + provider apply to every LLM the same way.
        _agentBusy = true;
        var spoken = new System.Text.StringBuilder();
        var permission = CurrentPermissionMode;
        try
        {
            var settings = EnvironmentSettingsStore.Load();
            _consoleSession.ConfigureMaestro(
                settings.MaestroCoordinator,
                settings,
                _desktopSettings.CustomProviders);
            _consoleSession.PermissionMode = permission;

            var workspace = ResolveAgentWorkspace();
            UpdateConsoleWorkspaceLabel(workspace);
            var provider = settings.MaestroCoordinator ?? "Gemini";

            _agentBridge ??= new AgentBridge();
            AppendConsoleLine(
                $"[Agent · {provider} · {permission} · workspace {workspace}]");
            if (permission == AgentPermission.Ask)
            {
                AppendConsoleLine(
                    "[Ask mode] Every tool call stops here for your approval: Allow once, "
                    + "Allow for session, or Deny. Anything you do not answer is denied.");
            }
            else if (permission != AgentPermission.Full)
            {
                AppendConsoleLine(
                    $"[Tip] Permissions={permission}. To approve tools one at a time, choose "
                    + "\"Ask before each tool\"; for no prompts at all, choose Full tools.");
            }

            await foreach (var ev in _agentBridge.TurnAsync(
                               text,
                               workspace,
                               provider,
                               permission,
                               _desktopSettings.CustomProviders))
            {
                switch (ev.Event)
                {
                    case "status":
                        AppendConsoleLine($"… {ev.Message}");
                        break;
                    case "model":
                        // Which model the per-task router picked for this round, and why.
                        // The CLI has always printed this; the app used to drop it.
                        ShowChosenModel(ev);
                        break;
                    case "command":
                        // A slash command was expanded before the model saw it.
                        AppendConsoleLine(
                            $"  ⌘ /{ev.Name} expanded from {ev.CommandPath ?? "a command file"}");
                        break;
                    case "tool":
                        AppendConsoleLine($"  → {ev.Name}({Truncate(ev.ArgsJson, 100)})");
                        break;
                    case "tool_result":
                        AppendConsoleLine($"  ← {Truncate(ev.Preview, 160)}");
                        break;
                    case "permission_request":
                    {
                        // Ask mode: the agent is blocked until we answer. Awaiting
                        // here is safe — the UI thread keeps pumping while the
                        // button click completes the task.
                        var decision = await RequestToolApprovalAsync(ev);
                        if (decision is null)
                        {
                            // Withdrawn (the bridge timed out or reset it first);
                            // the permission_decision event reports what happened.
                            break;
                        }

                        if (_agentBridge is not null && !string.IsNullOrEmpty(ev.Id))
                        {
                            await _agentBridge.RespondToPermissionAsync(ev.Id, decision);
                        }

                        break;
                    }
                    case "permission_decision":
                    {
                        // Whatever settled it — our click, a timeout, a shutdown —
                        // the transcript records the outcome, and any question
                        // still on screen for this id comes down.
                        if (!string.IsNullOrEmpty(ev.Id) && ev.Id == _pendingApprovalId)
                        {
                            CancelPendingApproval();
                        }

                        var verdict = AgentApprovalDecision.IsAllowed(ev.Decision) ? "ALLOWED" : "DENIED";
                        var by = ev.Source switch
                        {
                            "timeout" => " (no answer in time)",
                            "session-grant" => " (already allowed for this session)",
                            "no-approver" => " (nothing available to ask)",
                            "shutdown" or "reset" => " (session ended before you answered)",
                            _ => ""
                        };
                        AppendConsoleLine($"  ⇢ {verdict}: {ev.Tool ?? ev.Name ?? "tool"}{by}");
                        break;
                    }
                    case "permission_unknown":
                        AppendConsoleLine($"  ⇢ Approval ignored — {ev.Message}");
                        break;
                    case "assistant":
                        if (!string.IsNullOrWhiteSpace(ev.Text))
                        {
                            AppendConsoleLine(ev.Text);
                            if (!ev.Partial) spoken.Append(ev.Text).Append(' ');
                        }
                        break;
                    case "error":
                        AppendConsoleLine($"[Agent error] {ev.Message}");
                        if (spoken.Length == 0)
                        {
                            spoken.Append("There was an agent error. ");
                        }
                        break;
                    case "hello":
                    case "ready":
                        ConsoleServiceSessionText.Text =
                            $"Agent ready · {ev.Provider ?? provider} · {permission} · {ev.Workspace ?? workspace}";
                        break;
                }
            }

            AppendConsoleLine("");

            if (_voiceSession is { IsVoiceModeActive: true }
                && spoken.Length > 0)
            {
                try
                {
                    await _voiceSession.SpeakAsync(spoken.ToString());
                }
                catch (Exception voiceEx)
                {
                    AppendConsoleLine($"[Voice TTS error: {voiceEx.Message}]");
                }
            }
        }
        catch (Exception ex)
        {
            AppendConsoleLine(
                $"[Agent failed to start] {ex.Message}\n"
                + "Need Node.js on PATH and Helmion repo with bin/helmion.mjs "
                + "(expected under E:\\Helmion).");
            if (_voiceSession is { IsVoiceModeActive: true })
            {
                try
                {
                    await _voiceSession.SpeakAsync(
                        "The agent failed to start. Check Node and the Helmion install.");
                }
                catch
                {
                    // ignore TTS failure after agent failure
                }
            }
        }
        finally
        {
            _agentBusy = false;
            // A question can only be answered while its turn is running, so never
            // leave one on screen after the turn ends.
            CancelPendingApproval();
            // Composer was already cleared at dispatch; anything typed during the turn
            // is the user's next message and must survive.
        }
    }

    private static string Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value.Length <= max ? value : value[..max] + "…";
    }

    /// <summary>
    /// Render the router's choice for one round: the header label keeps the last
    /// one, the transcript keeps all of them with the reason.
    /// </summary>
    private void ShowChosenModel(AgentBridgeEvent ev)
    {
        var model = ev.Model;
        if (string.IsNullOrWhiteSpace(model)) return;

        var tier = string.IsNullOrWhiteSpace(ev.Tier) ? null : ev.Tier;
        var label = tier is null ? model! : $"{tier} · {model}";

        if (ConsoleModelLabel is not null)
        {
            ConsoleModelLabel.Text = $"model: {label}";
            ConsoleModelLabel.ToolTip = string.IsNullOrWhiteSpace(ev.Reason)
                ? $"Router chose {label}."
                : $"Router chose {label} — {ev.Reason}";
        }

        var line = $"  ◆ {label}";
        if (!string.IsNullOrWhiteSpace(ev.Reason)) line += $" — {ev.Reason}";
        if (ev.Round is > 1) line += $"  (round {ev.Round})";
        AppendConsoleLine(line);
    }

    /// <summary>
    /// Slash commands available in this workspace. Refreshed whenever the list is
    /// shown, and used to tell the user when a "/" line is not a command at all
    /// rather than letting it go to the model unremarked.
    /// </summary>
    private readonly HashSet<string> _knownCommands = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The workspace the bridge actually scanned to produce <see cref="_knownCommands"/>.
    /// Not necessarily the workspace the next turn will use: the bridge starts at
    /// <c>env.workspace || process.cwd()</c> (src/agent/bridge.mjs:54) and only adopts
    /// the desktop's workspace on a `configure` (:240) or a `turn` (:322), while the
    /// `commands` branch (:276) never reads req.workspace and re-scans
    /// <c>state.runtime.root</c> (:94). So a listing taken before the first turn can
    /// describe a different directory — exactly the mismatch that put
    /// WORKSPACE_PATH=C:\Users\troyh\.grok into a live agent turn.
    /// </summary>
    private string? _knownCommandsWorkspace;

    private bool _commandsListed;

    private async void ConsoleCommandsButton_Click(object sender, RoutedEventArgs e)
    {
        await ListSlashCommandsAsync(quiet: false);
    }

    private async Task ListSlashCommandsAsync(bool quiet)
    {
        try
        {
            _agentBridge ??= new AgentBridge();
            var ev = await _agentBridge.ListCommandsAsync();
            _commandsListed = true;

            if (ev.Event != "commands")
            {
                if (!quiet) AppendConsoleLine($"[Commands unavailable] {ev.Message ?? "no answer"}");
                return;
            }

            _knownCommands.Clear();
            foreach (var cmd in ev.Commands ?? [])
            {
                _knownCommands.Add(cmd.Name);
            }

            _knownCommandsWorkspace = ev.Workspace;

            if (quiet) return;

            var invocable = (ev.Commands ?? [])
                .Where(c => c.UserInvocable)
                .ToList();

            AppendConsoleLine("");
            AppendConsoleLine($"[Slash commands · workspace {ev.Workspace ?? "?"}]");
            if (invocable.Count == 0)
            {
                AppendConsoleLine(
                    "  (none yet — add a markdown file to .helmion\\commands\\, "
                    + "e.g. .helmion\\commands\\deploy.md becomes /deploy)");
            }
            else
            {
                foreach (var cmd in invocable)
                {
                    var head = string.IsNullOrWhiteSpace(cmd.ArgumentHint)
                        ? $"/{cmd.Name}"
                        : $"/{cmd.Name} {cmd.ArgumentHint}";
                    AppendConsoleLine(
                        $"  {head.PadRight(34)}{cmd.Description ?? "(no description)"}  [{cmd.Source}]");
                }
            }

            var plugins = ev.Plugins ?? [];
            AppendConsoleLine(plugins.Count == 0
                ? "  plugins: none loaded"
                : $"  plugins: {string.Join(", ", plugins)}");
            AppendConsoleLine("");
        }
        catch (Exception ex)
        {
            if (!quiet) AppendConsoleLine($"[Commands unavailable] {ex.Message}");
        }
    }

    private void ConsoleMcpSecurityButton_Click(object sender, RoutedEventArgs e)
    {
        if (ConsoleMcpPanel is null) return;

        var showing = ConsoleMcpPanel.Visibility == Visibility.Visible;
        ConsoleMcpPanel.Visibility = showing ? Visibility.Collapsed : Visibility.Visible;
        if (!showing)
        {
            AppendConsoleLine(
                "\n[MCP install security] Stage 1 (discover) and stage 2 (audit) run from here. "
                + "Approval, sandbox and install stay on the command line: approving requires typing "
                + "a freshly generated challenge phrase into a real terminal, and a window cannot "
                + "stand in for that.");
        }
    }

    private void McpBrowseButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "Choose the candidate MCP server's source folder",
        };

        if (dialog.ShowDialog(this) == true)
        {
            McpAuditPathInput.Text = dialog.FolderName;
        }
    }

    private async void McpDiscoverButton_Click(object sender, RoutedEventArgs e)
    {
        await RunMcpStageAsync(
            "discover",
            McpDiscoverButton,
            () => McpSecurityRunner.DiscoverAsync(McpDiscoverNeedInput.Text));
    }

    private async void McpAuditButton_Click(object sender, RoutedEventArgs e)
    {
        await RunMcpStageAsync(
            "audit",
            McpAuditButton,
            () => McpSecurityRunner.AuditAsync(McpAuditPathInput.Text));
    }

    private async Task RunMcpStageAsync(
        string stage,
        Button button,
        Func<Task<McpSecurityResult>> run)
    {
        button.IsEnabled = false;
        AppendConsoleLine($"\n[mcp-install {stage}] running…");
        try
        {
            var result = await run();
            AppendConsoleLine(result.Summary);
            if (!string.IsNullOrWhiteSpace(result.Stderr))
            {
                AppendConsoleLine($"  stderr: {Truncate(result.Stderr, 400)}");
            }
        }
        catch (Exception ex)
        {
            AppendConsoleLine($"[mcp-install {stage} failed] {ex.Message}");
        }
        finally
        {
            button.IsEnabled = true;
        }
    }

    /// <summary>
    /// Dictate mode: recognized speech is typed into the composer at the caret
    /// instead of being sent to the model. Off by default; the mic alone still
    /// means "talk to the agent".
    /// </summary>
    private bool _dictateMode;

    private void ConsoleDictateButton_Click(object sender, RoutedEventArgs e)
    {
        SetDictateMode(!_dictateMode);
    }

    private void SetDictateMode(bool on)
    {
        _dictateMode = on;
        ConsoleDictateButton.Background = on
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("AccentBrush");

        if (on)
        {
            ConsoleInputBox.Focus();
            AppendConsoleLine(
                "\n[Dictate ON — what you say is typed into the box, not sent. "
                + "Say \"send it\" to submit, \"new line\", \"scratch that\", or \"stop dictation\".]");
            ConsoleServiceSessionText.Text = "Dictate mode — speech goes to the composer";

            if (_voiceSession is not { IsVoiceModeActive: true })
            {
                AppendConsoleLine("[Dictate needs the mic — click 🎙 to start listening.]");
            }
        }
        else
        {
            AppendConsoleLine("\n[Dictate OFF — speech goes to the agent again]");
            ConsoleServiceSessionText.Text = _voiceSession is { IsVoiceModeActive: true }
                ? "Voice mode on — listening (two-way)"
                : "Voice mode off";
        }
    }

    /// <summary>
    /// Route one dictated utterance. Returns true when it was handled as
    /// dictation and must NOT reach the model.
    /// </summary>
    private bool HandleDictation(string heard)
    {
        var command = DictationCommands.Detect(heard);
        switch (command.Kind)
        {
            case DictationCommandKind.Newline:
                InsertAtCaret(Environment.NewLine);
                return true;

            case DictationCommandKind.Scratch:
                // Erase the last chunk this mode inserted. Nothing dictated yet
                // means there is nothing of ours to take back — leave typed text alone.
                if (_lastDictatedSpan is { Length: > 0 })
                {
                    var text = ConsoleInputBox.Text ?? string.Empty;
                    var start = Math.Clamp(_lastDictatedStart, 0, text.Length);
                    var length = Math.Clamp(_lastDictatedSpan.Length, 0, text.Length - start);
                    if (length > 0
                        && string.Equals(
                            text.Substring(start, length),
                            _lastDictatedSpan,
                            StringComparison.Ordinal))
                    {
                        ConsoleInputBox.Text = text.Remove(start, length);
                        ConsoleInputBox.CaretIndex = start;
                    }
                }

                _lastDictatedSpan = null;
                ConsoleServiceSessionText.Text = "Scratched the last dictated phrase";
                return true;

            case DictationCommandKind.Send:
                _lastDictatedSpan = null;
                // Falls through to the normal submit path, which clears the composer.
                _ = SendConsoleInputAsync();
                return true;

            case DictationCommandKind.Stop:
                SetDictateMode(false);
                return true;

            default:
                if (string.IsNullOrWhiteSpace(command.Text)) return true;
                InsertAtCaret(
                    NeedsLeadingSpace() ? " " + command.Text : command.Text);
                return true;
        }
    }

    private string? _lastDictatedSpan;
    private int _lastDictatedStart;

    private bool NeedsLeadingSpace()
    {
        var text = ConsoleInputBox.Text ?? string.Empty;
        var caret = Math.Clamp(ConsoleInputBox.CaretIndex, 0, text.Length);
        if (caret == 0) return false;
        var previous = text[caret - 1];
        return !char.IsWhiteSpace(previous);
    }

    /// <summary>
    /// Splice text in at the caret, the same span-concat the paste handler uses,
    /// so a dictated phrase lands where the cursor is rather than at the end.
    /// </summary>
    private void InsertAtCaret(string insert)
    {
        var box = ConsoleInputBox;
        var text = box.Text ?? string.Empty;
        var start = Math.Clamp(box.SelectionStart, 0, text.Length);
        var length = Math.Clamp(box.SelectionLength, 0, text.Length - start);

        box.Text = string.Concat(
            text.AsSpan(0, start),
            insert.AsSpan(),
            text.AsSpan(start + length));
        box.CaretIndex = start + insert.Length;
        box.ScrollToEnd();

        _lastDictatedStart = start;
        _lastDictatedSpan = insert;
    }

    /// <summary>
    /// Builds the turn-based session for the selector. Handlers are attached HERE
    /// rather than at the call site because the selector constructs a fresh
    /// session on every start and on every automatic fallback — anything wired to
    /// one instance from outside would be silently dropped on the next one.
    /// </summary>
    private VoiceSession CreateVoiceSession()
    {
        var session = new VoiceSession();
        session.OnSpeechRecognized += VoiceSession_OnSpeechRecognized;
        session.OnError += (_, msg) =>
            Dispatcher.Invoke(() =>
            {
                AppendConsoleLine($"\n[Voice] {msg}");
                ConsoleServiceSessionText.Text = msg;
            });
        session.OnStatus += (_, msg) =>
            Dispatcher.Invoke(() =>
            {
                ConsoleServiceSessionText.Text = msg;
            });

        _voiceSession = session;
        return session;
    }

    /// <summary>Show which speech backend is actually live. Never asserts more than the selector reported.</summary>
    private void ApplyVoiceBackendStatus(VoiceBackendStatus status)
    {
        if (ConsoleVoiceBackendLabel is null) return;

        var degraded = status.State == VoiceState.Degraded;
        ConsoleVoiceBackendLabel.Text = status.Backend switch
        {
            VoiceBackend.None when !degraded => "voice: off",
            _ => $"voice: {status.Display}",
        };
        ConsoleVoiceBackendLabel.Foreground = degraded
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");
        ConsoleVoiceBackendLabel.ToolTip = string.IsNullOrWhiteSpace(status.Detail)
            ? status.Display
            : $"{status.Display} — {status.Detail}";
    }

    private async void ConsoleMicButton_Click(object sender, RoutedEventArgs e)
    {
        if (_voiceSelector is null) return;

        ConsoleMicButton.IsEnabled = false;
        try
        {
            if (_voiceSession is { IsVoiceModeActive: true })
            {
                await _voiceSelector.StopAsync();
                // The selector owns and disposes the session it built.
                _voiceSession = null;
                if (_dictateMode) SetDictateMode(false);
                ConsoleMicButton.Background = (Brush)FindResource("AccentBrush");
                ConsoleMicButton.ToolTip =
                    "Start two-way voice (listen + speak). Works with every LLM.";
                AppendConsoleLine("\n[Voice mode OFF]");
                ConsoleServiceSessionText.Text = "Voice mode off";
                return;
            }

            var backend = await _voiceSelector.StartAsync();
            if (backend == VoiceBackend.None || _voiceSession is not { IsVoiceModeActive: true })
            {
                ConsoleMicButton.Background = (Brush)FindResource("AccentBrush");
                AppendConsoleLine("[Voice] Mic failed to start — see message above.");
                return;
            }

            ConsoleMicButton.Background = (Brush)FindResource("AmberBrush");
            ConsoleMicButton.ToolTip = "Stop two-way voice";
            AppendConsoleLine(
                "\n[Voice mode ON — two-way: speak, wait for the reply, speak again. Click mic to stop.]");
            AppendConsoleLine($"[Speech backend: {_voiceSelector.Status.Display}"
                              + (string.IsNullOrWhiteSpace(_voiceSelector.Status.Detail)
                                  ? "]"
                                  : $" — {_voiceSelector.Status.Detail}]"));
            AppendConsoleLine(
                "[Voice uses the selected Maestro LLM + permissions dropdown for tools.]");
            ConsoleServiceSessionText.Text = "Voice mode on — listening (two-way)";
        }
        catch (Exception ex)
        {
            // Audio never takes the window down with it.
            AppendConsoleLine($"[Voice] {ex.Message}");
        }
        finally
        {
            ConsoleMicButton.IsEnabled = true;
        }
    }

    private async void VoiceSession_OnSpeechRecognized(object? sender, string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;

        // Marshal to the UI thread and fully await the turn (InvokeAsync(async () =>) would not).
        if (!Dispatcher.CheckAccess())
        {
            await Dispatcher.InvokeAsync(() => VoiceSession_OnSpeechRecognized(sender, text));
            return;
        }

        if (_voiceSession is { IsSpeaking: true }) return;

        var heard = text.Trim();
        // Drop pure noise crumbs Windows dictation sometimes emits.
        if (heard.Length < 3)
        {
            return;
        }

        // Dictate mode: the words are the message, not a request. They go to the
        // caret, and the four reserved phrases act on the composer. Deliberately
        // ahead of the busy guards — typing into the box while the agent is
        // thinking is exactly what a person would do.
        if (_dictateMode)
        {
            AppendConsoleLine($"[Dictated] {heard}");
            HandleDictation(heard);
            return;
        }

        if (_voiceTurnBusy || _agentBusy) return;

        _voiceTurnBusy = true;
        try
        {
            // Pause mic while we call the model so ambient noise does not stack turns.
            _voiceSession?.PauseListeningForTts();

            // Windows STT mishears often ("DairyForge" → garbage), so the transcript goes
            // to the console log. SendConsoleInputAsync clears the composer at dispatch.
            ConsoleInputBox.Focus();
            AppendConsoleLine($"[You said] {heard}");
            ConsoleServiceSessionText.Text = $"Voice heard: {Truncate(heard, 80)}";

            await SendConsoleInputAsync(heard);
        }
        finally
        {
            _voiceTurnBusy = false;
            // If chat failed before SpeakAsync (or TTS was empty), ensure mic comes back.
            if (_voiceSession is { IsVoiceModeActive: true, IsSpeaking: false })
            {
                _voiceSession.ResumeListeningAfterTts();
            }
        }
    }

    private void UpdateConsoleWorkspaceLabel(string? workspace = null)
    {
        try
        {
            var path = workspace ?? ResolveAgentWorkspace();
            if (ConsoleWorkspaceLabel is not null)
            {
                ConsoleWorkspaceLabel.Text = $"workspace: {path}";
                ConsoleWorkspaceLabel.ToolTip =
                    "Tools can only touch files under this folder.\n"
                    + "Change it: Workspace page → Choose workspace.\n"
                    + "Point it at DairyForge, Helmion, or any project — not a whole drive.";
            }
        }
        catch
        {
            // ignore UI races
        }
    }

    /// <summary>
    /// Project folder for agent tools. Never a bare drive root (D:\, C:\), never a provider
    /// CLI home (%USERPROFILE%\.grok and friends), and never derived from the selected
    /// Maestro provider. See <see cref="AgentWorkspaceResolver"/>.
    /// </summary>
    private string ResolveAgentWorkspace()
    {
        return AgentWorkspaceResolver.Resolve(
            _registeredWorkspacePath,
            EnvironmentSettingsStore.LoadWorkspacePath(),
            _desktopSettings.LastWorkspacePath,
            AgentBridge.FindHelmionRoot());
    }
}

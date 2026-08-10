using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
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
    private bool _syncingThemeSelectors;
    private string? _registeredWorkspacePath;
    private string? _agentConfirmedWorkspacePath;
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
    /// <summary>Shared (no-session) bridge: still one turn. Named sessions run in parallel.</summary>
    private bool _sharedBridgeBusy;
    /// <summary>Per-session / shared turn cancel tokens. Esc cancels the selected session's turn.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, CancellationTokenSource> _activeTurnCts = new(StringComparer.Ordinal);
    /// <summary>Output ownership for concurrent turns (AsyncLocal so two sessions never cross-wire).</summary>
    private readonly System.Threading.AsyncLocal<AgentSession?> _asyncTurnSession = new();
    private string? _lastBusyMessage;
    private DateTimeOffset _lastBusyMessageAt;
    private bool _initializingPermissionSelection;
    private ShellLayoutState _shellLayout = ShellLayoutState.Default;
    private bool _consoleFullScreen => _shellLayout.IsFullScreen;
    // Claude Desktop (Troy's 03.43 recording): collapsed = top panel toggle only.
    // Expanded (hover top / pin) = full labeled sidebar. No permanent icon strip.
    private bool _sidebarPinnedOpen = false;
    private readonly GridLength _sidebarCollapsedWidth = new(48);
    private readonly GridLength _sidebarExpandedWidth = new(260);
    private DispatcherTimer? _sidebarCollapseTimer;
    private WindowState _restoreWindowState = WindowState.Normal;
    private WindowStyle _restoreWindowStyle = WindowStyle.SingleBorderWindow;
    private ResizeMode _restoreResizeMode = ResizeMode.CanResize;
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

            ConsoleExecutionBadgeText.Text = mode switch
            {
                AgentPermission.Full => "Full",
                AgentPermission.Ask => "Accept",
                AgentPermission.ReadTools => "Read",
                _ => "Plan"
            };
            // Access is a capability label, not a success signal. Full access in
            // particular must not read as a green "all clear" badge.
            ConsoleExecutionBadgeText.Foreground = mode == AgentPermission.ReadOnly
                ? (Brush)FindResource("AmberBrush")
                : new SolidColorBrush(Color.FromRgb(0xB9, 0xC8, 0xD1));

            ConsolePermissionInfoText.Text = mode switch
            {
                AgentPermission.Full =>
                    "Full — create/edit files, run declared tasks, open local previews without asking.",
                AgentPermission.Ask =>
                    "Accept — tools run only after you approve each call (Allow once / session / Deny).",
                AgentPermission.ReadTools =>
                    "Read — inspect and search the project; no writes or task runs.",
                _ =>
                    "Plan — chat only. File and command tools stay off."
            };

            HighlightPermissionChips(mode);
            UpdateClaudeModeLine(mode);

            // The permission mode is this window's own execution posture and the one
            // execution-side fact it genuinely knows. Full permissions gets a red,
            // pulsing card.
            PublishPermissionPostureCard();
        }
        catch
        {
            // Ignore UI update exceptions
        }
    }

    /// <summary>
    /// Claude Code CLI mode line: amber mode name + gray "Shift+Tab to …" hint.
    /// Primary source: screenshot Claude composer + <see cref="AgentPermission"/>.
    /// </summary>
    private void UpdateClaudeModeLine(string? mode = null)
    {
        mode ??= CurrentPermissionMode;
        if (ClaudeModeLabel is null || ClaudeModeHint is null)
            return;

        // Three-way Claude surface: plan / accept / auto-accept.
        // Read-tools maps to a distinct line so chips still show truth.
        var (label, hint, brush) = mode switch
        {
            AgentPermission.Full => (
                "auto-accept edits",
                "  Shift+Tab to plan",
                new SolidColorBrush(Color.FromRgb(0xE5, 0xA5, 0x4B))),
            AgentPermission.Ask => (
                "accept edits",
                "  Shift+Tab to auto-accept",
                new SolidColorBrush(Color.FromRgb(0xE5, 0xA5, 0x4B))),
            AgentPermission.ReadTools => (
                "read only",
                "  Shift+Tab to accept",
                new SolidColorBrush(Color.FromRgb(0x9C, 0xA3, 0xAF))),
            _ => (
                "plan mode",
                "  Shift+Tab to accept",
                new SolidColorBrush(Color.FromRgb(0xE5, 0xA5, 0x4B)))
        };

        ClaudeModeLabel.Text = label;
        ClaudeModeLabel.Foreground = brush;
        ClaudeModeHint.Text = hint;
    }

    /// <summary>
    /// Click the Claude mode label — cycle plan → accept → auto-accept → plan.
    /// Full still requires the auto-mode confirm dialog.
    /// </summary>
    private void ClaudeModeLabel_Click(object sender, MouseButtonEventArgs e)
    {
        CycleClaudePermissionMode();
        e.Handled = true;
    }

    /// <summary>
    /// Claude-style cycle: plan (read-only) → accept (ask) → auto-accept (full) → plan.
    /// Read-tools is skipped so Shift+Tab matches Claude's three-step surface.
    /// </summary>
    private void CycleClaudePermissionMode()
    {
        var current = CurrentPermissionMode;
        var next = current switch
        {
            AgentPermission.ReadOnly => AgentPermission.Ask,
            AgentPermission.ReadTools => AgentPermission.Ask,
            AgentPermission.Ask => AgentPermission.Full,
            AgentPermission.Full => AgentPermission.ReadOnly,
            _ => AgentPermission.Ask
        };

        if (next == AgentPermission.Full && current != AgentPermission.Full)
        {
            if (!ConfirmEnableFullPermissions())
                return;
        }

        SelectPermissionInCombo(next);
    }

    private void PermissionChip_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string tag }) return;
        var next = AgentPermission.Normalize(tag);
        // Full = Claude "auto mode": confirm once before tools run without asking.
        if (next == AgentPermission.Full && CurrentPermissionMode != AgentPermission.Full)
        {
            if (!ConfirmEnableFullPermissions())
                return;
        }
        SelectPermissionInCombo(next);
        // SelectionChanged persists mode + refreshes badge/chips.
    }

    /// <summary>
    /// Claude-style "Enable auto mode?" gate for Full permissions.
    /// Cancel keeps the previous mode. Primary source: AgentPermission.Full.
    /// </summary>
    private bool ConfirmEnableFullPermissions()
    {
        var workspace = _registeredWorkspacePath
            ?? _currentWorkspaceInspection?.ProjectPath
            ?? _desktopSettings.LastWorkspacePath
            ?? "(no workspace selected)";
        var shortPath = workspace.Length > 72 ? "…" + workspace[^68..] : workspace;

        // Claude Desktop "Enable auto mode?" shape — confirm before tools run without asking.
        var result = MessageBox.Show(
            this,
            "Helmian will run workspace actions without asking first.\n" +
            "Longer tasks can continue uninterrupted. Guard still blocks destructive commands.\n\n" +
            $"Workspace: {shortPath}\n\n" +
            "You can switch back to Plan, Read, or Accept anytime.\n\n" +
            "Enable full permissions?",
            "Enable full permissions?",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);

        return result == MessageBoxResult.OK;
    }

    private void HighlightPermissionChips(string mode)
    {
        void StyleChip(Button? chip, string chipMode)
        {
            if (chip is null) return;
            var on = string.Equals(mode, chipMode, StringComparison.Ordinal);
            chip.Opacity = on ? 1.0 : 0.72;
            chip.FontWeight = on ? FontWeights.Bold : FontWeights.SemiBold;
            chip.BorderBrush = on
                ? (Brush)FindResource("AccentBrush")
                : (Brush)FindResource("GlassStrokeBrush");
            chip.Foreground = on
                ? (Brush)FindResource("TextBrush")
                : (Brush)FindResource("SoftTextBrush");
        }

        StyleChip(PermissionChipReadOnly, AgentPermission.ReadOnly);
        StyleChip(PermissionChipReadTools, AgentPermission.ReadTools);
        StyleChip(PermissionChipAsk, AgentPermission.Ask);
        StyleChip(PermissionChipFull, AgentPermission.Full);
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

        if (_initializingPermissionSelection)
        {
            return;
        }

        var mode = CurrentPermissionMode;

        // Combo path to Full also needs the auto-mode confirm (chip path does its own).
        if (mode == AgentPermission.Full
            && e.RemovedItems.OfType<ComboBoxItem>().FirstOrDefault()?.Tag is string prevTag
            && AgentPermission.Normalize(prevTag) != AgentPermission.Full)
        {
            if (!ConfirmEnableFullPermissions())
            {
                _initializingPermissionSelection = true;
                try
                {
                    SelectPermissionInCombo(AgentPermission.Normalize(prevTag));
                }
                finally
                {
                    _initializingPermissionSelection = false;
                }
                return;
            }
        }

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
        // Do not spam the transcript with [Access → …] on every chip click (ship polish).
        if (ConsoleServiceSessionText is not null)
            ConsoleServiceSessionText.Text = $"Access · {ConsoleExecutionBadgeText.Text}";
    }

    private void ConsolePermissionInfoButton_Click(object sender, RoutedEventArgs e)
    {
        ConsolePermissionPopup.IsOpen = !ConsolePermissionPopup.IsOpen;
    }

    private void ConsoleInputBox_GotKeyboardFocus(object sender, KeyboardFocusChangedEventArgs e)
    {
        ConsolePasteHint.Visibility = Visibility.Visible;
        if (ConsoleComposerBorder is not null)
        {
            ConsoleComposerBorder.BorderBrush = (Brush)FindResource("AccentStrokeStrongBrush");
        }
    }

    private void ConsoleInputBox_LostKeyboardFocus(object sender, KeyboardFocusChangedEventArgs e)
    {
        ConsolePasteHint.Visibility = Visibility.Collapsed;
        if (ConsoleComposerBorder is not null)
        {
            ConsoleComposerBorder.BorderBrush = (Brush)FindResource("StrokeBrush");
        }
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

        // Mirror the same question into the always-visible guard panel with inline
        // A/B/C options, wired to this same CompleteApproval. Answering from the panel
        // and answering from the strip below the console do the identical thing.
        PublishApprovalCard(
            tool,
            request.Summary ?? tool,
            request.Workspace ?? "?",
            seconds);

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
        ResolveApprovalCard(string.Empty);
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
        ResolveApprovalCard(decision);
        pending?.TrySetResult(decision);
    }

    private void ConsoleApprovalAllowOnce_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.AllowOnce);

    private void ConsoleApprovalAllowSession_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.AllowSession);

    private void ConsoleApprovalDeny_Click(object sender, RoutedEventArgs e) =>
        CompleteApproval(AgentApprovalDecision.Deny);

    /// <summary>
    /// Write one line to the console.
    ///
    /// SESSION-AWARE. When sessions exist, every line belongs to exactly one of them
    /// and is appended to THAT session's own transcript. It reaches the visible box
    /// only when that session is the one on screen — so a turn running in a session
    /// you are not looking at can never scribble into the transcript you ARE looking
    /// at. <c>_turnSession</c> wins over the selection because output belongs to the
    /// session that produced it even if you switched away mid-turn.
    ///
    /// With no sessions started, <c>owner</c> is null and this behaves exactly as it
    /// did before: straight to the box.
    /// </summary>
    private void AppendConsoleLine(string line)
    {
        var text = line.EndsWith('\n') ? line : line + "\n";

        // The ownership rule itself lives in Core (SessionShelf.cs, SessionOutputRouting)
        // so the smoke suite can drive it — this project is not referenced by the test
        // project, and inline the rule was untestable.
        // Prefer AsyncLocal owner so concurrent multi-agent turns keep transcripts separate.
        var turnOwner = _asyncTurnSession.Value ?? _turnSession;
        var destination = SessionOutputRouting.ForLine(turnOwner, _sessions.Selected);
        if (destination.Owner is not null)
        {
            destination.Owner.Transcript.Append(text);
            destination.Owner.NotifyTranscriptChanged();
        }

        if (!destination.ShowOnScreen)
        {
            return;
        }

        if (ConsoleOutputText is null)
        {
            return;
        }

        ConsoleOutputText.AppendText(text);
        ConsoleOutputText.CaretIndex = ConsoleOutputText.Text.Length;
        ConsoleOutputText.ScrollToEnd();
    }

    private void ConsoleClearOutputButton_Click(object sender, RoutedEventArgs e)
    {
        // The bridge owns the conversation. The transcript buffer is display-only,
        // so clearing it cannot reset the model, permissions, settings or workspace.
        if (_sessions.Selected is { } cleared)
        {
            cleared.Transcript.Clear();
            cleared.NotifyTranscriptChanged();
        }
        ConsoleOutputText.Clear();
        ConsoleServiceSessionText.Text = "Output cleared · conversation preserved";
        ConsoleInputBox.Focus();
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
        PilotSnapshot snapshot;
        try
        {
            var settings = EnvironmentSettingsStore.Load();
            snapshot = PilotSnapshot.CreateLive(
                _serviceConnected,
                _currentWorkspaceInspection,
                settings.DatabaseUrl ?? "",
                settings.GeminiApiKey ?? "",
                settings.GrokApiKey ?? "",
                settings.MaestroCoordinator ?? "Codex");
        }
        catch
        {
            snapshot = PilotSnapshot.CreateLive(
                _serviceConnected,
                _currentWorkspaceInspection,
                "",
                "",
                "",
                "Codex");
        }

        DataContext = snapshot;
        // Every count and badge that used to be a hardcoded literal is set from this
        // snapshot, in one place, so a label can never describe a state the snapshot
        // does not hold. See MainWindow.GuardPanel.cs.
        ApplyDerivedSnapshotLabels(snapshot);
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
        // Before the first UpdateSnapshot: the derived labels read the feed.
        InitializeGuardPanel();
        // Read-only summary only. This deliberately does not populate the fresh
        // launch decision used by the detailed consent flow.
        RefreshSandboxSummaryCard();
        SetServiceStatus("Starting…", "Waiting for local loopback service", connected: false);
        UpdateSnapshot();
        ThemeSelector.ItemsSource = ColorThemeCatalog.All;
        ThemeSelector.SelectedValue = initialTheme.Id;
        QuickThemeSelector.ItemsSource = ColorThemeCatalog.All;
        QuickThemeSelector.SelectedValue = initialTheme.Id;
        RailThemeSelector.ItemsSource = ColorThemeCatalog.All;
        RailThemeSelector.SelectedValue = initialTheme.Id;
        ThemeDescription.Text = initialTheme.Description;
        ThemePersistenceLabel.Text = persistTheme
            ? "Saved locally for this Windows user"
            : "Preview override · not saved";
        // Restore the saved text size. save:false — reapplying what we just read
        // would rewrite the settings file on every launch for no reason.
        ApplyTextScale(_desktopSettings.ResolvedTextScale, save: false);
        // Herald pane sizes / QR / log font from the same desktop-settings file.
        ApplyHeraldLayoutFromSettings(saveLabel: false);

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
            ["Console"] = ConsoleNavPrimary,
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
        ApplyShellPanelVisibility();
        // Console is the cockpit desk (Room + Maestro). Overview is a status page, not home.
        NavigateTo("Console");
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
            button.Foreground = (Brush)FindResource("TextBrush");
        }

        _pages[pageName].Visibility = Visibility.Visible;
        if (string.Equals(pageName, "Overview", StringComparison.Ordinal)
            && DataContext is PilotSnapshot currentSnapshot)
        {
            ApplyDerivedSnapshotLabels(currentSnapshot);
        }
        if (string.Equals(pageName, "Integrations", StringComparison.Ordinal))
        {
            RefreshHeraldPrerequisiteUi();
            UpdateMediaProviderCapabilities();
        }
        var activeButton = _navigationButtons[pageName];
        activeButton.Background = (Brush)FindResource("AccentDarkBrush");
        activeButton.Foreground = (Brush)FindResource("TextBrush");

        var isConsole = string.Equals(pageName, "Console", StringComparison.Ordinal);
        HeaderChrome.Visibility = isConsole ? Visibility.Collapsed : Visibility.Visible;
        HeaderRow.Height = isConsole ? new GridLength(0) : new GridLength(58);

        if (!isConsole)
        {
            PageTitle.Text = pageName is "Activity" or "Evidence" or "Approvals"
                ? "Review & History"
                : pageName;
            PageContext.Text = pageName switch
            {
                "Overview" => "Actions and recent results",
                "Workspace" => "Project details",
                "Activity" => "Search recorded actions and results",
                "Evidence" => "Evidence and handoffs",
                "Approvals" => "Items that need attention",
                "Integrations" => "Connections and remote access",
                "Release" => "Internal release reference",
                "Settings" => "Appearance and advanced details",
                _ => "Helmian"
            };
        }
    }

    private void ConsoleFullScreenButton_Click(object sender, RoutedEventArgs e)
    {
        SetConsoleFullScreen(!_consoleFullScreen);
    }

    private void LeftPanelToggleButton_Click(object sender, RoutedEventArgs e)
    {
        // Hamburger cycles: unpinned strip → pinned open → unpinned strip.
        // (Full hide still available from View menu / restore edge button path.)
        if (!_shellLayout.LeftPanelVisible)
        {
            _shellLayout = _shellLayout.ToggleLeftPanel();
            _sidebarPinnedOpen = true;
            ApplyShellPanelVisibility();
            if (SidebarRailGlyphButton is not null)
                SidebarRailGlyphButton.ToolTip = "Pinned open · click to unpin (hover again)";
            return;
        }

        if (_sidebarPinnedOpen)
        {
            _sidebarPinnedOpen = false;
            CollapseSidebarHoverVisual();
            if (SidebarRailGlyphButton is not null)
                SidebarRailGlyphButton.ToolTip = "Hover to expand · click to pin open";
            if (LeftPanelCollapseButton is not null)
                LeftPanelCollapseButton.ToolTip = "Pin closed completely (edge restore)";
            return;
        }

        // Unpinned + glyph click → pin open (labels stay).
        _sidebarPinnedOpen = true;
        ExpandSidebarHoverVisual();
        if (SidebarRailGlyphButton is not null)
            SidebarRailGlyphButton.ToolTip = "Pinned open · click to unpin (hover again)";
    }

    /// <summary>
    /// Hover the top panel toggle (or open sidebar body) → full labeled menu.
    /// Leave the sidebar → collapse to toggle-only (unless pinned).
    /// </summary>
    private void SidebarHeaderHoverZone_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
    {
        EnsureSidebarHoverTimer();
        _sidebarCollapseTimer?.Stop();
        if (!_shellLayout.LeftPanelVisible) return;
        ExpandSidebarHoverVisual();
    }

    private void SidebarChrome_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
    {
        // Keep open while moving from toggle into the labeled list.
        EnsureSidebarHoverTimer();
        _sidebarCollapseTimer?.Stop();
    }

    private void SidebarChrome_MouseLeave(object sender, System.Windows.Input.MouseEventArgs e)
    {
        if (_sidebarPinnedOpen || !_shellLayout.LeftPanelVisible) return;
        EnsureSidebarHoverTimer();
        _sidebarCollapseTimer?.Stop();
        _sidebarCollapseTimer?.Start();
    }

    private void EnsureSidebarHoverTimer()
    {
        if (_sidebarCollapseTimer is not null) return;
        _sidebarCollapseTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(280) };
        _sidebarCollapseTimer.Tick += (_, _) =>
        {
            _sidebarCollapseTimer.Stop();
            if (_sidebarPinnedOpen || !_shellLayout.LeftPanelVisible) return;
            if (SidebarChrome?.IsMouseOver == true) return;
            CollapseSidebarHoverVisual();
        };
    }

    private void ExpandSidebarHoverVisual()
    {
        SidebarColumn.Width = _sidebarExpandedWidth;
        // Restore frosted glass panel only when the menu is open.
        if (SidebarChrome is not null)
        {
            SidebarChrome.Background = TryFindResource("GlassPanelBrush") as System.Windows.Media.Brush
                ?? SidebarChrome.Background;
            SidebarChrome.BorderThickness = new Thickness(0, 0, 1, 0);
        }
        if (SidebarBrandCopy is not null) SidebarBrandCopy.Visibility = Visibility.Visible;
        if (LeftPanelCollapseButton is not null) LeftPanelCollapseButton.Visibility = Visibility.Visible;
        if (SidebarExpandedBody is not null) SidebarExpandedBody.Visibility = Visibility.Visible;
        if (SidebarStatusDotButton is not null) SidebarStatusDotButton.Visibility = Visibility.Visible;
        if (SidebarRailGlyphButton is not null)
            SidebarRailGlyphButton.ToolTip = _sidebarPinnedOpen
                ? "Pinned open · click to unpin"
                : "Hover open · click to pin · leave to hide";
    }

    private void CollapseSidebarHoverVisual()
    {
        // Claude collapsed: only the top panel toggle — no tall glass strip, no "H" clip, no ghost chrome.
        SidebarColumn.Width = _sidebarCollapsedWidth;
        if (SidebarChrome is not null)
        {
            SidebarChrome.Background = System.Windows.Media.Brushes.Transparent;
            SidebarChrome.BorderThickness = new Thickness(0);
        }
        if (SidebarBrandCopy is not null) SidebarBrandCopy.Visibility = Visibility.Collapsed;
        if (LeftPanelCollapseButton is not null) LeftPanelCollapseButton.Visibility = Visibility.Collapsed;
        if (SidebarExpandedBody is not null) SidebarExpandedBody.Visibility = Visibility.Collapsed;
        if (SidebarStatusDotButton is not null) SidebarStatusDotButton.Visibility = Visibility.Collapsed;
        if (SidebarRailGlyphButton is not null)
            SidebarRailGlyphButton.ToolTip = "Open sidebar · click to pin";
    }

    /// <summary>Width remembered when Guard fully slides off to the right.</summary>
    private GridLength _guardColumnWidthBeforeCollapse = new(360);

    private void RightPanelToggleButton_Click(object sender, RoutedEventArgs e)
    {
        // Capture width before hide so restore feels like a slide, not a jump.
        if (_shellLayout.RightPanelVisible
            && GuardPanelColumn is not null
            && GuardPanelColumn.Width.IsAbsolute
            && GuardPanelColumn.Width.Value >= 120)
        {
            _guardColumnWidthBeforeCollapse = GuardPanelColumn.Width;
        }

        _shellLayout = _shellLayout.ToggleRightPanel();
        ApplyShellPanelVisibility();
    }

    /// <summary>
    /// Drag Guard fully right (narrower than snap threshold) → same full collapse
    /// as the › button, with the edge restore strip. Room already does this on the left.
    /// </summary>
    private void ContentGuardSplitter_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e)
    {
        if (GuardPanelColumn is null || !_shellLayout.RightPanelVisible)
            return;

        var width = GuardPanelChrome?.ActualWidth
            ?? (GuardPanelColumn.Width.IsAbsolute ? GuardPanelColumn.Width.Value : 0);
        // Still a usable panel — keep whatever they dragged to.
        if (width > 96)
        {
            if (width >= 200)
                _guardColumnWidthBeforeCollapse = new GridLength(width);
            return;
        }

        // Fully slid off right → collapse + edge strip.
        if (_shellLayout.RightPanelVisible)
        {
            _shellLayout = _shellLayout.ToggleRightPanel();
            ApplyShellPanelVisibility();
        }
    }

    private void ApplyShellPanelVisibility()
    {
        if (_shellLayout.LeftPanelVisible)
        {
            SidebarChrome.Visibility = Visibility.Visible;
            LeftPanelRestoreButton.Visibility = Visibility.Collapsed;
            if (_sidebarPinnedOpen)
                ExpandSidebarHoverVisual();
            else
                CollapseSidebarHoverVisual();
        }
        else
        {
            SidebarColumn.Width = new GridLength(0);
            SidebarChrome.Visibility = Visibility.Collapsed;
            LeftPanelRestoreButton.Visibility = Visibility.Visible;
        }

        // Splitter rails collapse with their panel so Create/Preview can drag on both ends.
        if (SidebarContentSplitColDef is not null)
        {
            SidebarContentSplitColDef.Width = _shellLayout.LeftPanelVisible
                ? new GridLength(10)
                : new GridLength(0);
        }

        if (ContentGuardSplitColDef is not null)
        {
            ContentGuardSplitColDef.Width = _shellLayout.RightPanelVisible
                ? new GridLength(10)
                : new GridLength(0);
        }

        if (SidebarContentSplitter is not null)
            SidebarContentSplitter.Visibility = _shellLayout.LeftPanelVisible
                ? Visibility.Visible
                : Visibility.Collapsed;
        if (ContentGuardSplitter is not null)
            ContentGuardSplitter.Visibility = _shellLayout.RightPanelVisible
                ? Visibility.Visible
                : Visibility.Collapsed;

        // MinWidth 0 always — full slide-off to the right (was stuck at 280 before).
        GuardPanelColumn.MinWidth = 0;
        GuardPanelColumn.MaxWidth = _shellLayout.RightPanelVisible ? 900 : 0;
        if (_shellLayout.RightPanelVisible)
        {
            var restore = _guardColumnWidthBeforeCollapse;
            if (!restore.IsAbsolute || restore.Value < 200)
                restore = new GridLength(360);
            GuardPanelColumn.Width = restore;
        }
        else
        {
            GuardPanelColumn.Width = new GridLength(0);
        }

        GuardPanelChrome.Visibility = _shellLayout.RightPanelVisible
            ? Visibility.Visible
            : Visibility.Collapsed;
        // Edge strip on the right when Guard is fully off (Room-style).
        RightPanelRestoreButton.Visibility = _shellLayout.RightPanelVisible
            ? Visibility.Collapsed
            : Visibility.Visible;
        if (ViewSidebarMenuItem is not null) ViewSidebarMenuItem.IsChecked = _shellLayout.LeftPanelVisible;
        if (ViewDetailsMenuItem is not null) ViewDetailsMenuItem.IsChecked = _shellLayout.RightPanelVisible;
    }

    /// <summary>
    /// Handled in PreviewKeyDown so every chord works on every page, including
    /// while the console input box has focus.
    ///
    /// The chord TABLE lives in Core (<see cref="ShellShortcuts.Resolve"/>) and
    /// this method only carries out the answer. That split is not decoration: a
    /// WPF key handler cannot be driven from the headless suite, so while the
    /// table was inline here nothing could prove that a shortcut the UI
    /// advertises is actually bound — and Ctrl+K, promised by the search box's
    /// own tooltip, turned out never to have been.
    /// </summary>
    private void MainWindow_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        // Esc cancels the selected session's mid-turn (or shared console turn).
        if (e.Key == System.Windows.Input.Key.Escape
            && (_sharedBridgeBusy || (_sessions.Selected?.IsBusy == true) || !_activeTurnCts.IsEmpty))
        {
            CancelActiveAgentTurn();
            AppendConsoleLine("[Turn cancelled (Esc) — you can send again.]");
            e.Handled = true;
            return;
        }

        var control = (System.Windows.Input.Keyboard.Modifiers
                       & System.Windows.Input.ModifierKeys.Control)
                      == System.Windows.Input.ModifierKeys.Control;
        var shift = (System.Windows.Input.Keyboard.Modifiers
                     & System.Windows.Input.ModifierKeys.Shift)
                    == System.Windows.Input.ModifierKeys.Shift;

        switch (ShellShortcuts.Resolve(control, ToShellKey(e.Key), _consoleFullScreen, shift))
        {
            case ShellShortcut.TextLarger:
                ApplyTextScale(TextScaleRange.Larger(_desktopSettings.ResolvedTextScale));
                break;

            case ShellShortcut.TextSmaller:
                ApplyTextScale(TextScaleRange.Smaller(_desktopSettings.ResolvedTextScale));
                break;

            case ShellShortcut.TextDefault:
                ApplyTextScale(TextScaleRange.Default);
                break;

            case ShellShortcut.FocusProjectSearch:
                FocusProjectSearch();
                break;

            case ShellShortcut.NewProject:
                MenuNewProject_Click(this, new RoutedEventArgs());
                break;

            case ShellShortcut.OpenProject:
                MenuOpenProject_Click(this, new RoutedEventArgs());
                break;

            case ShellShortcut.OpenSettings:
                NavigateTo("Settings");
                break;

            case ShellShortcut.ToggleSidebar:
                MenuToggleSidebar_Click(this, new RoutedEventArgs());
                break;

            case ShellShortcut.ToggleDetails:
                MenuToggleDetails_Click(this, new RoutedEventArgs());
                break;

            case ShellShortcut.ToggleBottomPanel:
                MenuToggleBottomPanel_Click(this, new RoutedEventArgs());
                break;

            case ShellShortcut.ToggleConsoleFullScreen:
                // Navigates to Console first when entering, so the chord works
                // from any page.
                if (!_consoleFullScreen)
                {
                    NavigateTo("Console");
                    SetConsoleFullScreen(true);
                }
                else
                {
                    SetConsoleFullScreen(false);
                }

                break;

            case ShellShortcut.ExitConsoleFullScreen:
                SetConsoleFullScreen(false);
                break;

            default:
                return;
        }

        e.Handled = true;
    }

    private static ShellKey ToShellKey(System.Windows.Input.Key key) => key switch
    {
        System.Windows.Input.Key.OemPlus => ShellKey.OemPlus,
        System.Windows.Input.Key.Add => ShellKey.Add,
        System.Windows.Input.Key.OemMinus => ShellKey.OemMinus,
        System.Windows.Input.Key.Subtract => ShellKey.Subtract,
        System.Windows.Input.Key.D0 => ShellKey.D0,
        System.Windows.Input.Key.NumPad0 => ShellKey.NumPad0,
        System.Windows.Input.Key.K => ShellKey.K,
        System.Windows.Input.Key.B => ShellKey.B,
        System.Windows.Input.Key.D => ShellKey.D,
        System.Windows.Input.Key.J => ShellKey.J,
        System.Windows.Input.Key.N => ShellKey.N,
        System.Windows.Input.Key.O => ShellKey.O,
        System.Windows.Input.Key.OemComma => ShellKey.OemComma,
        System.Windows.Input.Key.F11 => ShellKey.F11,
        System.Windows.Input.Key.Escape => ShellKey.Escape,
        _ => ShellKey.Other,
    };

    /// <summary>
    /// Ctrl+K. Selects what is already there so the next keystroke replaces the
    /// old filter rather than appending to it — pressing it twice in a row is
    /// how somebody starts a NEW search, not how they extend the last one.
    /// </summary>
    private void FocusProjectSearch()
    {
        if (ProjectSearchBox is null) return;

        ProjectSearchBox.Focus();
        ProjectSearchBox.SelectAll();
    }

    /// <summary>
    /// Ctrl+Wheel — text size, the way every browser does it. Troy asked for this
    /// one by name: "control and mouse wheel or something easily."
    ///
    /// PREVIEW, NOT THE BUBBLING MouseWheel. A ScrollViewer handles MouseWheel and
    /// marks it handled, so a bubbling handler on the Window never runs whenever the
    /// pointer happens to be over a scrollable region — which is most of this shell,
    /// and exactly where someone trying to read a card would have the mouse. The
    /// tunnelling PreviewMouseWheel reaches the Window first, so this works
    /// everywhere rather than only over the gaps between panels.
    /// </summary>
    private void MainWindow_PreviewMouseWheel(
        object sender,
        System.Windows.Input.MouseWheelEventArgs e)
    {
        if ((System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Control)
            != System.Windows.Input.ModifierKeys.Control)
        {
            return;
        }

        if (e.Delta == 0)
        {
            return;
        }

        // One notch, one stop on the ladder — the same ladder and the same save the
        // keyboard path uses, so the two can never disagree about where the stops are.
        ApplyTextScale(e.Delta > 0
            ? TextScaleRange.Larger(_desktopSettings.ResolvedTextScale)
            : TextScaleRange.Smaller(_desktopSettings.ResolvedTextScale));

        // Without this the page scrolls as well as the text resizing.
        e.Handled = true;
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
            _restoreWindowStyle = WindowStyle;
            _restoreResizeMode = ResizeMode;
            _restoreLeft = Left;
            _restoreTop = Top;
            _restoreWidth = Width;
            _restoreHeight = Height;

            // This is true Windows full screen: caption and resize chrome are
            // removed. Each side panel keeps the user's independent choice.
            ApplyShellPanelVisibility();
            HeaderChrome.Visibility = Visibility.Collapsed;
            FooterChrome.Visibility = Visibility.Collapsed;
            ApplicationMenu.Visibility = Visibility.Collapsed;
            HeaderRow.Height = new GridLength(0);
            FooterRow.Height = new GridLength(0);

            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
            _shellLayout = _shellLayout.WithFullScreen(true);
            ConsoleFullScreenButton.Content = "⛶";
            ConsoleFullScreenButton.ToolTip =
                "Exit full screen (Escape or F11). Sidebar and Details keep their independent state.";
            if (ConsoleLiveLabel is not null)
            {
                ConsoleLiveLabel.Text = "FULL SCREEN";
            }

        }
        else
        {
            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.SingleBorderWindow;
            // Always re-enable resize when leaving full screen (never stick on NoResize).
            ResizeMode = ResizeMode.CanResize;
            _restoreResizeMode = ResizeMode.CanResize;
            ApplyShellPanelVisibility();
            ApplicationMenu.Visibility = Visibility.Visible;
            var consoleVisible = ConsolePage.Visibility == Visibility.Visible;
            HeaderChrome.Visibility = consoleVisible ? Visibility.Collapsed : Visibility.Visible;
            var showBottomPanel = ViewBottomPanelMenuItem.IsChecked;
            FooterChrome.Visibility = showBottomPanel ? Visibility.Visible : Visibility.Collapsed;
            HeaderRow.Height = consoleVisible ? new GridLength(0) : new GridLength(58);
            FooterRow.Height = showBottomPanel ? new GridLength(38) : new GridLength(0);

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

            _shellLayout = _shellLayout.WithFullScreen(false);
            ConsoleFullScreenButton.Content = "⛶";
            ConsoleFullScreenButton.ToolTip = "Enter full-screen Console (F11). Press Escape or F11 to return.";
            if (ConsoleLiveLabel is not null)
            {
                ConsoleLiveLabel.Text = "LIVE";
            }

        }
    }

    public void ApplyThemeForPreview(string themeId)
    {
        ApplyTheme(themeId, save: false);
        SyncThemeSelectors(themeId);
    }

    /// <summary>
    /// Preview-only hooks, used by --render-preview to photograph states that
    /// normally need a click. save:false throughout — a screenshot must never
    /// write to the real user's settings file.
    /// </summary>
    public void ApplyTextScaleForPreview(double scale) => ApplyTextScale(scale, save: false);

    /// <summary>The MCP security panel starts collapsed behind the "mcp security" button.</summary>
    public void RevealMcpPanelForPreview()
    {
        NavigateTo("Console");
        ConsoleMcpPanel.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// Photographs the Antigravity settings panel with a REAL status, not the "Checking…"
    /// placeholder. RefreshAntigravityStatus is re-run here because the preview path renders
    /// before MainWindow_Loaded's async body has finished, so an unassisted shot proves only
    /// that the XAML parsed — not what the panel actually says about this machine.
    /// </summary>
    public void RevealAntigravityPanelForPreview()
    {
        NavigateTo("Settings");
        RefreshAntigravityStatus();

        // BringIntoView alone does nothing here: it defers to a later layout pass that the
        // preview path never runs, so the shot came back showing the top of Settings and
        // proved only that the XAML parsed. Measure first, then scroll the containing
        // ScrollViewer by the panel's own offset within it.
        UpdateLayout();
        DependencyObject? node = AntigravityStatusLabel;
        while (node is not null && node is not ScrollViewer)
        {
            node = VisualTreeHelper.GetParent(node);
        }

        if (node is ScrollViewer scroller)
        {
            var offset = AntigravityStatusLabel
                .TransformToAncestor(scroller)
                .Transform(new Point(0, 0)).Y;
            scroller.ScrollToVerticalOffset(scroller.VerticalOffset + offset - 320);
            UpdateLayout();
        }
    }

    /// <summary>
    /// THE FRESH-WORKSPACE RED AUDIT. Runs every + action whose outcome is decided
    /// purely by a local precondition, against a workspace with nothing in it, and
    /// returns how many of them came back red.
    ///
    /// Troy's rule, 2026-07-30: "a fresh empty workspace must produce zero red
    /// banners." The answer must be 0. A non-zero count means some first-run state
    /// — no plugins yet, nothing typed yet, no project yet — is once again being
    /// reported as a failure, which is the bug that made the only correctly
    /// working thing on the screen look like the broken one.
    ///
    /// Deliberately excludes Skills and Upload: Skills calls the agent bridge and
    /// Upload opens a file dialog, so neither has a deterministic offline answer,
    /// and a red from a bridge that genuinely did not start IS a real failure.
    /// </summary>
    public int CountFreshWorkspaceRedRows()
    {
        _plusMenu.Clear();
        if (ConsoleInputBox is not null)
        {
            ConsoleInputBox.Text = string.Empty;
        }

        AddPluginsAsync().GetAwaiter().GetResult();   // no .helmion/plugins.json
        _ = AddConnectorAsync();                      // nothing typed in the box
        NewProjectButton_Click(this, new RoutedEventArgs());  // no name typed

        return _plusMenu.Items.Count(item => item.State == PlusActionState.Failed);
    }

    /// <summary>Runs one + menu action so its resulting row can be photographed.</summary>
    public void RunPlusMenuActionForPreview(PlusMenuKind kind)
    {
        NavigateTo("Console");
        ConsolePlusPopup.IsOpen = true;
        _ = kind switch
        {
            PlusMenuKind.Plugin => AddPluginsAsync(),
            PlusMenuKind.Connector => AddConnectorAsync(),
            _ => Task.CompletedTask,
        };
    }

    private void ThemeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_themeSelectorReady || _syncingThemeSelectors
            || ThemeSelector.SelectedValue is not string themeId)
        {
            return;
        }

        SyncThemeSelectors(themeId);
        ApplyTheme(themeId, _persistTheme);
    }

    private void QuickThemeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_themeSelectorReady || _syncingThemeSelectors
            || QuickThemeSelector.SelectedValue is not string themeId)
        {
            return;
        }

        SyncThemeSelectors(themeId);
        ApplyTheme(themeId, _persistTheme);
    }

    private void RailThemeSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_themeSelectorReady || _syncingThemeSelectors
            || RailThemeSelector.SelectedValue is not string themeId)
        {
            return;
        }

        SyncThemeSelectors(themeId);
        ApplyTheme(themeId, _persistTheme);
    }

    private void SyncThemeSelectors(string themeId)
    {
        var selected = ColorThemeCatalog.Get(themeId);
        _syncingThemeSelectors = true;
        try
        {
            ThemeSelector.SelectedValue = selected.Id;
            QuickThemeSelector.SelectedValue = selected.Id;
            RailThemeSelector.SelectedValue = selected.Id;
            if (ThemeCycleButton is not null) ThemeCycleButton.Content = $"Theme · {selected.Name}";
        }
        finally
        {
            _syncingThemeSelectors = false;
        }
    }

    private void ThemeCycleButton_Click(object sender, RoutedEventArgs e)
    {
        var current = ColorThemeCatalog.Get(_desktopSettings.ColorTheme);
        var index = ColorThemeCatalog.All.ToList().FindIndex(option => option.Id == current.Id);
        var next = ColorThemeCatalog.All[(index + 1 + ColorThemeCatalog.All.Count) % ColorThemeCatalog.All.Count];
        SyncThemeSelectors(next.Id);
        ApplyTheme(next.Id, save: true);
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

    // ── text size ─────────────────────────────────────────────────────────────
    //
    // Troy, 2026-07-29: "there needs to be a way to enlarge the text on all of
    // that, 'cause I can't read anything on the cards."
    //
    // The scale is applied to ONE ScaleTransform on the root Grid (MainWindow.xaml
    // AppScale), because MainWindow.xaml sets FontSize as a literal in 261 places
    // and reads it from a resource in none — see the comment on the transform for
    // why routing all 261 through a resource is both bigger and worse.

    /// <summary>
    /// The window minimums as authored in MainWindow.xaml, before any scaling.
    /// Kept here rather than read back off the properties because ApplyTextScale
    /// overwrites those, and a minimum derived from an already-scaled minimum
    /// ratchets upward every time the user presses Ctrl+=.
    /// </summary>
    // Soft floors so the window stays resizable on smaller monitors (was 1120×720).
    private const double BaseMinWidth = 900;
    private const double BaseMinHeight = 560;

    private void TextScaleSmallerButton_Click(object sender, RoutedEventArgs e) =>
        ApplyTextScale(TextScaleRange.Smaller(_desktopSettings.ResolvedTextScale));

    private void TextScaleLargerButton_Click(object sender, RoutedEventArgs e) =>
        ApplyTextScale(TextScaleRange.Larger(_desktopSettings.ResolvedTextScale));

    private void TextScaleResetButton_Click(object sender, RoutedEventArgs e) =>
        ApplyTextScale(TextScaleRange.Default);

    /// <summary>
    /// Sets the shell scale, updates the readout and saves the choice.
    ///
    /// SAVING IS BEST-EFFORT AND NEVER FATAL. A settings file that cannot be
    /// written is a reason to lose the preference at restart, not a reason to
    /// refuse to make the text bigger for the user asking right now.
    /// </summary>
    private void ApplyTextScale(double scale, bool save = true)
    {
        var resolved = TextScaleRange.Clamp(scale);

        if (AppScale is not null)
        {
            AppScale.ScaleX = resolved;
            AppScale.ScaleY = resolved;
        }

        if (TextScaleValueLabel is not null)
        {
            TextScaleValueLabel.Text = TextScaleRange.Describe(resolved);
        }

        // THE WINDOW HAS TO GROW WITH THE TEXT.
        //
        // The shell declares MinWidth 1120 / MinHeight 720 in DIPs of ITS OWN
        // coordinate space, which the transform shrinks: at 160% a 1440px window
        // gives the layout only 900 units to work with — less than the 1120 it
        // says it needs — and the fixed 248px sidebar and 336px guard column eat
        // most of what is left, crushing the console between them. Scaling the
        // minimums keeps that from happening, and nudging the window out to meet
        // them means enlarging the text enlarges the window instead of squeezing
        // the middle. Bounded by the work area so it can never grow off-screen.
        // CAPPED AT THE SCREEN. A minimum is still a minimum: WPF enforces it even
        // when it exceeds the display, so an uncapped BaseMinHeight * 2.0 = 1440
        // pins a 1080p window taller than the monitor and pushes its own bottom
        // edge out of reach. The cap is what keeps "make the text bigger" from
        // costing the user the bottom of the window.
        var workArea = SystemParameters.WorkArea;
        MinWidth = Math.Min(BaseMinWidth * resolved, workArea.Width);
        MinHeight = Math.Min(BaseMinHeight * resolved, workArea.Height);

        if (WindowState == WindowState.Normal)
        {
            if (Width < MinWidth)
            {
                Width = MinWidth;
            }

            if (Height < MinHeight)
            {
                Height = MinHeight;
            }
        }

        if (!save)
        {
            return;
        }

        _desktopSettings = _desktopSettings with { TextScale = resolved };
        try
        {
            DesktopSettingsStore.Save(_desktopSettings);
            if (TextScalePersistenceLabel is not null)
            {
                TextScalePersistenceLabel.Text = "Saved locally for this Windows user";
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // Say so rather than showing "Saved" over a write that did not happen.
            if (TextScalePersistenceLabel is not null)
            {
                TextScalePersistenceLabel.Text =
                    "Applied, but NOT saved — this setting will reset when Helmion restarts.";
            }
        }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        StopRemoteControlDesktopGateway();
        DisposeSuperGrok();
        DisposeChatGpt();
        DisposeGeminiSubscription();
        DisposeAntigravity();
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
        // A REAL ANSWER HAS NOW ARRIVED. Until this flips, the guard card says "I
        // have not checked yet" rather than reporting the bool's false default as a
        // failed check — see PublishServicePostureCard.
        _serviceEverChecked = true;
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
        _serviceEverChecked = true;
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
        // Guarantee drag-resize unless true console full screen (F11).
        if (!_consoleFullScreen)
        {
            ResizeMode = ResizeMode.CanResize;
            WindowStyle = WindowStyle.SingleBorderWindow;
        }
        EnsureRemoteControlDesktopGatewayStarted();
        LoadApiKeysToInputs();

        _consoleSession = new ConsoleSession();
        _consoleSession.PermissionMode = _desktopSettings.ResolvedPermissionMode;
        // Before ConfigureMaestro below, so a stored SuperGrok session is already attached
        // when the Grok route is built rather than only after the first settings save.
        InitializeSuperGrok();
        InitializeChatGpt();
        InitializeGeminiSubscription();
        InitializeClaudeSubscription();
        InitializeAntigravity();
        _initializingPermissionSelection = true;
        try
        {
            SelectPermissionInCombo(_consoleSession.PermissionMode);
        }
        finally
        {
            _initializingPermissionSelection = false;
        }
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

        // Local voice only: Whisper STT + Kokoro TTS. No Moshi / duplex factory.
        _voiceSelector = new VoiceBackendSelector(
            CreateVoiceSession,
            duplexFactory: null,
            preferred: VoiceBackend.WhisperKokoro);
        _voiceSelector.StatusChanged += (_, status) =>
            Dispatcher.Invoke(() => ApplyVoiceBackendStatus(status));
        _voiceSelector.Error += (_, msg) =>
            Dispatcher.Invoke(() =>
            {
                // Status strip only — do not spam the transcript with model-path walls.
                if (ConsoleServiceSessionText is not null)
                    ConsoleServiceSessionText.Text = "Voice · " + (msg.Length > 96 ? msg[..96] + "…" : msg);
            });
        var envSettings = EnvironmentSettingsStore.Load();
        _consoleSession.ConfigureMaestro(
            envSettings.MaestroCoordinator,
            envSettings,
            _desktopSettings.CustomProviders);
        UpdateConsoleExecutionState();
        UpdateConsoleWorkspaceLabel();
        ApplyConsoleInputContrast();

        // Full multi-line paste into the console composer (WPF single-line boxes drop lines).
        DataObject.AddPastingHandler(ConsoleInputBox, ConsoleInputBox_OnPaste);

        await ConnectServiceAsync(restoreWorkspace: true);
        // The first remote-control sync can run before the local service is
        // available during a cold desktop start. Run it again after the
        // service handshake so an already-paired phone always receives a
        // live session without requiring the operator to reopen anything.
        await SyncRemoteControlSessionAsync();
        try
        {
            // Fill Team dropdowns with Discord servers and GitHub repos so the
            // panel is useful after login without another Connect click.
            await RefreshTeamConversationAsync();
        }
        catch
        {
            // Team is optional at boot; Connect buttons still work later.
        }
        UpdateConsoleWorkspaceLabel();
        ApplyConsoleInputContrast();
    }

    /// <summary>
    /// Keeps render/layout smoke windows from starting the live pipe service or
    /// restoring a user's workspace. Other Loaded handlers still run, so the
    /// visual tree is wired exactly as it is in the real desktop.
    /// </summary>
    public void DisableRuntimeStartupForPreview()
    {
        Loaded -= MainWindow_Loaded;
    }

    /// <summary>
    /// Keep the composer as one theme-cohesive surface. The TextBox is
    /// transparent so its rectangular background cannot show through the rounded
    /// parent; ink, caret and selection come from the active palette.
    /// </summary>
    private void ApplyConsoleInputContrast()
    {
        if (ConsoleInputBox is null)
        {
            return;
        }

        ConsoleInputBox.Background = Brushes.Transparent;
        ConsoleInputBox.Foreground = (Brush)FindResource("TextBrush");
        ConsoleInputBox.CaretBrush = (Brush)FindResource("AccentBrush");
        ConsoleInputBox.SelectionBrush = (Brush)FindResource("AccentStrokeStrongBrush");
        if (ConsoleComposerBorder is not null)
        {
            ConsoleComposerBorder.Background = (Brush)FindResource("PanelInsetBrush");
            ConsoleComposerBorder.BorderBrush = ConsoleInputBox.IsKeyboardFocusWithin
                ? (Brush)FindResource("AccentStrokeStrongBrush")
                : (Brush)FindResource("StrokeBrush");
        }
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
            ApplySuperGrokToConsole();
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
            else
            {
                var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                var customerRoot = ProjectWorkspaceDefaults.CustomerRoot(documents);
                dialog.InitialDirectory = Directory.Exists(customerRoot)
                    ? customerRoot
                    : documents;
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
                _serviceEverChecked = true;
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
                _serviceEverChecked = true;
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
            NotifyProjectScopedPanelsChanged();

            // Registering a workspace changes which projects exist. Without this
            // the panel kept listing the PREVIOUS workspace's projects until the
            // window was reopened, and the search box then filtered a stale list.
            RefreshProjectShelf();
            RefreshProjectWorkbench(forceCanvasReload: true);
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
        // 2026-07-29: these two used to be overwritten with the literals "Unknown" and
        // "Durable state not queried" immediately after the bindings had been given the
        // real values — so the card could never show the lease even once the lease
        // existed. The real status now comes from LeaseInspector via the snapshot, and
        // ApplyLeasePosture colours it.
        LeaseMetricText.Text = inspection.Lease.Status;
        LeaseMetricDetail.Text = inspection.Lease.Detail;

        // Re-read the block ledger and the lease for this workspace. On demand, here —
        // not on a timer.
        RefreshGuardFeedFromDisk(inspection);

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
        PublishServicePostureCard();
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
        // Claude Code: Shift+Tab cycles plan / accept / auto-accept on the mode line.
        if (e.Key == System.Windows.Input.Key.Tab
            && System.Windows.Input.Keyboard.Modifiers.HasFlag(System.Windows.Input.ModifierKeys.Shift)
            && !System.Windows.Input.Keyboard.Modifiers.HasFlag(System.Windows.Input.ModifierKeys.Control)
            && !System.Windows.Input.Keyboard.Modifiers.HasFlag(System.Windows.Input.ModifierKeys.Alt))
        {
            CycleClaudePermissionMode();
            e.Handled = true;
            return;
        }

        // TYPING "/" LISTS THE COMMANDS, which is what the app has been telling
        // people to do while doing nothing. The Skills row says "Type / in the box
        // to see them" and typing / did exactly nothing — Troy typed "/////" and
        // sat there. Same class of defect as the Ctrl+K tooltip: the UI made a
        // promise the code did not keep.
        //
        // Only fires on the FIRST character, so "/deploy staging" types normally
        // and a / inside a sentence is untouched.
        if ((e.Key == System.Windows.Input.Key.Oem2 || e.Key == System.Windows.Input.Key.Divide)
            && ConsoleInputBox is not null
            && ConsoleInputBox.Text.Length == 0)
        {
            // Fetch quietly, then OPEN THE PICKER. Quiet because the picker is the
            // answer now — printing the same list into the transcript as well would
            // be the app saying the same thing twice, which is the noise Troy has
            // been cutting out of this panel all night.
            await ListSlashCommandsAsync(quiet: true);
            ShowSlashPicker();
            return;   // NOT handled — the "/" still lands in the box so he can keep typing.
        }

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

    /// <summary>
    /// Fan-out: each @agent (or @all) gets a coordination prompt on its own bridge.
    /// Manager session is optional — console dispatch works without creating Maestro first.
    /// </summary>
    private async Task DispatchMaestroMentionsAsync(
        AgentSession? manager,
        MaestroMentions.ParseResult parse,
        string originalText)
    {
        var workers = MaestroMentions.ResolveWorkers(parse, _sessions.Sessions, manager);
        if (workers.Count == 0)
        {
            var known = _sessions.Sessions
                .Where(s => !s.IsManager)
                .Select(s => s.Name)
                .ToArray();
            var hint = known.Length == 0
                ? "Start agents with Claude / ChatGPT / Grok / Gemini first."
                : "Known agents: " + string.Join(", ", known.Select(n => "@" + CompactMentionName(n)))
                  + " — or @all.";
            AppendConsoleLine(
                "No matching agents for those @mentions. " + hint);
            return;
        }

        var busy = workers.Where(w => w.IsBusy).Select(w => w.Name).ToArray();
        var ready = workers.Where(w => !w.IsBusy).ToList();
        if (busy.Length > 0)
        {
            AppendConsoleLine(
                $"[Skipped busy: {string.Join(", ", busy)}. Wait for them or Esc their turn.]");
        }

        if (ready.Count == 0)
        {
            AppendConsoleLine("[All mentioned agents are busy — nothing dispatched.]");
            return;
        }

        var managerName = manager?.Name ?? "Console";
        var previous = _sessions.Selected;
        if (manager is not null)
            _sessions.Select(manager);

        AppendConsoleLine(
            $"{(manager is null ? "Dispatch" : $"Maestro \"{managerName}\"")} → " +
            $"{string.Join(", ", ready.Select(w => w.Name))}" +
            (parse.MentionsAll ? " (@all)" : "") + "\n" +
            "Each agent claims a distinct slice so they do not step on each other.");

        if (manager is not null)
            manager.IsBusy = true;
        try
        {
            var tasks = ready.Select(async worker =>
            {
                var peers = ready.Where(w => !ReferenceEquals(w, worker)).ToList();
                var prompt = MaestroMentions.BuildWorkerPrompt(
                    managerName,
                    worker,
                    peers,
                    parse.BodyWithoutMentions);

                AppendConsoleLine($"→ @{worker.Name}");

                try
                {
                    await SendConsoleInputAsync(
                        overrideText: prompt,
                        includeStagedAttachments: false,
                        allowConsoleControls: false,
                        forceSession: worker);

                    var preview = worker.ChatPreview;
                    if (manager is not null)
                        _asyncTurnSession.Value = manager;
                    else
                        _asyncTurnSession.Value = null;
                    AppendConsoleLine($"← @{worker.Name}: {preview}");
                    ReportReplyContentPolicy(worker, preview, worker.Name);
                }
                catch (Exception ex)
                {
                    if (manager is not null)
                        _asyncTurnSession.Value = manager;
                    else
                        _asyncTurnSession.Value = null;
                    AppendConsoleLine($"← @{worker.Name} failed: {ex.Message}");
                }
                finally
                {
                    _asyncTurnSession.Value = null;
                }
            });

            await Task.WhenAll(tasks);
            AppendConsoleLine(
                "Dispatch finished. Read each agent card for full chat; " +
                "claims should not overlap if they followed coordination rules.");
        }
        finally
        {
            if (manager is not null)
            {
                manager.IsBusy = false;
                manager.NotifyTranscriptChanged();
            }
            if (previous is not null)
                _sessions.Select(previous);
            else if (manager is not null)
                _sessions.Select(manager);
            ShowSessionTranscript(_sessions.Selected);
        }
    }

    private static string CompactMentionName(string name) =>
        string.Concat(name.Where(c => !char.IsWhiteSpace(c)));

    private async Task SendConsoleInputAsync(
        string? overrideText = null,
        bool includeStagedAttachments = true,
        bool allowConsoleControls = true,
        AgentSession? forceSession = null)
    {
        var text = (overrideText ?? ConsoleInputBox.Text).Trim();
        if (string.IsNullOrEmpty(text)) return;
        // MULTI-AGENT: each named session can run its own turn at once (own bridge).
        // Block only when THIS target is already mid-turn, or Ask-mode has an open approval.
        var sessionForGate = forceSession ?? _sessions.Selected;
        if (sessionForGate is not null && sessionForGate.IsBusy)
        {
            ReportBusyGate(sessionForGate);
            return;
        }
        if (sessionForGate is null && _sharedBridgeBusy)
        {
            ReportBusyGate(null);
            return;
        }
        if (AgentPermission.RequiresApproval(CurrentPermissionMode)
            && !string.IsNullOrEmpty(_pendingApprovalId))
        {
            AppendConsoleLine("[Busy — answer Allow once / Allow for session / Deny first, or Esc.]");
            return;
        }

        if (_consoleSession is null)
        {
            // Nothing was dispatched, so the text stays in the composer to be retried.
            ConsoleInputBox.Text = text;
            ConsoleInputBox.CaretIndex = text.Length;
            AppendConsoleLine($"\nRequest\n{text}");
            AppendConsoleLine("Action needed — the Console is not ready yet. Open Troubleshooting & Status for details.");
            return;
        }

        if (!allowConsoleControls && (text.StartsWith('!') || text.StartsWith('/')))
        {
            AppendConsoleLine("[Herald refused a shell escape or slash control. Nothing was sent.]");
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

        var session = forceSession ?? _sessions.Selected;

        // Worker dispatches log under manager; still stamp the assignment onto the worker card.
        if (forceSession is null)
            AppendConsoleLine($"\nYou\n{text}");
        else
        {
            forceSession.Transcript.Append($"\nManager → you\n{text}\n");
            forceSession.NotifyTranscriptChanged();
        }

        // Maestro @dispatch only for human-typed lines (not internal worker prompts).
        if (forceSession is null)
        {
            var mentionParse = MaestroMentions.Parse(text);
            if (mentionParse.HasMentions)
            {
                // Manager is optional: @agent / @all dispatch from console without creating Maestro first.
                var manager = session is { IsManager: true }
                    ? session
                    : _sessions.Manager;

                if (manager is { IsBusy: true })
                {
                    AppendConsoleLine($"[Manager \"{manager.Name}\" is still dispatching — wait or Esc.]");
                    return;
                }

                await DispatchMaestroMentionsAsync(manager, mentionParse, text);
                return;
            }
        }

        // "/reset" is a console control, not a command file — handle it before anything else.
        if (text.Equals("/reset", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                if (_agentBridge is not null) await _agentBridge.ResetAsync();
                AppendConsoleLine("Result\nConversation reset.");
            }
            catch (Exception ex)
            {
                AppendConsoleLine($"Action needed — the conversation could not be reset: {ex.Message}");
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

        // A tool-enabled model turn must be bound to a project the user selected
        // in this app. ResolveAgentWorkspace has useful read-only fallbacks for
        // status and chat, but a fallback must never silently become the folder
        // where a provider can read, write, run, or preview.
        var permission = CurrentPermissionMode;
        if (AgentPermission.AllowsExecution(permission)
            && (string.IsNullOrWhiteSpace(_registeredWorkspacePath)
                || !Directory.Exists(_registeredWorkspacePath)))
        {
            AppendConsoleLine(
                "Action needed — choose a project on the Workspace page before enabling workspace actions. Nothing was sent and nothing ran.");
            return;
        }

        // Full coding agent (same engine as `helmion agent` CLI) via Node bridge.
        // Named sessions run CONCURRENTLY (each own bridge). Shared console is one-at-a-time.
        var turnKey = session?.Id ?? "__shared__";
        _turnSession = session;
        _asyncTurnSession.Value = session;
        if (session is not null) session.IsBusy = true;
        else _sharedBridgeBusy = true;

        var turnCts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        _activeTurnCts[turnKey] = turnCts;
        var turnToken = turnCts.Token;
        var spoken = new System.Text.StringBuilder();
        try
        {
            var settings = EnvironmentSettingsStore.Load();

            // Core owns the routing rule (SessionShelf.cs, SessionTurnRouting) so the
            // smoke suite can prove a selected session's turn reaches ITS coordinator
            // rather than the global Maestro setting. Inline here, nothing could.
            var route = SessionTurnRouting.ForTurn(session, settings.MaestroCoordinator);
            var provider = route.Provider;

            _consoleSession.ConfigureMaestro(
                provider,
                settings,
                _desktopSettings.CustomProviders);
            _consoleSession.PermissionMode = permission;

            var workspace = AgentPermission.AllowsExecution(permission)
                ? Path.GetFullPath(_registeredWorkspacePath!)
                : ResolveAgentWorkspace();
            UpdateConsoleWorkspaceLabel(workspace);

            var bridge = route.Session is null
                ? (_agentBridge ??= new AgentBridge())
                : ResolveSessionBridge(route.Session);

            // THE + MENU'S ATTACHMENTS ACTUALLY GO NOW.
            //
            // This used to pass `text` alone while the composer showed a green
            // "attached" row, so the user was told the model had their file and it
            // did not. Composition lives in Core (PromptAttachments) so the smoke
            // suite can prove the file's real contents land in this payload with no
            // window open — the seam it could not reach before.
            //
            // Every attachment is RE-VALIDATED against AttachmentPolicy in there,
            // because a file can be deleted or grown past the cap between the file
            // dialog and this line. A refusal turns the row red with the reason and
            // says so in the transcript; it is never dropped in silence.
            var stagedAttachments = includeStagedAttachments
                ? _plusMenu.ActiveAttachments
                : Array.Empty<PlusActionItem>();
            var outgoing = PromptAttachments.Compose(text, stagedAttachments, provider);

            foreach (var refused in outgoing.Refused)
            {
                var stale = _plusMenu.ActiveAttachments.FirstOrDefault(
                    a => string.Equals(a.SourcePath, refused.Path, StringComparison.OrdinalIgnoreCase));
                if (stale is not null) _plusMenu.Fail(stale, refused.Message);
                AppendConsoleLine($"Action needed — attachment not included: {refused.Message}");
            }

            // Subscription sessions stay inside their provider-owned desktop CLI.
            // They are read-only by policy and never receive Helmion's tool protocol,
            // API-key environment, or any token copied from Settings. Tool-capable
            // turns keep using the governed AgentBridge path below.
            if (await TryRunProviderOwnedReadOnlyTurnAsync(
                    provider,
                    permission,
                    outgoing.Text,
                    outgoing.Images.Count > 0,
                    session,
                    turnToken))
            {
                return;
            }

            // Consumed by the message they were attached to, so a file does not
            // silently ride along with every later turn. The row stays on screen in
            // the Removed state, so Undo puts it back for the next message.
            foreach (var sent in outgoing.Included)
            {
                var done = _plusMenu.ActiveAttachments.FirstOrDefault(
                    a => string.Equals(a.SourcePath, sent.Path, StringComparison.OrdinalIgnoreCase));
                if (done is not null) _plusMenu.Remove(done);
            }

            var turnFailed = (string?)null;
            var resultStarted = false;
            await foreach (var ev in bridge.TurnAsync(
                               outgoing.Text,
                               workspace,
                               provider,
                               permission,
                               _desktopSettings.CustomProviders,
                               session?.TierOverride,
                               session?.ModelOverride,
                               outgoing.Images,
                               turnToken))
            {
                switch (ev.Event)
                {
                    case "status":
                        // Progress belongs in compact session details, not chat.
                        break;
                    case "model":
                        // Which model the per-task router picked for this round, and why.
                        // The CLI has always printed this; the app used to drop it.
                        ShowChosenModel(ev);
                        break;
                    case "provenance":
                        // Which model ACTUALLY answered. Emitted after the response
                        // arrived and after the row was written to the ledger, so
                        // this overwrites the header's guess with evidence.
                        ShowAnsweringModel(ev);
                        break;
                    case "command":
                        // Command expansion detail is retained by the audit path, not the main transcript.
                        break;
                    case "tool":
                        // Tool arguments are diagnostic detail and do not belong in the main transcript.
                        break;
                    case "tool_result":
                        // Raw provider tool output remains hidden; a typed, bounded
                        // workbench status is safe to surface and audit separately.
                        ApplyAgentWorkbenchResult(ev);
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

                        if (!string.IsNullOrEmpty(ev.Id))
                        {
                            await bridge.RespondToPermissionAsync(ev.Id, decision);
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
                        AppendConsoleLine($"Review result — {verdict.ToLowerInvariant()}: {ev.Tool ?? ev.Name ?? "action"}{by}");
                        break;
                    }
                    case "permission_unknown":
                        AppendConsoleLine($"  ⇢ Approval ignored — {ev.Message}");
                        break;
                    case "assistant":
                        if (!string.IsNullOrWhiteSpace(ev.Text))
                        {
                            if (!resultStarted)
                            {
                                AppendConsoleLine(session?.Name ?? "Maestro");
                                resultStarted = true;
                            }
                            AppendConsoleLine(ev.Text);
                            if (!ev.Partial) spoken.Append(ev.Text).Append(' ');
                        }
                        break;
                    case "error":
                        AppendConsoleLine($"Action needed — {ev.Message}");
                        turnFailed = ev.Message ?? "The bridge reported an error with no message.";
                        if (spoken.Length == 0)
                        {
                            spoken.Append("There was an agent error. ");
                        }
                        break;
                    case "hello":
                    case "ready":
                        if (!string.IsNullOrWhiteSpace(ev.Workspace))
                        {
                            UpdateConsoleWorkspaceLabel(
                                ev.Workspace,
                                agentConfirmed: true);
                        }
                        ConsoleServiceSessionText.Text =
                            $"Agent ready · {ev.Provider ?? provider} · {permission} · {ev.Workspace ?? workspace}";
                        break;
                }
            }

            AppendConsoleLine("");

            // The turn's outcome becomes this session's guard card, which is what
            // moves its dot. A clean turn reports Normal — the feed treats Normal as
            // recovery and resets the sighting count (GuardFeed.cs:184-188), so a
            // session that failed once and then worked goes back to green instead of
            // ratcheting toward red on a condition that has cleared.
            if (session is not null)
            {
                if (turnFailed is null)
                {
                    ReportSessionTurn(
                        session,
                        GuardLevel.Normal,
                        $"\"{session.Name}\" completed a turn",
                        $"The last turn on {provider} finished without the bridge reporting an "
                        + "error. This says the turn completed — not that the answer was correct.");
                    // Content policy on the full spoken reply (not streaming partials).
                    if (spoken.Length > 0)
                    {
                        ReportReplyContentPolicy(session, spoken.ToString());
                    }
                }
                else
                {
                    ReportSessionTurn(
                        session,
                        GuardLevel.Warning,
                        $"\"{session.Name}\" reported an error",
                        $"The bridge answered: {turnFailed}. Repeats escalate on the panel's stated "
                        + "rule; a clean turn clears it.");
                }
            }

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
        catch (OperationCanceledException)
        {
            AppendConsoleLine("[Turn cancelled — you can send again.]");
            if (ConsoleServiceSessionText is not null)
                ConsoleServiceSessionText.Text = "Turn cancelled";
        }
        catch (Exception ex)
        {
            AppendConsoleLine(
                $"[Agent failed to start] {ex.Message}\n"
                + "Need Node.js on PATH and Helmion repo with bin/helmion.mjs "
                + "(expected under E:\\Helmion).");

            // Red, not yellow: this session could not run at all, and the dot has to
            // say that rather than the softer "a turn reported an error".
            if (session is not null)
            {
                ReportSessionTurn(
                    session,
                    GuardLevel.Critical,
                    $"\"{session.Name}\" could not start its agent",
                    $"Starting the Node bridge for this session threw: {ex.Message}. "
                    + "Nothing ran. Needs Node.js on PATH and bin/helmion.mjs.");
            }

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
            if (session is not null) session.IsBusy = false;
            else _sharedBridgeBusy = false;
            if (ReferenceEquals(_turnSession, session))
                _turnSession = null;
            if (ReferenceEquals(_asyncTurnSession.Value, session))
                _asyncTurnSession.Value = null;
            if (_activeTurnCts.TryRemove(turnKey, out var doneCts))
            {
                try { doneCts.Dispose(); } catch { /* ignore */ }
            }
            _lastBusyMessage = null;
            // Only clear the global approval strip if this turn owned it.
            // Concurrent non-Ask turns leave another session's approval alone.
            CancelPendingApproval();
        }
    }

    private void ReportBusyGate(AgentSession? busySession)
    {
        var busy = SessionTurnRouting.BusyMessage(busySession)
            + " Other sessions can still run. Esc cancels THIS session's turn.";
        var now = DateTimeOffset.UtcNow;
        // Longer debounce — rapid retries used to flood the transcript with the same Busy line.
        if (!string.Equals(busy, _lastBusyMessage, StringComparison.Ordinal)
            || (now - _lastBusyMessageAt) > TimeSpan.FromSeconds(12))
        {
            AppendConsoleLine(busy);
            _lastBusyMessage = busy;
            _lastBusyMessageAt = now;
        }
        if (ConsoleServiceSessionText is not null)
            ConsoleServiceSessionText.Text = "Busy · Esc cancels · Esc×2 clears all · other agents free";
    }

    /// <summary>
    /// Abort the selected session's mid-turn (or shared console). Other agents keep running
    /// unless their token is cancelled. Always clears stuck IsBusy flags that have no live CTS
    /// so a dead mid-turn cannot trap the console (Esc spam).
    /// </summary>
    private void CancelActiveAgentTurn()
    {
        var key = _sessions.Selected?.Id ?? "__shared__";
        if (_activeTurnCts.TryGetValue(key, out var cts))
        {
            try { cts.Cancel(); } catch { /* ignore */ }
        }
        else
        {
            // No live token for selection — cancel everything and clear all busy flags.
            foreach (var pair in _activeTurnCts)
            {
                try { pair.Value.Cancel(); } catch { /* ignore */ }
            }
        }

        if (_sessions.Selected is not null)
            _sessions.Selected.IsBusy = false;
        else
            _sharedBridgeBusy = false;

        // Stuck busy without a cancellation token (bridge hung / crashed mid-turn).
        foreach (var session in _sessions.Sessions)
        {
            if (session.IsBusy && !_activeTurnCts.ContainsKey(session.Id))
                session.IsBusy = false;
        }

        // Second Esc within 2s while anything still busy → hard clear every session.
        var now = DateTimeOffset.UtcNow;
        if ((now - _lastCancelAllAt).TotalSeconds < 2)
        {
            foreach (var pair in _activeTurnCts)
            {
                try { pair.Value.Cancel(); } catch { /* ignore */ }
            }
            foreach (var session in _sessions.Sessions)
                session.IsBusy = false;
            _sharedBridgeBusy = false;
            AppendConsoleLine("[All agent turns cancelled (Esc×2).]");
        }

        _lastCancelAllAt = now;
        CancelPendingApproval();
        _lastBusyMessage = null;
        if (ConsoleServiceSessionText is not null)
            ConsoleServiceSessionText.Text = "Turn cancelled · ready";
    }

    private DateTimeOffset _lastCancelAllAt = DateTimeOffset.MinValue;

    private static string Truncate(string? value, int max)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value.Length <= max ? value : value[..max] + "…";
    }

    /// <summary>
    /// Render the router's choice for one round: the transcript keeps all of
    /// them with the reason.
    ///
    /// This is an INTENTION, not a result — src/agent/loop.mjs emits the `model`
    /// event before the request goes out. It no longer writes the header label,
    /// because on 2026-07-30 that header was the only thing on screen and it
    /// showed a model that did not answer. <see cref="ShowAnsweringModel"/> owns
    /// the header now.
    /// </summary>
    private void ShowChosenModel(AgentBridgeEvent ev)
    {
        var model = ev.Model;
        if (string.IsNullOrWhiteSpace(model)) return;
        if (ConsoleModelLabel is not null)
        {
            ConsoleModelLabel.ToolTip = $"Planned route: {ev.Tier ?? "auto"} · {model}"
                + (string.IsNullOrWhiteSpace(ev.Reason) ? "" : $" — {ev.Reason}");
        }
    }

    /// <summary>
    /// Put the model that ACTUALLY answered into the console header.
    ///
    /// Driven by the `provenance` event, which the bridge emits only after a
    /// response has arrived and after the row has been written to
    /// <c>.helmion\audit\provenance-YYYY-MM-DD.jsonl</c>. So this label and the
    /// durable ledger cannot disagree — the header is a view of the evidence,
    /// not a second opinion about it.
    ///
    /// A LOCAL answer says so, loudly and first. Troy asked "who am I talking
    /// to" after a 4B model on this machine replied in Helmion's voice with
    /// nothing on screen to say so; a marker he has to hunt for would not have
    /// answered him any faster than no marker at all.
    /// </summary>
    private void ShowAnsweringModel(AgentBridgeEvent ev)
    {
        // EVERY DECISION LIVES IN Core, and nothing is duplicated here. This
        // method paints and does nothing else.
        //
        // The reason is not tidiness. The SmokeTests console project references
        // Helmion.Desktop.Core but NOT this WPF project, and nothing may appear
        // on Troy's screen — so any rule written inline here can only ever be
        // shown to COMPILE, never to be correct. That is precisely how the
        // header came to assert something the code did not know. A second copy
        // of the rule sitting here would be the untested one, and it is the copy
        // that paints his screen.
        var rendering = ModelProvenanceLabel.ForAnswer(ev);
        if (rendering is null) return;

        if (ConsoleModelLabel is not null)
        {
            ConsoleModelLabel.Text = rendering.HeaderText;
            ConsoleModelLabel.ToolTip = rendering.ToolTip;
        }

        // The transcript is deliberately conversational. Provenance remains in
        // this compact inspector label and the durable audit ledger.
    }

    /// <summary>
    /// Slash commands available in this workspace. Refreshed whenever the list is
    /// shown, and used to tell the user when a "/" line is not a command at all
    /// rather than letting it go to the model unremarked.
    /// </summary>
    private readonly HashSet<string> _knownCommands = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Command name -> the one-line description the picker shows beside it.
    /// Populated from the same bridge payload as <see cref="_knownCommands"/>, so
    /// the picker can never show a command the bridge did not report.
    /// </summary>
    private readonly Dictionary<string, string> _knownCommandDetails = new(StringComparer.OrdinalIgnoreCase);

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

            // Scanned at the REGISTERED workspace. Left to itself the bridge
            // answers about the folder it started in — the Helmion repo root —
            // so this button used to list a different project's commands than
            // the one the next turn would run in.
            var ev = await _agentBridge.ListCommandsAsync(ResolveAgentWorkspace());
            _commandsListed = true;

            if (ev.Event != "commands")
            {
                if (!quiet) AppendConsoleLine($"[Commands unavailable] {ev.Message ?? "no answer"}");
                return;
            }

            _knownCommands.Clear();
            _knownCommandDetails.Clear();
            foreach (var cmd in ev.Commands ?? [])
            {
                _knownCommands.Add(cmd.Name);

                // The picker shows the description beside the name, so it is kept
                // here rather than only printed to the transcript. The argument hint
                // rides along because "/ship [what changed]" tells you how to use it
                // and "/ship" does not.
                var hint = string.IsNullOrWhiteSpace(cmd.ArgumentHint) ? string.Empty : $"{cmd.ArgumentHint}  ";
                _knownCommandDetails[cmd.Name] = (hint + (cmd.Description ?? string.Empty)).Trim();
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
                "\n[MCP security · read-only] Discover searches; Browse selects a local folder; "
                + "Audit reads source. This interface cannot approve or install anything.");
        }
    }

    private string? _lastMcpAuditRawJson;

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
            () => McpSecurityRunner.AuditAsync(McpAuditPathInput.Text),
            result =>
            {
                if (!string.IsNullOrWhiteSpace(result.RawJson))
                {
                    _lastMcpAuditRawJson = result.RawJson;
                }
            });
    }

    private void McpAuditSearchButton_Click(object sender, RoutedEventArgs e)
    {
        AppendConsoleLine(McpSecurityRunner.SearchAuditFindings(
            _lastMcpAuditRawJson,
            McpAuditSearchInput.Text));
    }

    private async Task RunMcpStageAsync(
        string stage,
        Button button,
        Func<Task<McpSecurityResult>> run,
        Action<McpSecurityResult>? completed = null)
    {
        button.IsEnabled = false;
        AppendConsoleLine($"\n[MCP read-only · {stage}] running…");
        try
        {
            var result = await run();
            completed?.Invoke(result);
            AppendConsoleLine(result.Summary);
            if (!string.IsNullOrWhiteSpace(result.Stderr))
            {
                AppendConsoleLine($"  stderr: {Truncate(result.Stderr, 400)}");
            }
        }
        catch (Exception ex)
        {
            AppendConsoleLine($"[MCP read-only · {stage} failed] {ex.Message}");
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

    private async void ConsoleDictateButton_Click(object sender, RoutedEventArgs e)
    {
        var enabling = !_dictateMode;
        SetDictateMode(enabling);

        // Dictate is an input mode, not a second prerequisite.  Requiring the
        // operator to discover and click Voice chat after enabling Dictate left
        // the composer visibly ready but with no microphone running.  Start the
        // same live voice session here; SetDictateMode makes it input-only, so
        // recognized speech is inserted into the composer instead of sent.
        if (enabling && _voiceSession is not { IsVoiceModeActive: true })
        {
            await StartConsoleVoiceAsync();
        }
    }

    private void SetDictateMode(bool on)
    {
        _dictateMode = on;
        ConsoleDictateButton.IsChecked = on;

        if (on)
        {
            ConsoleInputBox.Focus();
            ConsoleServiceSessionText.Text = _voiceSession is { IsVoiceModeActive: true }
                ? "Dictate on · microphone input only · spoken replies off"
                : "Dictate ready · start Voice chat to turn on the microphone";

            if (_voiceSession is not { IsVoiceModeActive: true })
            {
                ConsoleMicButton.ToolTip = "Voice mic · Dictate on (type only, no TTS)";
            }
        }
        else
        {
            ConsoleServiceSessionText.Text = _voiceSession is { IsVoiceModeActive: true }
                ? "Voice mode on — listening (two-way)"
                : "Voice mode off";
            ConsoleMicButton.ToolTip = _voiceSession is { IsVoiceModeActive: true }
                ? "Stop Voice chat"
                : "Voice chat: microphone input goes to the selected agent and Helmian speaks the reply. Click again to stop.";
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
                // Status only — transcript walls of [Voice warning] feel broken.
                if (ConsoleServiceSessionText is not null)
                    ConsoleServiceSessionText.Text = "Voice · " + (msg.Length > 100 ? msg[..100] + "…" : msg);
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
        var degraded = status.State == VoiceState.Degraded;
        var label = status.Backend switch
        {
            VoiceBackend.None when !degraded => "voice: off",
            _ => $"voice: {status.Display}",
        };
        var tip = string.IsNullOrWhiteSpace(status.Detail)
            ? status.Display
            : $"{status.Display} — {status.Detail}";
        var brush = degraded
            ? (Brush)FindResource("AmberBrush")
            : (Brush)FindResource("MutedTextBrush");

        // Status strip (transcript header) + pill beside Voice/Dictate (S7 always visible).
        if (ConsoleVoiceBackendLabel is not null)
        {
            ConsoleVoiceBackendLabel.Text = label;
            ConsoleVoiceBackendLabel.Foreground = brush;
            ConsoleVoiceBackendLabel.ToolTip = tip;
            ConsoleVoiceBackendLabel.Visibility = Visibility.Visible;
        }

        if (ConsoleVoicePill is not null)
        {
            ConsoleVoicePill.Text = label;
            ConsoleVoicePill.Foreground = brush;
            ConsoleVoicePill.ToolTip = tip;
            ConsoleVoicePill.Visibility = Visibility.Visible;
        }
    }

    private async void ConsoleMicButton_Click(object sender, RoutedEventArgs e)
    {
        if (_voiceSelector is null) return;

        if (_voiceSession is { IsVoiceModeActive: true })
        {
            ConsoleMicButton.IsEnabled = false;
            try
            {
                await _voiceSelector.StopAsync();
                // The selector owns and disposes the session it built.
                _voiceSession = null;
                if (_dictateMode) SetDictateMode(false);
                ConsoleMicButton.IsChecked = false;
                ConsoleMicButton.ToolTip = "Voice: hear you + speak agent replies";
                ConsoleServiceSessionText.Text = "Voice mode off";
            }
            finally
            {
                ConsoleMicButton.IsEnabled = true;
            }

            return;
        }

        await StartConsoleVoiceAsync();
    }

    /// <summary>Start the one live microphone session used by both Voice chat and Dictate.</summary>
    private async Task StartConsoleVoiceAsync()
    {
        if (_voiceSelector is null || _voiceSession is { IsVoiceModeActive: true })
        {
            return;
        }

        ConsoleMicButton.IsEnabled = false;
        try
        {
            var backend = await _voiceSelector.StartAsync();
            if (backend == VoiceBackend.None || _voiceSession is not { IsVoiceModeActive: true })
            {
                ConsoleMicButton.IsChecked = false;
                if (ConsoleServiceSessionText is not null)
                {
                    var detail = _voiceSelector?.Status.Detail;
                    ConsoleServiceSessionText.Text = string.IsNullOrWhiteSpace(detail)
                        ? "Voice · could not start (check mic privacy + models beside Helmian.exe)"
                        : "Voice · " + (detail.Length > 100 ? detail[..100] + "…" : detail);
                }
                return;
            }

            ConsoleMicButton.IsChecked = true;
            ConsoleMicButton.ToolTip = _dictateMode
                ? "Stop the microphone. Dictate is on, so speech is typed and replies are not spoken."
                : "Stop Voice chat";
            var backendLabel = backend == VoiceBackend.WhisperKokoro ? "Whisper+Kokoro" : backend.ToString();
            ConsoleServiceSessionText.Text = _dictateMode
                ? $"Dictate on · {backendLabel} · type only"
                : $"Voice chat on · {backendLabel} · listening";
        }
        catch (Exception ex)
        {
            // Audio never takes the window down with it.
            AppendConsoleLine($"[Voice] {ex.Message}");
        }
        finally
        {
            ConsoleMicButton.IsEnabled = true;
            if (_voiceSession is not { IsVoiceModeActive: true })
            {
                ConsoleMicButton.IsChecked = false;
            }
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

        if (_voiceTurnBusy) return;
        var voiceTarget = _sessions.Selected;
        if (voiceTarget is { IsBusy: true } || (voiceTarget is null && _sharedBridgeBusy))
        {
            if (ConsoleServiceSessionText is not null)
            {
                ConsoleServiceSessionText.Text =
                    $"Voice held · \"{voiceTarget?.Name ?? "console"}\" mid-turn · Esc or pick another agent";
            }
            return;
        }

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

    private void UpdateConsoleWorkspaceLabel(
        string? workspace = null,
        bool agentConfirmed = false)
    {
        try
        {
            var selectedPath = agentConfirmed
                ? ResolveAgentWorkspace()
                : workspace ?? ResolveAgentWorkspace();
            if (agentConfirmed && !string.IsNullOrWhiteSpace(workspace))
            {
                _agentConfirmedWorkspacePath = Path.GetFullPath(workspace);
            }

            var display = AgentWorkspaceScopeIndicator.Describe(
                selectedPath,
                _agentConfirmedWorkspacePath);
            if (ConsoleWorkspaceLabel is not null)
            {
                ConsoleWorkspaceLabel.Text = display.Text;
                ConsoleWorkspaceLabel.ToolTip = display.ToolTip;
            }

            // Claude Code footer: "workspace (/directory)" under the > prompt.
            if (ClaudeWorkspacePathLabel is not null)
            {
                var path = selectedPath;
                var shortPath = path.Length > 64 ? "…" + path[^60..] : path;
                ClaudeWorkspacePathLabel.Text = string.IsNullOrWhiteSpace(path)
                    ? "workspace (~)"
                    : $"workspace ({shortPath})";
                ClaudeWorkspacePathLabel.ToolTip = display.ToolTip;
            }
        }
        catch
        {
            // ignore UI races
        }
    }

    /// <summary>
    /// Show/hide the Claude-style ghost placeholder when the composer is empty.
    /// </summary>
    private void UpdateConsoleInputPlaceholderVisibility()
    {
        if (ConsoleInputPlaceholder is null || ConsoleInputBox is null)
            return;
        ConsoleInputPlaceholder.Visibility = string.IsNullOrEmpty(ConsoleInputBox.Text)
            ? Visibility.Visible
            : Visibility.Collapsed;
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

using System.Collections.Specialized;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

/// <summary>
/// THE GUARD FEED PANEL — Troy's escalating side panel, wired.
///
/// WHAT IT IS. A persistent third column, visible on every page, that surfaces
/// flags from the detection layers Helmion already has, in one running list with
/// timestamps, provider/site tabs and footer actions. Grey → yellow solid → yellow
/// pulsing → red pulsing, with the threshold between them stated on the panel's own
/// face (<see cref="GuardEscalationRule.StatedRule"/>).
///
/// WHAT IT IS NOT. It detects nothing of its own. Its cards come from:
///   · the block ledger — <c>&lt;workspace&gt;\.helmion\audit\blocks-*.jsonl</c>,
///     written by src/core/audit-log.mjs from BOTH layers Troy named: the browser
///     pattern match (extension/background/scan.js:156) and the execution guard
///     (src/core/governance-gate.mjs:226);
///   · the real write lease — src/core/lease.mjs, read by LeaseInspector.cs;
///   · this window's own permission gate — ToolDispatcher's IsExecutionEnabled;
///   · the local named-pipe service connection state.
///
/// AND WHERE IT CANNOT KNOW, IT SAYS SO. The browser extension and the Node
/// governance gate run in other processes with no channel into this window, so their
/// LIVE status is reported as UNKNOWN, in grey, with the word on the card, forever —
/// until somebody builds that channel. A safety panel that renders "unmonitored" the
/// same as "clean" is worse than no panel.
/// </summary>
public partial class MainWindow
{
    private readonly GuardFeed _guardFeed = new();
    private DispatcherTimer? _guardClock;
    private bool _guardPanelReady;
    private bool _guardSettingsOpen;

    // Routing tag for cards whose options the host actually acts on. A card without
    // one renders a visible warning that its buttons do nothing (GuardCard.OptionsAreInert).
    private const string ApprovalActionKind = "console-approval";
    private const string ApprovalProvider = "Console";
    private const string ApprovalSource = "Ask-mode approval";
    private const string PermissionSource = "Desktop permission gate";
    private const string BrowserLayerSource = "Browser pattern match";
    private const string ExecutionLayerSource = "Execution guard";
    private const string ServiceSource = "Local service";
    private const string LeaseSource = "Write lease";

    private string? _approvalCardSignature;

    /// <summary>
    /// Build the panel. Called immediately after InitializeComponent so the named
    /// elements exist, and before the first UpdateSnapshot so the derived labels have
    /// a feed to read.
    /// </summary>
    private void InitializeGuardPanel()
    {
        GuardCardList.ItemsSource = _guardFeed.Visible;
        GuardTabStrip.ItemsSource = _guardFeed.Tabs;
        GuardRuleText.Text = GuardEscalationRule.StatedRule;

        // REDUCED MOTION. SystemParameters.ClientAreaAnimation is WPF's surface for
        // the Win32 SPI_GETCLIENTAREAANIMATION setting — Windows' "Show animations in
        // Windows" / reduced-motion switch. Verified present in
        // C:\Program Files\dotnet\packs\Microsoft.WindowsDesktop.App.Ref\10.0.10\ref\
        // net10.0\PresentationFramework.dll (System.Windows.SystemParameters), along
        // with StaticPropertyChanged, which is how a live change reaches us.
        //
        // When it is off, nothing animates. The level word, the icon and the reason
        // string still say the card is escalating, so the escalation survives with the
        // motion switched off — that is the whole point of carrying it in four channels.
        ApplyMotionPolicy(SystemParameters.ClientAreaAnimation);
        SystemParameters.StaticPropertyChanged += OnSystemParametersChanged;
        Closed += (_, _) =>
        {
            SystemParameters.StaticPropertyChanged -= OnSystemParametersChanged;
            _guardClock?.Stop();
        };

        _guardFeed.Visible.CollectionChanged += OnGuardVisibleChanged;

        // THE CLOCK. Age alone escalates a card (2 minutes to pulse, 5 to red), so
        // something has to re-run the rule. This ticks the in-memory state machine
        // ONLY — it performs no I/O, opens no connection, re-reads no file and starts
        // no process. Re-reading the ledger happens on demand, when a workspace is
        // inspected or refreshed.
        _guardClock = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromSeconds(10)
        };
        _guardClock.Tick += (_, _) =>
        {
            if (_guardFeed.Tick(DateTimeOffset.Now) > 0)
            {
                RefreshGuardChrome();
            }
        };
        _guardClock.Start();

        _guardPanelReady = true;
        PublishStaticPostureCards();
        RefreshGuardChrome();
    }

    private void OnSystemParametersChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(SystemParameters.ClientAreaAnimation))
        {
            return;
        }

        Dispatcher.BeginInvoke(() => ApplyMotionPolicy(SystemParameters.ClientAreaAnimation));
    }

    private void ApplyMotionPolicy(bool animationsAllowed)
    {
        _guardFeed.AnimationsEnabled = animationsAllowed;
        if (GuardMotionCheckBox is not null)
        {
            GuardMotionCheckBox.IsChecked = animationsAllowed;
        }

        if (GuardMotionPolicyText is not null)
        {
            GuardMotionPolicyText.Text = _guardFeed.MotionPolicyText
                + (animationsAllowed
                    ? " · Windows reduced motion is OFF (SystemParameters.ClientAreaAnimation = true)."
                    : " · Windows reduced motion is ON (SystemParameters.ClientAreaAnimation = false); Helmion follows it.");
        }

        RefreshGuardChrome();
    }

    private void OnGuardVisibleChanged(object? sender, NotifyCollectionChangedEventArgs e) =>
        RefreshGuardChrome();

    /// <summary>
    /// The cards that describe the panel's own coverage. Two of them are permanently
    /// UNKNOWN, and that is the honest answer rather than a gap.
    /// </summary>
    private void PublishStaticPostureCards()
    {
        var now = DateTimeOffset.Now;

        // Both of these used to be hardcoded Unknown, and the reasons given were
        // true: neither layer runs in this window. Reporting Unknown was correct
        // and is NOT being softened — what changed is that both are now actually
        // computed, so Unknown is reserved for the case where the check itself
        // could not run.
        PublishBrowserLayerCard(now);
        _ = PublishExecutionGuardCardAsync();

        PublishPermissionPostureCard();
        PublishServicePostureCard();
    }

    /// <summary>
    /// Reads Chrome's own profile record for the extension. Installed and enabled
    /// is a fact; "watching this tab right now" is not knowable from here and the
    /// card does not claim it.
    /// </summary>
    private void PublishBrowserLayerCard(DateTimeOffset now)
    {
        if (!_guardPanelReady) return;

        BrowserExtensionState state;
        try
        {
            var extensionDir = Path.Combine(HelmionRootPath(), "extension");
            state = BrowserExtensionProbe.Inspect(extensionDir);
        }
        catch (Exception ex)
        {
            state = new BrowserExtensionState(
                GuardLevel.Unknown,
                "Browser layer could not be checked",
                $"Reading the browser profile threw: {ex.Message}. Could not compute — not an all-clear.",
                false, false, null);
        }

        _guardFeed.Report(
            new GuardObservation("Browser", BrowserLayerSource, "browser-layer-live-status",
                state.Title, state.Detail, state.Level),
            now);
        RefreshGuardChrome();
    }

    /// <summary>
    /// Asks the execution guard to refuse something, and watches whether it does.
    ///
    /// Async and fire-and-forget: it spawns node twice and takes a moment, and a
    /// status panel must not freeze the window to find out it is healthy. The
    /// card is published when the answer arrives.
    /// </summary>
    private async Task PublishExecutionGuardCardAsync()
    {
        if (!_guardPanelReady) return;

        GuardProbeResult probe;
        try
        {
            probe = await ExecutionGuardProbe.RunAsync(HelmionRootPath());
        }
        catch (Exception ex)
        {
            probe = new GuardProbeResult(
                GuardLevel.Unknown,
                "Execution guard could not be probed",
                $"The probe threw: {ex.Message}. Could not compute — not an all-clear.",
                false, false, TimeSpan.Zero);
        }

        Dispatcher.Invoke(() =>
        {
            if (!_guardPanelReady) return;
            _guardFeed.Report(
                new GuardObservation("Local", ExecutionLayerSource, "execution-layer-live-status",
                    probe.Title, probe.Detail, probe.Level),
                DateTimeOffset.Now);
            RefreshGuardChrome();
        });
    }

    /// <summary>
    /// This window's own execution posture, which it genuinely does know: the
    /// permission mode ToolDispatcher enforces. Full permissions is the loudest real
    /// thing the desktop can tell you about itself, so it is red.
    /// </summary>
    private void PublishPermissionPostureCard()
    {
        if (!_guardPanelReady)
        {
            return;
        }

        // The mapping lives in Helmion.Desktop.Core.GuardPermissionPosture as a
        // pure function so the smoke suite can prove it. It used to be the switch
        // that sat here, untested, rendering the safest setting yellow and a
        // setting the user deliberately picked from a dropdown critical red.
        var mode = CurrentPermissionMode;
        var card = GuardPermissionPosture.Describe(mode);

        _guardFeed.Report(
            new GuardObservation(
                "Console",
                PermissionSource,
                GuardPermissionPosture.Signature,
                card.Title,
                $"{card.Detail} · mode: {mode}",
                card.Level),
            DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    private void PublishServicePostureCard()
    {
        if (!_guardPanelReady)
        {
            return;
        }

        _guardFeed.Report(
            new GuardObservation(
                "Local",
                ServiceSource,
                "local-service-state",
                _serviceConnected ? "Local service connected" : "Local service not connected",
                _serviceConnected
                    ? "The current-user authenticated named pipe answered. This says nothing about "
                      + "the database or any provider credential."
                    : "The read-only named-pipe service is not answering. Workspace inspection falls "
                      + "back to a direct local inventory in this process.",
                _serviceConnected ? GuardLevel.Normal : GuardLevel.Warning),
            DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    /// <summary>
    /// Re-read everything on disk that feeds the panel for the registered workspace:
    /// the block ledger and the write lease. On demand only — called when a workspace
    /// is inspected or refreshed, never on a timer.
    /// </summary>
    private void RefreshGuardFeedFromDisk(WorkspaceInspection? inspection)
    {
        if (!_guardPanelReady)
        {
            return;
        }

        var now = DateTimeOffset.Now;

        if (inspection is null)
        {
            _guardFeed.Report(
                new GuardObservation(
                    "Local",
                    LeaseSource,
                    "write-lease-posture",
                    "Write lease unknown",
                    "No workspace is registered, so there is no lease file to read.",
                    GuardLevel.Unknown),
                now);
            _guardFeed.Report(
                new GuardObservation(
                    "Local",
                    "Block ledger",
                    "ledger-health",
                    "Block ledger not read",
                    "No workspace is registered, so no ledger path exists to read. This is not "
                    + "evidence that nothing was blocked.",
                    GuardLevel.Unknown),
                now);
            RefreshGuardChrome();
            return;
        }

        // 1. The real lease, straight off disk. UNREADABLE is its own level.
        var lease = inspection.Lease;
        _guardFeed.Report(
            new GuardObservation(
                "Local",
                LeaseSource,
                "write-lease-posture",
                lease.Label,
                lease.Detail,
                lease.Status switch
                {
                    LeaseInspector.StatusUnreadable => GuardLevel.Critical,
                    LeaseInspector.StatusStale => GuardLevel.Warning,
                    LeaseInspector.StatusActive => GuardLevel.Normal,
                    LeaseInspector.StatusNone => GuardLevel.Normal,
                    _ => GuardLevel.Unknown
                }),
            now);

        // 2. The block ledger: both detection layers' recorded blocks, plus the
        //    ledger's own health.
        GuardAuditRead read;
        try
        {
            // Start the ledger if it has never been started. Without this the
            // card can only say "not created yet" — which cannot distinguish
            // "nothing was blocked" from "nobody was recording", and that
            // ambiguity is precisely why it reported Unknown. Creating it makes
            // an empty ledger mean something: recording since this moment.
            GuardAuditLog.EnsureLedger(inspection.ProjectPath);
            read = GuardAuditLog.Read(inspection.ProjectPath);
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            _guardFeed.Report(
                new GuardObservation(
                    "Local",
                    "Block ledger",
                    "ledger-health",
                    "Block ledger could not be read",
                    error.Message,
                    GuardLevel.Critical),
                now);
            RefreshGuardChrome();
            return;
        }

        _guardFeed.Report(GuardAuditLog.LedgerHealth(read), now);

        // Replayed oldest-first so the occurrence counts — and therefore the
        // escalation — come out in the order the blocks actually happened.
        foreach (var observation in GuardAuditLog.ToObservations(read))
        {
            _guardFeed.Report(observation, now);
        }

        RefreshGuardChrome();
    }

    /// <summary>Update everything on the panel that is not an individual card.</summary>
    private void RefreshGuardChrome()
    {
        if (!_guardPanelReady)
        {
            return;
        }

        GuardHeadlineLevelText.Text = _guardFeed.WorstLevelText;
        GuardHeadlineIconText.Text = _guardFeed.WorstLevel switch
        {
            GuardLevel.Critical => "✖",
            GuardLevel.Warning => "!",
            GuardLevel.Normal => "✓",
            _ => "?"
        };

        var (fill, ink) = BrushesForLevel(_guardFeed.WorstLevel);
        GuardHeadlineChip.Background = fill;
        GuardHeadlineIconText.Foreground = ink;
        GuardHeadlineLevelText.Foreground = ink;

        // The headline pulses under the same rule as a card: red always, yellow only
        // once a threshold has been crossed by at least one card.
        var headlineShouldPulse = _guardFeed.WorstLevel == GuardLevel.Critical
            || _guardFeed.Visible.Any(card => card.ShouldPulse);
        SetHeadlinePulse(headlineShouldPulse && _guardFeed.AnimationsEnabled);

        GuardHeadlineCountsText.Text = _guardFeed.TotalCards == 0
            ? "No events"
            : $"{_guardFeed.CriticalCount} critical · {_guardFeed.WarningCount} warning · "
              + $"{_guardFeed.UnknownCount} unknown · {_guardFeed.TotalCards} total";

        GuardSourceText.Text = _guardFeed.SourceText;
        GuardRetentionText.Text = _guardFeed.RetentionText;

        var empty = _guardFeed.Visible.Count == 0;
        GuardEmptyPanel.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        GuardEmptyDetailText.Text = _guardFeed.TotalCards == 0
            ? _guardFeed.SourceText
            : $"Nothing matches the \"{_guardFeed.ActiveTab}\" tab. "
              + $"{_guardFeed.TotalCards} event(s) are held under other tabs.";

        if (_guardSettingsOpen)
        {
            GuardSettingsText.Text = BuildGuardSettingsText();
        }

        ApplyDerivedGuardrailLabel();
    }

    private void SetHeadlinePulse(bool pulse)
    {
        if (GuardHeadlinePulse is null)
        {
            return;
        }

        if (pulse)
        {
            GuardHeadlinePulse.BeginAnimation(
                UIElement.OpacityProperty,
                new DoubleAnimation(1.0, 0.45, new Duration(TimeSpan.FromSeconds(0.55)))
                {
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever,
                    FillBehavior = FillBehavior.Stop
                });
            return;
        }

        GuardHeadlinePulse.BeginAnimation(UIElement.OpacityProperty, null);
        GuardHeadlinePulse.Opacity = 1.0;
    }

    private (Brush Fill, Brush Ink) BrushesForLevel(GuardLevel level) => level switch
    {
        GuardLevel.Critical => (
            (Brush)FindResource("GuardCriticalBrush"),
            (Brush)FindResource("GuardCriticalInkBrush")),
        GuardLevel.Warning => (
            (Brush)FindResource("GuardWarningBrush"),
            (Brush)FindResource("GuardWarningInkBrush")),
        GuardLevel.Normal => (
            (Brush)FindResource("GuardNormalBrush"),
            (Brush)FindResource("GuardNormalInkBrush")),
        _ => (
            (Brush)FindResource("GuardUnknownBrush"),
            (Brush)FindResource("GuardUnknownInkBrush"))
    };

    // ---------------------------------------------------------------- interactions

    private void GuardTab_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string name })
        {
            _guardFeed.ActiveTab = name;
            RefreshGuardChrome();
        }
    }

    private void GuardAcknowledge_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: GuardCard card })
        {
            _guardFeed.Acknowledge(card, DateTimeOffset.Now);
            RefreshGuardChrome();
        }
    }

    /// <summary>
    /// An inline option click. The letter is presentation; <see cref="GuardOption.ActionId"/>
    /// is what actually happens. Only cards carrying a routing tag this method
    /// recognises do anything — and a card without one already says on its face that
    /// its buttons do nothing, rather than pretending.
    /// </summary>
    private void GuardOption_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button
            || button.Tag is not GuardOption option
            || button.CommandParameter is not GuardCard card)
        {
            return;
        }

        if (string.Equals(card.ActionKind, ApprovalActionKind, StringComparison.Ordinal))
        {
            // The real consumer: the existing ask-mode approval mechanism. Clicking
            // here answers the agent's question without leaving the console page.
            var decision = AgentApprovalDecision.Normalize(option.ActionId);
            AppendConsoleLine($"  [guard panel → {decision}] {option.Label}");
            CompleteApproval(decision);
            return;
        }

        // Nothing is registered to act on this card's options. Record the choice on
        // the card so the click is not silently swallowed, and say plainly that no
        // action followed.
        _guardFeed.Report(
            new GuardObservation(
                card.Provider,
                card.Source,
                card.Signature,
                card.Title,
                $"{card.Detail} · you chose {option.Key} ({option.Label}); no handler is "
                + "registered for this card, so nothing was executed.",
                card.ReportedLevel,
                card.Options,
                card.ActionKind),
            DateTimeOffset.Now);
        _guardFeed.Acknowledge(card, DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    private void GuardMotionToggle_Click(object sender, RoutedEventArgs e)
    {
        var allow = GuardMotionCheckBox.IsChecked == true;
        _guardFeed.AnimationsEnabled = allow;
        GuardMotionPolicyText.Text = _guardFeed.MotionPolicyText
            + (SystemParameters.ClientAreaAnimation
                ? " · Windows reduced motion is OFF; this checkbox overrides it for Helmion only."
                : " · Windows reduced motion is ON; turning this back on overrides the OS setting for Helmion only.");
        RefreshGuardChrome();
    }

    // ------------------------------------------------------------- footer actions

    /// <summary>
    /// Reads the real ledger — <c>&lt;workspace&gt;\.helmion\audit\blocks-*.jsonl</c>,
    /// the file src/core/audit-log.mjs actually writes. Reports the path, the file
    /// count, the byte total and the newest entries inline. Starts no process: the
    /// panel prints what it read rather than handing the file to another program.
    /// </summary>
    private void GuardViewQuarantineLog_Click(object sender, RoutedEventArgs e)
    {
        var workspace = _registeredWorkspacePath ?? _currentWorkspaceInspection?.ProjectPath;
        if (string.IsNullOrWhiteSpace(workspace))
        {
            ShowGuardFooterOutput(
                "No workspace is registered, so there is no quarantine log path to read. "
                + "Register a project on the Workspace page first.");
            return;
        }

        var read = GuardAuditLog.Read(workspace, maxEntries: 8);
        var lines = new List<string> { $"Quarantine log · {read.Directory}" };

        if (read.DirectoryError is not null)
        {
            lines.Add($"UNREADABLE — {read.DirectoryError}");
        }
        else if (!read.DirectoryExists)
        {
            lines.Add(
                "The directory does not exist. Nothing has been blocked on this workspace since "
                + "the ledger was added — this is not evidence that nothing was blocked before it.");
        }
        else
        {
            var bytes = 0L;
            foreach (var file in read.Files)
            {
                try { bytes += new FileInfo(file).Length; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }

            lines.Add($"{read.Files.Count} file(s), {bytes:N0} bytes, {read.Entries.Count} entry(ies) read.");
            if (read.Malformed > 0)
            {
                lines.Add($"{read.Malformed} unparseable line(s) — counted, not skipped.");
            }

            foreach (var name in read.UnreadableFiles)
            {
                lines.Add($"UNREADABLE FILE — {name}");
            }

            foreach (var entry in read.Entries)
            {
                lines.Add(
                    $"· {entry.Timestamp?.ToString("yyyy-MM-dd HH:mm:ss") ?? "no timestamp"} "
                    + $"[{GuardAuditLog.LayerLabel(entry.Layer)}] {entry.MatchedPattern} → {entry.Outcome}");
            }

            if (read.Entries.Count == 0)
            {
                lines.Add("No entries. The ledger exists and holds nothing.");
            }
        }

        ShowGuardFooterOutput(string.Join(Environment.NewLine, lines));
        RefreshGuardFeedFromDisk(_currentWorkspaceInspection);
    }

    /// <summary>
    /// Names the real suite command and does not run it. This panel starts no
    /// processes — a button that spawned a console window would be a surprise, and a
    /// button that claimed to have run tests it did not run would be a lie. The
    /// command is read out of the workspace's own package.json rather than hardcoded,
    /// so it cannot drift from what the repo actually defines.
    /// </summary>
    private void GuardRunTestSuite_Click(object sender, RoutedEventArgs e)
    {
        var workspace = _registeredWorkspacePath ?? _currentWorkspaceInspection?.ProjectPath;
        var lines = new List<string>
        {
            "This panel does not start processes, so nothing was run."
        };

        if (string.IsNullOrWhiteSpace(workspace))
        {
            lines.Add("No workspace is registered, so the suite command could not be read from a package.json.");
            ShowGuardFooterOutput(string.Join(Environment.NewLine, lines));
            return;
        }

        var packagePath = Path.Combine(workspace, "package.json");
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(packagePath));
            if (document.RootElement.TryGetProperty("scripts", out var scripts)
                && scripts.ValueKind == JsonValueKind.Object)
            {
                var found = 0;
                foreach (var name in new[] { "desktop:test", "desktop:build", "desktop:verify", "test" })
                {
                    if (scripts.TryGetProperty(name, out var script))
                    {
                        lines.Add($"npm run {name}  →  {script.GetString()}");
                        found++;
                    }
                }

                if (found == 0)
                {
                    lines.Add($"{packagePath} defines no desktop test script.");
                }

                lines.Add("Run one of these in a terminal you control.");
            }
            else
            {
                lines.Add($"{packagePath} has no scripts section.");
            }
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException or JsonException)
        {
            lines.Add($"{packagePath} could not be read ({error.Message}).");
        }

        ShowGuardFooterOutput(string.Join(Environment.NewLine, lines));
    }

    private void GuardSettings_Click(object sender, RoutedEventArgs e)
    {
        _guardSettingsOpen = !_guardSettingsOpen;
        GuardSettingsPanel.Visibility = _guardSettingsOpen ? Visibility.Visible : Visibility.Collapsed;
        if (_guardSettingsOpen)
        {
            GuardSettingsText.Text = BuildGuardSettingsText();
        }
    }

    /// <summary>
    /// Every value here is read from the constants the state machine obeys or from the
    /// OS. There is no place in this string for a number somebody typed.
    /// </summary>
    private string BuildGuardSettingsText() => string.Join(
        Environment.NewLine,
        $"Pulse threshold · {GuardEscalationRule.PulseAfterOccurrences} sightings, or "
        + $"{GuardEscalationRule.PulseAfterUnacknowledged.TotalMinutes:0} minutes unanswered",
        $"Red threshold · {GuardEscalationRule.CriticalAfterOccurrences} sightings, or "
        + $"{GuardEscalationRule.CriticalAfterUnacknowledged.TotalMinutes:0} minutes unanswered",
        $"Retention · at most {GuardFeed.MaxRetainedCards} cards; oldest dropped first, "
        + $"criticals dropped last; {_guardFeed.DroppedByRetention} dropped so far",
        "Deduplication · provider + detection layer + pattern signature; a repeat updates the card and bumps ×N",
        $"Re-evaluation · every {_guardClock?.Interval.TotalSeconds ?? 0:0} seconds, in memory only — no file, socket or process",
        $"Windows reduced motion · SystemParameters.ClientAreaAnimation = {SystemParameters.ClientAreaAnimation}",
        $"Helmion motion · {(_guardFeed.AnimationsEnabled ? "animations allowed" : "animations suppressed")}");

    private void ShowGuardFooterOutput(string text)
    {
        GuardFooterOutputText.Text = text;
        GuardFooterOutputText.Visibility = Visibility.Visible;
    }

    // -------------------------------------------- the ask-mode approval, as a card

    /// <summary>
    /// Mirror the console's approval question into the panel with inline A/B/C
    /// options, wired to the SAME <see cref="CompleteApproval"/> the console buttons
    /// call. This is the one card in the panel whose options do something, and it does
    /// the real thing rather than a simulation of it.
    /// </summary>
    private void PublishApprovalCard(string tool, string summary, string workspace, int timeoutSeconds)
    {
        if (!_guardPanelReady)
        {
            return;
        }

        var options = new List<GuardOption>
        {
            new(GuardOption.LetterFor(0), "Allow once", "Permit this single call.", AgentApprovalDecision.AllowOnce),
            new(GuardOption.LetterFor(1), "Allow for this session", "Permit this tool for the rest of the session.", AgentApprovalDecision.AllowSession),
            new(GuardOption.LetterFor(2), "Deny", "Refuse this call. This is also what happens if nobody answers.", AgentApprovalDecision.Deny)
        };

        _approvalCardSignature = $"approval|{tool}|{Guid.NewGuid():N}";
        _guardFeed.Report(
            new GuardObservation(
                ApprovalProvider,
                ApprovalSource,
                _approvalCardSignature,
                $"Approval needed · {tool}",
                timeoutSeconds > 0
                    ? $"{summary} · workspace {workspace} · denied automatically in {timeoutSeconds}s if nobody answers"
                    : $"{summary} · workspace {workspace}",
                GuardLevel.Warning,
                options,
                ApprovalActionKind),
            DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    /// <summary>Retire the approval card once the question has been answered anywhere.</summary>
    private void ResolveApprovalCard(string decision)
    {
        if (!_guardPanelReady || _approvalCardSignature is null)
        {
            return;
        }

        var card = _guardFeed.Find(ApprovalProvider, ApprovalSource, _approvalCardSignature);
        _approvalCardSignature = null;
        if (card is null)
        {
            return;
        }

        _guardFeed.Remove(card);
        _guardFeed.Report(
            new GuardObservation(
                ApprovalProvider,
                ApprovalSource,
                $"answered|{card.Title}",
                card.Title,
                string.IsNullOrEmpty(decision)
                    ? "Withdrawn before anyone answered."
                    : $"Answered: {decision}.",
                GuardLevel.Normal),
            DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    // ------------------------------------------------ derived labels, not literals

    /// <summary>
    /// The Overview page's "Local guardrails" line. It used to be the literal word
    /// "Ready" in accent green with no x:Name. It now reports the guard feed's
    /// headline level, which is UNKNOWN until a layer has reported.
    /// </summary>
    private void ApplyDerivedGuardrailLabel()
    {
        if (OverviewGuardrailStateText is null)
        {
            return;
        }

        var (fill, _) = BrushesForLevel(_guardFeed.WorstLevel);
        OverviewGuardrailStateText.Text = _guardFeed.WorstLevel switch
        {
            GuardLevel.Critical => $"Critical · {_guardFeed.CriticalCount}",
            GuardLevel.Warning => $"Warning · {_guardFeed.WarningCount}",
            GuardLevel.Normal => "No flags",
            _ => "Unknown"
        };
        OverviewGuardrailStateText.Foreground = fill;
    }

    /// <summary>
    /// Everything on the Overview, Activity and Evidence pages that used to be a
    /// hardcoded count or badge. Called from UpdateSnapshot, so it can never drift out
    /// of step with the snapshot it describes.
    /// </summary>
    private void ApplyDerivedSnapshotLabels(PilotSnapshot snapshot)
    {
        if (snapshot is null)
        {
            return;
        }

        var workspaceRegistered = _currentWorkspaceInspection is not null;

        if (WorkspaceCountText is not null)
        {
            WorkspaceCountText.Text = workspaceRegistered ? "1" : "0";
        }

        if (WorkspaceMetricDetail is not null)
        {
            WorkspaceMetricDetail.Text = workspaceRegistered
                ? snapshot.Workspace.Name
                : "None registered yet";
        }

        if (OpenDecisionsCountText is not null)
        {
            // Real inputs only: the approval queue plus guard cards that are
            // unacknowledged and carry a choice somebody has to make.
            var pendingGuardDecisions = _guardFeed.Visible
                .Count(card => card.HasOptions && !card.IsAcknowledged);
            var open = snapshot.ApprovalQueue.Count + pendingGuardDecisions;
            OpenDecisionsCountText.Text = open.ToString();
            OpenDecisionsDetailText.Text =
                $"{snapshot.ApprovalQueue.Count} in the approval queue · "
                + $"{pendingGuardDecisions} awaiting a choice in the guard feed";
        }

        if (RecentEvidenceStateText is not null)
        {
            RecentEvidenceStateText.Text = snapshot.RecentActivity.Count == 0
                ? "NO ROWS"
                : $"{snapshot.RecentActivity.Count} ROW(S) · LOCAL INVENTORY";
        }

        if (OrchestrationBadgeText is not null)
        {
            OrchestrationBadgeText.Text = snapshot.OrchestrationEvents.Count == 0
                ? "NO EVENTS · NOT STREAMING"
                : $"{snapshot.OrchestrationEvents.Count} EVENT(S)";
        }

        if (HandoffTimelineBadgeText is not null)
        {
            HandoffTimelineBadgeText.Text = snapshot.Handoffs.Count == 0
                ? "NO HANDOFFS RECORDED"
                : $"{snapshot.Handoffs.Count} HANDOFF(S)";
        }

        ApplyLeasePosture(snapshot.Workspace);
        ApplyDerivedGuardrailLabel();
    }

    /// <summary>
    /// Paint the lease dot, the status word and the two lease texts from the real
    /// status. The dot used to be a hardcoded accent-green Ellipse beside a hardcoded
    /// "UNAVAILABLE" — it is now the only thing on the card that is not also stated in
    /// words right beside it.
    /// </summary>
    private void ApplyLeasePosture(WorkspaceSummary workspace)
    {
        if (WorkspaceLeaseDot is null || workspace is null)
        {
            return;
        }

        var brush = (Brush)FindResource(workspace.LeaseLevelKey switch
        {
            "Normal" => "GuardNormalBrush",
            "Warning" => "GuardWarningBrush",
            "Critical" => "GuardCriticalBrush",
            "Quiet" => "GuardUnknownBrush",
            _ => "GuardUnknownBrush"
        });

        // ACTIVE is the one status that earns the app's accent colour.
        var headline = workspace.LeaseStatusText == LeaseInspector.StatusActive
            ? (Brush)FindResource("AccentBrush")
            : brush;

        WorkspaceLeaseDot.Fill = headline;
        WorkspaceLeaseStatusWordText.Text = workspace.LeaseStatusText;
        WorkspaceLeaseStatusWordText.Foreground = headline;
        WorkspaceLeaseStateText.Foreground = headline;
        LeaseMetricText.Foreground = headline;
    }
}

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
///   · the block ledger — <c>&lt;workspace&gt;\.helmion\audit\blocks-*.jsonl</c>.
///     This comment used to say that file carried blocks from BOTH of Troy's
///     layers. Traced 2026-07-30, it has never carried a browser row and cannot:
///     nothing outside <c>test/</c> writes one, and the extension is forbidden
///     network and file access (extension/test/package.test.mjs:151). Even the
///     execution half is narrow — src/agent/tools.mjs:522 passes no auditWorkspace,
///     so the in-agent gate records nothing, leaving bin/helmion.mjs:784 as the
///     only writer, and it writes to its own working directory. See the header of
///     GuardAuditLog.cs for the full trace, and LedgerHealth for why an empty
///     ledger is therefore grey rather than green;
///   · the real write lease — src/core/lease.mjs, read by LeaseInspector.cs;
///   · this window's own permission gate — ToolDispatcher's IsExecutionEnabled;
///   · a live probe of the command guard, and a read of Chrome's own extension
///     records. Both are measured ONCE, when this window is built, so both cards
///     carry GuardFreshness.MeasuredAt rather than speaking in the present tense;
///   · the local helper's connection state, which has three values and not two —
///     answering, not answering, and nobody has asked yet.
///
/// AND WHERE IT CANNOT KNOW, IT SAYS SO. A safety panel that renders "I could not
/// check" the same as "clean" is worse than no panel, so every could-not-check on
/// here is grey, says the words out loud, and never counts as an all-clear.
/// </summary>
public partial class MainWindow
{
    private readonly GuardFeed _guardFeed = new();
    private DispatcherTimer? _guardClock;
    private bool _guardPanelReady;
    private bool _guardSettingsOpen;

    /// <summary>
    /// Whether anything has ACTUALLY tried to reach the local helper yet.
    ///
    /// Without this, <c>_serviceConnected</c>'s false default was indistinguishable
    /// from a failed connection, and the panel opened by reporting a check that had
    /// never been attempted. Set only where a real answer arrives
    /// (MainWindow.xaml.cs, four places), never by a status label.
    /// </summary>
    private bool _serviceEverChecked;

    // Routing tag for cards whose options the host actually acts on. A card without
    // one renders a visible warning that its buttons do nothing (GuardCard.OptionsAreInert).
    private const string ApprovalActionKind = "console-approval";

    // THE ACTIONS A CARD CAN OFFER, and there are deliberately only two kinds.
    //
    // Troy, 2026-07-30: "you need to have an actionable button or interaction on
    // the card for that specific agent." Acknowledge was never that — it hides the
    // card and changes nothing about the thing the card is complaining about.
    //
    // Everything here is something the code can genuinely do TONIGHT. A button that
    // pretended to fix something would be the same defect as the cards this pass
    // just removed, so the honest majority of these are "measure it again now",
    // which is real work: the browser and command-guard cards are measured once at
    // startup and otherwise never re-checked at all.
    private const string RecheckActionKind = "guard-recheck";
    private const string RecheckBrowser = "recheck-browser";
    private const string RecheckCommandGuard = "recheck-command-guard";
    private const string RecheckLocalHelper = "recheck-local-helper";

    // Subjects for the cards that are about Helmion rather than about one of his
    // agents. Named constants because the same subject has to read identically on
    // every card that shares it, or the panel looks like several panels.
    private const string HelmionItselfSubject = "Helmion itself";
    private const string BrowserSubject = "Your browser";
    private const string ThisWindowSubject = "This window";
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
        GuardShowAcknowledgedCheckBox.IsChecked = _guardFeed.ShowDismissed;

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
                    ? " · Motion is allowed by Windows."
                    : " · Windows reduced-motion preference is on; Helmian follows it.");
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

        // FINDING HELMION'S OWN FOLDER IS A SEPARATE STEP, AND IT USED TO BE
        // BLAMED ON CHROME. HelmionRootPath() constructs an AgentBridge, which
        // throws when node.exe or bin/helmion.mjs is missing (AgentBridge.cs:28-39).
        // That call sat inside the try below, so a missing Node rendered as
        // "Browser layer could not be checked — Reading the browser profile threw:
        // node.exe not found on PATH". The card named the wrong cause, and a card
        // that names the wrong cause sends you to fix the wrong thing.
        string extensionDir;
        try
        {
            extensionDir = Path.Combine(HelmionRootPath(), "extension");
        }
        catch (Exception ex)
        {
            _guardFeed.Report(
                new GuardObservation("Browser", BrowserLayerSource, "browser-layer-live-status",
                    "I could not find Helmion's own folder",
                    "I need to know where Helmion is installed before I can check whether the "
                    + "browser guard is loaded, and I could not work it out. "
                    + $"({ex.Message}) This is not an all-clear — it is me saying I do not know.",
                    GuardLevel.Unknown),
                now);
            RefreshGuardChrome();
            return;
        }

        BrowserExtensionState state;
        try
        {
            state = BrowserExtensionProbe.Inspect(extensionDir);
        }
        catch (Exception ex)
        {
            state = new BrowserExtensionState(
                GuardLevel.Unknown,
                "I could not check the browser guard",
                $"Reading Chrome's records did not work ({ex.Message}). This is not an all-clear "
                + "— it is me saying I do not know.",
                false, BrowserExtensionEnablement.NotRecorded, null);
        }

        _guardFeed.Report(
            new GuardObservation("Browser", BrowserLayerSource, "browser-layer-live-status",
                state.Title,
                // MEASURED ONCE, AND THE CARD SAYS SO. Nothing called this again
                // after startup, so the present tense was a claim the code could
                // not back. The button below is what makes it re-checkable at all.
                $"{state.Detail} {GuardFreshness.MeasuredAt(now)}",
                state.Level,
                [new GuardOption(GuardOption.LetterFor(0), "Check again now",
                    "Reads Chrome's records again, right now.", RecheckBrowser)],
                RecheckActionKind,
                BrowserSubject),
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
                "I could not test whether dangerous commands are blocked",
                $"The test itself did not run ({ex.Message}). I do not know whether dangerous "
                + "commands would be stopped. This is not an all-clear.",
                false, false, TimeSpan.Zero);
        }

        Dispatcher.Invoke(() =>
        {
            if (!_guardPanelReady) return;
            var measuredAt = DateTimeOffset.Now;
            _guardFeed.Report(
                new GuardObservation("Local", ExecutionLayerSource, "execution-layer-live-status",
                    probe.Title,
                    // THIS CARD IS PUBLISHED ONCE AND NEVER AGAIN, so it says when
                    // it was measured instead of speaking in the present tense. It
                    // used to end "Probed just now", which was still on screen six
                    // hours later. See GuardFreshness.
                    $"{probe.Detail} {GuardFreshness.MeasuredAt(measuredAt)}",
                    probe.Level,
                    [new GuardOption(GuardOption.LetterFor(0), "Test it again now",
                        "Asks Helmion to refuse a dangerous command again, right now.",
                        RecheckCommandGuard)],
                    RecheckActionKind,
                    HelmionItselfSubject),
                measuredAt);
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
                card.Detail,
                card.Level,
                // NO BUTTON HERE ON PURPOSE. The only action would be "change the
                // permission mode", and that is the dropdown he already used to set
                // it. A second control for the same setting, on a card, is how two
                // places end up disagreeing about what the setting is.
                Options: null,
                ActionKind: "",
                Subject: ThisWindowSubject),
            DateTimeOffset.Now);
        RefreshGuardChrome();
    }

    /// <summary>
    /// The local helper's state, INCLUDING the state where nobody has asked it yet.
    ///
    /// <para>
    /// This used to read <c>_serviceConnected</c> directly — a plain bool that
    /// defaults to false (MainWindow.xaml.cs:43) — and it is called from
    /// InitializeGuardPanel, which runs in this window's constructor. App.xaml.cs
    /// only starts the named-pipe hello AFTER the window is shown, so the very
    /// first card on Troy's panel, before he had typed anything, was "Local service
    /// not connected · The read-only named-pipe service is not answering": a
    /// confident failure report about a question nobody had asked.
    /// </para>
    /// <para>
    /// <see cref="_serviceEverChecked"/> is what makes the third state expressible.
    /// The wording lives in Helmion.Desktop.Core.LocalServicePosture so the suite
    /// can prove all three; nothing decides a level in here.
    /// </para>
    /// </summary>
    private void PublishServicePostureCard()
    {
        if (!_guardPanelReady)
        {
            return;
        }

        var card = LocalServicePosture.Describe(_serviceEverChecked ? _serviceConnected : null);

        _guardFeed.Report(
            new GuardObservation(
                "Local",
                ServiceSource,
                LocalServicePosture.Signature,
                card.Title,
                card.Detail,
                card.Level,
                [new GuardOption(GuardOption.LetterFor(0), "Try again now",
                    "Tries to reach the background helper again, right now.", RecheckLocalHelper)],
                RecheckActionKind,
                HelmionItselfSubject),
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
                    "No project is open, so I cannot check the write lock",
                    "Only one agent at a time is allowed to write files in a project, and I check "
                    + "that by reading the project. Open one and I will tell you who holds it.",
                    GuardLevel.Unknown,
                    Subject: ThisWindowSubject),
                now);
            _guardFeed.Report(
                new GuardObservation(
                    "Local",
                    "Block ledger",
                    "ledger-health",
                    "No project is open, so I have no log of blocked commands to read",
                    "Blocked commands are written down inside the project they happened in. With "
                    + "no project open there is nothing for me to read. This is not evidence that "
                    + "nothing was blocked.",
                    GuardLevel.Unknown,
                    Subject: ThisWindowSubject),
                now);
            RefreshGuardChrome();
            return;
        }

        // 1. The real lease, straight off disk. UNREADABLE is its own level.
        //
        // THIS IS THE CARD TROY POINTED AT, and it is the one card on the panel
        // that CANNOT name its agent. The lock file records coordinatorId and
        // instanceId, which look like identities and are not: src/core/lease.mjs:210
        // defaults coordinatorId to the constant "claude-code" and :224 defaults
        // instanceId to "<machine>:<pid>", and src/agent/tools.mjs:260 — the only
        // place Helmion takes a lock — overrides neither. So every lock any session
        // takes carries the same word and a process number. Printing either as a
        // name would be a constant dressed as an identity, which is the exact thing
        // this pass exists to remove, and he would act on it.
        //
        // So the subject says plainly that the owner is unknown, and the card gets
        // the one action that IS real: clear a lock nobody is holding.
        var lease = inspection.Lease;
        _guardFeed.RegisterSource(LeaseSource);
        // Healthy "no lease" is silence — not an OK card (Troy: cards = problems only).
        // Stale / unreadable / active holder still surface.
        if (lease.Status is LeaseInspector.StatusStale
            or LeaseInspector.StatusUnreadable
            or LeaseInspector.StatusActive)
        {
            var leaseIsStale = lease.Status == LeaseInspector.StatusStale;
            _guardFeed.Report(
                new GuardObservation(
                    "Local",
                    LeaseSource,
                    "write-lease-posture",
                    lease.Label,
                    leaseIsStale
                        ? "Dead process left the lock. Clear it so agents can write."
                        : lease.Detail,
                    lease.Status switch
                    {
                        LeaseInspector.StatusUnreadable => GuardLevel.Critical,
                        LeaseInspector.StatusStale => GuardLevel.Warning,
                        _ => GuardLevel.Normal
                    },
                    leaseIsStale
                        ? [new GuardOption(GuardOption.LetterFor(0), "Clear the old lock",
                            "Deletes it after re-check that nothing holds it.",
                            StaleLockRelease.ActionKind)]
                        : null,
                    leaseIsStale ? StaleLockRelease.ActionKind : "",
                    leaseIsStale ? "An agent I cannot name" : inspection.ProjectName),
                now);
        }

        // 2. The recorded blocks, plus the log's own health.
        GuardAuditRead read;
        try
        {
            // Make the folder if it is absent, so a writer that does turn up has
            // somewhere to write.
            //
            // THIS IS NOT EVIDENCE OF ANYTHING, and the comment that used to sit
            // here said it was — "creating it makes an empty ledger mean something:
            // recording since this moment". It does not. The panel creating a
            // folder does not attach a recorder to it, and LedgerHealth no longer
            // reads an empty one as good news. See GuardAuditLog.LedgerHealth for
            // the full trace of what actually writes here, which on this machine
            // measured out as: nothing, ever.
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
                    "I could not read the log of blocked commands",
                    "Something went wrong reading the record of what has been blocked in this "
                    + "project, so I cannot show you what is in it. Use \"View quarantine log\" "
                    + "at the bottom of this panel for the exact reason.",
                    GuardLevel.Critical,
                    Subject: inspection.ProjectName),
                now);
            RefreshGuardChrome();
            return;
        }

        _guardFeed.Report(GuardAuditLog.LedgerHealth(read, inspection.ProjectName), now);

        // Replayed oldest-first so the occurrence counts — and therefore the
        // escalation — come out in the order the blocks actually happened.
        foreach (var observation in GuardAuditLog.ToObservations(read, inspection.ProjectName))
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

        // NO PILL. The chip that used to sit here — a coloured "! WARNING" badge
        // summarising the list underneath it — is deleted, along with the pulse
        // that drove it. Troy's ruling, 2026-07-30: "Nothing should be there unless
        // there's an issue. And yellow is not a fucking issue," then "There really
        // needs to be no fucking pills. The cards will pop up if there's real
        // issues and then you hit acknowledge."
        //
        // He is describing the failure mode this whole panel exists to avoid. An
        // indicator that is lit every time you look at it stops being an indicator.
        // The cards carry the signal, they carry it in words as well as colour, and
        // an empty list is now the healthy state rather than a state the header
        // argues with.
        GuardHeadlineCountsText.Text = _guardFeed.TotalCards == 0
            ? "Clear"
            : $"{_guardFeed.CriticalCount} crit · {_guardFeed.WarningCount} warn · {_guardFeed.TotalCards} total";

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

    // SetHeadlinePulse is deleted along with the pill it animated. It was the only
    // caller of the headline animation, and nothing else in this window pulses a
    // summary — cards pulse, and they do it under a rule the panel prints on its
    // own face (GuardEscalationRule.StatedRule).

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

    private void GuardAcknowledgeAll_Click(object sender, RoutedEventArgs e)
    {
        var n = _guardFeed.AcknowledgeAll(DateTimeOffset.Now);
        RefreshGuardChrome();
        if (GuardFooterOutputText is not null)
        {
            GuardFooterOutputText.Visibility = Visibility.Visible;
            GuardFooterOutputText.Text = n == 0
                ? "Nothing to acknowledge (or only criticals remain)."
                : $"Acknowledged {n} card(s). Non-criticals hide; criticals stay visible.";
        }
    }

    /// <summary>
    /// An inline option click. The letter is presentation; <see cref="GuardOption.ActionId"/>
    /// is what actually happens. Only cards carrying a routing tag this method
    /// recognises do anything — and a card without one already says on its face that
    /// its buttons do nothing, rather than pretending.
    /// </summary>
    private static T? FindAncestorDataContext<T>(DependencyObject? start) where T : class
    {
        for (var d = start; d is not null; d = System.Windows.Media.VisualTreeHelper.GetParent(d))
        {
            if (d is FrameworkElement { DataContext: T match })
                return match;
        }
        return null;
    }

    private void GuardOption_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not GuardOption option)
            return;

        // Prefer CommandParameter (card); fall back to walking the visual tree.
        var card = button.CommandParameter as GuardCard
            ?? FindAncestorDataContext<GuardCard>(button);
        if (card is null)
            return;

        if (string.Equals(card.ActionKind, ApprovalActionKind, StringComparison.Ordinal))
        {
            // The real consumer: the existing ask-mode approval mechanism. Clicking
            // here answers the agent's question without leaving the console page.
            var decision = AgentApprovalDecision.Normalize(option.ActionId);
            AppendConsoleLine($"  [guard panel → {decision}] {option.Label}");
            CompleteApproval(decision);
            return;
        }

        // MEASURE IT AGAIN, NOW. These cards are otherwise measured once, when the
        // window is built, and never again — so this button is not a refresh
        // gesture, it is the only way any of them can be re-measured at all.
        if (string.Equals(card.ActionKind, RecheckActionKind, StringComparison.Ordinal))
        {
            switch (option.ActionId)
            {
                case RecheckBrowser:
                    PublishBrowserLayerCard(DateTimeOffset.Now);
                    break;

                case RecheckCommandGuard:
                    // Fire and forget: it spawns node twice and a status panel must
                    // not freeze the window to find out it is healthy. The card
                    // updates when the answer lands.
                    _ = PublishExecutionGuardCardAsync();
                    break;

                case RecheckLocalHelper:
                    _ = ConnectServiceAsync(restoreWorkspace: false);
                    break;
            }

            return;
        }

        // THE ONE BUTTON THAT CHANGES SOMETHING. It re-reads the lock at the moment
        // of the click rather than trusting what the card said, because a card drawn
        // minutes ago can be describing a lock a live agent has since taken over.
        // The decision and the refusal wording live in Core so the suite can drive
        // all four states (StaleLockRelease).
        if (string.Equals(card.ActionKind, StaleLockRelease.ActionKind, StringComparison.Ordinal))
        {
            var workspace = _registeredWorkspacePath ?? _currentWorkspaceInspection?.ProjectPath;
            var outcome = StaleLockRelease.Run(workspace, DateTimeOffset.Now);
            ShowGuardFooterOutput(outcome.Message);

            // Re-read the lock either way, so the card now shows what is actually on
            // disk rather than what this method believes it did.
            RefreshGuardFeedFromDisk(_currentWorkspaceInspection);
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

    private void GuardShowAcknowledgedToggle_Click(object sender, RoutedEventArgs e)
    {
        _guardFeed.ShowDismissed = GuardShowAcknowledgedCheckBox.IsChecked == true;
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
    /// RUNS THE REAL SUITES. Hands straight off to
    /// <see cref="StartOrCancelGuardTestSuite"/> in MainWindow.TestSuiteRun.cs, which
    /// drives Helmion.Desktop.Core/TestSuiteRunner.cs.
    ///
    /// WHAT THIS USED TO BE, AND WHY IT IS ONE LINE NOW. This handler used to print
    /// the suite commands and end with "This panel does not start processes, so
    /// nothing was run" — a help page shaped like a button. It survived roughly nine
    /// hundred checks because a WPF click handler cannot be called from the headless
    /// suite, so nothing that lives inside one can ever be asserted. Everything with
    /// behaviour was therefore moved to Core, where TestSuiteRunnerChecks drives it
    /// for real, and this reduced to the call. Keeping the body at one line is the
    /// point of the change, not a tidiness preference.
    /// </summary>
    private void GuardRunTestSuite_Click(object sender, RoutedEventArgs e)
    {
        StartOrCancelGuardTestSuite();
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
    /// A concise operator summary. Exact thresholds still come from the same
    /// constants the state machine obeys; implementation property names do not
    /// belong in the product UI.
    /// </summary>
    private string BuildGuardSettingsText() => string.Join(
        Environment.NewLine,
        $"Showing · {_guardFeed.ActiveTab}",
        $"Acknowledged · {(_guardFeed.ShowDismissed ? "shown" : "hidden")}",
        GuardEscalationRule.StatedRuleDetail,
        $"Retention · {_guardFeed.RetentionText}",
        $"Motion · {(_guardFeed.AnimationsEnabled ? "on" : "off")} (presentation only)");

    private void ShowGuardFooterOutput(string text)
    {
        GuardFooterOutputText.Text = text;
        GuardFooterOutputText.Visibility = Visibility.Visible;
        GuardFooterOutputDismissButton.Visibility = Visibility.Visible;
    }

    private void GuardFooterOutputDismiss_Click(object sender, RoutedEventArgs e)
    {
        GuardFooterOutputText.Text = string.Empty;
        GuardFooterOutputText.Visibility = Visibility.Collapsed;
        GuardFooterOutputDismissButton.Visibility = Visibility.Collapsed;
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
                ApprovalActionKind,
                // WHICH AGENT IS ASKING. The approval comes back through the bridge
                // for whichever session is mid-turn, so that session's name is the
                // real answer; with no session running it is the console itself.
                _sessions.Selected?.Name ?? ThisWindowSubject),
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
                GuardLevel.Normal,
                Subject: card.Subject),
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
    /// Everything on the Overview and Evidence pages that used to be a
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
            // Real inputs only: project-local actionable reviews plus guard cards
            // that are unacknowledged and carry a choice somebody has to make.
            var pendingGuardDecisions = _guardFeed.Visible
                .Count(card => card.HasOptions && !card.IsAcknowledged);
            var pendingProjectReviews = 0;
            if (!string.IsNullOrWhiteSpace(_registeredWorkspacePath)
                && Directory.Exists(_registeredWorkspacePath))
            {
                try
                {
                    pendingProjectReviews = ProjectReviewQueue.Load(
                        _registeredWorkspacePath,
                        "needs-action").ActionableCount;
                }
                catch
                {
                    // The page itself surfaces a read failure. The Overview metric
                    // must stay usable even when a project ledger is malformed.
                }
            }
            var open = pendingProjectReviews + pendingGuardDecisions;
            OpenDecisionsCountText.Text = open.ToString();
            OpenDecisionsDetailText.Text =
                $"{pendingProjectReviews} in project review · "
                + $"{pendingGuardDecisions} awaiting a choice in the guard feed";
        }

        if (RecentEvidenceStateText is not null)
        {
            RecentEvidenceStateText.Text = snapshot.RecentActivity.Count == 0
                ? "NO ROWS"
                : $"{snapshot.RecentActivity.Count} ROW(S) · LOCAL INVENTORY";
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

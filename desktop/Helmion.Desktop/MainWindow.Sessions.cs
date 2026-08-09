using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// THE MULTI-SESSION MANAGER — the pills under the composer, and the named sessions
/// with live stoplights in the left panel.
///
/// TROY'S SPEC, 2026-07-30, his words: "for the multiple agents under each AI you
/// were supposed to have little pill buttons underneath the text box somewhere kind
/// of left to right in a row where you could just press the button for Claude or
/// ChatGPT, Grok, whatever, Gemini, and it'll spin up a fresh session, you can name
/// it. And then the Maestro needs to be able to communicate with all of them, with
/// every agent, and manage them. And then all their stuff comes up on the left side
/// panel, interactive, with their name so you know which one is which, with the
/// stoplight — yellow or green, yellow, red escalation, little tiny coloured
/// buttons."
///
/// THE DOTS ARE NOT DECORATION, AND THERE IS NO SECOND ESCALATION SCHEME. Every dot
/// is the worst level of the REAL guard cards that session put into the existing
/// <see cref="GuardFeed"/>, read back by signature through the feed's own public
/// <c>Find</c>. So a session's dot obeys the escalation rule Troy already verified
/// — pulse at 3 sightings or 2 minutes, red at 5 sightings or 5 minutes
/// (GuardEscalation.cs:80-89) — because it IS that rule's output. No guard logic is
/// duplicated or modified here; this file only reports observations and reads levels.
///
/// AN IDLE SESSION COSTS NOTHING. Creating a session starts no process. The Node
/// bridge for a session is constructed on its FIRST SEND
/// (<see cref="ResolveSessionBridge"/>) and nothing in this file polls, timers, or
/// touches a session that is sitting there. The only clock in the guard system is
/// the existing in-memory tick (MainWindow.GuardPanel.cs:94-105), which performs no
/// I/O.
///
/// MULTI-AGENT TURNS. Each named session owns its own bridge and may run a turn
/// while another session is mid-turn. The shared console (no pill) is still one-at-a-time.
/// Ask-mode keeps a single approval strip: a new Ask turn is refused while a decision
/// is pending (Allow once / session / Deny). Esc cancels the selected session's turn.
/// </summary>
public partial class MainWindow
{
    private readonly SessionShelf _sessions = new();

    /// <summary>
    /// One Node bridge per session, created lazily on first send. Held here rather
    /// than on <see cref="AgentSession"/> so the shelf stays a pure state object the
    /// smoke suite can drive with no processes at all.
    /// </summary>
    private readonly Dictionary<string, AgentBridge> _sessionBridges = new(StringComparer.Ordinal);

    /// <summary>The session whose turn is currently writing output, if any.</summary>
    private AgentSession? _turnSession;

    private string? _pendingPillLabel;
    private bool _sessionShelfWired;

    // ── wiring ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Populated from the control's own Loaded event rather than the window
    /// constructor, the same way the project shelf does it: MainWindow.xaml.cs is
    /// four thousand lines and is claimed by other work.
    /// </summary>
    private void SessionShelfList_Loaded(object sender, RoutedEventArgs e)
    {
        if (sender is ItemsControl list)
        {
            list.ItemsSource = _sessions.Sessions;
        }

        WireSessionShelfOnce();
    }

    /// <summary>
    /// Right Agents dock roster — same SessionShelf collection as the left list.
    /// Multi-agent lives here (Troy: "multi agent on right shelf its already there").
    /// </summary>
    private void AgentsSessionList_Loaded(object sender, RoutedEventArgs e)
    {
        if (sender is ItemsControl list)
        {
            list.ItemsSource = _sessions.Sessions;
        }

        WireSessionShelfOnce();
        RefreshSessionShelfChrome();
    }

    private void WireSessionShelfOnce()
    {
        if (_sessionShelfWired) return;
        _sessionShelfWired = true;

        // The clock escalates cards by age alone, and Report() raises the same
        // counts. Both funnel through the feed's own notifications, so subscribing
        // here keeps the dots current without adding a timer of our own and without
        // editing the guard panel.
        _guardFeed.PropertyChanged += (_, _) => RefreshSessionDots();

        _sessions.Sessions.CollectionChanged += (_, _) => RefreshSessionShelfChrome();

        Closed += (_, _) =>
        {
            foreach (var bridge in _sessionBridges.Values)
            {
                try { bridge.Dispose(); } catch { /* shutting down */ }
            }

            _sessionBridges.Clear();
        };

        RefreshSessionShelfChrome();
    }

    private void RefreshSessionShelfChrome()
    {
        var empty = _sessions.IsEmpty;
        if (SessionShelfEmpty is not null)
        {
            SessionShelfEmpty.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
            SessionShelfEmpty.Text = _sessions.EmptyText;
        }

        if (AgentsSessionEmpty is not null)
        {
            AgentsSessionEmpty.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
            AgentsSessionEmpty.Text =
                "No agents yet. Press Claude, ChatGPT, Grok, or Gemini above — each press adds another agent you can name.";
        }

        if (AgentsDockSubtitle is not null)
        {
            var n = _sessions.Sessions.Count;
            AgentsDockSubtitle.Text = n == 0
                ? "Multi-agent manager"
                : n == 1
                    ? "1 agent running"
                    : $"{n} agents running";
        }
    }

    // ── the pills ─────────────────────────────────────────────────────────────

    /// <summary>
    /// A pill was pressed. It does NOT start the session yet — Troy asked to name
    /// them ("you can name it"), so this opens the naming box with a free name
    /// already filled in, and the session begins when he confirms.
    /// </summary>
    private void SessionPill_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string pill } pillButton || string.IsNullOrWhiteSpace(pill)) return;
        if (SessionNamePopup is null || SessionNameBox is null) return;

        _pendingPillLabel = pill;

        // Anchor the naming popup on the pill that was pressed (composer row or Agents dock).
        SessionNamePopup.PlacementTarget = pillButton;
        SessionNamePopup.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;

        if (SessionNameHeader is not null)
        {
            if (string.Equals(pill, "Maestro", StringComparison.OrdinalIgnoreCase))
            {
                SessionNameHeader.Text =
                    "Name your Maestro manager. After it exists, type @Claude @Grok (or @all) " +
                    "so workers reply to the manager with non-overlapping work claims.";
            }
            else
            {
                var routed = MaestroKey.Normalize(pill);
                SessionNameHeader.Text = routed is null
                    ? $"New {pill} agent — Helmion has no coordinator route for {pill}, so this "
                      + "session will be created and will say so rather than pretending it can run."
                    : string.Equals(routed, pill, StringComparison.Ordinal)
                        ? $"New {pill} agent. Name it so you can tell it apart in the manager."
                        : $"New {pill} agent — routed to the {routed} coordinator. Name it so you "
                          + "can tell it apart in the manager.";
            }
        }

        SessionNameBox.Text = string.Equals(pill, "Maestro", StringComparison.OrdinalIgnoreCase)
            ? _sessions.SuggestName("Manager")
            : _sessions.SuggestName(pill);
        if (SessionTierCombo is not null) SessionTierCombo.SelectedIndex = 0;
        if (SessionModelOverrideBox is not null) SessionModelOverrideBox.Clear();
        SetSessionNameProblem(null);
        SessionNamePopup.IsOpen = true;
        SessionNameBox.SelectAll();
        SessionNameBox.Focus();
    }

    private void SessionNameBox_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            StartNamedSession();
            return;
        }

        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            CloseSessionNamePopup();
        }
    }

    private void SessionNameStart_Click(object sender, RoutedEventArgs e) => StartNamedSession();

    private void SessionNameCancel_Click(object sender, RoutedEventArgs e) => CloseSessionNamePopup();

    private void CloseSessionNamePopup()
    {
        _pendingPillLabel = null;
        if (SessionNamePopup is not null) SessionNamePopup.IsOpen = false;
        SetSessionNameProblem(null);
    }

    private void SetSessionNameProblem(string? problem)
    {
        if (SessionNameProblem is null) return;
        SessionNameProblem.Text = problem ?? string.Empty;
        SessionNameProblem.Visibility = problem is null ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>
    /// Create the session, run its preflight, and select it.
    ///
    /// The preflight is a REAL check of things that decide whether a turn can run at
    /// all, and its result becomes this session's first guard card — which is what
    /// gives the dot its first colour. It starts no process.
    /// </summary>
    private void StartNamedSession()
    {
        var pill = _pendingPillLabel;
        if (pill is null || SessionNameBox is null) return;

        var name = SessionNameBox.Text;
        var problem = _sessions.ValidateName(name);
        if (problem is not null)
        {
            SetSessionNameProblem(problem);
            return;
        }

        AgentSession session;
        try
        {
            session = _sessions.Create(pill, name, DateTimeOffset.Now);
        }
        catch (ArgumentException ex)
        {
            SetSessionNameProblem(ex.Message);
            return;
        }

        CloseSessionNamePopup();

        session.TierOverride = (SessionTierCombo?.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "auto";
        session.ModelOverride = SessionModelOverrideBox?.Text;

        ReportSessionPreflight(session);
        ShowSessionTranscript(session);
        RefreshSessionShelfChrome();
    }

    // ── the left-panel list ───────────────────────────────────────────────────

    private void SessionShelfItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string id }) return;
        var session = _sessions.ById(id);
        if (session is null) return;

        _sessions.Select(session);
        ShowSessionTranscript(session);
    }

    /// <summary>
    /// Close a session: drop its bridge process, and take its cards out of the guard
    /// feed so a dead session's flags stop counting toward the panel's headline.
    /// </summary>
    private void SessionClose_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string id }) return;
        var session = _sessions.ById(id);
        if (session is null) return;

        if (_turnSession is not null && ReferenceEquals(_turnSession, session))
        {
            AppendConsoleLine(
                $"[\"{session.Name}\" is mid-turn — let it finish, then close it.]");
            return;
        }

        if (_sessionBridges.Remove(session.Id, out var bridge))
        {
            try { bridge.Dispose(); } catch { /* the process is going away regardless */ }
        }

        foreach (var (source, signature) in SessionCardKeys())
        {
            var card = _guardFeed.Find(session.GuardProvider, source, signature);
            if (card is not null) _guardFeed.Remove(card);
        }

        var next = _sessions.Close(session);
        ShowSessionTranscript(next);
        RefreshSessionShelfChrome();
        RefreshSessionDots();
    }

    private static IEnumerable<(string Source, string Signature)> SessionCardKeys()
    {
        yield return (AgentSession.PreflightSource, AgentSession.PreflightSignature);
        yield return (AgentSession.TurnSource, AgentSession.TurnSignature);
    }

    /// <summary>
    /// Swap the visible transcript to a session's own buffer. Sessions do not share
    /// the console text: switching shows what THAT session said, and nothing else.
    /// </summary>
    private void ShowSessionTranscript(AgentSession? session)
    {
        if (ConsoleOutputText is null) return;

        if (session is null)
        {
            // No sessions left. The buffer is not cleared — the text already on
            // screen is the record of what happened before any session existed.
            return;
        }

        ConsoleOutputText.Text = session.Transcript.ToString();
        ConsoleOutputText.CaretIndex = ConsoleOutputText.Text.Length;
        ConsoleOutputText.ScrollToEnd();
    }

    // ── guard state ───────────────────────────────────────────────────────────

    /// <summary>
    /// Check whether this session could run a turn, and publish the answer as a real
    /// guard card. Everything it reads is already in memory or a plain file lookup:
    /// no process is started, no endpoint is called, no credential is used.
    /// </summary>
    private void ReportSessionPreflight(AgentSession session)
    {
        EnvironmentSettings settings;
        try
        {
            settings = EnvironmentSettingsStore.Load();
        }
        catch (Exception ex)
        {
            ReportSessionCard(
                session,
                AgentSession.PreflightSource,
                AgentSession.PreflightSignature,
                "Preflight could not be computed",
                $"Reading settings threw: {ex.Message}. Could not compute — not an all-clear.",
                GuardLevel.Unknown);
            return;
        }

        var credential = session.ProviderKey switch
        {
            MaestroKey.OpenAi => settings.OpenAiApiKey,
            MaestroKey.Claude => settings.AnthropicApiKey,
            MaestroKey.Gemini => settings.GeminiApiKey,
            MaestroKey.Grok => settings.GrokApiKey,
            _ => null,
        };

        // Static lookups: both walk directories and PATH, and neither launches
        // anything (AgentBridge.cs:515-558).
        var root = AgentBridge.FindHelmionRoot();
        var cli = root is null ? null : Path.Combine(root, "bin", "helmion.mjs");
        if (cli is not null && !File.Exists(cli)) cli = null;

        var result = SessionPreflight.Evaluate(
            session.ProviderKey,
            !string.IsNullOrWhiteSpace(credential),
            AgentBridge.FindNodeExecutable(),
            cli);

        ReportSessionCard(
            session,
            AgentSession.PreflightSource,
            AgentSession.PreflightSignature,
            result.Title,
            result.Detail,
            result.Level);
    }

    private void ReportSessionCard(
        AgentSession session,
        string source,
        string signature,
        string title,
        string detail,
        GuardLevel level)
    {
        // THE SESSION'S OWN NAME IS THE SUBJECT. This is the one place on the panel
        // where a genuine, Troy-typed agent name exists, and until now it appeared
        // only as the tab heading ("Session · Claude 2") and never on the card. It
        // is now the first thing the card says.
        _guardFeed.Report(
            new GuardObservation(
                session.GuardProvider, source, signature, title, detail, level,
                Subject: session.Name),
            DateTimeOffset.Now);
        RefreshSessionDots();
    }

    /// <summary>
    /// Re-read every session's dot from the cards that session actually owns.
    ///
    /// It reads through <see cref="GuardFeed.Find"/> and NOT through
    /// <c>GuardFeed.Visible</c>, which is filtered to the active tab — a dot sourced
    /// from the filtered list would change colour when somebody clicked a tab, which
    /// is the definition of a decorative light.
    /// </summary>
    private void RefreshSessionDots()
    {
        foreach (var session in _sessions.Sessions)
        {
            var preflight = _guardFeed.Find(
                session.GuardProvider, AgentSession.PreflightSource, AgentSession.PreflightSignature);
            var turn = _guardFeed.Find(
                session.GuardProvider, AgentSession.TurnSource, AgentSession.TurnSignature);

            session.ApplyGuardState(
                preflight is null ? null : (preflight.Level, preflight.Reason),
                turn is null ? null : (turn.Level, turn.Reason));
        }
    }

    // ── routing ───────────────────────────────────────────────────────────────

    /// <summary>
    /// The bridge for a session, started on demand. THIS is where a session first
    /// costs anything — pressing a pill does not reach here.
    /// </summary>
    private AgentBridge ResolveSessionBridge(AgentSession session)
    {
        if (_sessionBridges.TryGetValue(session.Id, out var existing) && existing.IsRunning)
        {
            return existing;
        }

        if (existing is not null)
        {
            // The process died between turns. Replace it rather than handing back a
            // dead one whose next turn would fail with a confusing message.
            try { existing.Dispose(); } catch { /* already gone */ }
            _sessionBridges.Remove(session.Id);
        }

        var bridge = new AgentBridge();
        _sessionBridges[session.Id] = bridge;
        return bridge;
    }

    /// <summary>
    /// Record how a turn ended, as this session's turn card.
    ///
    /// A clean turn reports Normal, which is what lets a session RECOVER: the feed
    /// treats Normal as "the condition cleared" and resets the sighting count
    /// (GuardFeed.cs:184-188), so one bad turn followed by a good one goes back to
    /// green instead of ratcheting.
    /// </summary>
    private void ReportSessionTurn(AgentSession session, GuardLevel level, string title, string detail) =>
        ReportSessionCard(
            session, AgentSession.TurnSource, AgentSession.TurnSignature, title, detail, level);

    /// <summary>
    /// Stage-one scan of model prose: unsupported confidence, false certainty, harm.
    /// Reports Guard cards; never withholds the reply. Same policy intent as the
    /// browser extension claim lane, applied inside Helmian.
    /// </summary>
    private void ReportReplyContentPolicy(AgentSession? session, string? replyText, string? subjectOverride = null)
    {
        var scan = ReplyContentPolicy.Scan(replyText);
        if (!scan.Flagged)
        {
            return;
        }

        var provider = session?.GuardProvider ?? "Maestro";
        var subject = subjectOverride
            ?? session?.Name
            ?? "Maestro";
        foreach (var observation in ReplyContentPolicy.ToObservations(scan, provider, subject))
        {
            _guardFeed.Report(observation, DateTimeOffset.Now);
        }

        RefreshSessionDots();
        if (scan.Findings.Any(f => f.Kind == ReplyContentFindingKind.Harm))
        {
            AppendConsoleLine("[Guard] Harmful-content pattern flagged — open Guard panel.");
        }
        else
        {
            AppendConsoleLine(
                $"[Guard] {scan.Findings.Count} unsupported/unsourced claim(s) — open Guard to review.");
        }
    }
}

using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text;

namespace Helmion.Desktop.Core;

/// <summary>
/// What a session's stoplight dot is, and why.
///
/// <see cref="Level"/> is never invented here. It is the WORST level of the guard
/// cards the session actually put into the feed, ranked the same way
/// <c>GuardFeed.Rank</c> ranks them (GuardFeed.cs:539-547): Critical &gt; Warning &gt;
/// Unknown &gt; Normal. Unknown deliberately outranks Normal, so a session nobody has
/// computed a state for can never render the same as one that was checked and found
/// healthy.
/// </summary>
public sealed record SessionDot(GuardLevel Level, string Reason)
{
    /// <summary>Colour key for the template. A string so no converter is needed.</summary>
    public string LevelKey => Level switch
    {
        GuardLevel.Critical => "Critical",
        GuardLevel.Warning => "Warning",
        GuardLevel.Normal => "Normal",
        _ => "Unknown"
    };

    /// <summary>The level as a word, so the dot's colour is never the only channel.</summary>
    public string LevelText => Level switch
    {
        GuardLevel.Critical => "RED",
        GuardLevel.Warning => "YELLOW",
        GuardLevel.Normal => "GREEN",
        _ => "GREY"
    };

    /// <summary>
    /// Combine the cards a session owns into one dot.
    ///
    /// A null argument means NO SUCH CARD EXISTS — nothing has reported that
    /// aspect of this session yet — and it contributes Unknown rather than being
    /// skipped. Skipping it would let a session with nothing behind it inherit the
    /// only level present and go green on no evidence.
    /// </summary>
    public static SessionDot Combine(
        (GuardLevel Level, string Reason)? preflight,
        (GuardLevel Level, string Reason)? turn)
    {
        var parts = new List<(GuardLevel Level, string Reason)>();
        parts.Add(preflight ?? (GuardLevel.Unknown,
            "Nothing has checked whether this session can run. Not an all-clear."));
        parts.Add(turn ?? (GuardLevel.Unknown,
            "No turn has run in this session yet, so nothing is known about how it behaves."));

        var worst = parts[0];
        foreach (var part in parts)
        {
            if (Rank(part.Level) > Rank(worst.Level))
            {
                worst = part;
            }
        }

        return new SessionDot(worst.Level, worst.Reason);
    }

    /// <summary>
    /// Severity order, copied deliberately from <c>GuardFeed.Rank</c>
    /// (GuardFeed.cs:539-547) rather than from the enum's numeric order, which has
    /// Unknown=0 below Normal=1 and would rank "could not compute" as better than
    /// "checked and fine". SessionShelfChecks pins the two orderings together.
    /// </summary>
    public static int Rank(GuardLevel level) => level switch
    {
        GuardLevel.Critical => 3,
        GuardLevel.Warning => 2,
        GuardLevel.Normal => 0,
        _ => 1
    };
}

/// <summary>
/// Whether a session can run at all, computed from things that are cheap to check
/// and true right now: is there a Node executable, is there a helmion.mjs, is there
/// a credential for the provider this session routes to.
///
/// IT LAUNCHES NOTHING. Every input is a path or a boolean the caller already has,
/// so creating a session starts no process and opens no connection. Troy's rule:
/// an idle session costs nothing. A green dot from this function therefore means
/// exactly "the preconditions were checked and are present" — never "the model
/// answered", which nothing here can know.
/// </summary>
public static class SessionPreflight
{
    public sealed record Result(GuardLevel Level, string Title, string Detail);

    /// <param name="providerKey">
    /// The canonical key from <see cref="MaestroKey.Normalize"/>, or null when the
    /// pill routes somewhere this build has no route for.
    /// </param>
    /// <param name="hasCredential">
    /// Whether the credential this provider needs is present in settings. A key that
    /// EXISTS is not a key that WORKS — the detail text says so rather than implying
    /// a verified credential.
    /// </param>
    /// <param name="nodePath">Path to node.exe, or null when it was not found.</param>
    /// <param name="cliScriptPath">Path to bin/helmion.mjs, or null when not found.</param>
    public static Result Evaluate(
        string? providerKey,
        bool hasCredential,
        string? nodePath,
        string? cliScriptPath)
    {
        // Nothing can run a turn without both of these, so this is the loudest and
        // it is checked first.
        if (string.IsNullOrWhiteSpace(nodePath) || string.IsNullOrWhiteSpace(cliScriptPath))
        {
            var missing = string.IsNullOrWhiteSpace(nodePath)
                ? (string.IsNullOrWhiteSpace(cliScriptPath)
                    ? "neither node.exe nor bin/helmion.mjs could be found"
                    : "node.exe could not be found on PATH")
                : "bin/helmion.mjs could not be found";

            return new Result(
                GuardLevel.Critical,
                "This session cannot run a turn",
                $"Preflight failed: {missing}. The agent engine runs as a Node process, so "
                + "sending to this session will fail until that is fixed. Nothing was started.");
        }

        if (string.IsNullOrWhiteSpace(providerKey))
        {
            return new Result(
                GuardLevel.Warning,
                "No route for this provider",
                "Helmion has no coordinator route for this session's provider, so a turn would "
                + "have nowhere to go. The four it routes are OpenAI, Claude, Gemini and Grok.");
        }

        if (!hasCredential)
        {
            return new Result(
                GuardLevel.Warning,
                $"No {providerKey} credential configured",
                $"node and bin/helmion.mjs were both found, but there is no {CredentialName(providerKey)} "
                + "in settings. A turn in this session will fail at the provider call. "
                + "Add the key on the Settings page.");
        }

        return new Result(
            GuardLevel.Normal,
            "Preflight clear",
            $"Checked and present: node at {nodePath}, the agent CLI at {cliScriptPath}, and a "
            + $"{CredentialName(providerKey)} in settings. That is all this says — no turn has run, "
            + "the credential has not been used, and nothing has been started for this session.");
    }

    /// <summary>The environment variable name the operator would recognise.</summary>
    public static string CredentialName(string? providerKey) => providerKey switch
    {
        MaestroKey.OpenAi => "OPENAI_API_KEY",
        MaestroKey.Claude => "ANTHROPIC_API_KEY",
        MaestroKey.Gemini => "GEMINI_API_KEY",
        MaestroKey.Grok => "XAI_API_KEY",
        _ => "provider credential"
    };
}

/// <summary>
/// One named, running session: which provider it talks to, what it has said, and the
/// worst live guard state attributable to it.
///
/// THE DOT IS NOT SET FROM HERE. <see cref="ApplyGuardState"/> is the only way the
/// level moves, and its caller reads the levels off real cards in the guard feed.
/// There is no constructor overload, no default and no setter that produces a green
/// dot without a card behind it — a new session starts Unknown/grey and says so.
/// </summary>
public sealed class AgentSession : INotifyPropertyChanged
{
    /// <summary>Guard-feed <c>Source</c> for this session's preflight card.</summary>
    public const string PreflightSource = "Session preflight";

    /// <summary>Guard-feed <c>Source</c> for this session's turn outcome card.</summary>
    public const string TurnSource = "Session turn";

    public const string PreflightSignature = "session-preflight";
    public const string TurnSignature = "session-turn";

    // The starting dot comes from Combine with NO cards rather than from a literal
    // of its own. One code path produces an evidence-free dot, so the sentence a
    // brand-new session shows can never drift away from the sentence Combine gives
    // a session whose cards have gone missing.
    private SessionDot _dot = SessionDot.Combine(null, null);

    private bool _isSelected;
    private bool _isBusy;
    private string _tierOverride = "auto";
    private string? _modelOverride;

    internal AgentSession(
        string id,
        string name,
        string? providerKey,
        string pillLabel,
        DateTimeOffset createdAt,
        bool isManager = false)
    {
        Id = id;
        Name = name;
        ProviderKey = providerKey;
        PillLabel = pillLabel;
        CreatedAt = createdAt;
        IsManager = isManager;
    }

    public string Id { get; }

    /// <summary>The name Troy typed. Unique within the shelf so the dots cannot be confused.</summary>
    public string Name { get; }

    /// <summary>
    /// The canonical coordinator this session routes to — what goes on the wire —
    /// or null when this build has no route for it.
    /// </summary>
    public string? ProviderKey { get; }

    /// <summary>
    /// The button Troy actually pressed. Kept separate from <see cref="ProviderKey"/>
    /// because the ChatGPT pill routes to the OpenAI coordinator, and a row that
    /// showed only "ChatGPT" would hide which coordinator really ran.
    /// </summary>
    public string PillLabel { get; }

    /// <summary>
    /// Maestro manager: dispatches @mentions to worker agents and receives their replies.
    /// </summary>
    public bool IsManager { get; }

    public DateTimeOffset CreatedAt { get; }

    public string TierOverride
    {
        get => _tierOverride;
        set => _tierOverride = string.IsNullOrWhiteSpace(value) ? "auto" : value.Trim().ToLowerInvariant();
    }

    public string? ModelOverride
    {
        get => _modelOverride;
        set => _modelOverride = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    /// <summary>
    /// This session's own transcript. Sessions do not share the console buffer —
    /// output from a session you are not looking at goes here and stays here.
    /// </summary>
    public StringBuilder Transcript { get; } = new();

    /// <summary>
    /// Last meaningful chat lines for the Agents shelf card (message-style preview).
    /// Updated when the window appends to <see cref="Transcript"/>.
    /// </summary>
    public string ChatPreview
    {
        get
        {
            if (Transcript.Length == 0)
                return IsBusy ? "Working…" : "No messages yet — send from Maestro while this agent is selected.";

            // Prefer last non-empty lines; collapse whitespace so the card stays sleek.
            var lines = Transcript.ToString()
                .Replace("\r\n", "\n", StringComparison.Ordinal)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (lines.Length == 0)
                return IsBusy ? "Working…" : "No messages yet.";

            // Skip pure labels like "You" / "Result" if followed by content.
            var pick = new List<string>(2);
            for (var i = lines.Length - 1; i >= 0 && pick.Count < 2; i--)
            {
                var line = lines[i];
                if (line.Length is 0 or > 280)
                    line = line.Length > 280 ? line[..277] + "…" : line;
                if (line is "You" or "Result" or "Request" or "Action needed")
                    continue;
                if (line.StartsWith('[') && line.EndsWith(']'))
                    continue;
                pick.Add(line);
            }

            if (pick.Count == 0)
                return lines[^1].Length > 120 ? lines[^1][..117] + "…" : lines[^1];

            pick.Reverse();
            var joined = string.Join(" · ", pick);
            return joined.Length > 160 ? joined[..157] + "…" : joined;
        }
    }

    /// <summary>Call after Transcript is mutated so Agents cards refresh the preview.</summary>
    public void NotifyTranscriptChanged()
    {
        Raise(nameof(ChatPreview));
    }

    /// <summary>
    /// The <c>Provider</c> value every guard card belonging to this session carries.
    /// It doubles as the session's tab in the guard panel, so a session's flags are
    /// filterable in the same panel as every other layer.
    /// </summary>
    public string GuardProvider => $"Session · {Name}";

    public GuardLevel Level => _dot.Level;

    public string LevelKey => _dot.LevelKey;

    /// <summary>The dot's colour said as a word, for anyone who cannot use colour.</summary>
    public string LevelText => _dot.LevelText;

    /// <summary>Which card produced the dot's colour, with its own sentence.</summary>
    public string Reason => _dot.Reason;

    public bool IsSelected
    {
        get => _isSelected;
        internal set
        {
            if (_isSelected == value) return;
            _isSelected = value;
            Raise(nameof(IsSelected));
            Raise(nameof(RowWeight));
            Raise(nameof(AccessibleName));
        }
    }

    /// <summary>
    /// True while a turn belonging to this session is in flight. Set by the window's
    /// turn loop only — it is a fact about work in progress, not a level, and it
    /// never changes <see cref="Level"/> or the dot's colour.
    /// </summary>
    public bool IsBusy
    {
        get => _isBusy;
        set
        {
            if (_isBusy == value) return;
            _isBusy = value;
            Raise(nameof(IsBusy));
            Raise(nameof(SubtitleText));
            Raise(nameof(ChatPreview));
            Raise(nameof(AccessibleName));
        }
    }

    public string RowWeight => IsSelected ? "Bold" : "Normal";

    /// <summary>
    /// The second line of the row. It names the coordinator that actually runs and
    /// the dot's colour in words, so neither is carried by the dot alone.
    /// </summary>
    public string SubtitleText
    {
        get
        {
            if (IsManager)
            {
                var managerState = IsBusy ? "dispatching" : LevelText;
                return $"Maestro · manager · {managerState}";
            }

            var provider = ProviderKey ?? $"{PillLabel} · no route";
            var workerState = IsBusy ? "working" : LevelText;
            return $"{provider} · {workerState}";
        }
    }

    public string DotTooltip => $"{LevelText} — {Reason}";

    /// <summary>
    /// What a screen reader says for this row. The dot is an Ellipse and a colour —
    /// two things assistive technology cannot report — so the level has to be in the
    /// accessible name or the stoplight exists for sighted users only.
    /// </summary>
    public string AccessibleName =>
        $"Session {Name}, {ProviderKey ?? PillLabel}, guard state {LevelText}"
        + (IsBusy ? ", working" : string.Empty)
        + (IsSelected ? ", selected" : string.Empty);

    public string CloseAccessibleName => $"Close session {Name}";

    /// <summary>Single letter for the sleek Agents avatar chip.</summary>
    public string AvatarInitial
    {
        get
        {
            var s = Name.Trim();
            if (s.Length == 0) s = PillLabel;
            return s.Length == 0 ? "?" : char.ToUpperInvariant(s[0]).ToString();
        }
    }

    /// <summary>
    /// Move the dot. The caller passes the levels it read off this session's real
    /// cards; null means the card does not exist and is treated as Unknown by
    /// <see cref="SessionDot.Combine"/>.
    /// </summary>
    public bool ApplyGuardState(
        (GuardLevel Level, string Reason)? preflight,
        (GuardLevel Level, string Reason)? turn)
    {
        var next = SessionDot.Combine(preflight, turn);
        if (next == _dot) return false;

        _dot = next;
        Raise(nameof(Level));
        Raise(nameof(LevelKey));
        Raise(nameof(LevelText));
        Raise(nameof(Reason));
        Raise(nameof(SubtitleText));
        Raise(nameof(DotTooltip));
        Raise(nameof(AccessibleName));
        return true;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Raise([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name!));
}

/// <summary>
/// The sessions the operator has started, in the order they were started.
///
/// TROY'S SHAPE, 2026-07-30: "little pill buttons underneath the text box … press
/// the button for Claude or ChatGPT, Grok, whatever, Gemini, and it'll spin up a
/// fresh session, you can name it … And then all their stuff comes up on the left
/// side panel, interactive, with their name so you know which one is which, with
/// the stoplight."
///
/// A session ADDS to what is running — it never replaces the previous one. Closing
/// one is an explicit act.
///
/// NO PROCESSES LIVE HERE. This holds names, order, selection and dot state only.
/// The window owns the Node bridge per session and starts it on the FIRST SEND, not
/// at creation, because an idle session must cost nothing.
/// </summary>
public sealed class SessionShelf : INotifyPropertyChanged
{
    /// <summary>The four pills, left to right, in Troy's order.</summary>
    public static IReadOnlyList<string> PillLabels { get; } =
        ["Claude", "ChatGPT", "Grok", "Gemini"];

    private readonly ObservableCollection<AgentSession> _sessions = [];
    private AgentSession? _selected;
    private int _counter;

    public ObservableCollection<AgentSession> Sessions => _sessions;

    public AgentSession? Selected => _selected;

    public bool IsEmpty => _sessions.Count == 0;

    /// <summary>
    /// What the left panel says when there are no sessions. It states HOW to make
    /// one, so an empty list reads as "none started yet" rather than as a panel that
    /// failed to load.
    /// </summary>
    public string EmptyText =>
        "No sessions yet. Press one of the pills under the message box — Claude, ChatGPT, "
        + "Grok or Gemini — to start one and give it a name. A new session adds to what is "
        + "running; it does not replace anything.";

    /// <summary>
    /// A name that is free, e.g. "Claude 2". A suggestion only — Troy can type over it.
    /// </summary>
    public string SuggestName(string pillLabel)
    {
        var baseName = string.IsNullOrWhiteSpace(pillLabel) ? "Session" : pillLabel.Trim();
        for (var n = 1; n < 1000; n++)
        {
            var candidate = n == 1 ? baseName : $"{baseName} {n}";
            if (ValidateName(candidate) is null) return candidate;
        }

        return $"{baseName} {Guid.NewGuid():N}"[..24];
    }

    /// <summary>
    /// Null when the name may be used; otherwise the sentence explaining why not.
    /// Uniqueness is enforced because a session's guard cards are keyed on its name
    /// (<see cref="AgentSession.GuardProvider"/>) — two sessions called the same
    /// thing would share one dot and each would be showing the other's state.
    /// </summary>
    public string? ValidateName(string? name)
    {
        var trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return "Give the session a name so you can tell it apart from the others.";
        }

        if (trimmed.Length > 40)
        {
            return "That name is longer than 40 characters. Shorten it so the row stays readable.";
        }

        if (_sessions.Any(session =>
                string.Equals(session.Name, trimmed, StringComparison.OrdinalIgnoreCase)))
        {
            return $"There is already a session called \"{trimmed}\". "
                + "Names have to be unique — each one keys its own guard state.";
        }

        return null;
    }

    /// <summary>
    /// Start a session and select it. Throws when the name is not usable, so a
    /// caller cannot end up with a row whose name does not key its own state.
    /// </summary>
    public AgentSession Create(string pillLabel, string name, DateTimeOffset now)
    {
        var problem = ValidateName(name);
        if (problem is not null)
        {
            throw new ArgumentException(problem, nameof(name));
        }

        var isManager = string.Equals(pillLabel.Trim(), "Maestro", StringComparison.OrdinalIgnoreCase);
        var session = new AgentSession(
            $"session-{++_counter}-{Guid.NewGuid():N}"[..24],
            name.Trim(),
            // Manager is not a provider brand — wire key stays null; SessionTurnRouting
            // fills from the app Maestro setting on each turn.
            isManager ? null : MaestroKey.Normalize(pillLabel),
            isManager ? "Maestro" : (string.IsNullOrWhiteSpace(pillLabel) ? "Session" : pillLabel.Trim()),
            now,
            isManager: isManager);

        _sessions.Add(session);
        Select(session);
        Raise(nameof(IsEmpty));
        return session;
    }

    /// <summary>First manager session if any (for @ dispatch context).</summary>
    public AgentSession? Manager =>
        _sessions.FirstOrDefault(s => s.IsManager);

    public bool Select(AgentSession? session)
    {
        if (session is not null && !_sessions.Contains(session)) return false;
        if (ReferenceEquals(_selected, session)) return false;

        if (_selected is not null) _selected.IsSelected = false;
        _selected = session;
        if (_selected is not null) _selected.IsSelected = true;
        Raise(nameof(Selected));
        return true;
    }

    /// <summary>
    /// Close a session and hand back the one now selected, so the caller knows which
    /// transcript to show. Selection moves to the previous session in the list, or to
    /// null when that was the last one.
    /// </summary>
    public AgentSession? Close(AgentSession session)
    {
        var index = _sessions.IndexOf(session);
        if (index < 0) return _selected;

        var wasSelected = ReferenceEquals(_selected, session);
        session.IsSelected = false;
        _sessions.RemoveAt(index);

        if (wasSelected)
        {
            _selected = null;
            var next = _sessions.Count == 0
                ? null
                : _sessions[Math.Min(index, _sessions.Count - 1)];
            Select(next);
        }

        Raise(nameof(IsEmpty));
        return _selected;
    }

    public AgentSession? ById(string? id) =>
        string.IsNullOrEmpty(id)
            ? null
            : _sessions.FirstOrDefault(session => string.Equals(session.Id, id, StringComparison.Ordinal));

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Raise(string name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>
/// WHOSE transcript a line of console output lands in, and whether it is allowed to
/// reach the visible box.
///
/// This rule used to live inline in <c>MainWindow.AppendConsoleLine</c>, where the
/// smoke suite could not reach it — the test project references Core only
/// (Helmion.Desktop.SmokeTests.csproj:10-12). It is the rule that stops a turn running
/// in a session you are NOT looking at from scribbling into the transcript you ARE
/// looking at, so leaving it untestable meant the single most likely way for sessions
/// to bleed into each other was the one thing nothing checked. MainWindow now calls
/// this rather than carrying its own copy; there is one implementation, and it is this.
/// </summary>
public static class SessionOutputRouting
{
    /// <param name="Owner">
    /// The session whose transcript gets the text, or null when no session exists yet.
    /// </param>
    /// <param name="ShowOnScreen">
    /// Whether the line may also be appended to the visible console box.
    /// </param>
    public sealed record Destination(AgentSession? Owner, bool ShowOnScreen);

    /// <summary>
    /// <paramref name="turnSession"/> wins over <paramref name="selected"/> because
    /// output belongs to the session that PRODUCED it even if the operator switched
    /// away mid-turn. With no session at all the line goes straight to the box, which
    /// is exactly how the console behaved before sessions existed.
    /// </summary>
    public static Destination ForLine(AgentSession? turnSession, AgentSession? selected)
    {
        var owner = turnSession ?? selected;

        return owner is null
            ? new Destination(null, true)
            : new Destination(owner, ReferenceEquals(owner, selected));
    }
}

/// <summary>
/// WHERE a turn goes when the operator presses send: which session owns it, which
/// coordinator name goes on the wire, and whether it runs on the shared bridge or the
/// session's own.
///
/// Extracted from <c>MainWindow.SendConsoleInputAsync</c> for the same reason as
/// <see cref="SessionOutputRouting"/> — it decided which provider a keystroke reached
/// and nothing could test it. MainWindow calls this; it is not a parallel copy.
/// </summary>
public static class SessionTurnRouting
{
    /// <summary>
    /// What a turn runs on when no session is selected and settings name no
    /// coordinator. Preserves the console's long-standing default.
    /// </summary>
    public const string NoSessionFallbackProvider = "Gemini";

    /// <param name="Session">The session that owns the turn, or null for the shared console.</param>
    /// <param name="Provider">The coordinator name that goes on the wire.</param>
    /// <param name="UsesSharedBridge">
    /// True only when no session is selected. A session always runs on its OWN bridge
    /// process, so two sessions can never end up sharing one conversation.
    /// </param>
    public sealed record Route(AgentSession? Session, string Provider, bool UsesSharedBridge);

    /// <summary>
    /// A selected session routes to ITS coordinator, never to the Maestro setting —
    /// borrowing the global coordinator would run the turn on a provider the operator
    /// did not pick for this session while the row kept showing the one they did.
    ///
    /// A session with no route falls back to its own pill label rather than to the
    /// Maestro setting, for the same reason: it goes out as the unroutable thing it is
    /// and fails honestly, instead of quietly succeeding as somebody else's provider.
    /// Its preflight card already says so (<see cref="SessionPreflight.Evaluate"/>).
    /// </summary>
    public static Route ForTurn(AgentSession? selected, string? maestroCoordinator) =>
        selected is null
            ? new Route(null, maestroCoordinator ?? NoSessionFallbackProvider, true)
            : selected.IsManager
                // Manager uses the app Maestro coordinator (or its pinned key), never the literal "Maestro" label.
                ? new Route(
                    selected,
                    selected.ProviderKey
                        ?? MaestroKey.Normalize(maestroCoordinator)
                        ?? maestroCoordinator
                        ?? NoSessionFallbackProvider,
                    false)
                : new Route(selected, selected.ProviderKey ?? selected.PillLabel, false);

    /// <summary>
    /// What the console says when a send is refused because a turn is already running.
    /// It NAMES the session holding the line — which can be one the operator is not
    /// looking at — because that is the difference between a wait and a mystery.
    /// </summary>
    public static string BusyMessage(AgentSession? turnSession) =>
        turnSession is null
            ? "[Busy — console is mid-turn. Wait or Esc cancel. Other session pills can still run.]"
            : $"[Busy — \"{turnSession.Name}\" is mid-turn. Wait or Esc cancel. "
              + "Pick another agent pill to run in parallel.]";
}

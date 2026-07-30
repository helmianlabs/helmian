using System.Collections.ObjectModel;
using System.ComponentModel;

namespace Helmion.Desktop.Core;

/// <summary>
/// One inline choice on a card. <see cref="Key"/> is what the user reads and clicks
/// — "A", "B", "C", "D" or "1".."9" — and <see cref="ActionId"/> is what the host
/// actually does with it. They are separate because the letter is presentation and
/// the action is behaviour, and a card whose letters silently reorder must not
/// change which action a click performs.
/// </summary>
public sealed record GuardOption(string Key, string Label, string Detail, string ActionId)
{
    private const string Letters = "ABCDEFGH";

    /// <summary>A, B, C, D … by position. Falls back to the 1-based number past H.</summary>
    public static string LetterFor(int index) =>
        index >= 0 && index < Letters.Length
            ? Letters[index].ToString()
            : (index + 1).ToString();
}

/// <summary>
/// What a detection layer hands the panel. The panel is a dashboard, not a detector:
/// it renders these and never manufactures one.
/// </summary>
/// <param name="Provider">The tab this belongs under — a provider or site, e.g. "Claude", "Local".</param>
/// <param name="Source">Which detection layer said it, e.g. "Browser pattern match".</param>
/// <param name="Signature">The dedup key within (Provider, Source). Same signature = same card.</param>
/// <param name="Level">What the layer computed. Unknown when it could not tell.</param>
/// <param name="Options">Inline choices. Non-empty makes the card render large.</param>
/// <param name="ActionKind">Routing tag the host uses to decide what a click means. Empty = nothing acts on it.</param>
public sealed record GuardObservation(
    string Provider,
    string Source,
    string Signature,
    string Title,
    string Detail,
    GuardLevel Level,
    IReadOnlyList<GuardOption>? Options = null,
    string ActionKind = "");

/// <summary>
/// One row in the feed. Mutable and observable, because the same flag firing again
/// updates a card rather than adding a second one — that is the deduplication.
/// </summary>
public sealed class GuardCard : INotifyPropertyChanged
{
    private GuardVisual _visual;
    private bool _animationsEnabled = true;

    internal GuardCard(GuardObservation observation, DateTimeOffset firstSeen)
    {
        Provider = observation.Provider;
        Source = observation.Source;
        Signature = observation.Signature;
        Title = observation.Title;
        Detail = observation.Detail;
        ReportedLevel = observation.Level;
        ActionKind = observation.ActionKind;
        Options = observation.Options ?? [];
        FirstSeen = firstSeen;
        LastSeen = firstSeen;
        Occurrences = 1;
        _visual = GuardEscalationRule.Evaluate(ReportedLevel, 1, TimeSpan.Zero, false);
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public string Provider { get; private set; }
    public string Source { get; private set; }
    public string Signature { get; }
    public string Title { get; private set; }
    public string Detail { get; private set; }
    public string ActionKind { get; private set; }
    public GuardLevel ReportedLevel { get; private set; }
    public IReadOnlyList<GuardOption> Options { get; private set; }
    public DateTimeOffset FirstSeen { get; }
    public DateTimeOffset LastSeen { get; private set; }
    public int Occurrences { get; private set; }
    public DateTimeOffset? AcknowledgedAt { get; private set; }

    public GuardLevel Level => _visual.Level;
    public GuardMotion Motion => _visual.Motion;

    /// <summary>The one word the level is, for anyone who cannot use the colour.</summary>
    public string LevelText => _visual.LevelText;

    /// <summary>Level plus motion as words, so neither is carried by colour or movement alone.</summary>
    public string StateText => _visual.StateText;

    /// <summary>A shape as a third redundant channel: ? / ✓ / ! / ✖.</summary>
    public string Icon => _visual.Icon;

    /// <summary>Which threshold fired, with its number in it. Never "because".</summary>
    public string Reason => _visual.Reason;

    /// <summary>Colour-key for the template. A string so no converter is needed.</summary>
    public string LevelKey => _visual.Level switch
    {
        GuardLevel.Critical => "Critical",
        GuardLevel.Warning => "Warning",
        GuardLevel.Normal => "Normal",
        _ => "Unknown"
    };

    /// <summary>True when the rule says this card should be in motion, regardless of whether motion is permitted.</summary>
    public bool ShouldPulse => _visual.Motion == GuardMotion.Pulsing;

    /// <summary>
    /// Whether the animation may actually run. False when the OS asks for reduced
    /// motion — <see cref="ShouldPulse"/> stays true and the words still say
    /// "escalating", so the escalation is never carried by movement alone.
    /// </summary>
    public bool AnimatePulse => ShouldPulse && _animationsEnabled;

    public bool IsAcknowledged => AcknowledgedAt is not null;

    public string AcknowledgementText => AcknowledgedAt is null
        ? "Not acknowledged"
        : $"Acknowledged {AcknowledgedAt.Value:h:mm:ss tt}";

    /// <summary>The grouping count. "×1" is shown too, so a 1 is a measured 1 rather than a hidden default.</summary>
    public string OccurrenceText => $"×{Occurrences}";

    public string TimeText => LastSeen.ToString("HH:mm:ss");

    public string OriginText => $"{Provider} · {Source}";

    public GuardCardSize Size => GuardEscalationRule.SizeFor(Options.Count);

    public bool HasOptions => Options.Count > 0;

    /// <summary>True when nothing in the host will act on a click, so the card says so instead of pretending.</summary>
    public bool OptionsAreInert => Options.Count > 0 && string.IsNullOrEmpty(ActionKind);

    internal void SetAnimationsEnabled(bool enabled)
    {
        if (_animationsEnabled == enabled)
        {
            return;
        }

        _animationsEnabled = enabled;
        Raise(nameof(AnimatePulse));
    }

    /// <summary>A repeat sighting: bump the count, clear any acknowledgement, re-evaluate.</summary>
    internal void Observe(GuardObservation observation, DateTimeOffset now)
    {
        Provider = observation.Provider;
        Source = observation.Source;
        Title = observation.Title;
        Detail = observation.Detail;
        ActionKind = observation.ActionKind;
        Options = observation.Options ?? [];
        LastSeen = now;
        Occurrences++;

        // A level may only be raised by a repeat, never lowered. A flag that was
        // critical once does not become a warning because the next report was
        // milder — that would erase the worst thing the layer ever said.
        if (observation.Level > ReportedLevel)
        {
            ReportedLevel = observation.Level;
        }

        // A fresh sighting is new information, so a previous acknowledgement no
        // longer covers it and the motion comes back.
        AcknowledgedAt = null;

        Reevaluate(now);
        RaiseAll();
    }

    internal void Acknowledge(DateTimeOffset now)
    {
        AcknowledgedAt = now;
        Reevaluate(now);
        RaiseAll();
    }

    /// <summary>Re-run the rule against the clock. Age alone can escalate a card.</summary>
    internal bool Reevaluate(DateTimeOffset now)
    {
        var age = AcknowledgedAt is null ? now - LastSeen : TimeSpan.Zero;
        var next = GuardEscalationRule.Evaluate(
            ReportedLevel,
            Occurrences,
            age,
            AcknowledgedAt is not null);
        if (next == _visual)
        {
            return false;
        }

        _visual = next;
        RaiseAll();
        return true;
    }

    private void RaiseAll()
    {
        foreach (var name in new[]
                 {
                     nameof(Title), nameof(Detail), nameof(Level), nameof(Motion),
                     nameof(LevelText), nameof(StateText), nameof(Icon), nameof(Reason),
                     nameof(LevelKey), nameof(ShouldPulse), nameof(AnimatePulse),
                     nameof(IsAcknowledged), nameof(AcknowledgementText),
                     nameof(Occurrences), nameof(OccurrenceText), nameof(TimeText),
                     nameof(OriginText), nameof(Options), nameof(HasOptions),
                     nameof(Size), nameof(OptionsAreInert)
                 })
        {
            Raise(name);
        }
    }

    private void Raise(string name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>
/// One provider/site tab. Every number here is counted from the cards behind it —
/// there is no place to put a literal.
/// </summary>
public sealed record GuardTab(
    string Name,
    int Total,
    int Warnings,
    int Criticals,
    int Unknowns,
    bool IsActive)
{
    public string Label => $"{Name} ({Total})";
}

/// <summary>
/// The feed behind Troy's side panel: a persistent, always-visible list of what the
/// existing detection layers reported, deduplicated, grouped, retained to a limit,
/// and acknowledgeable.
///
/// WHAT IT IS NOT. It detects nothing. Every card here was handed to it by the
/// browser pattern match, the execution guard, the lease reader or the local
/// service. If no layer has reported, the feed is EMPTY AND SAYS SO — an empty
/// safety panel must never read as "all clear", which is why
/// <see cref="WorstLevel"/> is <see cref="GuardLevel.Unknown"/> rather than Normal
/// when nothing has registered.
/// </summary>
public sealed class GuardFeed : INotifyPropertyChanged
{
    /// <summary>Retention limit. Oldest card is dropped first, and the drop is counted and shown.</summary>
    public const int MaxRetainedCards = 200;

    public const string AllTab = "All";

    private readonly List<GuardCard> _cards = [];
    private readonly HashSet<string> _registeredSources = new(StringComparer.OrdinalIgnoreCase);
    private string _activeTab = AllTab;
    private bool _animationsEnabled = true;
    private int _droppedByRetention;

    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>The rows the panel renders, already filtered to <see cref="ActiveTab"/>.</summary>
    public ObservableCollection<GuardCard> Visible { get; } = [];

    public ObservableCollection<GuardTab> Tabs { get; } = [];

    public string ActiveTab
    {
        get => _activeTab;
        set
        {
            var next = string.IsNullOrWhiteSpace(value) ? AllTab : value;
            if (string.Equals(_activeTab, next, StringComparison.Ordinal))
            {
                return;
            }

            _activeTab = next;
            Rebuild();
        }
    }

    /// <summary>
    /// Whether pulse animations may run. Set from the OS reduced-motion setting.
    /// Turning it off never changes a level or hides an escalation — only the movement.
    /// </summary>
    public bool AnimationsEnabled
    {
        get => _animationsEnabled;
        set
        {
            if (_animationsEnabled == value)
            {
                return;
            }

            _animationsEnabled = value;
            foreach (var card in _cards)
            {
                card.SetAnimationsEnabled(value);
            }

            Raise(nameof(AnimationsEnabled));
            Raise(nameof(MotionPolicyText));
        }
    }

    public string MotionPolicyText => _animationsEnabled
        ? "Motion ON · pulsing animations play"
        : "Reduced motion ON · nothing animates; escalation is carried by the level word, the icon and the reason";

    public int DroppedByRetention => _droppedByRetention;

    public int TotalCards => _cards.Count;

    public int CriticalCount => _cards.Count(card => card.Level == GuardLevel.Critical);

    public int WarningCount => _cards.Count(card => card.Level == GuardLevel.Warning);

    public int UnknownCount => _cards.Count(card => card.Level == GuardLevel.Unknown);

    /// <summary>
    /// The panel's headline level. Unknown — never Normal — when no detection layer
    /// has reported, because "nobody is watching" and "nothing is wrong" must not
    /// render the same.
    /// </summary>
    public GuardLevel WorstLevel
    {
        get
        {
            if (_registeredSources.Count == 0)
            {
                return GuardLevel.Unknown;
            }

            var worst = GuardLevel.Normal;
            foreach (var card in _cards)
            {
                if (card.Level == GuardLevel.Critical)
                {
                    return GuardLevel.Critical;
                }

                if (Rank(card.Level) > Rank(worst))
                {
                    worst = card.Level;
                }
            }

            return worst;
        }
    }

    public string WorstLevelText => WorstLevel switch
    {
        GuardLevel.Critical => "CRITICAL",
        GuardLevel.Warning => "WARNING",
        GuardLevel.Normal => "OK",
        _ => "UNKNOWN"
    };

    public string WorstLevelKey => WorstLevel switch
    {
        GuardLevel.Critical => "Critical",
        GuardLevel.Warning => "Warning",
        GuardLevel.Normal => "Normal",
        _ => "Unknown"
    };

    /// <summary>
    /// States plainly whether anything is feeding this panel. The sentence a buyer
    /// reads when the list is empty decides whether an empty list means "clean" or
    /// "blind", so it says which.
    /// </summary>
    public string SourceText
    {
        get
        {
            if (_registeredSources.Count == 0)
            {
                return "No detection layer has reported to this panel. An empty feed here means "
                    + "nothing is connected — not that nothing was found.";
            }

            var names = string.Join(", ", _registeredSources.OrderBy(name => name, StringComparer.Ordinal));
            return $"Reporting layers: {names}.";
        }
    }

    public string RetentionText => _droppedByRetention == 0
        ? $"{_cards.Count} of at most {MaxRetainedCards} events retained."
        : $"{_cards.Count} of at most {MaxRetainedCards} events retained · "
          + $"{_droppedByRetention} older event{(_droppedByRetention == 1 ? string.Empty : "s")} dropped.";

    public string EscalationRuleText => GuardEscalationRule.StatedRule;

    /// <summary>
    /// Tell the panel a layer exists before it has anything to say. Without this an
    /// unreported layer and a silent one are indistinguishable.
    /// </summary>
    public void RegisterSource(string source)
    {
        if (string.IsNullOrWhiteSpace(source) || !_registeredSources.Add(source))
        {
            return;
        }

        Raise(nameof(SourceText));
        Raise(nameof(WorstLevel));
        Raise(nameof(WorstLevelText));
        Raise(nameof(WorstLevelKey));
    }

    /// <summary>
    /// Record one observation. Same (Provider, Source, Signature) updates the
    /// existing card and bumps its count; anything else becomes a new card.
    /// </summary>
    public GuardCard Report(GuardObservation observation, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(observation);
        RegisterSource(observation.Source);

        var existing = Find(observation.Provider, observation.Source, observation.Signature);
        if (existing is not null)
        {
            existing.Observe(observation, now);
            Rebuild();
            return existing;
        }

        var card = new GuardCard(observation, now);
        card.SetAnimationsEnabled(_animationsEnabled);
        _cards.Add(card);
        Trim();
        Rebuild();
        return card;
    }

    public GuardCard? Find(string provider, string source, string signature) =>
        _cards.FirstOrDefault(card =>
            string.Equals(card.Provider, provider, StringComparison.OrdinalIgnoreCase)
            && string.Equals(card.Source, source, StringComparison.OrdinalIgnoreCase)
            && string.Equals(card.Signature, signature, StringComparison.Ordinal));

    public bool Acknowledge(GuardCard card, DateTimeOffset now)
    {
        if (card is null || !_cards.Contains(card))
        {
            return false;
        }

        card.Acknowledge(now);
        Rebuild();
        return true;
    }

    public int AcknowledgeAll(DateTimeOffset now)
    {
        var acknowledged = 0;
        foreach (var card in _cards.Where(card => !card.IsAcknowledged))
        {
            card.Acknowledge(now);
            acknowledged++;
        }

        if (acknowledged > 0)
        {
            Rebuild();
        }

        return acknowledged;
    }

    /// <summary>
    /// Re-run the rule on every card against the current clock, because age alone
    /// escalates. Returns how many changed, so a caller can skip a redraw.
    /// </summary>
    public int Tick(DateTimeOffset now)
    {
        var changed = _cards.Count(card => card.Reevaluate(now));
        if (changed > 0)
        {
            RaiseCounts();
        }

        return changed;
    }

    /// <summary>Drops a card entirely. Used when a live question is answered elsewhere.</summary>
    public bool Remove(GuardCard card)
    {
        if (card is null || !_cards.Remove(card))
        {
            return false;
        }

        Rebuild();
        return true;
    }

    /// <summary>
    /// Severity order for the headline and the row order. This is DELIBERATELY NOT the
    /// enum's numeric order: <see cref="GuardLevel.Unknown"/> is 0 and
    /// <see cref="GuardLevel.Normal"/> is 1, so the obvious <c>level &gt; worst</c>
    /// comparison ranks "could not compute" as better than "checked and fine". That is
    /// exactly how this panel printed the headline OK over a grey UNKNOWN card — the
    /// contradiction the class documentation above forbids. An uncomputable state is
    /// worse than a clean one and quieter than a warning, so it sits between them.
    /// </summary>
    private static int Rank(GuardLevel level) => level switch
    {
        GuardLevel.Critical => 3,
        GuardLevel.Warning => 2,
        GuardLevel.Normal => 0,
        // Unknown, and any level this build does not recognise, rank above OK: an
        // unrecognised state is not evidence of health.
        _ => 1
    };

    private void Trim()
    {
        while (_cards.Count > MaxRetainedCards)
        {
            // Oldest first, and never a critical while a quieter card is available:
            // retention must not be the thing that hides the worst flag.
            var victim = _cards
                .OrderBy(card => card.Level == GuardLevel.Critical ? 1 : 0)
                .ThenBy(card => card.LastSeen)
                .First();
            _cards.Remove(victim);
            _droppedByRetention++;
        }
    }

    private void Rebuild()
    {
        RebuildTabs();

        var wanted = _cards
            .Where(card => string.Equals(_activeTab, AllTab, StringComparison.Ordinal)
                || string.Equals(card.Provider, _activeTab, StringComparison.OrdinalIgnoreCase))
            // Loudest first, then most recent. A red never sits below a grey, and an
            // uncomputable card never sits below an OK one — same Rank as the headline.
            .OrderByDescending(card => Rank(card.Level))
            .ThenByDescending(card => card.LastSeen)
            .ToList();

        Visible.Clear();
        foreach (var card in wanted)
        {
            Visible.Add(card);
        }

        RaiseCounts();
    }

    private void RebuildTabs()
    {
        var tabs = new List<GuardTab>
        {
            new(
                AllTab,
                _cards.Count,
                _cards.Count(card => card.Level == GuardLevel.Warning),
                _cards.Count(card => card.Level == GuardLevel.Critical),
                _cards.Count(card => card.Level == GuardLevel.Unknown),
                string.Equals(_activeTab, AllTab, StringComparison.Ordinal))
        };

        foreach (var group in _cards
                     .GroupBy(card => card.Provider, StringComparer.OrdinalIgnoreCase)
                     .OrderBy(group => group.Key, StringComparer.OrdinalIgnoreCase))
        {
            tabs.Add(new GuardTab(
                group.Key,
                group.Count(),
                group.Count(card => card.Level == GuardLevel.Warning),
                group.Count(card => card.Level == GuardLevel.Critical),
                group.Count(card => card.Level == GuardLevel.Unknown),
                string.Equals(_activeTab, group.Key, StringComparison.OrdinalIgnoreCase)));
        }

        Tabs.Clear();
        foreach (var tab in tabs)
        {
            Tabs.Add(tab);
        }
    }

    private void RaiseCounts()
    {
        foreach (var name in new[]
                 {
                     nameof(TotalCards), nameof(CriticalCount), nameof(WarningCount),
                     nameof(UnknownCount), nameof(WorstLevel), nameof(WorstLevelText),
                     nameof(WorstLevelKey), nameof(RetentionText), nameof(DroppedByRetention),
                     nameof(SourceText), nameof(ActiveTab)
                 })
        {
            Raise(name);
        }
    }

    private void Raise(string name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

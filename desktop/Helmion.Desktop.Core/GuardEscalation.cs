namespace Helmion.Desktop.Core;

/// <summary>
/// How serious a guard card is. <see cref="Unknown"/> is a first-class level, not a
/// missing value: a panel that cannot compute a state must say so on the card's
/// face rather than fall back to a confident colour.
/// </summary>
public enum GuardLevel
{
    /// <summary>The state could not be computed. Renders grey with the word UNKNOWN.</summary>
    Unknown = 0,

    /// <summary>Computed, and nothing is wrong. Grey. Never flashes.</summary>
    Normal = 1,

    /// <summary>A flag worth reading. Yellow.</summary>
    Warning = 2,

    /// <summary>A flag that needs an answer now. Red, and always in motion.</summary>
    Critical = 3
}

/// <summary>Whether a card is asking for attention by moving.</summary>
public enum GuardMotion
{
    /// <summary>Solid. No animation.</summary>
    Steady = 0,

    /// <summary>Pulsing, because the escalation threshold below has been crossed.</summary>
    Pulsing = 1
}

/// <summary>Compact for a one-line flag; expanded when the card carries options.</summary>
public enum GuardCardSize
{
    Compact = 0,
    Expanded = 1
}

/// <summary>
/// The rendered result of the escalation rule. Every field is a redundant channel
/// for the same fact, so no single channel — least of all colour — is load-bearing:
/// <see cref="Level"/> drives colour, <see cref="LevelText"/> and
/// <see cref="StateText"/> are words, <see cref="Icon"/> is a shape, and
/// <see cref="Reason"/> names the number that fired.
/// </summary>
public sealed record GuardVisual(
    GuardLevel Level,
    GuardMotion Motion,
    string LevelText,
    string StateText,
    string Icon,
    string Reason);

/// <summary>
/// THE ESCALATION RULE, with its thresholds as named constants so the panel can
/// print the same numbers it obeys. Troy's requirement was that the point at which
/// yellow becomes red is stated and visible, not magic — so
/// <see cref="StatedRule"/> is rendered verbatim in the panel and is built from
/// these very constants.
///
/// The shape Troy asked for, in order:
///   grey  → never moves (Normal and Unknown are both quiet)
///   yellow SOLID   → a warning that has not yet crossed a threshold
///   yellow PULSING → the warning before critical: a threshold has been crossed
///   red PULSING    → critical, and red is in motion from its first frame; it is
///                    never rendered solid, because a static red is indistinguishable
///                    from a red somebody already dealt with.
///
/// Deliberately a pure function of its four arguments. No clock, no rendering, no
/// UI types — so the state machine can be proven without a window
/// (see GuardEscalationChecks in the smoke suite).
/// </summary>
public static class GuardEscalationRule
{
    /// <summary>
    /// The occurrence count at which a yellow card starts pulsing. The first
    /// sighting counts as 1, so this fires on the third time the same flag is seen.
    /// </summary>
    public const int PulseAfterOccurrences = 3;

    /// <summary>The occurrence count at which a yellow card becomes red.</summary>
    public const int CriticalAfterOccurrences = 5;

    /// <summary>How long an unacknowledged yellow card may sit still before it pulses.</summary>
    public static readonly TimeSpan PulseAfterUnacknowledged = TimeSpan.FromMinutes(2);

    /// <summary>How long an unacknowledged yellow card may sit before it turns red.</summary>
    public static readonly TimeSpan CriticalAfterUnacknowledged = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Short face copy for the Guard panel (not a tutorial). Numbers still come from the constants.
    /// Full prose: <see cref="StatedRuleDetail"/> (settings / docs only).
    /// </summary>
    public static string StatedRule =>
        $"Yellow → red at ×{CriticalAfterOccurrences} or {CriticalAfterUnacknowledged.TotalMinutes:0} min. "
        + $"Pulse at ×{PulseAfterOccurrences} or {PulseAfterUnacknowledged.TotalMinutes:0} min. Ack hides non-criticals.";

    /// <summary>Long form for Guard settings only — not the main feed.</summary>
    public static string StatedRuleDetail =>
        $"Grey never moves. A yellow card is solid until it has been seen "
        + $"{PulseAfterOccurrences} times or sat unanswered for "
        + $"{PulseAfterUnacknowledged.TotalMinutes:0} minutes — then it pulses. At "
        + $"{CriticalAfterOccurrences} sightings or "
        + $"{CriticalAfterUnacknowledged.TotalMinutes:0} minutes unanswered it turns red. "
        + "Red is never solid — it pulses from the first frame. Acknowledge stops motion; a fresh sighting restores it.";

    /// <summary>
    /// Evaluate one card.
    /// </summary>
    /// <param name="reported">What the detection layer said. Unknown means it could not tell.</param>
    /// <param name="occurrences">How many times this exact flag has been seen. First sighting = 1.</param>
    /// <param name="unacknowledgedFor">How long since it was last seen and not answered.</param>
    /// <param name="acknowledged">Whether a human has acknowledged the current occurrence.</param>
    public static GuardVisual Evaluate(
        GuardLevel reported,
        int occurrences,
        TimeSpan unacknowledgedFor,
        bool acknowledged)
    {
        // A negative age is a caller bug, not a reason to escalate. Clamp rather
        // than letting a clock skew invent a critical.
        if (unacknowledgedFor < TimeSpan.Zero)
        {
            unacknowledgedFor = TimeSpan.Zero;
        }

        var seen = occurrences < 1 ? 1 : occurrences;

        switch (reported)
        {
            case GuardLevel.Unknown:
                // The single most important branch in this file. An unknown state
                // never escalates and never goes green: it is grey, it says the
                // word UNKNOWN, and it says why it could not be computed.
                return new GuardVisual(
                    GuardLevel.Unknown,
                    GuardMotion.Steady,
                    "UNKNOWN",
                    "UNKNOWN · state not computed",
                    "?",
                    "This state could not be computed, so it is shown as Unknown rather than guessed.");

            case GuardLevel.Normal:
                return new GuardVisual(
                    GuardLevel.Normal,
                    GuardMotion.Steady,
                    "OK",
                    "OK · steady",
                    "✓",
                    "Computed, and nothing is flagged. Grey never pulses.");

            case GuardLevel.Critical:
                return new GuardVisual(
                    GuardLevel.Critical,
                    acknowledged ? GuardMotion.Steady : GuardMotion.Pulsing,
                    "CRITICAL",
                    acknowledged ? "CRITICAL · acknowledged" : "CRITICAL · needs an answer now",
                    "✖",
                    acknowledged
                        ? "Reported critical by the detection layer. Acknowledged, so the motion is stopped; the level is unchanged."
                        : "Reported critical by the detection layer. Red pulses from its first frame and is never rendered solid.");

            case GuardLevel.Warning:
                break;

            default:
                // An enum value nobody defined is exactly the case that must not
                // render as a confident colour.
                return new GuardVisual(
                    GuardLevel.Unknown,
                    GuardMotion.Steady,
                    "UNKNOWN",
                    "UNKNOWN · unrecognised level",
                    "?",
                    $"The detection layer reported level {(int)reported}, which this panel does not recognise.");
        }

        // --- yellow, and the only branch where thresholds apply -----------------
        var occurrenceCritical = seen >= CriticalAfterOccurrences;
        var ageCritical = unacknowledgedFor >= CriticalAfterUnacknowledged;
        if (occurrenceCritical || ageCritical)
        {
            var reason = occurrenceCritical
                ? $"Seen {seen} times, at or past the {CriticalAfterOccurrences}-sighting red threshold."
                : $"Unanswered for {Describe(unacknowledgedFor)}, at or past the "
                  + $"{CriticalAfterUnacknowledged.TotalMinutes:0}-minute red threshold.";
            return new GuardVisual(
                GuardLevel.Critical,
                acknowledged ? GuardMotion.Steady : GuardMotion.Pulsing,
                "CRITICAL",
                acknowledged ? "CRITICAL · acknowledged" : "CRITICAL · escalated from warning",
                "✖",
                acknowledged ? $"{reason} Acknowledged, so the motion is stopped; the level is unchanged." : reason);
        }

        var occurrencePulse = seen >= PulseAfterOccurrences;
        var agePulse = unacknowledgedFor >= PulseAfterUnacknowledged;
        if (occurrencePulse || agePulse)
        {
            var reason = occurrencePulse
                ? $"Seen {seen} times, at or past the {PulseAfterOccurrences}-sighting pulse threshold. "
                  + $"Turns red at {CriticalAfterOccurrences}."
                : $"Unanswered for {Describe(unacknowledgedFor)}, at or past the "
                  + $"{PulseAfterUnacknowledged.TotalMinutes:0}-minute pulse threshold. Turns red at "
                  + $"{CriticalAfterUnacknowledged.TotalMinutes:0} minutes.";
            return new GuardVisual(
                GuardLevel.Warning,
                acknowledged ? GuardMotion.Steady : GuardMotion.Pulsing,
                "WARNING",
                acknowledged ? "WARNING · acknowledged" : "WARNING · escalating toward critical",
                "!",
                acknowledged ? $"{reason} Acknowledged, so the motion is stopped; the level is unchanged." : reason);
        }

        return new GuardVisual(
            GuardLevel.Warning,
            GuardMotion.Steady,
            "WARNING",
            acknowledged ? "WARNING · acknowledged" : "WARNING · solid",
            "!",
            $"Seen {seen} time{(seen == 1 ? string.Empty : "s")}, unanswered for "
            + $"{Describe(unacknowledgedFor)}. Pulses at {PulseAfterOccurrences} sightings or "
            + $"{PulseAfterUnacknowledged.TotalMinutes:0} minutes.");
    }

    /// <summary>A card carrying options renders large so the options are clickable inline.</summary>
    public static GuardCardSize SizeFor(int optionCount) =>
        optionCount > 0 ? GuardCardSize.Expanded : GuardCardSize.Compact;

    private static string Describe(TimeSpan span)
    {
        if (span < TimeSpan.FromSeconds(1))
        {
            return "under a second";
        }

        if (span < TimeSpan.FromMinutes(1))
        {
            return $"{span.TotalSeconds:0}s";
        }

        return $"{span.TotalMinutes:0.#} min";
    }
}

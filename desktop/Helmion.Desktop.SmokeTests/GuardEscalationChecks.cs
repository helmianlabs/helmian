using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under <see cref="GuardEscalationRule"/>.
///
/// WHY THIS EXISTS. GuardEscalation.cs:72 states, in its own documentation, that the
/// state machine "can be proven without a window (see GuardEscalationChecks in the
/// smoke suite)". That sentence was written; this class was not. The build stayed
/// green and every escalation threshold in the product — the numbers the panel
/// prints to a buyer and claims to obey — was unverified.
///
/// Everything here is asserted against the RULE'S OWN CONSTANTS, never against
/// literals. Retuning a threshold moves these checks with it; deleting a threshold's
/// effect breaks them. A boundary is tested ON the threshold and one step below it,
/// because a >= written as > lands exactly there and passes every other case.
/// </summary>
internal static class GuardEscalationChecks
{
    public static void Run()
    {
        var checks = 0;

        var pulseAt = GuardEscalationRule.PulseAfterOccurrences;
        var redAt = GuardEscalationRule.CriticalAfterOccurrences;
        var pulseAge = GuardEscalationRule.PulseAfterUnacknowledged;
        var redAge = GuardEscalationRule.CriticalAfterUnacknowledged;
        var oneTick = TimeSpan.FromSeconds(1);

        // --- 0. The thresholds have to be orderable, or every case below is vacuous.
        Assert(pulseAt >= 1 && redAt > pulseAt, "the pulse threshold sits below the red threshold");
        Assert(pulseAge > TimeSpan.Zero && redAge > pulseAge, "the pulse age sits below the red age");
        checks += 2;

        // --- 1. UNKNOWN never escalates and never renders as OK ------------------
        // The single most important branch: a state that could not be computed must
        // stay grey and say so, no matter how often it is seen or how long it sits.
        foreach (var (seen, age) in new[]
                 {
                     (1, TimeSpan.Zero),
                     (redAt * 10, redAge * 10),
                     (int.MaxValue, TimeSpan.FromDays(30))
                 })
        {
            var unknown = GuardEscalationRule.Evaluate(GuardLevel.Unknown, seen, age, false);
            Assert(unknown.Level == GuardLevel.Unknown, "an uncomputable state stays Unknown however often it is seen");
            Assert(unknown.Motion == GuardMotion.Steady, "an Unknown card never pulses");
            Assert(unknown.LevelText == "UNKNOWN", "an Unknown card says the word UNKNOWN");
            Assert(unknown.Icon == "?", "an Unknown card carries the ? icon as a non-colour channel");
            checks += 4;
        }

        // --- 2. NORMAL is quiet, permanently ------------------------------------
        foreach (var (seen, age) in new[] { (1, TimeSpan.Zero), (redAt * 4, redAge * 4) })
        {
            var normal = GuardEscalationRule.Evaluate(GuardLevel.Normal, seen, age, false);
            Assert(normal.Level == GuardLevel.Normal, "a Normal card never escalates on repetition or age");
            Assert(normal.Motion == GuardMotion.Steady, "grey never moves");
            Assert(normal.LevelText == "OK", "a Normal card says OK in words");
            checks += 3;
        }

        // --- 3. RED IS NEVER SOLID ----------------------------------------------
        // A static red is indistinguishable from a red somebody already handled, so
        // a reported critical pulses from its first frame.
        var freshCritical = GuardEscalationRule.Evaluate(GuardLevel.Critical, 1, TimeSpan.Zero, false);
        Assert(freshCritical.Level == GuardLevel.Critical, "a reported critical stays critical");
        Assert(freshCritical.Motion == GuardMotion.Pulsing, "red pulses on its very first frame");
        Assert(freshCritical.LevelText == "CRITICAL" && freshCritical.Icon == "✖",
            "a critical states CRITICAL in words and carries the ✖ icon");
        checks += 3;

        // --- 4. YELLOW: solid below both thresholds -----------------------------
        var quietWarning = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, TimeSpan.Zero, false);
        Assert(quietWarning.Level == GuardLevel.Warning, "a first-sighting warning is a warning");
        Assert(quietWarning.Motion == GuardMotion.Steady, "a warning below both thresholds is solid");
        Assert(quietWarning.LevelText == "WARNING" && quietWarning.Icon == "!",
            "a warning states WARNING in words and carries the ! icon");
        checks += 3;

        // --- 5. THE OCCURRENCE BOUNDARY, on the number and one below it ---------
        var justBelowPulse = GuardEscalationRule.Evaluate(GuardLevel.Warning, pulseAt - 1, TimeSpan.Zero, false);
        Assert(justBelowPulse.Motion == GuardMotion.Steady,
            "one sighting below the pulse threshold is still solid");
        var onPulse = GuardEscalationRule.Evaluate(GuardLevel.Warning, pulseAt, TimeSpan.Zero, false);
        Assert(onPulse.Level == GuardLevel.Warning && onPulse.Motion == GuardMotion.Pulsing,
            "ON the pulse threshold the card pulses and is still yellow — the warning before critical");
        var justBelowRed = GuardEscalationRule.Evaluate(GuardLevel.Warning, redAt - 1, TimeSpan.Zero, false);
        Assert(justBelowRed.Level == GuardLevel.Warning,
            "one sighting below the red threshold is still yellow");
        var onRed = GuardEscalationRule.Evaluate(GuardLevel.Warning, redAt, TimeSpan.Zero, false);
        Assert(onRed.Level == GuardLevel.Critical && onRed.Motion == GuardMotion.Pulsing,
            "ON the red threshold the card is critical and pulsing");
        checks += 4;

        // --- 6. THE AGE BOUNDARY, same shape ------------------------------------
        var justBelowPulseAge = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, pulseAge - oneTick, false);
        Assert(justBelowPulseAge.Motion == GuardMotion.Steady,
            "a second below the pulse age is still solid");
        var onPulseAge = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, pulseAge, false);
        Assert(onPulseAge.Level == GuardLevel.Warning && onPulseAge.Motion == GuardMotion.Pulsing,
            "ON the pulse age a single-sighting warning pulses");
        var justBelowRedAge = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, redAge - oneTick, false);
        Assert(justBelowRedAge.Level == GuardLevel.Warning,
            "a second below the red age is still yellow");
        var onRedAge = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, redAge, false);
        Assert(onRedAge.Level == GuardLevel.Critical && onRedAge.Motion == GuardMotion.Pulsing,
            "ON the red age a single-sighting warning turns red");
        checks += 4;

        // Either signal alone is sufficient: age escalates a card seen exactly once,
        // and occurrences escalate a card with no age at all. Both proven above, so
        // neither can be quietly made dependent on the other.

        // --- 7. ACKNOWLEDGEMENT STOPS MOTION AND KEEPS THE LEVEL ----------------
        // The failure to avoid is acknowledgement being implemented as "make it OK".
        var ackWarning = GuardEscalationRule.Evaluate(GuardLevel.Warning, pulseAt, TimeSpan.Zero, true);
        Assert(ackWarning.Level == GuardLevel.Warning, "acknowledging an escalating warning keeps it a warning");
        Assert(ackWarning.Motion == GuardMotion.Steady, "acknowledging stops the motion");
        var ackEscalated = GuardEscalationRule.Evaluate(GuardLevel.Warning, redAt, TimeSpan.Zero, true);
        Assert(ackEscalated.Level == GuardLevel.Critical,
            "acknowledging a card past the red threshold does not demote it out of critical");
        Assert(ackEscalated.Motion == GuardMotion.Steady, "an acknowledged critical is allowed to be still");
        var ackReported = GuardEscalationRule.Evaluate(GuardLevel.Critical, 1, TimeSpan.Zero, true);
        Assert(ackReported.Level == GuardLevel.Critical && ackReported.Motion == GuardMotion.Steady,
            "acknowledging a reported critical stops the motion without changing the level");
        Assert(ackReported.StateText.Contains("acknowledged", StringComparison.OrdinalIgnoreCase),
            "an acknowledged card says so in words, not only by having stopped moving");
        checks += 6;

        // --- 8. A CLOCK GOING BACKWARDS MUST NOT INVENT AN ESCALATION -----------
        var negative = GuardEscalationRule.Evaluate(GuardLevel.Warning, 1, TimeSpan.FromMinutes(-90), false);
        Assert(negative.Level == GuardLevel.Warning && negative.Motion == GuardMotion.Steady,
            "a negative age clamps to zero instead of escalating");
        checks += 1;

        // --- 9. A ZERO OR NEGATIVE COUNT IS ONE SIGHTING, NOT NONE --------------
        foreach (var seen in new[] { 0, -5 })
        {
            var clamped = GuardEscalationRule.Evaluate(GuardLevel.Warning, seen, TimeSpan.Zero, false);
            Assert(clamped.Level == GuardLevel.Warning && clamped.Motion == GuardMotion.Steady,
                "a nonsensical occurrence count is treated as the first sighting");
            Assert(clamped.Reason.Contains("1 time", StringComparison.Ordinal),
                "the clamped count is reported as 1, not as the caller's nonsense");
            checks += 2;
        }

        // --- 10. AN ENUM VALUE NOBODY DEFINED IS UNKNOWN, NOT A CONFIDENT COLOUR
        var bogus = GuardEscalationRule.Evaluate((GuardLevel)97, 1, TimeSpan.Zero, false);
        Assert(bogus.Level == GuardLevel.Unknown, "an unrecognised level falls to Unknown, never to a colour");
        Assert(bogus.Motion == GuardMotion.Steady, "an unrecognised level does not pulse");
        Assert(bogus.Reason.Contains("97", StringComparison.Ordinal),
            "the unrecognised level number is named in the reason so it can be traced");
        checks += 3;

        // --- 11. THE REASON NAMES THE NUMBER THAT FIRED -------------------------
        // "Because it escalated" is useless. The threshold that fired is printed.
        Assert(onPulse.Reason.Contains(pulseAt.ToString(), StringComparison.Ordinal),
            "an occurrence-pulsed card names the sighting count that fired");
        Assert(onRed.Reason.Contains(redAt.ToString(), StringComparison.Ordinal),
            "an occurrence-reddened card names the sighting count that fired");
        Assert(onPulseAge.Reason.Contains(pulseAge.TotalMinutes.ToString("0"), StringComparison.Ordinal),
            "an age-pulsed card names the minute threshold that fired");
        Assert(onRedAge.Reason.Contains(redAge.TotalMinutes.ToString("0"), StringComparison.Ordinal),
            "an age-reddened card names the minute threshold that fired");
        checks += 4;

        // --- 12. EVERY VISUAL FILLS EVERY NON-COLOUR CHANNEL --------------------
        // Colour is not allowed to be the only carrier, so no channel may be blank.
        foreach (var level in new[]
                 {
                     GuardLevel.Unknown, GuardLevel.Normal, GuardLevel.Warning, GuardLevel.Critical
                 })
        {
            foreach (var acknowledged in new[] { false, true })
            {
                var visual = GuardEscalationRule.Evaluate(level, pulseAt, pulseAge, acknowledged);
                Assert(!string.IsNullOrWhiteSpace(visual.LevelText), $"{level} fills the level word");
                Assert(!string.IsNullOrWhiteSpace(visual.StateText), $"{level} fills the state sentence");
                Assert(!string.IsNullOrWhiteSpace(visual.Icon), $"{level} fills the icon channel");
                Assert(!string.IsNullOrWhiteSpace(visual.Reason), $"{level} fills the reason");
                checks += 4;
            }
        }

        // --- 13. THE PRINTED RULE CANNOT DRIFT FROM THE OBEYED RULE -------------
        // The panel shows StatedRule to the user. If a constant is retuned and the
        // sentence is hand-written, the product lies about its own thresholds.
        var stated = GuardEscalationRule.StatedRule;
        Assert(stated.Contains(pulseAt.ToString(), StringComparison.Ordinal),
            "the stated rule prints the pulse sighting threshold it obeys");
        Assert(stated.Contains(redAt.ToString(), StringComparison.Ordinal),
            "the stated rule prints the red sighting threshold it obeys");
        Assert(stated.Contains(pulseAge.TotalMinutes.ToString("0"), StringComparison.Ordinal),
            "the stated rule prints the pulse age threshold it obeys");
        Assert(stated.Contains(redAge.TotalMinutes.ToString("0"), StringComparison.Ordinal),
            "the stated rule prints the red age threshold it obeys");
        Assert(stated.Contains("never solid", StringComparison.OrdinalIgnoreCase),
            "the stated rule tells the reader red is never solid");
        Assert(stated.Contains("Grey never moves", StringComparison.Ordinal),
            "the stated rule tells the reader grey never moves");
        checks += 6;

        // --- 14. A CARD WITH CHOICES RENDERS LARGE ------------------------------
        Assert(GuardEscalationRule.SizeFor(0) == GuardCardSize.Compact,
            "a card with no options stays compact");
        Assert(GuardEscalationRule.SizeFor(1) == GuardCardSize.Expanded
            && GuardEscalationRule.SizeFor(4) == GuardCardSize.Expanded,
            "a card carrying options grows so the options are clickable inline");
        Assert(GuardEscalationRule.SizeFor(-1) == GuardCardSize.Compact,
            "a negative option count does not grow the card");
        checks += 3;

        Console.WriteLine($"Helmion guard escalation checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Guard escalation rule failed: {what}");
        }
    }
}

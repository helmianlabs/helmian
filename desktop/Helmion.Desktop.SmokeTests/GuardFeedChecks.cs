using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under <see cref="GuardFeed"/> — the list behind the side panel.
///
/// WHY THIS EXISTS. The feed shipped with 590 lines of deduplication, retention,
/// grouping, acknowledgement and reduced-motion behaviour and zero tests. Its own
/// documentation makes a safety promise at GuardFeed.cs:326-330 — that an empty or
/// uncomputable panel must never render the same as a clean one — and nothing
/// enforced it.
///
/// The checks assert against <see cref="GuardFeed.MaxRetainedCards"/> and the rule's
/// constants rather than literals, so retuning a limit moves the checks with it.
/// </summary>
internal static class GuardFeedChecks
{
    private static readonly DateTimeOffset T0 =
        new(2026, 7, 29, 20, 0, 0, TimeSpan.Zero);

    public static void Run()
    {
        var checks = 0;

        // --- 1. NOTHING CONNECTED MUST NOT READ AS ALL CLEAR --------------------
        var blind = new GuardFeed();
        Assert(blind.TotalCards == 0, "a new feed holds no cards");
        Assert(blind.WorstLevel == GuardLevel.Unknown,
            "a feed no layer has reported to is UNKNOWN, not OK — nobody watching is not nothing wrong");
        Assert(blind.WorstLevelText == "UNKNOWN", "the blind headline says UNKNOWN in words");
        Assert(blind.WorstLevelKey == "Unknown", "the blind headline colour key is Unknown, not Normal");
        Assert(blind.SourceText.Contains("nothing is connected", StringComparison.OrdinalIgnoreCase),
            "an empty feed states that an empty list means nothing is connected");
        checks += 5;

        // --- 2. A REGISTERED LAYER WITH NOTHING TO SAY IS GENUINELY OK ----------
        var quiet = new GuardFeed();
        quiet.RegisterSource("Browser pattern match");
        Assert(quiet.WorstLevel == GuardLevel.Normal,
            "once a layer has registered and found nothing, the headline is OK");
        Assert(quiet.SourceText.Contains("Browser pattern match", StringComparison.Ordinal),
            "the feed names the layers reporting to it");
        checks += 2;

        // --- 3. AN UNCOMPUTABLE CARD MUST NOT LEAVE THE HEADLINE AT OK ---------
        // GuardLevel.Unknown is enum 0 and Normal is 1, so a "worst wins" comparison
        // written as `level > worst` silently ranks "could not compute" as BETTER
        // than "checked and fine". The panel would show a grey UNKNOWN card while
        // its own headline read OK — the exact contradiction GuardFeed.cs:326-330
        // says must never render.
        var murky = new GuardFeed();
        murky.Report(
            new GuardObservation("Claude", "Lease reader", "lease-unreadable",
                "Lease state could not be read", "The lease file is present but unparseable.",
                GuardLevel.Unknown),
            T0);
        Assert(murky.UnknownCount == 1, "the uncomputable card is counted as Unknown");
        Assert(murky.WorstLevel != GuardLevel.Normal,
            "a feed whose only card is UNKNOWN must not report the headline OK");
        Assert(murky.WorstLevel == GuardLevel.Unknown,
            "an uncomputable card carries the headline to UNKNOWN");
        Assert(murky.WorstLevelText == "UNKNOWN", "that headline says UNKNOWN in words");
        checks += 4;

        // A real flag still outranks an uncomputable one — Unknown sits between OK
        // and yellow, it does not outrank a warning.
        murky.Report(
            new GuardObservation("Claude", "Browser pattern match", "rm-rf",
                "Destructive shell command", "rm -rf /", GuardLevel.Warning),
            T0);
        Assert(murky.WorstLevel == GuardLevel.Warning,
            "a warning outranks an uncomputable card in the headline");
        checks += 1;

        // ...and a critical outranks everything.
        murky.Report(
            new GuardObservation("Claude", "Execution guard", "drop-table",
                "Destructive SQL", "DROP TABLE loads", GuardLevel.Critical),
            T0);
        Assert(murky.WorstLevel == GuardLevel.Critical, "a critical takes the headline");
        Assert(murky.CriticalCount == 1 && murky.WarningCount == 1 && murky.UnknownCount == 1,
            "each level is counted separately from the cards behind it");
        checks += 2;

        // --- 4. THE SAME FLAG TWICE IS ONE CARD, COUNTED TWICE -----------------
        var feed = new GuardFeed();
        var first = feed.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0);
        Assert(feed.TotalCards == 1 && first.Occurrences == 1, "the first sighting creates one card");
        Assert(first.OccurrenceText == "×1", "a count of one is shown, not hidden as a default");
        var again = feed.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0.AddSeconds(5));
        Assert(ReferenceEquals(first, again), "the same signature updates the existing card");
        Assert(feed.TotalCards == 1, "deduplication does not add a second row");
        Assert(again.Occurrences == 2, "a repeat sighting bumps the count");
        Assert(again.LastSeen == T0.AddSeconds(5), "a repeat sighting moves LastSeen");
        Assert(again.FirstSeen == T0, "a repeat sighting leaves FirstSeen alone");
        checks += 7;

        // A different signature is a different flag.
        feed.Report(Warning("Claude", "Browser pattern match", "drop-table"), T0);
        Assert(feed.TotalCards == 2, "a different signature is a different card");
        checks += 1;

        // Signature is the dedup key and is matched exactly; provider and source are
        // matched case-insensitively because they are display names.
        feed.Report(Warning("Claude", "Browser pattern match", "RM-RF"), T0);
        Assert(feed.TotalCards == 3, "signatures are matched exactly — case is meaningful in a pattern key");
        var caseFold = feed.Report(Warning("claude", "browser pattern match", "rm-rf"), T0.AddSeconds(9));
        Assert(ReferenceEquals(caseFold, first) && feed.TotalCards == 3,
            "a provider or source differing only by case is the same card");
        checks += 2;

        // --- 5. A FRESH SIGHTING CLEARS AN ACKNOWLEDGEMENT ---------------------
        // Otherwise one click silences a flag permanently, including its next
        // occurrence, which is how a real warning gets lost.
        var acked = new GuardFeed();
        var card = acked.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0);
        Assert(acked.Acknowledge(card, T0.AddSeconds(1)), "a card in the feed can be acknowledged");
        Assert(card.IsAcknowledged && !card.ShouldPulse, "acknowledging stops the motion");
        Assert(card.AcknowledgementText.Contains("Acknowledged", StringComparison.Ordinal),
            "the acknowledgement is stated in words on the card");
        acked.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0.AddSeconds(2));
        Assert(!card.IsAcknowledged,
            "a fresh sighting clears the acknowledgement — new information is not covered by an old click");
        checks += 4;

        // --- 6. A LEVEL MAY BE RAISED BY A REPEAT, NEVER LOWERED ---------------
        var raise = new GuardFeed();
        var raised = raise.Report(
            new GuardObservation("Claude", "Execution guard", "sig", "t", "d", GuardLevel.Critical), T0);
        raise.Report(
            new GuardObservation("Claude", "Execution guard", "sig", "t", "d", GuardLevel.Warning),
            T0.AddSeconds(1));
        Assert(raised.ReportedLevel == GuardLevel.Critical,
            "a milder repeat never erases the worst thing the detection layer ever said");
        checks += 1;

        // --- 6b. RECOVERY IS NOT A MILDER REPEAT -------------------------------
        // Found on the live panel, 2026-07-29, and it is the reason this section
        // exists twice. The local-service card was reported Warning while the
        // named pipe was down, hit the 5-sighting threshold and turned red. The
        // pipe then came up. Title and detail updated to "Local service
        // connected · the named pipe answered" — but the level could only ever
        // be raised, so the card kept rendering CRITICAL, and every refresh bumped
        // the count higher: observed at ×6, then ×7, while the service was
        // healthy the whole time.
        //
        // A card whose words say fine and whose colour says emergency is worse
        // than no card. The distinction that fixes it: Normal means the layer
        // COMPUTED the state and found nothing wrong — the condition cleared.
        // That is different information from a milder repeat of a live problem,
        // and it must be allowed to bring the card down.
        var recover = new GuardFeed();
        var down = new GuardObservation(
            "Local", "Local service", "local-service-state",
            "Local service not connected", "the named pipe is not answering", GuardLevel.Warning);
        var up = new GuardObservation(
            "Local", "Local service", "local-service-state",
            "Local service connected", "the named pipe answered", GuardLevel.Normal);

        var serviceCard = recover.Report(down, T0);
        for (var i = 1; i < GuardEscalationRule.CriticalAfterOccurrences; i += 1)
        {
            recover.Report(down, T0.AddSeconds(i));
        }
        Assert(serviceCard.Level == GuardLevel.Critical,
            "the precondition for this check: repeated warnings do escalate to red");

        recover.Report(up, T0.AddSeconds(30));
        Assert(serviceCard.ReportedLevel == GuardLevel.Normal,
            "a layer reporting the condition CLEARED lowers the card — recovery is not a milder repeat");
        Assert(serviceCard.Level == GuardLevel.Normal,
            "a recovered card must stop rendering red while its own text says it is connected");
        Assert(serviceCard.Occurrences == 1,
            "recovery restarts the count, so old sightings cannot instantly re-escalate the healthy state");

        // Unknown is NOT recovery. A state nobody could compute must never clear
        // a real flag — that would be the panel going quiet because it went blind.
        var blindAfterFlag = new GuardFeed();
        var flagged = blindAfterFlag.Report(down, T0);
        blindAfterFlag.Report(
            new GuardObservation("Local", "Local service", "local-service-state",
                "Local service state unknown", "the probe did not answer", GuardLevel.Unknown),
            T0.AddSeconds(1));
        Assert(flagged.ReportedLevel == GuardLevel.Warning,
            "an Unknown repeat does not clear a warning — could-not-tell is not all-clear");
        checks += 5;

        // --- 7. GROUPING: TABS ARE COUNTED, NEVER LITERAL ----------------------
        var grouped = new GuardFeed();
        grouped.Report(Warning("Claude", "Browser pattern match", "a"), T0);
        grouped.Report(Warning("Claude", "Browser pattern match", "b"), T0);
        grouped.Report(
            new GuardObservation("Gemini", "Browser pattern match", "c", "t", "d", GuardLevel.Critical), T0);
        Assert(grouped.Tabs[0].Name == GuardFeed.AllTab, "the first tab is All");
        Assert(grouped.Tabs[0].Total == 3, "the All tab counts every card");
        Assert(grouped.Tabs.Count == 3, "one tab per provider, plus All");
        var claudeTab = grouped.Tabs.Single(tab => tab.Name == "Claude");
        Assert(claudeTab.Total == 2 && claudeTab.Warnings == 2 && claudeTab.Criticals == 0,
            "a provider tab counts only its own cards");
        Assert(claudeTab.Label == "Claude (2)", "a tab label carries its count");
        var geminiTab = grouped.Tabs.Single(tab => tab.Name == "Gemini");
        Assert(geminiTab.Criticals == 1, "the critical is counted under its own provider");
        checks += 6;

        // --- 8. THE ACTIVE TAB FILTERS THE ROWS --------------------------------
        Assert(grouped.Visible.Count == 3, "All shows every card");
        grouped.ActiveTab = "Claude";
        Assert(grouped.Visible.Count == 2 && grouped.Visible.All(c => c.Provider == "Claude"),
            "selecting a provider tab filters the rows to that provider");
        grouped.ActiveTab = "   ";
        Assert(grouped.ActiveTab == GuardFeed.AllTab, "a blank tab selection falls back to All");
        Assert(grouped.Visible.Count == 3, "falling back to All restores every row");
        checks += 4;

        // --- 9. A RED NEVER SITS BELOW A QUIETER CARD --------------------------
        Assert(grouped.Visible[0].Level == GuardLevel.Critical,
            "the loudest card sorts to the top of the panel regardless of when it arrived");
        checks += 1;

        // --- 10. RETENTION IS BOUNDED, COUNTED, AND STATED ---------------------
        // A silently truncated safety list reads as "that is all there was".
        var retained = new GuardFeed();
        // The oldest card is a critical, and it must survive the trim.
        retained.Report(
            new GuardObservation("Claude", "Execution guard", "oldest-critical", "t", "d", GuardLevel.Critical),
            T0);
        for (var i = 0; i < GuardFeed.MaxRetainedCards; i++)
        {
            retained.Report(Warning("Claude", "Browser pattern match", $"sig-{i}"), T0.AddSeconds(i + 1));
        }

        Assert(retained.TotalCards == GuardFeed.MaxRetainedCards,
            "the feed never holds more than its stated retention limit");
        Assert(retained.DroppedByRetention == 1, "the dropped card is counted");
        Assert(retained.RetentionText.Contains("1 older event dropped", StringComparison.Ordinal),
            "the panel states how many events it dropped rather than truncating silently");
        Assert(retained.Find("Claude", "Execution guard", "oldest-critical") is not null,
            "retention drops the oldest QUIET card first — it never hides the worst flag");
        checks += 4;

        // --- 11. REDUCED MOTION REMOVES THE MOVEMENT, NEVER THE MEANING --------
        var motion = new GuardFeed();
        var pulsing = motion.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0);
        for (var i = 1; i < GuardEscalationRule.PulseAfterOccurrences; i++)
        {
            motion.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0.AddSeconds(i));
        }

        Assert(pulsing.ShouldPulse, "the card has crossed the pulse threshold");
        Assert(pulsing.AnimatePulse, "with motion allowed, the animation runs");
        motion.AnimationsEnabled = false;
        Assert(pulsing.ShouldPulse,
            "reduced motion does not change the rule — the card still SHOULD pulse");
        Assert(!pulsing.AnimatePulse, "reduced motion stops the animation from running");
        Assert(pulsing.StateText.Contains("escalating", StringComparison.OrdinalIgnoreCase),
            "the escalation is carried by words, so nothing is lost when the movement is off");
        Assert(motion.MotionPolicyText.Contains("Reduced motion", StringComparison.Ordinal),
            "the panel states its motion policy");
        checks += 6;

        // A card created while reduced motion is on inherits the policy.
        var late = motion.Report(
            new GuardObservation("Claude", "Execution guard", "late", "t", "d", GuardLevel.Critical), T0);
        Assert(late.ShouldPulse && !late.AnimatePulse,
            "a card added under reduced motion is born non-animating and still says it is critical");
        checks += 1;

        // --- 12. AGE ALONE ESCALATES, VIA TICK ---------------------------------
        var aging = new GuardFeed();
        var stale = aging.Report(Warning("Claude", "Browser pattern match", "rm-rf"), T0);
        Assert(stale.Level == GuardLevel.Warning && !stale.ShouldPulse, "the card starts solid yellow");
        Assert(aging.Tick(T0 + GuardEscalationRule.PulseAfterUnacknowledged) == 1,
            "Tick reports the card that changed");
        Assert(stale.ShouldPulse, "sitting unanswered past the pulse age starts the motion");
        Assert(aging.Tick(T0 + GuardEscalationRule.CriticalAfterUnacknowledged) == 1,
            "Tick reports the escalation to red");
        Assert(stale.Level == GuardLevel.Critical, "sitting unanswered past the red age turns the card red");
        Assert(aging.Tick(T0 + GuardEscalationRule.CriticalAfterUnacknowledged) == 0,
            "a Tick that changes nothing reports nothing, so the panel can skip the redraw");
        checks += 6;

        // --- 13. ACKNOWLEDGE-ALL, AND A CARD THAT IS NOT OURS ------------------
        var bulk = new GuardFeed();
        bulk.Report(Warning("Claude", "Browser pattern match", "a"), T0);
        bulk.Report(Warning("Gemini", "Browser pattern match", "b"), T0);
        Assert(bulk.AcknowledgeAll(T0.AddSeconds(1)) == 2, "acknowledge-all reports how many it changed");
        Assert(bulk.AcknowledgeAll(T0.AddSeconds(2)) == 0, "a second acknowledge-all changes nothing");
        var foreign = new GuardFeed().Report(Warning("Claude", "Browser pattern match", "x"), T0);
        Assert(!bulk.Acknowledge(foreign, T0), "a card from another feed cannot be acknowledged here");
        Assert(!bulk.Remove(foreign), "a card from another feed cannot be removed from here");
        checks += 4;

        // --- 14. A CARD WHOSE OPTIONS DO NOTHING SAYS SO -----------------------
        // Painted buttons that no host acts on are the aspirational UI Troy objects to.
        var options = new[]
        {
            new GuardOption("A", "Allow once", "Runs the command as written", "allow-once"),
            new GuardOption("B", "Block", "Refuses the command", "block")
        };
        var inertFeed = new GuardFeed();
        var inert = inertFeed.Report(
            new GuardObservation("Claude", "Browser pattern match", "opts", "t", "d",
                GuardLevel.Warning, options, ActionKind: ""),
            T0);
        Assert(inert.HasOptions && inert.Size == GuardCardSize.Expanded,
            "a card carrying options renders expanded so the options are clickable inline");
        Assert(inert.OptionsAreInert,
            "options with no routing tag are declared inert rather than painted as live");
        var liveCard = inertFeed.Report(
            new GuardObservation("Claude", "Browser pattern match", "opts-live", "t", "d",
                GuardLevel.Warning, options, ActionKind: "guard-decision"),
            T0);
        Assert(!liveCard.OptionsAreInert, "options with a routing tag are not marked inert");
        var plain = inertFeed.Report(Warning("Claude", "Browser pattern match", "plain"), T0);
        Assert(!plain.HasOptions && plain.Size == GuardCardSize.Compact && !plain.OptionsAreInert,
            "a card with no options is compact and is not described as inert");
        checks += 5;

        // --- 15. OPTION KEYS ARE A, B, C … AND THE ACTION IS SEPARATE ----------
        Assert(GuardOption.LetterFor(0) == "A" && GuardOption.LetterFor(3) == "D",
            "options are lettered from A by position");
        Assert(GuardOption.LetterFor(7) == "H", "lettering runs to H");
        Assert(GuardOption.LetterFor(8) == "9", "past H the option falls back to its 1-based number");
        Assert(GuardOption.LetterFor(-1) == "0", "a negative index does not index the letter table");
        checks += 4;

        // --- 16. THE PANEL PRINTS THE RULE IT OBEYS ---------------------------
        Assert(inertFeed.EscalationRuleText == GuardEscalationRule.StatedRule,
            "the panel renders the escalation rule from the rule itself, not a copy");
        checks += 1;

        // --- 17. REMOVE TAKES THE CARD OUT OF EVERY COUNT ---------------------
        var removal = new GuardFeed();
        var doomed = removal.Report(
            new GuardObservation("Claude", "Execution guard", "sig", "t", "d", GuardLevel.Critical), T0);
        Assert(removal.CriticalCount == 1, "the card is counted before removal");
        Assert(removal.Remove(doomed), "a card in the feed can be removed");
        Assert(removal.TotalCards == 0 && removal.CriticalCount == 0 && removal.Visible.Count == 0,
            "removal clears the card from the counts, the rows and the tabs");
        Assert(removal.WorstLevel == GuardLevel.Normal,
            "with its layer still registered and nothing flagged, the emptied feed reads OK");
        checks += 4;

        // --- 18. THE FEED DETECTS NOTHING ITSELF ------------------------------
        var passive = new GuardFeed();
        passive.RegisterSource("Execution guard");
        passive.Tick(T0.AddHours(9));
        Assert(passive.TotalCards == 0,
            "the feed is a dashboard: no amount of time passing manufactures a card it was not handed");
        checks += 1;

        Console.WriteLine($"Helmion guard feed checks passed ({checks} checks).");
    }

    private static GuardObservation Warning(string provider, string source, string signature) =>
        new(provider, source, signature, $"flag {signature}", "detail", GuardLevel.Warning);

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Guard feed failed: {what}");
        }
    }
}

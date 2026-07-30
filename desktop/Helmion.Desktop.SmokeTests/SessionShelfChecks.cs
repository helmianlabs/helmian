using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under the multi-session manager.
///
/// THE THING WORTH PROTECTING is that a session's stoplight is REAL. A fake session
/// list with decorative dots would be the exact failure Helmion exists to catch, so
/// these checks are pointed at the two ways a dot could start lying:
///
///   1. Going green on no evidence. A session nobody has computed a state for must
///      render grey/UNKNOWN, and Unknown must outrank Normal so "could not compute"
///      never reads as "checked and fine".
///   2. Running a second, parallel escalation scheme. Section 6 drives a REAL
///      <see cref="GuardFeed"/> and proves the dot is that feed's own escalation
///      output — the same rule, the same thresholds — rather than a colour this
///      feature picked for itself.
/// </summary>
internal static class SessionShelfChecks
{
    public static void Run()
    {
        var checks = 0;
        var now = DateTimeOffset.UnixEpoch;

        // --- 1. TROY'S FOUR PILLS, IN HIS ORDER, ROUTED CORRECTLY --------------
        // "press the button for Claude or ChatGPT, Grok, whatever, Gemini".
        Assert(
            SessionShelf.PillLabels.SequenceEqual(["Claude", "ChatGPT", "Grok", "Gemini"]),
            "the pills are Claude, ChatGPT, Grok, Gemini, left to right");

        // The ChatGPT pill has to reach the OpenAI coordinator, because that is the
        // key MaestroKey and the agent bridge understand. A pill that shipped
        // "ChatGPT" onto the wire would route nowhere.
        Assert(
            MaestroKey.Normalize("ChatGPT") == MaestroKey.OpenAi
            && MaestroKey.Normalize("Claude") == MaestroKey.Claude
            && MaestroKey.Normalize("Grok") == MaestroKey.Grok
            && MaestroKey.Normalize("Gemini") == MaestroKey.Gemini,
            "every pill normalizes to a coordinator key the bridge accepts");
        checks += 2;

        // --- 2. A NEW SESSION IS GREY, NOT GREEN ------------------------------
        var shelf = new SessionShelf();
        Assert(shelf.IsEmpty, "a fresh shelf has no sessions");
        Assert(
            shelf.EmptyText.Contains("No sessions yet", StringComparison.Ordinal)
            && shelf.EmptyText.Contains("pills", StringComparison.Ordinal),
            "the empty shelf says none have been started and how to start one");

        var claude = shelf.Create("Claude", "Nightly audit", now);
        Assert(claude.Level == GuardLevel.Unknown, "a brand-new session is UNKNOWN, never Normal");
        Assert(claude.LevelKey == "Unknown" && claude.LevelText == "GREY",
            "a new session's dot is grey and says so in words");
        Assert(
            claude.Reason.Contains("Nothing has checked", StringComparison.Ordinal)
            || claude.Reason.Contains("No turn has run", StringComparison.Ordinal),
            "a grey dot explains that nothing has reported rather than staying blank");
        Assert(claude.ProviderKey == MaestroKey.Claude, "the session carries the routed coordinator");
        Assert(claude.GuardProvider == "Session · Nightly audit",
            "a session's guard cards are keyed on its own name");
        checks += 6;

        // --- 3. SESSIONS ADD; THEY DO NOT REPLACE -----------------------------
        // Troy: "it's not a new chat it's in addition to."
        var gpt = shelf.Create("ChatGPT", "Spec reader", now);
        Assert(shelf.Sessions.Count == 2, "a second pill press adds a session rather than replacing one");
        Assert(ReferenceEquals(shelf.Selected, gpt), "the newest session becomes the selected one");
        Assert(gpt.IsSelected && !claude.IsSelected, "exactly one session is selected");
        Assert(gpt.ProviderKey == MaestroKey.OpenAi && gpt.PillLabel == "ChatGPT",
            "the row remembers both the button pressed and the coordinator that runs");
        Assert(
            gpt.SubtitleText.StartsWith(MaestroKey.OpenAi, StringComparison.Ordinal),
            "the row shows the coordinator that actually runs, not just the pill's label");

        // The dot is an Ellipse and a colour. Both are invisible to a screen reader,
        // so the level has to survive in the accessible name or the stoplight is a
        // sighted-users-only feature — the same failure as colour being the only
        // channel, one control further along.
        Assert(
            gpt.AccessibleName.Contains(gpt.Name, StringComparison.Ordinal)
            && gpt.AccessibleName.Contains(MaestroKey.OpenAi, StringComparison.Ordinal)
            && gpt.AccessibleName.Contains(gpt.LevelText, StringComparison.Ordinal),
            "the accessible name carries the session, its coordinator and its level in words");
        Assert(
            gpt.CloseAccessibleName.Contains(gpt.Name, StringComparison.Ordinal),
            "the close button names the session it would close");
        checks += 7;

        // --- 4. NAMES ARE UNIQUE, BECAUSE THE NAME KEYS THE GUARD STATE -------
        Assert(shelf.ValidateName("Nightly audit") is not null,
            "a duplicate name is refused — two sessions would share one dot");
        Assert(
            shelf.ValidateName("nightly AUDIT") is not null,
            "duplicate detection ignores case, since the guard key does too");
        Assert(shelf.ValidateName("  ") is not null, "a blank name is refused");
        Assert(shelf.ValidateName(new string('x', 41)) is not null, "an unreadably long name is refused");
        Assert(shelf.ValidateName("Second audit") is null, "a free name is accepted");
        Assert(shelf.SuggestName("Claude") != claude.Name,
            "the suggested name is one that is actually free");

        var refused = false;
        try
        {
            shelf.Create("Claude", "Nightly audit", now);
        }
        catch (ArgumentException)
        {
            refused = true;
        }

        Assert(refused, "Create refuses a duplicate rather than making an unkeyable row");
        Assert(shelf.Sessions.Count == 2, "a refused Create adds nothing");
        checks += 8;

        // --- 5. TRANSCRIPTS DO NOT MIX ----------------------------------------
        claude.Transcript.Append("claude said this\n");
        gpt.Transcript.Append("chatgpt said that\n");
        Assert(
            !claude.Transcript.ToString().Contains("chatgpt", StringComparison.Ordinal)
            && !gpt.Transcript.ToString().Contains("claude said", StringComparison.Ordinal),
            "each session keeps its own transcript");
        checks += 1;

        // --- 6. THE DOT IS THE GUARD FEED'S OWN ESCALATION OUTPUT -------------
        //
        // This is the load-bearing check. It uses a REAL GuardFeed and the REAL
        // escalation rule; nothing here fabricates a level. A yellow observation
        // repeated to the stated red threshold must turn the session's dot red, and
        // it must do so at the number GuardEscalationRule prints on the panel.
        var feed = new GuardFeed();

        GuardCard ReportTurn(AgentSession session, GuardLevel level) =>
            feed.Report(
                new GuardObservation(
                    session.GuardProvider,
                    AgentSession.TurnSource,
                    AgentSession.TurnSignature,
                    "turn outcome",
                    "fixture",
                    level),
                now);

        var preflightCard = feed.Report(
            new GuardObservation(
                claude.GuardProvider,
                AgentSession.PreflightSource,
                AgentSession.PreflightSignature,
                "Preflight clear",
                "fixture",
                GuardLevel.Normal),
            now);

        // Preflight green, but no turn has ever run: the dot must still be grey,
        // because a missing card is Unknown and Unknown outranks Normal.
        claude.ApplyGuardState((preflightCard.Level, preflightCard.Reason), null);
        Assert(claude.Level == GuardLevel.Unknown,
            "a green preflight with no turn behind it does NOT make the dot green");
        checks += 1;

        var turnCard = ReportTurn(claude, GuardLevel.Normal);
        claude.ApplyGuardState((preflightCard.Level, preflightCard.Reason), (turnCard.Level, turnCard.Reason));
        Assert(claude.Level == GuardLevel.Normal && claude.LevelText == "GREEN",
            "green only once both the preflight and a real turn have reported healthy");
        checks += 1;

        // Now walk a warning up to the panel's own stated red threshold.
        //
        // The loop counts the CARD's sightings, not its own iterations, because the
        // rule counts sightings of the card and this card already carried one from
        // the healthy turn above: a level may be RAISED by a repeat without the
        // count restarting (GuardFeed.cs:184-192), so the first warning here lands
        // as sighting two. Asserting on a loop index instead would be asserting
        // against a number the rule never looks at.
        GuardCard? escalating = null;
        for (var attempt = 0; attempt < 50; attempt++)
        {
            escalating = ReportTurn(claude, GuardLevel.Warning);
            claude.ApplyGuardState(
                (preflightCard.Level, preflightCard.Reason),
                (escalating.Level, escalating.Reason));

            if (escalating.Occurrences >= GuardEscalationRule.CriticalAfterOccurrences)
            {
                break;
            }

            Assert(claude.Level == GuardLevel.Warning,
                $"sighting {escalating.Occurrences} keeps the dot yellow, below the "
                + $"{GuardEscalationRule.CriticalAfterOccurrences}-sighting red threshold");
            checks += 1;
        }

        Assert(escalating!.Occurrences >= GuardEscalationRule.CriticalAfterOccurrences,
            "the feed counted every sighting");
        Assert(claude.Level == GuardLevel.Critical && claude.LevelText == "RED",
            $"the dot turns red at the rule's own {GuardEscalationRule.CriticalAfterOccurrences}-sighting "
            + "threshold — the same rule the panel prints, not a second scheme");
        Assert(claude.Reason.Contains(
                GuardEscalationRule.CriticalAfterOccurrences.ToString(),
                StringComparison.Ordinal),
            "the dot's tooltip names the number that fired");
        checks += 3;

        // And recovery, which is the other half of being real: a clean turn clears
        // it, rather than a session staying red forever on a condition that passed.
        var recovered = ReportTurn(claude, GuardLevel.Normal);
        claude.ApplyGuardState((preflightCard.Level, preflightCard.Reason), (recovered.Level, recovered.Reason));
        Assert(claude.Level == GuardLevel.Normal,
            "a clean turn takes the dot back to green — the feed's own recovery branch");
        checks += 1;

        // A session's cards belong to that session ALONE. gpt never reported, so it
        // must still be grey while claude was going red and back.
        Assert(gpt.Level == GuardLevel.Unknown,
            "one session's escalation never colours another session's dot");
        Assert(feed.Find(gpt.GuardProvider, AgentSession.TurnSource, AgentSession.TurnSignature) is null,
            "a session with no cards has no cards — nothing was invented for it");
        checks += 2;

        // --- 7. RANKING AGREES WITH THE FEED'S OWN RANKING --------------------
        //
        // SessionDot.Rank is a copy of GuardFeed's private Rank. Proven behaviourally
        // against the real feed rather than by reading the constant, so the two
        // cannot drift apart silently.
        var rankFeed = new GuardFeed();
        rankFeed.Report(new GuardObservation("P", "S", "healthy", "t", "d", GuardLevel.Normal), now);
        rankFeed.Report(new GuardObservation("P", "S", "blind", "t", "d", GuardLevel.Unknown), now);
        Assert(rankFeed.WorstLevel == GuardLevel.Unknown,
            "the real feed ranks Unknown above Normal");
        Assert(
            SessionDot.Combine((GuardLevel.Normal, "a"), (GuardLevel.Unknown, "b")).Level
                == GuardLevel.Unknown,
            "a session dot ranks Unknown above Normal the same way");
        Assert(
            SessionDot.Combine((GuardLevel.Critical, "a"), (GuardLevel.Warning, "b")).Level
                == GuardLevel.Critical
            && SessionDot.Combine((GuardLevel.Unknown, "a"), (GuardLevel.Warning, "b")).Level
                == GuardLevel.Warning,
            "Critical beats Warning, and Warning beats Unknown");
        Assert(
            SessionDot.Combine(null, null).Level == GuardLevel.Unknown,
            "no cards at all is Unknown, never Normal");
        checks += 4;

        // --- 8. PREFLIGHT IS A REAL CHECK THAT STARTS NOTHING -----------------
        var noNode = SessionPreflight.Evaluate(MaestroKey.Claude, true, null, @"E:\Helmion\bin\helmion.mjs");
        Assert(noNode.Level == GuardLevel.Critical, "no node.exe is critical — nothing can run");
        Assert(noNode.Detail.Contains("node.exe", StringComparison.Ordinal),
            "the critical card names what is missing");

        var noCli = SessionPreflight.Evaluate(MaestroKey.Claude, true, @"C:\node\node.exe", null);
        Assert(noCli.Level == GuardLevel.Critical, "no helmion.mjs is critical — nothing can run");

        var noRoute = SessionPreflight.Evaluate(null, true, @"C:\node\node.exe", @"E:\h\bin\helmion.mjs");
        Assert(noRoute.Level == GuardLevel.Warning, "a provider with no coordinator route is a warning");

        var noKey = SessionPreflight.Evaluate(
            MaestroKey.Grok, false, @"C:\node\node.exe", @"E:\h\bin\helmion.mjs");
        Assert(noKey.Level == GuardLevel.Warning, "a missing credential is a warning");
        Assert(noKey.Detail.Contains("XAI_API_KEY", StringComparison.Ordinal),
            "the warning names the exact credential the operator has to add");

        var clear = SessionPreflight.Evaluate(
            MaestroKey.Claude, true, @"C:\node\node.exe", @"E:\h\bin\helmion.mjs");
        Assert(clear.Level == GuardLevel.Normal, "everything present is Normal");

        // The green preflight must not over-claim. It checked for a key's presence;
        // it did not use it, and it certainly did not run a turn.
        Assert(
            clear.Detail.Contains("no turn has run", StringComparison.OrdinalIgnoreCase)
            && clear.Detail.Contains("has not been used", StringComparison.OrdinalIgnoreCase),
            "a green preflight states its own limits instead of implying a working session");
        Assert(
            clear.Detail.Contains(@"C:\node\node.exe", StringComparison.Ordinal)
            && clear.Detail.Contains("helmion.mjs", StringComparison.Ordinal),
            "a green preflight cites the paths it actually found");
        checks += 9;

        // --- 10. WHERE A TURN GOES, AND WHOSE TRANSCRIPT IT LANDS IN ----------
        //
        // Both rules used to be written inline in MainWindow.xaml.cs, which this
        // project does not reference (Helmion.Desktop.SmokeTests.csproj:10-12), so the
        // two decisions most able to cross sessions — which provider a keystroke
        // reaches, and whose transcript a line lands in — were the two nothing could
        // check. They now live in Core and MainWindow calls them, so what runs below
        // is the shipping implementation and not a copy of it.

        // A selected session routes to ITS OWN coordinator. This is the load-bearing
        // one: it proves the wire gets "OpenAI" and not the pill's label "ChatGPT",
        // AND that a session ignores the global Maestro setting — a turn running on a
        // provider the operator did not pick for this session, while the row still
        // showed the one they did, is the dot lying one control further along.
        var gptRoute = SessionTurnRouting.ForTurn(gpt, MaestroKey.Claude);
        Assert(gptRoute.Provider == MaestroKey.OpenAi,
            "a selected ChatGPT session sends OpenAI on the wire, not the pill's label");
        Assert(gptRoute.Provider != MaestroKey.Claude,
            "a selected session ignores the global Maestro coordinator");
        Assert(ReferenceEquals(gptRoute.Session, gpt) && !gptRoute.UsesSharedBridge,
            "a session's turn runs on that session's own bridge, never the shared one");
        checks += 3;

        // With nothing selected the console behaves exactly as it did before sessions
        // existed: the Maestro setting, on the shared bridge.
        var bare = SessionTurnRouting.ForTurn(null, MaestroKey.Claude);
        Assert(bare.Session is null && bare.UsesSharedBridge && bare.Provider == MaestroKey.Claude,
            "with no session started the turn uses the Maestro setting and the shared bridge");
        Assert(
            SessionTurnRouting.ForTurn(null, null).Provider
                == SessionTurnRouting.NoSessionFallbackProvider,
            "no session and no configured coordinator falls back to a named provider, not to empty");
        checks += 2;

        // A session whose provider this build cannot route goes out AS ITSELF and
        // fails honestly. Borrowing the Maestro coordinator would let it quietly
        // succeed as somebody else's provider while its row claimed otherwise.
        var odd = shelf.Create("Copilot", "Unroutable", now);
        Assert(odd.ProviderKey is null, "an unknown provider normalizes to null, not to a default");
        var oddRoute = SessionTurnRouting.ForTurn(odd, MaestroKey.Claude);
        Assert(oddRoute.Provider == "Copilot" && oddRoute.Provider != MaestroKey.Claude,
            "a session with no route sends its own label, never the Maestro coordinator");
        Assert(
            SessionPreflight.Evaluate(odd.ProviderKey, true, @"C:\node\node.exe", @"E:\h\bin\helmion.mjs")
                .Level == GuardLevel.Warning,
            "and its preflight says so out loud rather than letting the row look ready");
        shelf.Close(odd);
        checks += 4;

        // Output ownership. gpt is the selected session; claude is running a turn in
        // the background.
        Assert(ReferenceEquals(shelf.Selected, gpt), "the fixture still has the ChatGPT session on screen");

        var noSession = SessionOutputRouting.ForLine(null, null);
        Assert(noSession.Owner is null && noSession.ShowOnScreen,
            "with no sessions a line goes straight to the box, as it did before sessions existed");

        var foreground = SessionOutputRouting.ForLine(null, gpt);
        Assert(ReferenceEquals(foreground.Owner, gpt) && foreground.ShowOnScreen,
            "with no turn running, output belongs to the session on screen and is shown");

        var ownTurn = SessionOutputRouting.ForLine(gpt, gpt);
        Assert(ReferenceEquals(ownTurn.Owner, gpt) && ownTurn.ShowOnScreen,
            "a turn in the session you are looking at is shown");
        checks += 4;

        // THE ONE THAT MATTERS MOST. A turn running in a session the operator switched
        // away from must NOT reach the visible box. If this regresses, one agent's
        // output appears inside another agent's transcript — which is the multi-session
        // version of a decorative dot, and unlike a dot it corrupts the record.
        var backgroundBefore = gpt.Transcript.ToString();
        var background = SessionOutputRouting.ForLine(claude, gpt);
        Assert(ReferenceEquals(background.Owner, claude),
            "output belongs to the session that produced it, even after switching away");
        Assert(!background.ShowOnScreen,
            "a background session's output never reaches the transcript on screen");

        background.Owner?.Transcript.Append("background chatter\n");
        Assert(gpt.Transcript.ToString() == backgroundBefore,
            "the visible session's transcript is untouched by another session's turn");
        Assert(claude.Transcript.ToString().Contains("background chatter", StringComparison.Ordinal),
            "and the line is kept in its own session's transcript rather than dropped");
        checks += 4;

        // A refused send names who is holding the line — it can be a session that is
        // not on screen, so "busy" without a name is a mystery rather than a wait.
        Assert(
            SessionTurnRouting.BusyMessage(claude).Contains(claude.Name, StringComparison.Ordinal),
            "the busy message names the session that is mid-turn");
        Assert(
            !SessionTurnRouting.BusyMessage(null).Contains(claude.Name, StringComparison.Ordinal),
            "with no turn owner it invents no name");
        checks += 2;

        // --- 9. CLOSING ------------------------------------------------------
        var afterClose = shelf.Close(gpt);
        Assert(shelf.Sessions.Count == 1, "closing removes exactly one session");
        Assert(ReferenceEquals(afterClose, claude) && ReferenceEquals(shelf.Selected, claude),
            "closing the selected session hands selection to the one still running");
        Assert(shelf.Close(claude) is null && shelf.IsEmpty,
            "closing the last session leaves nothing selected and an empty shelf");
        Assert(shelf.ValidateName("Nightly audit") is null,
            "a closed session's name is free again");
        checks += 4;

        Console.WriteLine($"Helmion session shelf smoke tests passed ({checks} checks).");
    }

    private static void Assert(bool condition, string description)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Session shelf check failed: {description}");
        }
    }
}

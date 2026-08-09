using Helmion.Desktop.Core;

/// <summary>
/// THE PIN: "a fresh empty workspace must produce ZERO red banners."
///
/// WHY THIS FILE EXISTS RATHER THAN THE FLAG THAT WAS ALREADY THERE. The previous
/// proof was `Helmion Pilot.exe --empty-workspace-audit`, which constructs a real
/// WPF Window. Nothing may appear on Troy's screen, so that proof could not be run
/// — and a proof nobody is allowed to run is not a weaker proof, it is no proof.
/// The classification moved into Helmion.Desktop.Core, which this console project
/// already references, so the rule is now asserted against a REAL empty temporary
/// folder with no window in the room.
///
/// It checks the actual filesystem condition rather than a boolean handed in by
/// the test, because "there is no plugins.json yet" is the exact thing being
/// asserted and a test that mocks it away would pass over the real bug.
/// </summary>
public static class FreshWorkspaceChecks
{
    public static void Run()
    {
        var checks = 0;
        var workspace = Path.Combine(Path.GetTempPath(), $"helmion-fresh-{Guid.NewGuid():N}");

        try
        {
            // ── THE RULE ITSELF, against a genuinely empty directory ────────────
            Directory.CreateDirectory(workspace);

            var outcomes = FirstRunStates.FreshWorkspaceOutcomes(workspace);
            Assert(outcomes.Count > 0, "the fresh-workspace audit actually examines something");
            Assert(FirstRunStates.FreshWorkspaceRedCount(workspace) == 0,
                "A FRESH EMPTY WORKSPACE PRODUCES ZERO RED BANNERS — the rule this file exists for");
            Assert(outcomes.All(o => o.State == PlusActionState.Empty),
                "and every one of its first-run states is Empty, not a failure");
            Assert(outcomes.All(o => !string.IsNullOrWhiteSpace(o.Message)),
                "each still says what to do next — an empty state without a next step is a dead end");
            checks += 4;

            // THE COUNTER MUST BE ABLE TO COUNT. A zero from a counter that cannot
            // reach one is not a measurement, and this rule is only worth having if
            // its green can go red.
            Assert(new PlusOutcome(PlusActionState.Failed, "x").IsRed,
                "a Failed outcome reports itself as red");
            Assert(!new PlusOutcome(PlusActionState.Empty, "x").IsRed,
                "and an Empty one does not");
            Assert(new[]
            {
                new PlusOutcome(PlusActionState.Empty, "x"),
                new PlusOutcome(PlusActionState.Failed, "y"),
            }.Count(o => o.IsRed) == 1, "so the zero above is a measured zero, not a counter stuck at zero");
            checks += 3;

            // ── PLUGINS ────────────────────────────────────────────────────────
            var missing = FirstRunStates.Plugins(Path.Combine(workspace, "no-such-dir"));
            Assert(missing.State == PlusActionState.Empty,
                "a workspace that does not exist is an empty state, not a failure");
            Assert(missing.Message.Contains("Workspace tab", StringComparison.Ordinal),
                "and it names the tab that fixes it");
            checks += 2;

            var noRegistry = FirstRunStates.Plugins(workspace);
            Assert(noRegistry.State == PlusActionState.Empty,
                "a fresh workspace with no plugins.json is an empty state — the NORMAL first run");
            Assert(noRegistry.Message.Contains("helmion plugin add", StringComparison.Ordinal),
                "and it says how to install one");
            checks += 2;

            // A registry that IS there reads as success, so Empty is not a
            // catch-all that would swallow the working case too.
            var registry = FirstRunStates.PluginRegistryPath(workspace);
            Directory.CreateDirectory(Path.GetDirectoryName(registry)!);
            File.WriteAllText(registry, "{\"plugins\":[]}");
            var present = FirstRunStates.Plugins(workspace);
            Assert(present.State == PlusActionState.Succeeded,
                "a workspace that HAS a plugins.json reads as success");
            Assert(present.Message.Contains(registry, StringComparison.Ordinal),
                "and names the file it actually read");
            checks += 2;

            // ── CONNECTORS ─────────────────────────────────────────────────────
            var blank = FirstRunStates.ConnectorNeed("   ");
            Assert(blank is { State: PlusActionState.Empty },
                "an empty connector box is a step not taken yet, not a search that failed");
            Assert(blank!.Message.Contains("sqlite", StringComparison.OrdinalIgnoreCase)
                   || blank.Message.Contains("Discover", StringComparison.Ordinal)
                   || blank.Message.Contains("Connectors", StringComparison.Ordinal),
                "and it gives an example of what to type");
            Assert(FirstRunStates.ConnectorNeed("post to Slack") is null,
                "a filled box returns nothing so the caller runs the real discovery");
            checks += 3;

            // ── NEW PROJECT ────────────────────────────────────────────────────
            Assert(FirstRunStates.NewProject(null, "thing") is { State: PlusActionState.Empty },
                "no workspace is an empty state, not a failure");
            Assert(FirstRunStates.NewProject(workspace, "  ") is { State: PlusActionState.Empty },
                "an untyped project name is a pre-input hint, not a failure");
            Assert(FirstRunStates.NewProject(workspace, "thing") is null,
                "a workspace and a name together return nothing so the caller scaffolds");
            checks += 3;

            // ── THE WORDS ARE TROY'S AND MUST SURVIVE THE MOVE ─────────────────
            // The brief was explicit: keep the words, change only the level. These
            // pin the sentences so a later refactor cannot quietly reword them.
            Assert(FirstRunStates.NewProject(workspace, null)!.Message
                    .Contains("It becomes the folder name and the title inside PROJECT.md", StringComparison.Ordinal),
                "the project-name wording is carried over verbatim");
            Assert(FirstRunStates.NewProject(null, null)!.Message
                    .Contains("Pick one on the Workspace page first", StringComparison.Ordinal),
                "and so is the no-workspace wording");
            checks += 2;

            // ── Settle MAPS OUTCOME TO ROW, so the tested value is the rendered value ──
            var controller = new PlusMenuController();

            var emptyRow = controller.Settle(
                controller.Begin(PlusMenuKind.Plugin, "Plugins"),
                FirstRunStates.Plugins(Path.Combine(workspace, "nope")));
            Assert(emptyRow.State == PlusActionState.Empty, "Settle renders an Empty outcome as an Empty row");
            Assert(emptyRow.StateKey == "Empty", "which the template colours grey, not red");
            checks += 2;

            var failedRow = controller.Settle(
                controller.Begin(PlusMenuKind.Plugin, "Plugins"),
                new PlusOutcome(PlusActionState.Failed, "it really did break"));
            Assert(failedRow.State == PlusActionState.Failed, "and a real failure still renders red");
            Assert(failedRow.Message.Contains("it really did break", StringComparison.Ordinal),
                "carrying its own message");
            checks += 2;

            // An outcome in a state that is not an outcome must not render as
            // success. Silence here would be the panel inventing an all-clear.
            var nonsense = controller.Settle(
                controller.Begin(PlusMenuKind.Plugin, "Plugins"),
                new PlusOutcome(PlusActionState.InProgress, "still going"));
            Assert(nonsense.State == PlusActionState.Failed,
                "a state that is not an outcome fails loudly rather than rendering as success");
            Assert(nonsense.Message.Contains("bug in Helmion", StringComparison.Ordinal),
                "and says it is Helmion's bug, not the user's");
            checks += 2;
        }
        finally
        {
            try { Directory.Delete(workspace, recursive: true); } catch { /* temp */ }
        }

        Console.WriteLine($"Helmion fresh-workspace red-banner checks passed ({checks} checks).");
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Fresh-workspace audit failed: {what}");
        }
    }
}

using Helmion.Desktop.Core;

/// <summary>
/// Checks for the ALWAYS ASK permission tier on the desktop side.
/// </summary>
/// <remarks>
/// The WPF prompt itself cannot be clicked from a console suite, so what is
/// verified here is everything underneath it that decides safety: that "ask" is
/// a real, normalizable fourth mode, that it is offered in the dropdown model,
/// that the badge tells the truth about it, and — the part that actually
/// matters — that no value other than an explicit allow is ever read as
/// consent. The button wiring is proved by the Node-side end-to-end test
/// (test/ask-permission.test.mjs), which drives the same wire protocol the
/// buttons speak.
/// </remarks>
internal static class AskPermissionSmokeChecks
{
    private static int _checks;

    public static void Run()
    {
        _checks = 0;

        // --- ask is a real mode, not a typo that degrades to read-only ---
        Check(AgentPermission.Ask == "ask", "ask mode has the wire id 'ask'");
        Check(AgentPermission.Normalize("ask") == AgentPermission.Ask, "'ask' normalizes to ask");

        foreach (var alias in new[]
                 { "Ask", "ASK", " ask ", "always-ask", "always_ask", "ask-each", "approve", "prompt", "confirm" })
        {
            Check(
                AgentPermission.Normalize(alias) == AgentPermission.Ask,
                $"'{alias}' normalizes to ask");
        }

        // --- the other three tiers did not move ---
        Check(AgentPermission.Normalize("full") == AgentPermission.Full, "full still normalizes to full");
        Check(AgentPermission.Normalize("all") == AgentPermission.Full, "'all' is still full, not ask");
        Check(
            AgentPermission.Normalize("read-tools") == AgentPermission.ReadTools,
            "read-tools still normalizes to read-tools");
        Check(
            AgentPermission.Normalize("read-only") == AgentPermission.ReadOnly,
            "read-only still normalizes to read-only");
        Check(
            AgentPermission.Normalize("something-invented") == AgentPermission.ReadOnly,
            "an unknown mode still falls back to read-only, the safest tier");
        Check(AgentPermission.Normalize(null) == AgentPermission.ReadOnly, "null falls back to read-only");

        // --- the dropdown model offers it, in escalation order ---
        Check(AgentPermission.Options.Count == 4, "the permissions dropdown offers four tiers");
        Check(
            AgentPermission.Options.Select(option => option.Id).SequenceEqual(
                [AgentPermission.ReadOnly, AgentPermission.ReadTools, AgentPermission.Ask, AgentPermission.Full]),
            "dropdown order runs read-only → read-tools → ask → full");
        var askOption = AgentPermission.Options.Single(option => option.Id == AgentPermission.Ask);
        Check(askOption.Label == "Ask before each action", "the ask option is labelled for a human");
        Check(
            askOption.Description.Contains("approve", StringComparison.OrdinalIgnoreCase),
            "the ask description says you approve each call");

        // --- the badge does not lie about which mode is live ---
        Check(
            AgentPermission.BadgeLabel("ask") == "PERMISSIONS · ASK EACH TOOL",
            "the badge names ask mode explicitly");
        Check(
            AgentPermission.BadgeLabel("full") == "PERMISSIONS · FULL TOOLS",
            "the full badge is unchanged");
        Check(
            AgentPermission.BadgeLabel("ask") != AgentPermission.BadgeLabel("full"),
            "ask can never be mistaken for full on the badge");

        // --- who is allowed to do what ---
        Check(AgentPermission.RequiresApproval("ask"), "ask requires approval");
        Check(!AgentPermission.RequiresApproval("full"), "full does not stop to ask");
        Check(!AgentPermission.RequiresApproval("read-tools"), "read-tools does not stop to ask");
        Check(
            AgentPermission.AllowsExecution("ask"),
            "ask can reach a tool (after approval), unlike read-only");
        Check(!AgentPermission.AllowsExecution("read-only"), "read-only still reaches no tool");

        // --- the legacy in-process dispatcher fails CLOSED in ask mode ---
        using (var session = new ConsoleSession())
        {
            session.PermissionMode = AgentPermission.Ask;
            Check(
                !session.IsExecutionEnabled,
                "ConsoleSession.IsExecutionEnabled is false in ask mode, so the legacy "
                + "ToolDispatcher (which cannot prompt anyone) refuses tools rather than "
                + "running them unapproved");

            var dispatcherRoot = Path.Combine(
                Path.GetTempPath(),
                $"helmion-ask-smoke-{Guid.NewGuid():N}");
            Directory.CreateDirectory(dispatcherRoot);
            try
            {
                var dispatcher = new ToolDispatcher(session, dispatcherRoot);
                var refused = dispatcher.WriteWorkspaceFile("ask-smoke.txt", "must not exist");
                Check(
                    !File.Exists(Path.Combine(dispatcherRoot, "ask-smoke.txt")),
                    "the legacy dispatcher wrote NOTHING to disk in ask mode");
                Check(
                    refused.StartsWith("Error", StringComparison.OrdinalIgnoreCase),
                    "the legacy dispatcher returns a refusal string rather than writing");
            }
            finally
            {
                if (Directory.Exists(dispatcherRoot)) Directory.Delete(dispatcherRoot, recursive: true);
            }
        }

        // --- consent cannot be manufactured ---
        Check(
            AgentApprovalDecision.IsAllowed(AgentApprovalDecision.AllowOnce)
            && AgentApprovalDecision.IsAllowed(AgentApprovalDecision.AllowSession),
            "the two allow decisions are allowed");
        foreach (var hostile in new string?[]
                 {
                     null, "", " ", "deny", "no", "n", "maybe", "ALLOW-ONCE", "allow once",
                     "true", "1", "yes please", "allow-once-please", "{\"decision\":\"allow-once\"}",
                 })
        {
            Check(
                !AgentApprovalDecision.IsAllowed(hostile),
                $"'{hostile ?? "null"}' is NOT treated as consent");
        }

        Check(
            AgentApprovalDecision.Normalize("nonsense") == AgentApprovalDecision.Deny,
            "an unrecognized answer normalizes to deny");
        Check(
            AgentApprovalDecision.Normalize(null) == AgentApprovalDecision.Deny,
            "a missing answer normalizes to deny");
        Check(
            AgentApprovalDecision.Normalize("YES") == AgentApprovalDecision.AllowOnce,
            "a plain yes is one-time consent only");
        Check(
            AgentApprovalDecision.Normalize("always") == AgentApprovalDecision.AllowSession,
            "'always' is session consent");

        // --- the wire contract matches src/agent/approval.mjs ---
        Check(AgentApprovalDecision.AllowOnce == "allow-once", "allow-once wire value matches the Node side");
        Check(AgentApprovalDecision.AllowSession == "allow-session", "allow-session wire value matches the Node side");
        Check(AgentApprovalDecision.Deny == "deny", "deny wire value matches the Node side");

        // --- the desktop can carry the new event fields ---
        var request = new AgentBridgeEvent(
            "permission_request",
            Id: "perm-1-abc",
            Tool: "write_file",
            Summary: "write_file: notes.txt (12 bytes)",
            Workspace: @"E:\Helmion",
            TimeoutMs: 300000);
        Check(request.Id == "perm-1-abc", "a permission_request carries its id back to the responder");
        Check(request.Summary!.Contains("notes.txt", StringComparison.Ordinal), "the summary reaches the UI intact");
        Check(request.TimeoutMs == 300000, "the UI can show how long the user has to answer");

        var decision = new AgentBridgeEvent(
            "permission_decision",
            Id: "perm-1-abc",
            Tool: "write_file",
            Decision: "deny",
            Source: "timeout");
        Check(
            !AgentApprovalDecision.IsAllowed(decision.Decision),
            "a timed-out decision reads as denied");

        Console.WriteLine($"Helmion ask-permission smoke tests passed ({_checks} checks).");
    }

    private static void Check(bool condition, string description)
    {
        _checks++;
        if (!condition)
        {
            Console.Error.WriteLine($"FAIL: {description}");
            Environment.Exit(1);
        }

        Console.WriteLine($"PASS: {description}");
    }
}

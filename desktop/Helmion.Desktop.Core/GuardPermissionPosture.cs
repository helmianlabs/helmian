namespace Helmion.Desktop.Core;

/// <summary>One guard card describing the console's tool-permission setting.</summary>
public sealed record GuardPermissionCard(GuardLevel Level, string Title, string Detail);

/// <summary>
/// Turns the console's permission mode into a guard card.
///
/// WHY THIS IS ITS OWN FILE, AND PURE.
///
/// This mapping used to live inside a private method of MainWindow, which meant
/// no test could reach it and it was wrong in two directions at once:
///
///   Full  was rendered CRITICAL RED.  Troy's ruling, 2026-07-29: "that is a
///         choice that the user makes so I don't think that needs to be red
///         because that is something they have to physically choose through the
///         drop down." He is right, and the reason is the same one that produced
///         the stale-card bug fixed alongside this: a panel that shouts at you
///         for a setting you deliberately selected trains you to stop reading it,
///         and then it is not there when something is genuinely wrong.
///
///   Ask   was rendered YELLOW WARNING — and Ask is the SAFEST setting in the
///         list, the one where every single tool call stops and waits for a
///         click. So the panel nagged hardest at the person who chose the most
///         careful option, while grading a stricter option (read tools only) as
///         quiet. Nobody caught it because nothing could test it.
///
/// A DELIBERATE SETTING IS A STATE, NOT AN ALARM. Every recognised mode is
/// reported <see cref="GuardLevel.Normal"/> and says in plain words exactly what
/// it permits. The card still appears, still names what can happen, and no
/// longer competes with a real flag for the colour red.
///
/// An UNRECOGNISED mode is <see cref="GuardLevel.Unknown"/>, not a guess. The
/// enforcement path folds an unknown string into read-only and fails closed
/// (AgentPermission.Normalize) — correct for a gate, wrong for a panel, because
/// stating "Read-only chat" in a confident colour about a setting nobody could
/// parse is the exact lie GuardFeed.WorstLevel exists to prevent.
/// </summary>
public static class GuardPermissionPosture
{
    /// <summary>The dedup signature for this card. One card, updated in place.</summary>
    public const string Signature = "desktop-permission-mode";

    public static GuardPermissionCard Describe(string? mode)
    {
        var resolved = AgentPermission.TryNormalize(mode);

        return resolved switch
        {
            AgentPermission.Full => new GuardPermissionCard(
                GuardLevel.Normal,
                "Full tool permissions",
                "write_file and run_command run without stopping to ask. Every provider in this "
                + "window can write files and run shell commands in the registered workspace. "
                + "This is the setting you chose; change it in the permission dropdown."),

            AgentPermission.Ask => new GuardPermissionCard(
                GuardLevel.Normal,
                "Every tool call needs your approval",
                "Each call waits for a click, and an unanswered call is denied "
                + "(AgentApprovalDecision.Normalize defaults to deny). This is the strictest "
                + "setting that still lets tools run."),

            AgentPermission.ReadTools => new GuardPermissionCard(
                GuardLevel.Normal,
                "Read tools only",
                "read_file, list_dir and search_text are allowed. Writes and shell are refused "
                + "by ToolDispatcher."),

            AgentPermission.ReadOnly => new GuardPermissionCard(
                GuardLevel.Normal,
                "Read-only chat",
                "No tools are available until permissions are raised."),

            // Null means TryNormalize did not recognise the string at all.
            _ => new GuardPermissionCard(
                GuardLevel.Unknown,
                "Permission mode not recognised",
                $"The console reported a permission mode this panel does not know: "
                + $"\"{mode}\". It is shown as Unknown rather than guessed. The enforcement "
                + "path treats an unrecognised mode as read-only and refuses tools."),
        };
    }
}

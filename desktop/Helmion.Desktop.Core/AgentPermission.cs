namespace Helmion.Desktop.Core;

/// <summary>
/// Console tool permission modes shared by the WPF shell and the Node agent bridge.
/// Applies to every Maestro coordinator (OpenAI, Claude, Gemini, xAI Grok).
/// </summary>
public static class AgentPermission
{
    public const string ReadOnly = "read-only";
    public const string ReadTools = "read-tools";

    /// <summary>
    /// ALWAYS ASK. Every tool is eligible, but each individual call stops and
    /// waits for the user to allow or deny it. Fails closed: no answer, no run.
    /// </summary>
    public const string Ask = "ask";

    public const string Full = "full";

    public static IReadOnlyList<(string Id, string Label, string Description)> Options { get; } =
    [
        (ReadOnly, "Read-only chat", "No tools. Text-only conversation with the selected LLM."),
        (ReadTools, "Read tools", "Allow read_file, list_dir, search_text. Block writes and shell."),
        (Ask, "Ask before each tool", "Every tool available, but you approve each call before it runs."),
        (Full, "Full tools (no ask)", "Full control — write_file + run_command without asking.")
    ];

    /// <summary>
    /// The recognised mode, or null when the string means nothing here.
    /// <para>
    /// <see cref="Normalize"/> folds an unrecognised value into
    /// <see cref="ReadOnly"/>, which is the right default for a GATE — an
    /// unreadable setting must not grant tools. It is the wrong answer for a
    /// STATUS PANEL, which would then state, in a confident colour, that the
    /// session is in read-only chat when nobody actually knows what it is in.
    /// Callers that report state use this and render Unknown; callers that
    /// enforce keep using Normalize and fail closed.
    /// </para>
    /// </summary>
    public static string? TryNormalize(string? mode)
    {
        var m = (mode ?? string.Empty).Trim().ToLowerInvariant();
        return m switch
        {
            "full" or "execution" or "on" or "write" or "all" => Full,
            "ask" or "always-ask" or "always_ask" or "ask-each" or "approve" or "prompt" or "confirm" => Ask,
            "read-tools" or "read" or "tools-read" or "readonly-tools" => ReadTools,
            "read-only" or "readonly" or "chat" or "off" or "none" or "" => ReadOnly,
            _ => null
        };
    }

    public static string Normalize(string? mode) => TryNormalize(mode) ?? ReadOnly;

    /// <summary>
    /// True when the mode can reach a tool at all — read-tools, ask, or full.
    /// <para>
    /// Ask is included because an approved call really does execute; the mode
    /// changes WHO decides, not WHETHER execution is possible. Callers that
    /// need "runs without stopping to ask" must test for <see cref="Full"/>
    /// directly rather than using this. As of this change there are no callers
    /// in the solution (verified by search), so nothing silently changed
    /// meaning; the two nearby gates were each checked by hand:
    /// ConsoleSession.IsExecutionEnabled compares to Full and so treats ask as
    /// not-executing, which keeps the legacy in-process ToolDispatcher path
    /// refusing tools in ask mode — fail closed, since that path has no way to
    /// prompt anyone. The live desktop tool path is the Node agent bridge,
    /// which does the asking.
    /// </para>
    /// </summary>
    public static bool AllowsExecution(string? mode) =>
        Normalize(mode) is ReadTools or Ask or Full;

    /// <summary>True only for modes that stop and ask before each tool call.</summary>
    public static bool RequiresApproval(string? mode) => Normalize(mode) == Ask;

    public static string BadgeLabel(string? mode) =>
        Normalize(mode) switch
        {
            Full => "PERMISSIONS · FULL TOOLS",
            Ask => "PERMISSIONS · ASK EACH TOOL",
            ReadTools => "PERMISSIONS · READ TOOLS",
            _ => "PERMISSIONS · READ-ONLY"
        };
}

/// <summary>
/// The three answers the desktop can send for one ask-mode approval question.
/// These strings are the wire contract with src/agent/approval.mjs.
/// </summary>
public static class AgentApprovalDecision
{
    public const string AllowOnce = "allow-once";
    public const string AllowSession = "allow-session";
    public const string Deny = "deny";

    /// <summary>
    /// Anything that is not one of the two allow values is a denial, so a
    /// garbled or unexpected value can never be read as consent.
    /// </summary>
    public static bool IsAllowed(string? decision) =>
        decision == AllowOnce || decision == AllowSession;

    /// <summary>Coerce any inbound string to a decision, defaulting to Deny.</summary>
    public static string Normalize(string? decision) =>
        (decision ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            AllowOnce or "allow" or "once" or "yes" or "y" => AllowOnce,
            AllowSession or "session" or "always" => AllowSession,
            _ => Deny
        };
}

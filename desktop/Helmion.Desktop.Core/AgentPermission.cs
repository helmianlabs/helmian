namespace Helmion.Desktop.Core;

/// <summary>
/// Console tool permission modes shared by the WPF shell and the Node agent bridge.
/// Applies to every Maestro coordinator (OpenAI, Claude, Gemini, xAI Grok).
/// </summary>
public static class AgentPermission
{
    public const string ReadOnly = "read-only";
    public const string ReadTools = "read-tools";
    public const string Full = "full";

    public static IReadOnlyList<(string Id, string Label, string Description)> Options { get; } =
    [
        (ReadOnly, "Read-only chat", "No tools. Text-only conversation with the selected LLM."),
        (ReadTools, "Read tools", "Allow read_file, list_dir, search_text. Block writes and shell."),
        (Full, "Full tools (no ask)", "Full control — write_file + run_command without asking.")
    ];

    public static string Normalize(string? mode)
    {
        var m = (mode ?? string.Empty).Trim().ToLowerInvariant();
        return m switch
        {
            "full" or "execution" or "on" or "write" or "all" => Full,
            "read-tools" or "read" or "tools-read" or "readonly-tools" => ReadTools,
            "read-only" or "readonly" or "chat" or "off" or "none" or "" => ReadOnly,
            _ => ReadOnly
        };
    }

    public static bool AllowsExecution(string? mode) =>
        Normalize(mode) is ReadTools or Full;

    public static string BadgeLabel(string? mode) =>
        Normalize(mode) switch
        {
            Full => "PERMISSIONS · FULL TOOLS",
            ReadTools => "PERMISSIONS · READ TOOLS",
            _ => "PERMISSIONS · READ-ONLY"
        };
}

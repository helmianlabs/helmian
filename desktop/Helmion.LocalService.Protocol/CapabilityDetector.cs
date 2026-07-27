namespace Helmion.LocalService.Protocol;

public static class CapabilityDetector
{
    private static readonly CapabilityDefinition[] Definitions =
    [
        new("codex-cli", "Codex CLI", ["codex"]),
        new("claude-code-cli", "Claude Code CLI", ["claude"]),
        new("gemini-cli", "Gemini CLI", ["gemini"]),
        new("grok-cli", "Grok CLI", ["grok"]),
        new("git-cli", "Git CLI", ["git"]),
        new("github-cli", "GitHub CLI", ["gh"])
    ];

    public static IReadOnlyList<LocalCapability> Detect(
        string? searchPath = null,
        string? executableExtensions = null)
    {
        var path = searchPath ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        var extensions = ParseExtensions(
            executableExtensions
            ?? Environment.GetEnvironmentVariable("PATHEXT")
            ?? ".COM;.EXE;.BAT;.CMD");

        return Definitions
            .Select(definition =>
            {
                var available = definition.CommandNames.Any(command =>
                    IsCommandAvailable(command, path, extensions));
                return new LocalCapability(
                    definition.Id,
                    definition.DisplayName,
                    available,
                    available ? "Available on PATH" : "Not found on PATH",
                    "Filename presence only · command not executed");
            })
            .ToArray();
    }

    private static bool IsCommandAvailable(
        string command,
        string searchPath,
        IReadOnlyList<string> extensions)
    {
        foreach (var rawDirectory in searchPath.Split(
                     Path.PathSeparator,
                     StringSplitOptions.RemoveEmptyEntries
                         | StringSplitOptions.TrimEntries))
        {
            var directory = rawDirectory.Trim('"');
            if (string.IsNullOrWhiteSpace(directory)
                || !Path.IsPathFullyQualified(directory))
            {
                continue;
            }

            foreach (var extension in extensions.Prepend(string.Empty))
            {
                try
                {
                    if (File.Exists(Path.Combine(directory, command + extension)))
                    {
                        return true;
                    }
                }
                catch (Exception error) when (
                    error is ArgumentException
                        or IOException
                        or UnauthorizedAccessException
                        or NotSupportedException)
                {
                    // Detection is best-effort and never executes a discovered file.
                }
            }
        }

        return false;
    }

    private static IReadOnlyList<string> ParseExtensions(string value)
    {
        return value
            .Split(
                ';',
                StringSplitOptions.RemoveEmptyEntries
                    | StringSplitOptions.TrimEntries)
            .Select(extension => extension.StartsWith('.')
                ? extension
                : $".{extension}")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private sealed record CapabilityDefinition(
        string Id,
        string DisplayName,
        IReadOnlyList<string> CommandNames);
}

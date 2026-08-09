namespace Helmion.Desktop.Core;

public sealed record ExternalSkillEntry(string Name, string Scope, string Location);

/// <summary>Read-only inventory of Codex SKILL.md files. Inventory is not enablement.</summary>
public static class CodexSkillDiscovery
{
    public static IReadOnlyList<ExternalSkillEntry> Discover()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roots = new[]
        {
            (Path.Combine(home, ".codex", "skills"), "Codex personal"),
            (Path.Combine(home, ".codex", "plugins", "cache"), "Codex plugin"),
        };
        var found = new List<ExternalSkillEntry>();
        foreach (var (root, scope) in roots)
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                foreach (var path in Directory.EnumerateFiles(root, "SKILL.md", SearchOption.AllDirectories).Take(200))
                {
                    var name = new DirectoryInfo(Path.GetDirectoryName(path)!).Name;
                    found.Add(new ExternalSkillEntry(name, scope, path));
                }
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }
        return found
            .OrderBy(item => item.Scope, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }
}

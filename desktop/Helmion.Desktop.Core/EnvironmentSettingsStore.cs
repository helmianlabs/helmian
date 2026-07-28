using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Helmion.Desktop.Core;

public sealed record EnvironmentSettings(
    string GeminiApiKey,
    string DatabaseUrl,
    string ExpectedEndpointId,
    string CodexMode,
    string CodexInstanceId,
    string GrokApiKey,
    string MaestroCoordinator,
    string OpenAiApiKey = "",
    string AnthropicApiKey = "");

public static class EnvironmentSettingsStore
{
    public static string FindEnvPath(string? customPath = null)
    {
        if (!string.IsNullOrWhiteSpace(customPath) && File.Exists(customPath))
        {
            return Path.GetFullPath(customPath);
        }

        // Prefer explicit workspace roots first. Single-file Pilot extracts under
        // %TEMP%\.net\… so walking only AppContext.BaseDirectory often misses
        // E:\Helmion\.env and the Console ends up with no/stale keys.
        var searchRoots = new List<string>();
        var workspace = Environment.GetEnvironmentVariable("WORKSPACE_PATH")
            ?? Environment.GetEnvironmentVariable("HELMION_WORKSPACE_PATH");
        if (!string.IsNullOrWhiteSpace(workspace))
        {
            searchRoots.Add(workspace);
        }
        searchRoots.Add(@"E:\Helmion");
        searchRoots.Add(AppContext.BaseDirectory);
        try
        {
            var exeDir = Path.GetDirectoryName(Environment.ProcessPath);
            if (!string.IsNullOrWhiteSpace(exeDir))
            {
                searchRoots.Add(exeDir);
            }
        }
        catch
        {
            // ProcessPath unavailable — ignore.
        }

        foreach (var root in searchRoots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var current = new DirectoryInfo(root);
            for (var i = 0; i < 12 && current is not null; i++)
            {
                var candidate = Path.Combine(current.FullName, ".env");
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
                current = current.Parent;
            }
        }

        return Path.Combine(AppContext.BaseDirectory, ".env");
    }

    public static EnvironmentSettings Load(string? envPath = null)
    {
        var target = FindEnvPath(envPath);
        var map = ReadEnvDictionary(target);

        var geminiKey = map.GetValueOrDefault("GEMINI_API_KEY")
            ?? Environment.GetEnvironmentVariable("GEMINI_API_KEY")
            ?? string.Empty;

        var dbUrl = map.GetValueOrDefault("HELMION_DATABASE_URL")
            ?? Environment.GetEnvironmentVariable("HELMION_DATABASE_URL")
            ?? string.Empty;

        var endpointId = map.GetValueOrDefault("HELMION_EXPECTED_ENDPOINT_ID")
            ?? Environment.GetEnvironmentVariable("HELMION_EXPECTED_ENDPOINT_ID")
            ?? ExtractEndpointId(dbUrl);

        var codexMode = map.GetValueOrDefault("HELMION_CODEX_MODE")
            ?? Environment.GetEnvironmentVariable("HELMION_CODEX_MODE")
            ?? "read-only";

        var codexInstanceId = map.GetValueOrDefault("HELMION_CODEX_INSTANCE_ID")
            ?? Environment.GetEnvironmentVariable("HELMION_CODEX_INSTANCE_ID")
            ?? "helmion-local-dev-01";

        // xAI Grok key — never Groq. Accept XAI_API_KEY or GROK_API_KEY.
        var grokKey = map.GetValueOrDefault("XAI_API_KEY")
            ?? map.GetValueOrDefault("GROK_API_KEY")
            ?? Environment.GetEnvironmentVariable("XAI_API_KEY")
            ?? Environment.GetEnvironmentVariable("GROK_API_KEY")
            ?? string.Empty;

        var openAiKey = map.GetValueOrDefault("OPENAI_API_KEY")
            ?? Environment.GetEnvironmentVariable("OPENAI_API_KEY")
            ?? string.Empty;

        var anthropicKey = map.GetValueOrDefault("ANTHROPIC_API_KEY")
            ?? Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY")
            ?? string.Empty;

        var maestroCoordinator = map.GetValueOrDefault("HELMION_MAESTRO_COORDINATOR")
            ?? Environment.GetEnvironmentVariable("HELMION_MAESTRO_COORDINATOR")
            ?? "Gemini";

        var loaded = new EnvironmentSettings(
            geminiKey,
            dbUrl,
            endpointId,
            codexMode,
            codexInstanceId,
            grokKey,
            maestroCoordinator,
            openAiKey,
            anthropicKey);

        // Push into this process so Node agent-bridge children inherit live keys
        // even when the Pilot was started before .env was fixed.
        ApplyToProcess(loaded);
        return loaded;
    }

    /// <summary>
    /// Writes Helmion settings into the current process environment (not machine/user).
    /// AgentBridge children inherit these values.
    /// </summary>
    public static void ApplyToProcess(EnvironmentSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        Environment.SetEnvironmentVariable("GEMINI_API_KEY", settings.GeminiApiKey ?? "");
        Environment.SetEnvironmentVariable("OPENAI_API_KEY", settings.OpenAiApiKey ?? "");
        Environment.SetEnvironmentVariable("ANTHROPIC_API_KEY", settings.AnthropicApiKey ?? "");
        Environment.SetEnvironmentVariable("XAI_API_KEY", settings.GrokApiKey ?? "");
        Environment.SetEnvironmentVariable("GROK_API_KEY", settings.GrokApiKey ?? "");
        Environment.SetEnvironmentVariable("HELMION_DATABASE_URL", settings.DatabaseUrl ?? "");
        Environment.SetEnvironmentVariable("HELMION_EXPECTED_ENDPOINT_ID", settings.ExpectedEndpointId ?? "");
        Environment.SetEnvironmentVariable("HELMION_CODEX_MODE", settings.CodexMode ?? "");
        Environment.SetEnvironmentVariable("HELMION_CODEX_INSTANCE_ID", settings.CodexInstanceId ?? "");
        Environment.SetEnvironmentVariable("HELMION_MAESTRO_COORDINATOR", settings.MaestroCoordinator ?? "");
    }

    public static void Save(EnvironmentSettings settings, string? envPath = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var target = FindEnvPath(envPath);
        var lines = File.Exists(target) ? File.ReadAllLines(target).ToList() : new List<string>();

        SetOrUpdateKey(lines, "GEMINI_API_KEY", settings.GeminiApiKey);
        SetOrUpdateKey(lines, "OPENAI_API_KEY", settings.OpenAiApiKey);
        SetOrUpdateKey(lines, "ANTHROPIC_API_KEY", settings.AnthropicApiKey);
        SetOrUpdateKey(lines, "XAI_API_KEY", settings.GrokApiKey);
        SetOrUpdateKey(lines, "GROK_API_KEY", settings.GrokApiKey);
        SetOrUpdateKey(lines, "HELMION_DATABASE_URL", settings.DatabaseUrl);
        SetOrUpdateKey(lines, "HELMION_EXPECTED_ENDPOINT_ID", settings.ExpectedEndpointId);
        SetOrUpdateKey(lines, "HELMION_CODEX_MODE", settings.CodexMode);
        SetOrUpdateKey(lines, "HELMION_CODEX_INSTANCE_ID", settings.CodexInstanceId);
        SetOrUpdateKey(lines, "HELMION_MAESTRO_COORDINATOR", settings.MaestroCoordinator);

        var parent = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllLines(target, lines);

        ApplyToProcess(settings);
    }

    public static string ExtractEndpointId(string dbUrl)
    {
        if (string.IsNullOrWhiteSpace(dbUrl)) return string.Empty;
        try
        {
            var uri = new Uri(dbUrl);
            var host = uri.Host;
            var parts = host.Split('.');
            if (parts.Length > 0 && parts[0].StartsWith("ep-", StringComparison.OrdinalIgnoreCase))
            {
                return parts[0];
            }
        }
        catch
        {
        }
        return string.Empty;
    }

    public static string? LoadWorkspacePath(string? envPath = null)
    {
        var target = FindEnvPath(envPath);
        var map = ReadEnvDictionary(target);
        var path = map.GetValueOrDefault("WORKSPACE_PATH")
            ?? map.GetValueOrDefault("HELMION_WORKSPACE_PATH")
            ?? Environment.GetEnvironmentVariable("WORKSPACE_PATH")
            ?? Environment.GetEnvironmentVariable("HELMION_WORKSPACE_PATH");
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        var trimmed = path.Trim();
        // Never treat a bare drive root (D:\, C:\) or a CLI config home (%USERPROFILE%\.grok,
        // \.claude, …) as a project workspace — the agent will list recycle bins, whole disks,
        // or another tool's private state. Callers should fall back to Helmion.
        if (IsUnsafeWorkspaceRoot(trimmed))
        {
            return null;
        }

        return trimmed;
    }

    /// <summary>
    /// True for paths that must never become the agent's tool workspace: bare drive roots
    /// like <c>D:\</c> or <c>C:</c>, and provider CLI / config homes such as
    /// <c>%USERPROFILE%\.grok</c> (see <see cref="IsProviderHomeDirectory"/>).
    /// </summary>
    public static bool IsUnsafeWorkspaceRoot(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return true;
        }

        try
        {
            var full = Path.GetFullPath(path.Trim());
            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root))
            {
                return true;
            }

            // "D:\" or "D:" after trim of trailing separators.
            var normalized = full.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            var rootNormalized = root.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            if (string.Equals(normalized, rootNormalized, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return IsProviderHomeDirectory(full);
        }
        catch
        {
            return true;
        }
    }

    /// <summary>
    /// True when <paramref name="path"/> is the user profile itself, a Windows per-user
    /// application-data root, or a dot-prefixed config home directly under the profile
    /// (<c>%USERPROFILE%\.grok</c>, <c>\.claude</c>, <c>\.gemini</c>, <c>\.codex</c>, …) —
    /// or anything beneath one.
    /// <para>
    /// These are the private state directories of the CLI tools Helmion coordinates. They are
    /// never a project, and pointing the full-permission tool loop at one lets the agent read
    /// and rewrite another tool's credentials and history. Selecting a Maestro provider must
    /// never move the workspace into that provider's home.
    /// </para>
    /// </summary>
    public static bool IsProviderHomeDirectory(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        try
        {
            var full = Path.GetFullPath(path.Trim())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

            // Roaming and ProgramData hold application state only. LocalApplicationData is
            // deliberately absent: %TEMP% lives under it and a scratch folder there is a
            // legitimate throwaway project.
            foreach (var folder in new[]
                     {
                         Environment.SpecialFolder.ApplicationData,
                         Environment.SpecialFolder.CommonApplicationData,
                     })
            {
                if (IsSameOrUnder(full, Environment.GetFolderPath(folder)))
                {
                    return true;
                }
            }

            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.IsNullOrEmpty(profile))
            {
                return false;
            }

            // The profile root itself is as broad as a drive root.
            if (string.Equals(full, profile, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (!IsSameOrUnder(full, profile))
            {
                return false;
            }

            // First segment below the profile: ".grok" and friends are config homes,
            // "aimforge-main" and friends are ordinary project folders.
            var relative = full[(profile.Length + 1)..];
            var firstSegment = relative.Split(
                [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            return firstSegment is not null && firstSegment.StartsWith('.');
        }
        catch
        {
            return false;
        }
    }

    private static bool IsSameOrUnder(string candidate, string? ancestor)
    {
        if (string.IsNullOrWhiteSpace(ancestor))
        {
            return false;
        }

        var root = Path.GetFullPath(ancestor)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(candidate, root, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    public static void SaveWorkspacePath(string workspacePath, string? envPath = null)
    {
        if (string.IsNullOrWhiteSpace(workspacePath))
        {
            throw new ArgumentException("Workspace path is required", nameof(workspacePath));
        }

        var full = Path.GetFullPath(workspacePath);
        if (IsProviderHomeDirectory(full))
        {
            throw new ArgumentException(
                "Cannot use a CLI config home or your user profile (e.g. "
                + "C:\\Users\\you\\.grok) as the workspace. Those hold another tool's "
                + "credentials and history, not a project. "
                + "Pick a project folder such as DairyForge or E:\\Helmion.",
                nameof(workspacePath));
        }

        if (IsUnsafeWorkspaceRoot(full))
        {
            throw new ArgumentException(
                "Cannot use a drive root (e.g. D:\\) as the workspace. "
                + "Pick a project folder such as DairyForge or E:\\Helmion.",
                nameof(workspacePath));
        }

        if (!Directory.Exists(full))
        {
            throw new DirectoryNotFoundException($"Workspace folder does not exist: {full}");
        }

        var target = FindEnvPath(envPath);
        var lines = File.Exists(target) ? File.ReadAllLines(target).ToList() : new List<string>();
        SetOrUpdateKey(lines, "WORKSPACE_PATH", full);
        SetOrUpdateKey(lines, "HELMION_WORKSPACE_PATH", full);

        var parent = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllLines(target, lines);
        Environment.SetEnvironmentVariable("WORKSPACE_PATH", full);
        Environment.SetEnvironmentVariable("HELMION_WORKSPACE_PATH", full);
    }

    private static Dictionary<string, string> ReadEnvDictionary(string path)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!File.Exists(path)) return result;

        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#')) continue;

            var equalsIndex = line.IndexOf('=');
            if (equalsIndex < 0) continue;

            var key = line[..equalsIndex].Trim();
            var val = line[(equalsIndex + 1)..].Trim();
            result[key] = val;
        }

        return result;
    }

    private static void SetOrUpdateKey(List<string> lines, string key, string value)
    {
        var updatedLine = $"{key}={value}";
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i].Trim();
            if (line.StartsWith(key + "=", StringComparison.OrdinalIgnoreCase))
            {
                lines[i] = updatedLine;
                return;
            }
        }
        lines.Add(updatedLine);
    }
}

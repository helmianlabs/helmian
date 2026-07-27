using System.Text.Json;

namespace Helmion.Desktop.Core;

public sealed record EnvironmentSettings(
    string GeminiApiKey,
    string DatabaseUrl,
    string ExpectedEndpointId,
    string CodexMode,
    string CodexInstanceId);

public static class EnvironmentSettingsStore
{
    public static string FindEnvPath(string? customPath = null)
    {
        if (!string.IsNullOrWhiteSpace(customPath) && File.Exists(customPath))
        {
            return Path.GetFullPath(customPath);
        }

        var baseDir = AppContext.BaseDirectory;
        var current = new DirectoryInfo(baseDir);
        while (current is not null)
        {
            var candidate = Path.Combine(current.FullName, ".env");
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
            current = current.Parent;
        }

        return Path.Combine(baseDir, ".env");
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

        return new EnvironmentSettings(geminiKey, dbUrl, endpointId, codexMode, codexInstanceId);
    }

    public static void Save(EnvironmentSettings settings, string? envPath = null)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var target = FindEnvPath(envPath);
        var lines = File.Exists(target) ? File.ReadAllLines(target).ToList() : new List<string>();

        SetOrUpdateKey(lines, "GEMINI_API_KEY", settings.GeminiApiKey);
        SetOrUpdateKey(lines, "HELMION_DATABASE_URL", settings.DatabaseUrl);
        SetOrUpdateKey(lines, "HELMION_EXPECTED_ENDPOINT_ID", settings.ExpectedEndpointId);
        SetOrUpdateKey(lines, "HELMION_CODEX_MODE", settings.CodexMode);
        SetOrUpdateKey(lines, "HELMION_CODEX_INSTANCE_ID", settings.CodexInstanceId);

        var parent = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllLines(target, lines);

        Environment.SetEnvironmentVariable("GEMINI_API_KEY", settings.GeminiApiKey);
        Environment.SetEnvironmentVariable("HELMION_DATABASE_URL", settings.DatabaseUrl);
        Environment.SetEnvironmentVariable("HELMION_EXPECTED_ENDPOINT_ID", settings.ExpectedEndpointId);
        Environment.SetEnvironmentVariable("HELMION_CODEX_MODE", settings.CodexMode);
        Environment.SetEnvironmentVariable("HELMION_CODEX_INSTANCE_ID", settings.CodexInstanceId);
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
                var ep = parts[0];
                if (ep.EndsWith("-pooler", StringComparison.OrdinalIgnoreCase))
                {
                    ep = ep[..^7];
                }
                return ep;
            }
        }
        catch
        {
            // Ignore format errors
        }
        return string.Empty;
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
            if (equalsIndex <= 0) continue;

            var key = line[..equalsIndex].Trim();
            var val = line[(equalsIndex + 1)..].Trim();
            if ((val.StartsWith('"') && val.EndsWith('"')) || (val.StartsWith('\'') && val.EndsWith('\'')))
            {
                val = val[1..^1];
            }
            result[key] = val;
        }

        return result;
    }

    private static void SetOrUpdateKey(List<string> lines, string key, string value)
    {
        var prefix = $"{key}=";
        var index = lines.FindIndex(line => line.TrimStart().StartsWith(prefix, StringComparison.Ordinal));
        if (index >= 0)
        {
            lines[index] = $"{key}={value}";
        }
        else
        {
            lines.Add($"{key}={value}");
        }
    }
}

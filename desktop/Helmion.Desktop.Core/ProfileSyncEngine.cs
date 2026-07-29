using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Helmion.Desktop.Core;

public sealed record SyncResult(
    bool Success,
    string Message,
    IReadOnlyList<string> SyncedItems);

/// <summary>
/// The filesystem roots a profile sync writes user-scoped files into
/// (<c>.claude.json</c>, <c>.claude/</c>, <c>.gemini/</c>, and
/// <c>AppData/Claude/claude_desktop_config.json</c>).
///
/// Production callers pass null and get the real user profile and roaming
/// AppData. Tests MUST pass a temp pair: on 2026-07-28 the smoke suite invoked
/// a live sync on every <c>dotnet run</c>, which rewrote the user's own
/// BASE_RULES.md back to a template and restored plaintext API keys into
/// <c>~/.claude.json</c> after they had been moved to environment variables.
/// A test suite must never be able to reach a user's real configuration.
/// </summary>
public sealed record ProfileSyncTargets(string UserProfileDirectory, string AppDataDirectory)
{
    public static ProfileSyncTargets Live() => new(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
}

public static class ProfileSyncEngine
{
    private const string GeminiRulesContent = """
        # Helmion Gemini Rules — Read First Every Session

        These rules apply every session, every model, every project.
        Read them before any tool call or answer.

        ## 0. HONESTY OVERRIDES EVERYTHING

        - If you don't know something, say "I do not know," then offer to check.
        - Separate what you are certain of from what you are guessing.
        - Acknowledge mistakes plainly.
        - When you ship something it actually works, or you name exactly what doesn't.

        ## 0.001. SOURCE OF TRUTH + FULL TRACING

        Every factual claim requires a primary-source citation AND an end-to-end trace.

        **GATE 1 — SOURCE OF TRUTH**
        - Code → file:line
        - API → response body + endpoint
        - Vendor docs → URL + quoted sentence
        - NOT "memory says," NOT "handoff says," NOT "I recall"

        **GATE 2 — FULL TRACING**
        For any multi-stage claim, draw the chain explicitly:
          Stage A → Stage B → Stage C → … → N
        A chain with one uncited arrow IS the lie.

        ## 0.002. CITE OR SHUT UP

        If you cannot cite a primary source, do not make the claim.
        Banned: "probably," "I think," "should be," "it looks like," "if I recall."

        ## 0.003. PARALLEL BY DEFAULT

        When two or more sub-tasks have no dependency on each other, run them
        concurrently. Never serialize what can fan out.
        """;

    private static JsonObject CreateMcpServerConfig(string scriptPath, string databaseUrl, string? mode = null, string? instanceId = null, string? grokApiKey = null)
    {
        var env = new JsonObject { ["HELMION_DATABASE_URL"] = databaseUrl };
        if (mode is not null)
        {
            env["HELMION_CODEX_MODE"] = mode;
        }
        if (instanceId is not null)
        {
            env["HELMION_CODEX_INSTANCE_ID"] = instanceId;
        }
        if (!string.IsNullOrEmpty(grokApiKey))
        {
            env["GROK_API_KEY"] = grokApiKey;
        }

        return new JsonObject
        {
            ["command"] = "node",
            ["args"] = new JsonArray { scriptPath },
            ["env"] = env
        };
    }

    public static async Task<SyncResult> SyncProfileAsync(
        CancellationToken cancellationToken = default,
        ProfileSyncTargets? targets = null)
    {
        var syncedItems = new List<string>();
        try
        {
            // 1. Load active environment settings
            var settings = EnvironmentSettingsStore.Load();

            // 2. Resolve project root path
            var envPath = EnvironmentSettingsStore.FindEnvPath();
            var projectRoot = Path.GetDirectoryName(envPath);
            if (string.IsNullOrEmpty(projectRoot))
            {
                return new SyncResult(false, "Could not determine project root directory from .env path.", syncedItems);
            }

            // 3. Setup paths
            var resolvedTargets = targets ?? ProfileSyncTargets.Live();
            var appData = resolvedTargets.AppDataDirectory;
            var userProfile = resolvedTargets.UserProfileDirectory;

            var claudeDesktopConfigPath = Path.Combine(appData, "Claude", "claude_desktop_config.json");
            var claudeCodeConfigPath = Path.Combine(userProfile, ".claude.json");
            var geminiDir = Path.Combine(userProfile, ".gemini");
            var geminiRulesPath = Path.Combine(geminiDir, "GEMINI.md");

            var contextScript = Path.Combine(projectRoot, "bin", "mcp-helmion-context.mjs");
            var flywheelScript = Path.Combine(projectRoot, "bin", "mcp-helmion-flywheel.mjs");
            var advisoryScript = Path.Combine(projectRoot, "bin", "mcp-helmion-advisory.mjs");
            var codexScript = Path.Combine(projectRoot, "bin", "mcp-helmion-codex.mjs");

            // 4. Update Claude Desktop config
            var claudeDesktopDir = Path.GetDirectoryName(claudeDesktopConfigPath);
            if (!string.IsNullOrEmpty(claudeDesktopDir))
            {
                Directory.CreateDirectory(claudeDesktopDir);
            }

            JsonObject desktopRoot;
            if (File.Exists(claudeDesktopConfigPath))
            {
                try
                {
                    var content = await File.ReadAllTextAsync(claudeDesktopConfigPath, cancellationToken);
                    desktopRoot = JsonSerializer.Deserialize<JsonObject>(content) ?? new JsonObject();
                }
                catch
                {
                    desktopRoot = new JsonObject();
                }
            }
            else
            {
                desktopRoot = new JsonObject();
            }

            if (!desktopRoot.ContainsKey("mcpServers") || desktopRoot["mcpServers"] is not JsonObject)
            {
                desktopRoot["mcpServers"] = new JsonObject();
            }

            var desktopMcpServers = desktopRoot["mcpServers"]!.AsObject();
            desktopMcpServers["helmion-context"] = CreateMcpServerConfig(contextScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            desktopMcpServers["helmion-flywheel"] = CreateMcpServerConfig(flywheelScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            desktopMcpServers["helmion-advisory"] = CreateMcpServerConfig(advisoryScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            desktopMcpServers["helmion-codex"] = CreateMcpServerConfig(codexScript, settings.DatabaseUrl, settings.CodexMode, settings.CodexInstanceId, settings.GrokApiKey);

            var serializeOptions = new JsonSerializerOptions { WriteIndented = true };
            await File.WriteAllTextAsync(claudeDesktopConfigPath, JsonSerializer.Serialize(desktopRoot, serializeOptions), cancellationToken);
            syncedItems.Add("Claude Desktop MCP configuration");

            // 5. Update Claude Code config
            JsonObject codeRoot;
            if (File.Exists(claudeCodeConfigPath))
            {
                try
                {
                    var content = await File.ReadAllTextAsync(claudeCodeConfigPath, cancellationToken);
                    codeRoot = JsonSerializer.Deserialize<JsonObject>(content) ?? new JsonObject();
                }
                catch
                {
                    codeRoot = new JsonObject();
                }
            }
            else
            {
                codeRoot = new JsonObject();
            }

            if (!codeRoot.ContainsKey("mcpServers") || codeRoot["mcpServers"] is not JsonObject)
            {
                codeRoot["mcpServers"] = new JsonObject();
            }

            var codeMcpServers = codeRoot["mcpServers"]!.AsObject();
            codeMcpServers["helmion-context"] = CreateMcpServerConfig(contextScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            codeMcpServers["helmion-flywheel"] = CreateMcpServerConfig(flywheelScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            codeMcpServers["helmion-advisory"] = CreateMcpServerConfig(advisoryScript, settings.DatabaseUrl, grokApiKey: settings.GrokApiKey);
            codeMcpServers["helmion-codex"] = CreateMcpServerConfig(codexScript, settings.DatabaseUrl, settings.CodexMode, settings.CodexInstanceId, settings.GrokApiKey);

            if (!codeRoot.ContainsKey("hooks") || codeRoot["hooks"] is not JsonObject)
            {
                codeRoot["hooks"] = new JsonObject();
            }
            var codeHooks = codeRoot["hooks"]!.AsObject();
            codeHooks["PreToolUse"] = $"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(projectRoot, "hooks", "pretooluse.ps1")}\"";

            await File.WriteAllTextAsync(claudeCodeConfigPath, JsonSerializer.Serialize(codeRoot, serializeOptions), cancellationToken);
            syncedItems.Add("Claude Code MCP & Hook configuration");

            // 6. Sync Claude Markdown Rules & Skills
            var claudeDir = Path.Combine(userProfile, ".claude");
            // Ensure .claude exists so IsClaudePresent returns true
            Directory.CreateDirectory(claudeDir);

            var approvedClaudeFiles = new HashSet<string>
            {
                "HELMION_CLAUDE.md",
                "BASE_RULES.md",
                "LEARNINGS.md",
                "LESSONS.md",
                "skills/brain-dump-processor/SKILL.md",
                "skills/sprint-pack-handoff/SKILL.md",
                "skills/verify-by-durable-side-effect/SKILL.md",
                "skills/cite-or-shut-up/SKILL.md",
                "skills/concurrent-session-hygiene/SKILL.md",
                "skills/go-no-go-stall-detection/SKILL.md"
            };
            // A sandboxed sync must install into the sandbox too, otherwise the
            // installer falls back to the real ~/.claude and the isolation leaks.
            var installerResult = await ClaudeProfileInstaller.InstallAsync(
                approvedClaudeFiles,
                cancellationToken,
                overwriteExisting: false,
                targetDirectory: targets is null ? null : claudeDir);
            if (installerResult.Success)
            {
                syncedItems.Add($"Claude markdown rules and skills ({installerResult.WrittenPaths.Count} files)");
            }
            else
            {
                syncedItems.Add($"Claude rule sync partial warning: {installerResult.Message}");
            }

            // 7. Sync Gemini Rules
            //
            // GEMINI.md is the operator's own global rules file for the Gemini CLI —
            // the same class of living document as BASE_RULES.md and LESSONS.md, and
            // this line used to truncate it unconditionally on every sync. The
            // preserve-existing rule was extended to the Claude installer on
            // 2026-07-28 and never to this one, so it stayed a silent reset.
            //
            // Troy's instruction 2026-07-29: no deletion, no reset. Seed it when it
            // does not exist; leave it exactly as it is when it does.
            Directory.CreateDirectory(geminiDir);
            if (File.Exists(geminiRulesPath))
            {
                syncedItems.Add("Gemini global rules (GEMINI.md) left untouched — your file, not ours");
            }
            else
            {
                await File.WriteAllTextAsync(geminiRulesPath, GeminiRulesContent, cancellationToken);
                syncedItems.Add("Gemini global rules (GEMINI.md) created");
            }

            // 8. Sync Codex Rules & Hooks
            var helmionConfigDir = Path.Combine(projectRoot, ".helmion");
            var helmionHookDir = Path.Combine(helmionConfigDir, "hooks");
            Directory.CreateDirectory(helmionHookDir);

            // Copy pretooluse.ps1 to .helmion/hooks
            var sourceHook = Path.Combine(projectRoot, "hooks", "pretooluse.ps1");
            if (File.Exists(sourceHook))
            {
                File.Copy(sourceHook, Path.Combine(helmionHookDir, "pretooluse.ps1"), true);
                syncedItems.Add("Codex pre-tool-use hook script");
            }

            // Write autonomy_rules.json
            var autonomyRulesPath = Path.Combine(helmionConfigDir, "autonomy_rules.json");
            JsonObject rulesRoot;
            if (File.Exists(autonomyRulesPath))
            {
                try
                {
                    var content = await File.ReadAllTextAsync(autonomyRulesPath, cancellationToken);
                    rulesRoot = JsonSerializer.Deserialize<JsonObject>(content) ?? new JsonObject();
                }
                catch
                {
                    rulesRoot = new JsonObject();
                }
            }
            else
            {
                rulesRoot = new JsonObject();
            }

            if (!rulesRoot.ContainsKey("promoted_rules") || rulesRoot["promoted_rules"] is not JsonArray)
            {
                rulesRoot["promoted_rules"] = new JsonArray();
            }

            var promotedRules = rulesRoot["promoted_rules"]!.AsArray();
            
            // Check and add "git push" rule
            bool hasGitPush = false;
            foreach (var node in promotedRules)
            {
                if (node is JsonObject obj && obj.ContainsKey("pattern") && obj["pattern"]?.ToString() == "git\\s+push")
                {
                    hasGitPush = true;
                    break;
                }
            }
            if (!hasGitPush)
            {
                promotedRules.Add(new JsonObject
                {
                    ["pattern"] = "git\\s+push",
                    ["severity"] = "flag",
                    ["project_slug"] = null
                });
            }

            // Check and add "--force" rule
            bool hasForce = false;
            foreach (var node in promotedRules)
            {
                if (node is JsonObject obj && obj.ContainsKey("pattern") && obj["pattern"]?.ToString() == "--force")
                {
                    hasForce = true;
                    break;
                }
            }
            if (!hasForce)
            {
                promotedRules.Add(new JsonObject
                {
                    ["pattern"] = "--force",
                    ["severity"] = "block",
                    ["project_slug"] = null
                });
            }

            // 9. Bidirectional Neon autonomy rule sync (HELMION_DATABASE_URL from .env)
            try
            {
                var neonStatus = await ProfileSyncService.SyncAutonomyRulesAsync(
                    rulesRoot,
                    settings.DatabaseUrl,
                    cancellationToken);
                syncedItems.Add(neonStatus);

                // Re-write local file after merge from Neon
                await File.WriteAllTextAsync(
                    autonomyRulesPath,
                    JsonSerializer.Serialize(rulesRoot, serializeOptions),
                    cancellationToken);
                syncedItems.Add("Codex autonomy rules configuration");
            }
            catch (Exception neonEx)
            {
                // Offline / schema missing must not fail the whole profile package.
                await File.WriteAllTextAsync(
                    autonomyRulesPath,
                    JsonSerializer.Serialize(rulesRoot, serializeOptions),
                    cancellationToken);
                syncedItems.Add("Codex autonomy rules configuration");
                syncedItems.Add($"Neon autonomy rules warning: {neonEx.Message}");
            }

            return new SyncResult(true, "Profile synchronized successfully.", syncedItems);
        }
        catch (Exception ex)
        {
            return new SyncResult(false, $"Profile sync failed: {ex.Message}", syncedItems);
        }
    }
}

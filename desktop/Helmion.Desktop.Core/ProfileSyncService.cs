using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;

namespace Helmion.Desktop.Core;

/// <summary>
/// Reads and writes learned autonomy rules against Neon PostgreSQL using
/// <c>HELMION_DATABASE_URL</c> from the configured <c>.env</c>.
/// </summary>
public static class ProfileSyncService
{
    public sealed record LearnedRule(
        string Pattern,
        string Severity,
        string? ProjectSlug,
        string Reason,
        string Snippet,
        string Citation);

    /// <summary>
    /// Bidirectional sync between local <c>promoted_rules</c> JSON and
    /// <c>helmion.autonomy_rules</c>. Returns a human-readable status line for syncedItems.
    /// </summary>
    public static async Task<string> SyncAutonomyRulesAsync(
        JsonObject rulesRoot,
        string databaseUrl,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            return "Neon autonomy rules skipped (HELMION_DATABASE_URL empty)";
        }

        if (!rulesRoot.ContainsKey("promoted_rules") || rulesRoot["promoted_rules"] is not JsonArray)
        {
            rulesRoot["promoted_rules"] = new JsonArray();
        }

        var promotedRules = rulesRoot["promoted_rules"]!.AsArray();
        await using var conn = new NpgsqlConnection(databaseUrl);
        await conn.OpenAsync(cancellationToken);

        var remote = await ReadActiveRulesAsync(conn, cancellationToken);
        var localPatterns = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in promotedRules)
        {
            if (node is JsonObject obj && obj["pattern"]?.ToString() is { Length: > 0 } pattern)
            {
                localPatterns.Add(pattern);
            }
        }

        var mergedFromDb = 0;
        foreach (var rule in remote)
        {
            if (localPatterns.Contains(rule.Pattern))
            {
                continue;
            }

            promotedRules.Add(new JsonObject
            {
                ["pattern"] = rule.Pattern,
                ["severity"] = rule.Severity,
                ["project_slug"] = rule.ProjectSlug
            });
            localPatterns.Add(rule.Pattern);
            mergedFromDb++;
        }

        var written = 0;
        foreach (var node in promotedRules)
        {
            if (node is not JsonObject obj)
            {
                continue;
            }

            var pattern = obj["pattern"]?.ToString();
            if (string.IsNullOrWhiteSpace(pattern))
            {
                continue;
            }

            var severity = obj["severity"]?.ToString() ?? "flag";
            if (severity is not ("flag" or "block"))
            {
                severity = "flag";
            }

            string? projectSlug = obj["project_slug"]?.GetValueKind() == JsonValueKind.Null
                ? null
                : obj["project_slug"]?.ToString();
            if (string.IsNullOrWhiteSpace(projectSlug))
            {
                projectSlug = null;
            }

            var upserted = await UpsertRuleAsync(
                conn,
                new LearnedRule(
                    Pattern: pattern,
                    Severity: severity,
                    ProjectSlug: projectSlug,
                    Reason: "profile-sync default",
                    Snippet: "n/a",
                    Citation: "ProfileSyncService.cs:0"),
                cancellationToken);
            if (upserted)
            {
                written++;
            }
        }

        return $"Neon autonomy rules (read {remote.Count}, merged local +{mergedFromDb}, upserted {written})";
    }

    private static async Task<IReadOnlyList<LearnedRule>> ReadActiveRulesAsync(
        NpgsqlConnection conn,
        CancellationToken cancellationToken)
    {
        const string sql = """
            select pattern, severity, project_slug, reason, snippet, citation
            from helmion.autonomy_rules
            where active
            order by case severity when 'block' then 0 else 1 end, created_at
            """;

        var list = new List<LearnedRule>();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            list.Add(new LearnedRule(
                reader.GetString(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5)));
        }

        return list;
    }

    private static async Task<bool> UpsertRuleAsync(
        NpgsqlConnection conn,
        LearnedRule rule,
        CancellationToken cancellationToken)
    {
        // PostgreSQL UNIQUE treats NULL project_slug as distinct, so ON CONFLICT is unsafe.
        // Match with IS NOT DISTINCT FROM, then update or insert.
        const string selectSql = """
            select id from helmion.autonomy_rules
            where pattern = @pattern
              and project_slug is not distinct from @project_slug
            limit 1
            """;

        await using (var select = new NpgsqlCommand(selectSql, conn))
        {
            select.Parameters.AddWithValue("pattern", rule.Pattern);
            select.Parameters.AddWithValue("project_slug", (object?)rule.ProjectSlug ?? DBNull.Value);
            var existingId = await select.ExecuteScalarAsync(cancellationToken);
            if (existingId is not null and not DBNull)
            {
                const string updateSql = """
                    update helmion.autonomy_rules
                    set severity = @severity,
                        active = true,
                        promotion_basis = 'profile-sync'
                    where id = @id
                    """;
                await using var update = new NpgsqlCommand(updateSql, conn);
                update.Parameters.AddWithValue("severity", rule.Severity);
                update.Parameters.AddWithValue("id", existingId);
                await update.ExecuteNonQueryAsync(cancellationToken);
                return true;
            }
        }

        const string insertSql = """
            insert into helmion.autonomy_rules
              (project_slug, pattern, flags, severity, reason, snippet, citation, active, promotion_basis)
            values
              (@project_slug, @pattern, 'i', @severity, @reason, @snippet, @citation, true, 'profile-sync')
            """;

        await using var insert = new NpgsqlCommand(insertSql, conn);
        insert.Parameters.AddWithValue("project_slug", (object?)rule.ProjectSlug ?? DBNull.Value);
        insert.Parameters.AddWithValue("pattern", rule.Pattern);
        insert.Parameters.AddWithValue("severity", rule.Severity);
        insert.Parameters.AddWithValue("reason", rule.Reason);
        insert.Parameters.AddWithValue("snippet", rule.Snippet);
        insert.Parameters.AddWithValue("citation", rule.Citation);
        var rows = await insert.ExecuteNonQueryAsync(cancellationToken);
        return rows > 0;
    }
}

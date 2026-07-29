using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>
/// Desktop surface for the READ-ONLY half of the MCP install security pipeline:
/// stage 1 (discover) and stage 2 (audit).
/// </summary>
/// <remarks>
/// <para>
/// What this deliberately does NOT do: approve, sandbox, or install anything.
/// The human approval gate (<c>src/core/mcp-approval.mjs:80-89</c>) refuses any
/// caller whose stdin/stdout is not a TTY, and a WPF app never has one. That
/// refusal is the feature — it is what makes "a human approved this" mean
/// something. So approval stays on the command line, where a person types a
/// freshly generated challenge phrase that could not have been pre-scripted
/// (<c>mcp-approval.mjs:61-74</c>). Nothing here weakens, wraps, or simulates it.
/// </para>
/// <para>
/// Both stages verified non-interactive: neither reaches
/// <c>assertInteractiveTerminal</c>, which is called only from
/// <c>requestInstallApproval</c> (<c>mcp-approval.mjs:201</c>), itself reached
/// only from <c>runInstallPipeline</c> (<c>mcp-install-pipeline.mjs:195</c>) —
/// i.e. only from the <c>review</c> subcommand.
/// </para>
/// <para>
/// The child process is spawned with <c>CreateNoWindow</c> and redirected pipes,
/// so nothing flashes on screen.
/// </para>
/// </remarks>
public static class McpSecurityRunner
{
    /// <summary>Wall-clock ceiling for one stage. Discover hits the GitHub API.</summary>
    private const int DefaultTimeoutMs = 90_000;

    /// <summary>
    /// Stage 1. Search GitHub for candidate MCP servers matching a stated need.
    /// Requires network. Never installs anything.
    /// </summary>
    public static Task<McpSecurityResult> DiscoverAsync(
        string need,
        int limit = 10,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(need))
        {
            return Task.FromResult(McpSecurityResult.Failed(
                "Say what you need the server to do, e.g. \"read local sqlite\"."));
        }

        // The CLI reads the positional from argv[4] (bin/helmion.mjs:544), so the
        // need MUST precede every flag or "--json" would be taken as the need.
        return RunAsync(
            "discover",
            [need.Trim(), "--limit", limit.ToString(), "--json"],
            FormatDiscovery,
            cancellationToken);
    }

    /// <summary>
    /// Stage 2. Read every source file in a candidate directory and report what
    /// it can actually do. Pure local file reads: no network, no database, no
    /// code execution.
    /// </summary>
    public static Task<McpSecurityResult> AuditAsync(
        string candidatePath,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(candidatePath))
        {
            return Task.FromResult(McpSecurityResult.Failed(
                "Choose the folder holding the candidate server's source."));
        }

        var path = candidatePath.Trim().Trim('"');
        if (!Directory.Exists(path))
        {
            return Task.FromResult(McpSecurityResult.Failed($"No such folder: {path}"));
        }

        return RunAsync("audit", [path, "--json"], FormatAudit, cancellationToken);
    }

    private static async Task<McpSecurityResult> RunAsync(
        string subcommand,
        string[] arguments,
        Func<JsonElement, int, string> format,
        CancellationToken cancellationToken)
    {
        string root;
        string node;
        try
        {
            root = AgentBridge.FindHelmionRoot()
                   ?? throw new InvalidOperationException(
                       "Could not find the Helmion repo (bin/helmion.mjs).");
            node = AgentBridge.FindNodeExecutable()
                   ?? throw new FileNotFoundException(
                       "node.exe not found on PATH. Install Node 20+ to run the MCP security stages.");
        }
        catch (Exception ex)
        {
            return McpSecurityResult.Failed(ex.Message);
        }

        var start = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        start.ArgumentList.Add(Path.Combine(root, "bin", "helmion.mjs"));
        start.ArgumentList.Add("mcp-install");
        start.ArgumentList.Add(subcommand);
        foreach (var arg in arguments)
        {
            start.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = start };
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };

        try
        {
            if (!process.Start())
            {
                return McpSecurityResult.Failed("Failed to start node.");
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            // Close the child's stdin immediately. Nothing on these two stages
            // reads it, and an inherited open handle is how a "non-interactive"
            // run turns into a hang.
            try { process.StandardInput.Close(); } catch { /* already gone */ }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(DefaultTimeoutMs);

            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return McpSecurityResult.Failed(
                    $"mcp-install {subcommand} did not finish within {DefaultTimeoutMs / 1000}s — cancelled.");
            }
        }
        catch (Exception ex)
        {
            return McpSecurityResult.Failed($"Could not run mcp-install {subcommand}: {ex.Message}");
        }

        var raw = stdout.ToString().Trim();
        var err = stderr.ToString().Trim();
        var exitCode = process.ExitCode;

        if (raw.Length == 0)
        {
            return McpSecurityResult.Failed(
                err.Length > 0
                    ? $"mcp-install {subcommand} failed (exit {exitCode}):\n{Trim(err, 1200)}"
                    : $"mcp-install {subcommand} produced no output (exit {exitCode}).");
        }

        try
        {
            using var doc = JsonDocument.Parse(raw);
            return new McpSecurityResult(
                true,
                exitCode,
                format(doc.RootElement, exitCode),
                raw,
                err.Length > 0 ? Trim(err, 1200) : null);
        }
        catch (JsonException)
        {
            // Report what came back rather than inventing a verdict for it.
            return new McpSecurityResult(
                false,
                exitCode,
                $"mcp-install {subcommand} returned output that is not JSON (exit {exitCode}):\n"
                + Trim(raw, 2000),
                raw,
                err.Length > 0 ? Trim(err, 1200) : null);
        }
    }

    private static string FormatDiscovery(JsonElement root, int exitCode)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"MCP DISCOVERY — need: {Str(root, "need") ?? "(unstated)"}");
        sb.AppendLine($"  query: {Str(root, "query")}");
        if (root.TryGetProperty("totalCount", out var total) && total.ValueKind == JsonValueKind.Number)
        {
            sb.AppendLine($"  matches on GitHub: {total.GetInt32()}");
        }

        if (root.TryGetProperty("repositories", out var repos) && repos.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine($"  candidates listed: {repos.GetArrayLength()}");
            sb.AppendLine();
            foreach (var repo in repos.EnumerateArray())
            {
                var stars = repo.TryGetProperty("stars", out var s) && s.ValueKind == JsonValueKind.Number
                    ? s.GetInt32()
                    : 0;
                sb.AppendLine($"  • {Str(repo, "fullName")}  ★{stars}  license={Str(repo, "license") ?? "none"}");
                var desc = Str(repo, "description");
                if (!string.IsNullOrWhiteSpace(desc)) sb.AppendLine($"      {Trim(desc!, 160)}");
                sb.AppendLine($"      {Str(repo, "htmlUrl")}");
                if (repo.TryGetProperty("provenanceNotes", out var notes)
                    && notes.ValueKind == JsonValueKind.Array)
                {
                    foreach (var note in notes.EnumerateArray())
                    {
                        sb.AppendLine($"      ! {note.GetString()}");
                    }
                }
            }
        }

        var caveat = Str(root, "caveat");
        if (!string.IsNullOrWhiteSpace(caveat))
        {
            sb.AppendLine();
            sb.AppendLine($"  NOTE: {caveat}");
        }

        sb.AppendLine();
        sb.AppendLine("  Discovery proves nothing about safety. Clone a candidate, then run Audit on it.");
        return sb.ToString().TrimEnd();
    }

    private static string FormatAudit(JsonElement root, int exitCode)
    {
        var sb = new StringBuilder();
        var verdict = Str(root, "verdict") ?? "(none)";
        var blocking = root.TryGetProperty("blocking", out var b) && b.ValueKind == JsonValueKind.True;

        sb.AppendLine($"MCP CODE READ — {Str(root, "root")}");
        var scanned = root.TryGetProperty("filesScanned", out var files)
                      && files.ValueKind == JsonValueKind.Array
            ? files.GetArrayLength()
            : 0;
        sb.AppendLine($"  files scanned: {scanned}   verdict: {verdict.ToUpperInvariant()}"
                      + (blocking ? "   ← BLOCKING" : ""));

        if (root.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.Object)
        {
            sb.AppendLine(
                $"  critical {Num(summary, "critical")} · high {Num(summary, "high")} · "
                + $"medium {Num(summary, "medium")} · low {Num(summary, "low")} · info {Num(summary, "info")}");
        }

        if (root.TryGetProperty("findings", out var findings) && findings.ValueKind == JsonValueKind.Array)
        {
            if (findings.GetArrayLength() == 0)
            {
                sb.AppendLine("  (no findings)");
            }
            else
            {
                sb.AppendLine();
                foreach (var f in findings.EnumerateArray())
                {
                    sb.AppendLine($"  [{(Str(f, "severity") ?? "?").ToUpperInvariant()}] {Str(f, "rule")}");
                    sb.AppendLine($"      {Str(f, "message")}");
                    sb.AppendLine($"      {Str(f, "citation")}");
                    var evidence = Str(f, "evidence");
                    if (!string.IsNullOrWhiteSpace(evidence))
                    {
                        sb.AppendLine($"      > {Trim(evidence!.Replace('\n', ' '), 160)}");
                    }
                }
            }
        }

        if (root.TryGetProperty("limitations", out var limits)
            && limits.ValueKind == JsonValueKind.Array
            && limits.GetArrayLength() > 0)
        {
            sb.AppendLine();
            sb.AppendLine("  WHAT THIS STAGE CANNOT SEE:");
            foreach (var limit in limits.EnumerateArray())
            {
                sb.AppendLine($"    - {limit.GetString()}");
            }
        }

        sb.AppendLine();
        sb.AppendLine($"  exit {exitCode} ({(exitCode == 2 ? "critical findings" : "no critical findings")})");
        return sb.ToString().TrimEnd();
    }

    private static string? Str(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;

    private static int Num(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0;

    private static string Trim(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";
}

/// <summary>
/// Outcome of one read-only MCP security stage. <see cref="Summary"/> is always
/// safe to show the user; <see cref="RawJson"/> is the unmodified stage report.
/// </summary>
public sealed record McpSecurityResult(
    bool Ok,
    int ExitCode,
    string Summary,
    string RawJson,
    string? Stderr)
{
    public static McpSecurityResult Failed(string message) =>
        new(false, -1, message, string.Empty, null);
}

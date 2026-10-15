using System.Diagnostics;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>Raised when a CLI subprocess chat turn cannot complete.</summary>
public sealed class ProviderCliChatException(string message) : Exception(message);

/// <summary>
/// Runs one chat turn by shelling out to a provider's own official CLI in non-interactive mode,
/// instead of calling that provider's undocumented subscription backend directly. The CLI reads
/// its own auth file (<see cref="CodexCliSessionReader"/> / <see cref="GeminiCliSessionReader"/>
/// only ever READ that file, never write it) and does whatever request it already knows how to
/// make correctly.
///
/// <para>
/// Both CLIs are invoked read-only / plan-mode — this is a chat assistant, not a coding agent
/// turned loose on Helmion's own filesystem, so neither CLI is given permission to edit files or
/// run shell commands on Troy's machine from inside a chat turn.
/// </para>
/// </summary>
public sealed record ProviderCliChatResult(string Text, bool IsError);

public static class ProviderCliChatSession
{
    /// <summary>
    /// codex exec — verified against `codex exec --help` on the installed CLI, 2026-08-04.
    /// --sandbox read-only and --ephemeral keep this to "answer, don't touch the filesystem, don't
    /// persist a session file." --json streams structured events; -o writes the final message to
    /// a temp file so a truncated/garbled stdout parse still leaves a clean answer to read.
    /// </summary>
    public static async IAsyncEnumerable<ProviderCliChatResult> SendToCodexAsync(
        string prompt,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var outputFile = Path.Combine(Path.GetTempPath(), $"helmion-codex-{Guid.NewGuid():N}.txt");
        var psi = new ProcessStartInfo
        {
            FileName = "codex",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        ClearApiKeyEnvironment(psi, "OPENAI_API_KEY");
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--sandbox");
        psi.ArgumentList.Add("read-only");
        psi.ArgumentList.Add("--ephemeral");
        psi.ArgumentList.Add("--skip-git-repo-check");
        psi.ArgumentList.Add("-o");
        psi.ArgumentList.Add(outputFile);
        psi.ArgumentList.Add(prompt);

        string? failure = null;
        string answer = "";
        try
        {
            answer = await RunAndReadOutputFileAsync(psi, outputFile, "codex", cancellationToken);
        }
        catch (ProviderCliChatException ex)
        {
            failure = ex.Message;
        }

        if (failure is not null)
        {
            yield return new ProviderCliChatResult(failure, IsError: true);
            yield break;
        }

        yield return new ProviderCliChatResult(answer, IsError: false);
    }

    /// <summary>
    /// gemini -p — verified against `gemini --help` on the installed CLI, 2026-08-04.
    /// --approval-mode plan is Gemini CLI's read-only mode (no tool execution), matching Codex's
    /// --sandbox read-only above. --output-format json gives a parseable envelope instead of
    /// terminal-formatted text.
    /// </summary>
    public static async IAsyncEnumerable<ProviderCliChatResult> SendToGeminiAsync(
        string prompt,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "gemini",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        ClearApiKeyEnvironment(psi, "GEMINI_API_KEY", "GOOGLE_API_KEY");
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add(prompt);
        psi.ArgumentList.Add("--approval-mode");
        psi.ArgumentList.Add("plan");
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("json");

        string? failure = null;
        string answer = "";
        try
        {
            answer = await RunAndReadJsonStdoutAsync(psi, "gemini", cancellationToken);
        }
        catch (ProviderCliChatException ex)
        {
            failure = ex.Message;
        }

        if (failure is not null)
        {
            yield return new ProviderCliChatResult(failure, IsError: true);
            yield break;
        }

        yield return new ProviderCliChatResult(answer, IsError: false);
    }

    /// <summary>
    /// Runs the provider-owned Claude Code CLI in its documented non-interactive,
    /// read-only permission mode. Helmion does not pass its locally stored
    /// setup-token to this process: Claude Code owns its own sign-in and auth state.
    /// </summary>
    public static async IAsyncEnumerable<ProviderCliChatResult> SendToClaudeAsync(
        string prompt,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "claude",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        ClearApiKeyEnvironment(psi, "ANTHROPIC_API_KEY");
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add(prompt);
        psi.ArgumentList.Add("--permission-mode");
        psi.ArgumentList.Add("plan");
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("json");

        var result = await RunResultAsync(psi, "Claude Code", cancellationToken);
        yield return result;
    }

    /// <summary>
    /// Runs the official Grok CLI in one-turn plan mode. This avoids treating a
    /// SuperGrok desktop session as an xAI API key, which is what causes the
    /// Chat Completions entitlement rejection for subscription-only accounts.
    /// </summary>
    public static async IAsyncEnumerable<ProviderCliChatResult> SendToGrokAsync(
        string prompt,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "grok",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        ClearApiKeyEnvironment(psi, "XAI_API_KEY", "GROK_API_KEY");
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add(prompt);
        psi.ArgumentList.Add("--permission-mode");
        psi.ArgumentList.Add("plan");
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("--no-memory");
        psi.ArgumentList.Add("--no-subagents");
        psi.ArgumentList.Add("--disable-web-search");

        var result = await RunResultAsync(psi, "Grok CLI", cancellationToken);
        yield return result;
    }

    private static async Task<ProviderCliChatResult> RunResultAsync(
        ProcessStartInfo psi,
        string toolName,
        CancellationToken cancellationToken)
    {
        try
        {
            return new ProviderCliChatResult(
                await RunAndReadJsonStdoutAsync(psi, toolName, cancellationToken),
                IsError: false);
        }
        catch (ProviderCliChatException ex)
        {
            return new ProviderCliChatResult(ex.Message, IsError: true);
        }
    }

    /// <summary>
    /// A provider-owned CLI must choose its own subscription session for this path.
    /// Do not let an inherited API-key environment variable silently switch it back
    /// to the separate API billing/entitlement route.
    /// </summary>
    private static void ClearApiKeyEnvironment(ProcessStartInfo psi, params string[] names)
    {
        foreach (var name in names)
        {
            psi.Environment.Remove(name);
        }
    }

    private static async Task<string> RunAndReadOutputFileAsync(
        ProcessStartInfo psi, string outputFile, string toolName, CancellationToken cancellationToken)
    {
        try
        {
            using var process = Process.Start(psi)
                ?? throw new ProviderCliChatException($"Could not start {toolName}.");

            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                throw new ProviderCliChatException(
                    $"{toolName} exited with code {process.ExitCode}"
                    + (string.IsNullOrWhiteSpace(stderr) ? "." : $": {Truncate(stderr)}"));
            }

            if (!File.Exists(outputFile))
            {
                throw new ProviderCliChatException(
                    $"{toolName} finished but did not write an answer. Is it signed in? Run "
                    + $"\"{toolName} login\" in a terminal.");
            }

            var text = await File.ReadAllTextAsync(outputFile, cancellationToken);
            return text.Trim();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            throw new ProviderCliChatException(
                $"Could not find the \"{toolName}\" command on PATH ({ex.Message}). Install the "
                + $"official {toolName} CLI and sign in with \"{toolName} login\" first.");
        }
        finally
        {
            try { if (File.Exists(outputFile)) File.Delete(outputFile); } catch { /* best effort */ }
        }
    }

    private static async Task<string> RunAndReadJsonStdoutAsync(
        ProcessStartInfo psi, string toolName, CancellationToken cancellationToken)
    {
        try
        {
            using var process = Process.Start(psi)
                ?? throw new ProviderCliChatException($"Could not start {toolName}.");

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                throw new ProviderCliChatException(
                    $"{toolName} exited with code {process.ExitCode}"
                    + (string.IsNullOrWhiteSpace(stderr) ? "." : $": {Truncate(stderr)}"));
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                throw new ProviderCliChatException(
                    $"{toolName} produced no output. Is it signed in? Run \"{toolName}\" once "
                    + "interactively to complete login.");
            }

            try
            {
                using var doc = JsonDocument.Parse(stdout);
                // Gemini CLI's JSON output shape is not independently verified here beyond
                // "top-level object with a text-ish field" — fall through to raw stdout rather
                // than guess a field name that might not exist.
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (var candidate in new[] { "result", "response", "text", "output", "answer" })
                    {
                        if (doc.RootElement.TryGetProperty(candidate, out var field)
                            && field.ValueKind == JsonValueKind.String)
                        {
                            return field.GetString() ?? stdout.Trim();
                        }
                    }
                }
            }
            catch (JsonException)
            {
                // Not JSON despite --output-format json (older CLI version?) — return raw text.
            }

            return stdout.Trim();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            throw new ProviderCliChatException(
                $"Could not find the \"{toolName}\" command on PATH ({ex.Message}). Install the "
                + $"official {toolName} CLI and sign in first.");
        }
    }

    /// <summary>
    /// agy.exe --print — Google's official Antigravity CLI. Verified live 2026-08-05: installed
    /// via the official installer (irm https://antigravity.google/cli/install.ps1 | iex), answers
    /// real prompts with no login step because it shares an already-authenticated session with
    /// the Antigravity desktop app already installed on this machine (confirmed in
    /// cli.log: "applyAuthResult: email=..., authMethod=consumer" — a real consumer Google
    /// account, not enterprise). --mode plan is Antigravity's read-only mode, matching the
    /// pattern used for Codex/Gemini above.
    /// </summary>
    public static async IAsyncEnumerable<ProviderCliChatResult> SendToAntigravityAsync(
        string prompt,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var psi = new ProcessStartInfo
        {
            FileName = AntigravityCliSessionReader.ExecutablePath(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("--print");
        psi.ArgumentList.Add(prompt);
        psi.ArgumentList.Add("--mode");
        psi.ArgumentList.Add("plan");

        string? failure = null;
        string answer = "";
        try
        {
            answer = await RunAndReadStdoutTextAsync(psi, "Antigravity", cancellationToken);
        }
        catch (ProviderCliChatException ex)
        {
            failure = ex.Message;
        }

        if (failure is not null)
        {
            yield return new ProviderCliChatResult(failure, IsError: true);
            yield break;
        }

        yield return new ProviderCliChatResult(answer, IsError: false);
    }

    private static async Task<string> RunAndReadStdoutTextAsync(
        ProcessStartInfo psi, string toolName, CancellationToken cancellationToken)
    {
        try
        {
            using var process = Process.Start(psi)
                ?? throw new ProviderCliChatException($"Could not start {toolName}.");

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                throw new ProviderCliChatException(
                    $"{toolName} exited with code {process.ExitCode}"
                    + (string.IsNullOrWhiteSpace(stderr) ? "." : $": {Truncate(stderr)}"));
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                throw new ProviderCliChatException($"{toolName} produced no output.");
            }

            return stdout.Trim();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            throw new ProviderCliChatException(
                $"Could not find {toolName} on PATH ({ex.Message}). Install it from "
                + "antigravity.google/cli/install.");
        }
    }

    private static string Truncate(string text) => text.Length > 300 ? text[..300] : text;
}

/// <summary>
/// Reads whether Antigravity CLI has a usable authenticated session, by tailing its own log for
/// the last successful auth result. Read-only, mirrors <see cref="GrokCliSessionReader"/> — never
/// writes to or modifies Antigravity's own state.
/// </summary>
public static class AntigravityCliSessionReader
{
    public static string ExecutablePath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "agy", "bin", "agy.exe");

    private static string LogDirectory() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".gemini", "antigravity-cli");

    /// <summary>
    /// Returns the email of the last successful auth result found in the CLI's own logs, or null
    /// if no log carries one. Scans the most recently modified log file only — these logs rotate
    /// per session, so older ones are not authoritative about the current state.
    /// </summary>
    public static string? TryReadAuthenticatedEmail()
    {
        var logDir = System.IO.Path.Combine(LogDirectory(), "log");
        if (!Directory.Exists(logDir)) return null;

        var newest = new DirectoryInfo(logDir)
            .GetFiles("cli-*.log")
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .FirstOrDefault();
        if (newest is null) return null;

        try
        {
            string? lastMatch = null;
            foreach (var line in File.ReadLines(newest.FullName))
            {
                var idx = line.IndexOf("applyAuthResult: email=", StringComparison.Ordinal);
                if (idx < 0) continue;
                var rest = line[(idx + "applyAuthResult: email=".Length)..];
                var comma = rest.IndexOf(',');
                lastMatch = comma > 0 ? rest[..comma] : rest.Trim();
            }
            return lastMatch;
        }
        catch (IOException)
        {
            return null;
        }
    }
}

using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>
/// Signs the official Grok CLI (Grok Build) in and out by running it hidden, so the user
/// never opens a terminal. The CLI owns its own sign-in in <c>~/.grok/auth.json</c>; Helmion
/// only runs <c>grok login --device-auth</c> / <c>grok logout</c> and reads that file to
/// report status, read-only. Read-only chat turns then run <c>grok -p</c>
/// (<see cref="ProviderCliChatSession.SendToGrokAsync"/>), which uses that same sign-in.
///
/// <para>
/// Flags verified against docs.x.ai/build/enterprise (Authentication): "Device code:
/// <c>grok login --device-auth</c> … Grok prints a URL and a short user code. Complete login
/// on any device with a browser." <c>grok logout</c> is listed in docs.x.ai/build/cli/reference.
/// </para>
/// </summary>
public static partial class GrokCliLogin
{
    public const string InstallUrl = "https://docs.x.ai/build/overview";

    public const string NotInstalledMessage =
        "The Grok app (Grok Build) isn't installed on this PC. Install it from "
        + InstallUrl + ", then press Sign in again.";

    public const string PlanMissingMessage =
        "Your Grok plan doesn't include Grok Build. Use an xAI API key in Settings or upgrade your plan.";

    public const string SignInNeededMessage =
        "Grok isn't signed in. Click \"Sign in with SuperGrok\" on the Grok card in Integrations "
        + "(or \"Login with SuperGrok\" in Settings), then try again.";

    /// <summary>Map raw Grok CLI output to a plain message; unrecognised text passes through.</summary>
    public static string FriendlyError(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return message;
        if (message.Contains("403", StringComparison.Ordinal)
            || message.Contains("does not have Grok", StringComparison.OrdinalIgnoreCase)
            || message.Contains("entitle", StringComparison.OrdinalIgnoreCase))
        {
            return PlanMissingMessage;
        }
        if (message.Contains("command on PATH", StringComparison.OrdinalIgnoreCase)
            || message.Contains("Could not start Grok", StringComparison.OrdinalIgnoreCase))
        {
            return NotInstalledMessage;
        }
        if (message.Contains("not signed in", StringComparison.OrdinalIgnoreCase)
            || message.Contains("grok login", StringComparison.OrdinalIgnoreCase))
        {
            return SignInNeededMessage;
        }
        return message;
    }

    [GeneratedRegex(@"https://[^\s""'<>)\]]+", RegexOptions.IgnoreCase)]
    private static partial Regex UrlPattern();

    [GeneratedRegex(@"code\W{0,6}([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})*)", RegexOptions.IgnoreCase)]
    private static partial Regex LabelledCodePattern();

    [GeneratedRegex(@"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")]
    private static partial Regex BareCodePattern();

    /// <summary>First https URL in a line of CLI output, or null.</summary>
    public static string? ParseVerificationUrl(string line)
    {
        var match = UrlPattern().Match(line ?? "");
        return match.Success ? match.Value.TrimEnd('.', ',', ';') : null;
    }

    /// <summary>
    /// The user code from a line of CLI output ("code: ABCD-EFGH", or a bare ABCD-EFGH), or
    /// null. URLs are removed first so a query string is never mistaken for the code.
    /// </summary>
    public static string? ParseUserCode(string line)
    {
        var text = UrlPattern().Replace(line ?? "", " ");
        var labelled = LabelledCodePattern().Match(text);
        if (labelled.Success)
        {
            var value = labelled.Groups[1].Value;
            // "the code below" must not count: a real code has a digit or a dash.
            if (value.Any(char.IsDigit) || value.Contains('-')) return value.ToUpperInvariant();
        }
        var bare = BareCodePattern().Match(text);
        return bare.Success ? bare.Groups[1].Value : null;
    }

    /// <summary>
    /// True when the CLI's auth file holds an xAI sign-in that the CLI can use or refresh
    /// (an access key or a refresh token under the auth.x.ai issuer). Read-only; never writes.
    /// </summary>
    public static bool HasCliSession(string? authFilePath = null)
    {
        var path = authFilePath ?? GrokCliSessionReader.DefaultAuthFilePath();
        try
        {
            if (!File.Exists(path)) return false;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
            foreach (var entry in document.RootElement.EnumerateObject())
            {
                if (!entry.Name.StartsWith(SuperGrokOAuthClient.Issuer, StringComparison.OrdinalIgnoreCase)) continue;
                if (entry.Value.ValueKind != JsonValueKind.Object) continue;
                if (HasText(entry.Value, "key") || HasText(entry.Value, "refresh_token")) return true;
            }
            return false;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool HasText(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(value.GetString());

    /// <summary>Result of a hidden CLI run.</summary>
    public sealed record RunResult(bool Started, int ExitCode, string Output);

    /// <summary>
    /// Run <c>grok login --device-auth</c> hidden. Each stdout/stderr line is passed to
    /// <paramref name="onLine"/> (on a thread-pool thread) so the caller can pick out the URL
    /// and code. Cancelling kills the process.
    /// </summary>
    public static Task<RunResult> RunLoginAsync(Action<string> onLine, CancellationToken cancellationToken) =>
        RunHiddenAsync(["login", "--device-auth"], onLine, TimeSpan.FromMinutes(15), cancellationToken);

    /// <summary>Run <c>grok logout</c> hidden.</summary>
    public static Task<RunResult> RunLogoutAsync(CancellationToken cancellationToken) =>
        RunHiddenAsync(["logout"], _ => { }, TimeSpan.FromMinutes(1), cancellationToken);

    /// <summary>
    /// "grok" from PATH first, then the official installer's location (~/.grok/bin/grok.exe).
    /// </summary>
    private static IEnumerable<string> Candidates()
    {
        yield return "grok";
        yield return InstallerExecutablePath();
    }

    private static string InstallerExecutablePath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".grok", "bin", "grok.exe");

    /// <summary>
    /// The grok executable for chat turns: the official installer's grok.exe when present
    /// (works even if this app started before PATH was updated), else "grok" from PATH.
    /// </summary>
    public static string ResolveExecutable()
    {
        var installed = InstallerExecutablePath();
        return File.Exists(installed) ? installed : "grok";
    }

    private static async Task<RunResult> RunHiddenAsync(
        string[] arguments,
        Action<string> onLine,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        foreach (var fileName in Candidates())
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var argument in arguments) psi.ArgumentList.Add(argument);
            // The CLI must use its own sign-in, never an inherited API key.
            psi.Environment.Remove("XAI_API_KEY");
            psi.Environment.Remove("GROK_API_KEY");

            Process process;
            try
            {
                process = Process.Start(psi) ?? throw new Win32Exception();
            }
            catch (Win32Exception)
            {
                continue; // not at this location; try the next one
            }

            using (process)
            {
                var output = new System.Text.StringBuilder();
                void Handle(string? line)
                {
                    if (line is null) return;
                    lock (output) output.AppendLine(line);
                    onLine(line);
                }
                process.OutputDataReceived += (_, e) => Handle(e.Data);
                process.ErrorDataReceived += (_, e) => Handle(e.Data);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                try { process.StandardInput.Close(); } catch { /* no input is ever sent */ }

                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeoutCts.CancelAfter(timeout);
                try
                {
                    await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
                    throw;
                }
                process.WaitForExit(); // flush the async output readers
                string text;
                lock (output) text = output.ToString();
                return new RunResult(true, process.ExitCode, text);
            }
        }
        return new RunResult(false, -1, "");
    }
}

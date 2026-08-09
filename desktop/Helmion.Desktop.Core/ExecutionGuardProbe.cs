using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Helmion.Desktop.Core;

/// <summary>What a liveness probe concluded, and how it knows.</summary>
/// <param name="Level">
/// Normal when the guard provably refused a known-destructive command AND
/// allowed a known-harmless one. Critical when it failed either. Unknown ONLY
/// when the probe could not run at all — a missing node, a missing CLI. Unknown
/// still means "could not compute", never "probably fine".
/// </param>
public sealed record GuardProbeResult(
    GuardLevel Level,
    string Title,
    string Detail,
    bool RefusedDestructive,
    bool AllowedHarmless,
    TimeSpan Elapsed);

/// <summary>
/// Answers "is the execution guard actually live right now" by asking it.
///
/// WHY A PROBE AND NOT AN INSPECTION. The panel used to report this Unknown, and
/// the reason it gave was true: the destructive-pattern gate runs in the Node
/// agent process, and this window does not host it. Checking that the FILE
/// exists would not fix that — a file on disk proves nothing about whether the
/// gate is wired into the path that runs commands. The only honest way to know a
/// guard is alive is to hand it something it must refuse and watch it refuse.
///
/// So this runs `helmion guard`, the same stdin/stdout entry point a Claude Code
/// PreToolUse hook uses (bin/helmion.mjs:501), twice:
///
///   1. a known-destructive command  -> must come back allowed:false, exit 2
///   2. a known-harmless command     -> must come back allowed:true
///
/// BOTH directions, because a gate stuck refusing everything is just as broken as
/// one stuck allowing everything, and only the second probe can tell them apart.
/// This is the same discipline the browser extension's own self-test uses.
///
/// IT MUST NOT POLLUTE THE LEDGER. `helmion guard` writes a real block event to
/// &lt;cwd&gt;/.helmion/audit/ every time it refuses something (bin/helmion.mjs:536).
/// A probe running on every panel refresh would fill the evidence log with
/// thousands of blocks nobody ever attempted. So the probe runs with its working
/// directory set to a THROWAWAY temp folder, and deletes it. The real ledger
/// never sees a probe row.
/// </summary>
public static class ExecutionGuardProbe
{
    /// <summary>The command the gate must always refuse. Aimed at a path that does not exist.</summary>
    public const string DestructiveProbe = "rm -rf /helmion-liveness-probe-not-a-real-path";

    /// <summary>The command the gate must always allow.</summary>
    public const string HarmlessProbe = "echo helmion-liveness-probe";

    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(25);

    public static async Task<GuardProbeResult> RunAsync(
        string helmionRoot,
        CancellationToken cancellationToken = default)
    {
        var started = Stopwatch.StartNew();
        var cli = Path.Combine(helmionRoot ?? string.Empty, "bin", "helmion.mjs");

        if (!File.Exists(cli))
        {
            return new GuardProbeResult(
                GuardLevel.Unknown,
                "I could not test whether dangerous commands are blocked",
                "Helmion's own command-line program is not where I expected it, so I had nothing "
                + "to ask. I do not know whether dangerous commands would be stopped. "
                + "This is not an all-clear.",
                false, false, started.Elapsed);
        }

        // Throwaway working directory: any block the probe triggers is recorded
        // there and thrown away with it, never in the operator's real ledger.
        var scratch = Path.Combine(Path.GetTempPath(), $"helmion-probe-{Guid.NewGuid():N}");
        Directory.CreateDirectory(scratch);

        try
        {
            var blocked = await AskGuardAsync(cli, scratch, DestructiveProbe, cancellationToken);
            var allowed = await AskGuardAsync(cli, scratch, HarmlessProbe, cancellationToken);

            if (blocked.Failed || allowed.Failed)
            {
                var why = blocked.Failed ? blocked.Error : allowed.Error;
                return new GuardProbeResult(
                    GuardLevel.Unknown,
                    "I could not test whether dangerous commands are blocked",
                    $"The test itself did not run — {why}. I do not know whether dangerous "
                    + "commands would be stopped. This is not an all-clear.",
                    false, false, started.Elapsed);
            }

            var refusedDestructive = blocked.Allowed == false;
            var allowedHarmless = allowed.Allowed == true;

            // THE WORDING SAYS WHAT WAS DONE, NOT WHAT IS TRUE RIGHT NOW.
            //
            // This card said "Execution guard is LIVE … Probed just now". It is
            // published once, from PublishStaticPostureCards, and nothing calls it
            // again — so six hours later "just now" was a green all-clear for a
            // check that had not run since. The caller appends
            // GuardFreshness.MeasuredAt, which names the clock time and says out
            // loud that nothing re-checks it.
            if (refusedDestructive && allowedHarmless)
            {
                return new GuardProbeResult(
                    GuardLevel.Normal,
                    "Dangerous commands are being blocked",
                    "I asked Helmion to run a command that would delete a whole folder tree and it "
                    + "refused, then asked it to run a harmless one and it allowed that. Both "
                    + "directions matter: something that refuses everything is just as broken as "
                    + "something that refuses nothing. Nothing real was run either way.",
                    true, true, started.Elapsed);
            }

            if (!refusedDestructive)
            {
                return new GuardProbeResult(
                    GuardLevel.Critical,
                    "DANGEROUS COMMANDS ARE NOT BEING BLOCKED",
                    "I asked Helmion to run a command that would delete a whole folder tree, and it "
                    + "let it through. Nothing is stopping destructive commands in this project. "
                    + "Do not let an agent run unattended until this is fixed.",
                    false, allowedHarmless, started.Elapsed);
            }

            return new GuardProbeResult(
                GuardLevel.Critical,
                "Everything is being blocked, including safe commands",
                "Helmion refused a completely harmless command as well as a dangerous one, which "
                + "means its rules are wrong or cannot be read. Work will fail for no reason until "
                + "this is fixed.",
                true, false, started.Elapsed);
        }
        finally
        {
            try { Directory.Delete(scratch, recursive: true); } catch { /* temp dir */ }
        }
    }

    /// <summary>
    /// One verdict from the guard. Public so the smoke suite can pin
    /// <see cref="ParseVerdict"/> — the piece that decides whether a crashed node
    /// is mistaken for a successful block.
    /// </summary>
    public sealed record GuardAnswer(bool? Allowed, bool Failed, string Error);

    private static async Task<GuardAnswer> AskGuardAsync(
        string cli,
        string workingDirectory,
        string command,
        CancellationToken cancellationToken)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = workingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(cli);
        psi.ArgumentList.Add("guard");

        try
        {
            using var process = Process.Start(psi);
            if (process is null) return new GuardAnswer(null, true, "node could not be started");

            var payload = JsonSerializer.Serialize(new { tool_input = new { command } });
            await process.StandardInput.WriteAsync(payload.AsMemory(), cancellationToken);
            process.StandardInput.Close();

            var stdout = new StringBuilder();
            var readOut = process.StandardOutput.ReadToEndAsync(cancellationToken)
                .ContinueWith(t => stdout.Append(t.Result), TaskScheduler.Default);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return new GuardAnswer(null, true, $"the guard did not answer within {Timeout.TotalSeconds:0}s");
            }

            await readOut;
            return ParseVerdict(stdout.ToString());
        }
        catch (Exception ex)
        {
            return new GuardAnswer(null, true, ex.Message);
        }
    }

    /// <summary>
    /// Reads `allowed` out of the guard's JSON verdict.
    ///
    /// The EXIT CODE is deliberately not used as the signal. bin/helmion.mjs:545
    /// sets exit 2 on a block, but a non-zero exit can also mean node crashed —
    /// and treating a crash as "successfully blocked" would report a dead guard
    /// as a live one. The verdict body is the only thing that distinguishes them.
    /// </summary>
    public static GuardAnswer ParseVerdict(string stdout)
    {
        var text = (stdout ?? string.Empty).Trim();
        if (text.Length == 0) return new GuardAnswer(null, true, "the guard printed nothing");

        // The verdict is the last JSON line; anything before it is noise.
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Reverse())
        {
            var candidate = line.Trim();
            if (!candidate.StartsWith('{')) continue;
            try
            {
                using var document = JsonDocument.Parse(candidate);
                if (document.RootElement.TryGetProperty("allowed", out var allowed)
                    && (allowed.ValueKind == JsonValueKind.True || allowed.ValueKind == JsonValueKind.False))
                {
                    return new GuardAnswer(allowed.GetBoolean(), false, string.Empty);
                }
            }
            catch (JsonException)
            {
                // Not the verdict line. Keep looking.
            }
        }

        return new GuardAnswer(null, true, "the guard's answer had no 'allowed' field");
    }
}

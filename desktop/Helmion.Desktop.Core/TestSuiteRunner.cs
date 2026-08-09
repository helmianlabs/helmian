using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Helmion.Desktop.Core;

/// <summary>
/// RUNS THE REAL TEST SUITES, HIDDEN, AND REPORTS WHAT ACTUALLY HAPPENED.
///
/// WHAT THIS IS FOR. The guard panel's "Run test suite" button is meant to be the
/// place the operator proves the system works. It used to print a list of commands
/// for him to type into a terminal himself and end with "This panel does not start
/// processes, so nothing was run". This type is the thing that makes the button a
/// button.
///
/// WHY IT LIVES IN CORE AND NOT IN THE CLICK HANDLER. A WPF click handler cannot be
/// called from a headless test process, so anything that lives inside one is,
/// permanently, unassertable — which is exactly how a dead button survived ~900
/// checks. Everything with behaviour is here, where TestSuiteRunnerChecks drives it
/// directly. The click handler is reduced to a call.
///
/// THE FOUR RULES IT OBEYS.
///
///  1. IT RUNS THE SUITES THE REPO ALREADY DEFINES. The commands are read out of the
///     workspace's own package.json (<see cref="TestSuiteCommandResolver"/>), never
///     hardcoded here, so this cannot drift from what the repo says its tests are —
///     and there is deliberately no third "sandbox suite" that this file could pass
///     on its own terms.
///
///  2. NOTHING APPEARS ON SCREEN. Every process is created through the single
///     factory <see cref="CreateStartInfo"/>, so there is one place to audit and one
///     place for a test to assert against. See its own comment for why
///     CreateNoWindow alone is not the reason it is safe.
///
///  3. IT NEVER SAYS GREEN FOR A RUN IT CANNOT VOUCH FOR. Exit code is the ground
///     truth. A suite that could not start, was cancelled, timed out, or finished
///     zero-but-illegibly is reported as its own state — never as passing. See
///     <see cref="TestSuiteStatus"/>, every member of which exists because rounding
///     it up to Passed would be a lie.
///
///  4. IT REPORTS COUNTS IT PARSED, AND SAYS SO WHEN IT COULD NOT PARSE THEM. A tick
///     is not a result. "861 tests, 861 passed, 0 failed, exit 0" is.
/// </summary>
public static class TestSuiteRunner
{
    /// <summary>How long a single suite may run before it is killed and reported as timed out.</summary>
    public static readonly TimeSpan DefaultSuiteTimeout = TimeSpan.FromMinutes(15);

    /// <summary>
    /// TRUE WHEN THE OPERATOR IS PROBABLY TALKING RIGHT NOW.
    ///
    /// The desktop suite's VoiceHostSmokeChecks starts a SECOND helmion-voice.exe and
    /// makes it load Kokoro and Whisper. That is the one check in ~900 that competes
    /// with the operator's own voice stack: measured back to back on this machine, the
    /// selftest's synthesis step took 2,762 ms with nothing else running and 7,575 ms
    /// with a second voice process alive — 2.7x. Dictation latency is the thing he
    /// would feel.
    ///
    /// WHAT IT DOES NOT DO, stated because the opposite was assumed and it changes the
    /// fix. The selftest does NOT open a capture stream: Helmion.Voice.Host/Program.cs
    /// :686-697 synthesizes to a WAV FILE and transcribes that FILE, and its only
    /// microphone contact is AudioDevicePosture.ReadDefaultCapture, which reads
    /// FriendlyName / Mute / MasterVolumeLevelScalar off the endpoint
    /// (AudioDevicePosture.cs:44-60) and asserts they did not change. So this guard is
    /// about CONTENTION, not about a stolen device — which is why it is a skip when the
    /// host is live rather than a permanent removal.
    /// </summary>
    public static bool LiveVoiceHostIsRunning()
    {
        try
        {
            foreach (var process in Process.GetProcessesByName("helmion-voice"))
            {
                process.Dispose();
                return true;
            }

            return false;
        }
        catch (InvalidOperationException)
        {
            // COULD NOT TELL. Answering "no" would run the check anyway; the whole
            // point of the guard is that the expensive mistake is in that direction.
            return true;
        }
    }

    /// <summary>
    /// THE ONLY PLACE A PROCESS IS CREATED, so "nothing may appear on Troy's screen"
    /// has one audit point instead of several.
    ///
    /// WHY IT IS ACTUALLY HIDDEN, PRECISELY. CreateNoWindow is not a magic hide flag
    /// and setting it is not the argument — publish.ps1 sets it while launching a WPF
    /// app and that app's window appears anyway, because CreateNoWindow only governs
    /// whether a CONSOLE is allocated for a console subsystem process. It is
    /// sufficient here for one reason and one reason only: everything spawned from
    /// this file is a console program (cmd.exe, and under it node.exe / dotnet.exe),
    /// so its console IS its only window. Nothing here launches a GUI subsystem
    /// binary, and if anything ever does, this comment is wrong and so is the flag.
    ///
    /// UseShellExecute MUST STAY FALSE. It is what makes CreateNoWindow apply at all
    /// (the flag is ignored when shell-executing) and what allows the pipes below.
    /// WindowStyle is redundant in that mode and is set anyway so that a test has a
    /// second, independent property to assert.
    ///
    /// STANDARD INPUT IS REDIRECTED AND IMMEDIATELY CLOSED. A child that decides to
    /// prompt gets EOF and dies, rather than blocking forever on a console nobody can
    /// see and nobody can answer.
    /// </summary>
    public static ProcessStartInfo CreateStartInfo(
        string command,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? extraEnvironment = null)
    {
        var comSpec = Environment.GetEnvironmentVariable("ComSpec");
        if (string.IsNullOrWhiteSpace(comSpec))
        {
            comSpec = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = comSpec,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };

        // /d skips AutoRun registry commands, so a machine-local profile script cannot
        // inject anything into a run the operator believes is just the test suite.
        // /s with the whole command in one quoted argument keeps cmd's quote-stripping
        // rules from mangling scripts that contain quotes.
        startInfo.ArgumentList.Add("/d");
        startInfo.ArgumentList.Add("/s");
        startInfo.ArgumentList.Add("/c");
        startInfo.ArgumentList.Add(command);

        // Colour escapes would land in the panel as unreadable bracket noise, and the
        // count parser would have to strip them back out.
        startInfo.Environment["NO_COLOR"] = "1";
        startInfo.Environment["FORCE_COLOR"] = "0";
        startInfo.Environment["DOTNET_NOLOGO"] = "1";
        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";

        // A caller may itself be running inside a voice-protected smoke process.
        // Do not let that inherited request silently make an explicitly unprotected
        // child incomplete. RunOneAsync adds it back below only when this child is
        // deliberately protecting the live voice host.
        startInfo.Environment.Remove(TestSuiteSkipContract.VoiceHostVariable);

        if (extraEnvironment is not null)
        {
            foreach (var (key, value) in extraEnvironment)
            {
                startInfo.Environment[key] = value;
            }
        }

        return startInfo;
    }

    /// <summary>
    /// Runs every suite in order, streaming each output line to <paramref name="progress"/>
    /// as it arrives. Returns one outcome per suite — including for suites that never
    /// started, which are reported rather than omitted.
    /// </summary>
    public static async Task<TestSuiteRunReport> RunAsync(
        string suiteRoot,
        IReadOnlyList<TestSuiteDefinition> suites,
        IProgress<TestSuiteProgress>? progress,
        CancellationToken cancellationToken,
        TimeSpan? suiteTimeout = null,
        bool? protectLiveVoiceHost = null)
    {
        ArgumentNullException.ThrowIfNull(suites);

        // DECIDED ONCE, FOR THE WHOLE RUN. Probing per suite could answer differently
        // halfway through and produce a report that skipped something it also claims
        // to have run.
        var protect = protectLiveVoiceHost ?? LiveVoiceHostIsRunning();

        var outcomes = new List<TestSuiteOutcome>();
        foreach (var suite in suites)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                // NOT SILENTLY DROPPED. A suite that never ran because the operator
                // stopped the run is a fact about the run, and the panel says it.
                outcomes.Add(TestSuiteOutcome.Cancelled(suite, TimeSpan.Zero, 0, "stopped before this suite started"));
                continue;
            }

            outcomes.Add(await RunOneAsync(
                    suiteRoot, suite, progress, cancellationToken, suiteTimeout, protect)
                .ConfigureAwait(false));
        }

        return new TestSuiteRunReport(suiteRoot, outcomes);
    }

    /// <summary>Resolves one suite's command, runs it hidden, and parses its counts.</summary>
    public static async Task<TestSuiteOutcome> RunOneAsync(
        string suiteRoot,
        TestSuiteDefinition suite,
        IProgress<TestSuiteProgress>? progress,
        CancellationToken cancellationToken,
        TimeSpan? suiteTimeout = null,
        bool protectLiveVoiceHost = false)
    {
        ArgumentNullException.ThrowIfNull(suite);

        var resolution = TestSuiteCommandResolver.Resolve(suiteRoot, suite);
        if (resolution.Command is null)
        {
            return TestSuiteOutcome.CannotRun(suite, resolution.Reason);
        }

        progress?.Report(new TestSuiteProgress(suite.Id, suite.Name, $"$ {resolution.Command}"));

        var started = Stopwatch.StartNew();
        var output = new StringBuilder();
        var timeout = suiteTimeout ?? DefaultSuiteTimeout;

        using var timeoutSource = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutSource.Token);

        Process process;
        try
        {
            var environment = protectLiveVoiceHost
                ? new Dictionary<string, string> { [TestSuiteSkipContract.VoiceHostVariable] = "1" }
                : null;
            var startInfo = CreateStartInfo(resolution.Command, suiteRoot, environment);
            process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("the operating system returned no process handle");
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return TestSuiteOutcome.CannotRun(
                suite, $"the command could not be started ({error.Message})");
        }

        using (process)
        {
            void Capture(string? line)
            {
                if (line is null) return;
                lock (output) { output.AppendLine(line); }
                progress?.Report(new TestSuiteProgress(suite.Id, suite.Name, line));
            }

            process.OutputDataReceived += (_, e) => Capture(e.Data);
            process.ErrorDataReceived += (_, e) => Capture(e.Data);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            // Give a child that wants to prompt an immediate EOF instead of a hang.
            try { process.StandardInput.Close(); } catch (IOException) { /* already gone */ }

            try
            {
                await process.WaitForExitAsync(linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                KillTree(process);
                var elapsed = started.Elapsed;
                var text = ReadOutput(output);

                // A TIMEOUT IS A FAILURE, A STOP IS NOT. Rounding either one up to
                // "passed" would be the defect this whole file exists to remove, and
                // rounding a timeout down to "cancelled" would hide a hung suite.
                return timeoutSource.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                    ? TestSuiteOutcome.Failed(
                        suite, exitCode: null, elapsed, suite.Parse(text),
                        $"timed out after {timeout.TotalMinutes:0} minutes and was killed", text)
                    : TestSuiteOutcome.Cancelled(suite, elapsed, suite.Parse(text).Passed ?? 0, "stopped by the operator");
            }

            // WaitForExitAsync returns once the process object signals exit; this
            // second, argument-less wait is what flushes the redirected readers, so
            // the last lines of output are not lost from the parse.
            process.WaitForExit();

            var duration = started.Elapsed;
            var stdout = ReadOutput(output);
            var exitCode = process.ExitCode;
            var counts = suite.Parse(stdout);

            if (LooksLikeMissingTool(stdout, exitCode))
            {
                return TestSuiteOutcome.CannotRun(
                    suite,
                    $"the command exited {exitCode} because the tool it needs is not on PATH — "
                    + "install it, or run the suite from a shell where it resolves");
            }

            if (exitCode != 0 || counts.Failed is > 0)
            {
                return TestSuiteOutcome.Failed(
                    suite, exitCode, duration, counts, ExtractFailureReason(stdout), stdout);
            }

            // EXIT 0 IS NOT ENOUGH ON ITS OWN. A suite that exits clean while
            // reporting no tests at all is the classic false green — a filter that
            // matched nothing, a runner that found no files. It is reported as
            // inconclusive, which never renders green.
            if (counts.Passed is not > 0)
            {
                return TestSuiteOutcome.Inconclusive(
                    suite, exitCode, duration, counts,
                    "it exited 0 but reported no test counts, so there is nothing here that proves tests ran",
                    stdout);
            }

            var skips = ExtractSkips(stdout);
            return skips.Count == 0
                ? TestSuiteOutcome.Passed(suite, exitCode, duration, counts, stdout)
                : TestSuiteOutcome.PassedWithSkips(suite, exitCode, duration, counts, stdout, skips);
        }
    }

    private static string ReadOutput(StringBuilder output)
    {
        lock (output) { return output.ToString(); }
    }

    /// <summary>
    /// Every suite that announced it did not run. Read out of the suite's OWN output
    /// rather than inferred from what the runner asked for, so a request that the suite
    /// ignored — an old binary, a renamed variable, a branch that never fires — shows
    /// up as "no skips" and the run is reported as fully green, correctly.
    /// </summary>
    public static IReadOnlyList<string> ExtractSkips(string stdout)
    {
        if (string.IsNullOrEmpty(stdout)) return [];

        var found = new List<string>();
        foreach (var raw in stdout.Split('\n'))
        {
            var line = raw.Trim();
            var at = line.IndexOf(TestSuiteSkipContract.Marker, StringComparison.Ordinal);
            if (at >= 0)
            {
                found.Add(line[(at + TestSuiteSkipContract.Marker.Length)..].Trim());
            }
        }

        return found;
    }

    private static void KillTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(10_000);
            }
        }
        catch (Exception error) when (
            error is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            // Already gone, or the OS refused. Either way there is nothing further to do.
        }
    }

    /// <summary>
    /// cmd.exe answers 9009 for a command it cannot find. Reported as CANNOT RUN
    /// rather than FAILED, because "node is not installed" and "the tests failed" are
    /// different facts and the operator acts on them differently.
    /// </summary>
    private static bool LooksLikeMissingTool(string stdout, int exitCode) =>
        exitCode == 9009
        || stdout.Contains("is not recognized as an internal or external command", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Pulls the first line that reads like the reason, so the panel can lead with it
    /// instead of making the operator scroll a stack trace to find out what broke.
    /// </summary>
    public static string ExtractFailureReason(string stdout)
    {
        foreach (var raw in stdout.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("Unhandled exception.", StringComparison.Ordinal))
            {
                var colon = line.IndexOf(": ", StringComparison.Ordinal);
                return colon >= 0 ? line[(colon + 2)..].Trim() : line;
            }

            if (line.StartsWith("error ", StringComparison.OrdinalIgnoreCase)
                || line.Contains("): error ", StringComparison.Ordinal))
            {
                return line;
            }
        }

        foreach (var raw in stdout.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Contains("not ok ", StringComparison.Ordinal) || line.StartsWith("✖", StringComparison.Ordinal))
            {
                return line;
            }
        }

        return "the suite exited non-zero; the output above is the whole of what it said";
    }
}

/// <summary>
/// THE AGREEMENT BETWEEN THE RUNNER AND THE SUITE, in one place because it is a
/// protocol between two processes.
///
/// The runner sets the variable; Program.cs reads it and prints the marker; the runner
/// reads the marker back out of stdout and refuses to call the run green. If either
/// side hardcoded its own copy of these strings, a rename would break the loop
/// silently — and "silently" here means a suite that stopped running while the panel
/// kept saying PASSED, which is the exact failure this whole feature exists to remove.
/// </summary>
public static class TestSuiteSkipContract
{
    /// <summary>Set to "1" by the runner to ask the desktop suite to leave the live voice host alone.</summary>
    public const string VoiceHostVariable = "HELMION_SMOKE_SKIP_VOICE_HOST";

    /// <summary>
    /// What a skipping suite must print. A SKIP THAT PRINTS NOTHING IS A LIE BY
    /// OMISSION — it is indistinguishable from a suite that ran and passed, which is
    /// how a suite quietly stops running for months.
    /// </summary>
    public const string Marker = "SUITE SKIPPED - ";
}

/// <summary>
/// Every state a run can end in. There is no combined "not passed" member on purpose:
/// the panel has to be able to tell the operator WHICH of these happened, because
/// "your tests are broken", "you stopped it", "it hung", and "node is not installed"
/// call for four different next actions.
/// </summary>
public enum TestSuiteStatus
{
    /// <summary>Exited 0 and reported at least one passing test. The only green state.</summary>
    Passed,

    /// <summary>Exited non-zero, or reported failures. Real red.</summary>
    Failed,

    /// <summary>Never started: no such script, no package.json, tool not installed.</summary>
    CannotRun,

    /// <summary>The operator stopped it. Says nothing about the code either way.</summary>
    Cancelled,

    /// <summary>Exited 0 but produced no legible count. Never rendered as green.</summary>
    Inconclusive,

    /// <summary>
    /// Everything that RAN passed, but part of the suite was deliberately not run.
    ///
    /// SEPARATE FROM Passed, AND NOT GREEN. The checks that were skipped might have
    /// failed; nobody knows, because nobody ran them. Folding this into Passed would
    /// mean the button could show green for a suite it had just been told to partly
    /// skip, which is a worse lie than the dead button, because it is a confident one.
    /// </summary>
    PassedWithSkips,
}

/// <summary>
/// Counts as PARSED, not as assumed. Every field is nullable because "the suite did
/// not tell us" and "the suite told us zero" are different, and collapsing them is
/// how a zero-test run gets displayed as a pass.
/// </summary>
public sealed record TestSuiteCounts(int? Total, int? Passed, int? Failed, int? Skipped)
{
    public static TestSuiteCounts Unknown { get; } = new(null, null, null, null);

    /// <summary>The count line for the panel, in the operator's words, or an admission.</summary>
    public string Describe(string noun)
    {
        if (Passed is null && Total is null)
        {
            return $"no {noun} counts could be read from the output";
        }

        var parts = new List<string>();
        if (Total is not null) parts.Add($"{Total:N0} {noun}");
        if (Passed is not null) parts.Add($"{Passed:N0} passed");
        if (Failed is not null) parts.Add($"{Failed:N0} failed");
        if (Skipped is > 0) parts.Add($"{Skipped:N0} skipped");
        return string.Join(", ", parts);
    }
}

/// <summary>One suite: what it is, which package.json script defines it, how to read its counts.</summary>
/// <param name="StopsAtFirstFailure">
/// True when the suite ABORTS on its first failing check rather than continuing and
/// tallying. The desktop smoke suite does (its Check() throws), the node runner does
/// not. This changes what its numbers MEAN — "605 passed" out of an aborting suite is
/// "605 ran before it stopped", not "605 of 606 are fine" — so the panel has to word
/// the two cases differently or it reports a near-total failure as a near-total pass.
/// </param>
public sealed record TestSuiteDefinition(
    string Id,
    string Name,
    string PackageScript,
    string WhatItCovers,
    string CountNoun,
    bool StopsAtFirstFailure,
    Func<string, TestSuiteCounts> Parse);

/// <summary>The two suites that exist. Not a menu — the repo has these and only these.</summary>
public static class TestSuiteCatalog
{
    public static TestSuiteDefinition NodeSuite { get; } = new(
        "node",
        "Node test suite",
        "test",
        "the governance kernel, the agent loop, the providers and the advisory lane",
        "tests",
        StopsAtFirstFailure: false,
        TestSuiteOutputParser.ParseNode);

    public static TestSuiteDefinition DesktopSmokeSuite { get; } = new(
        "desktop",
        "Desktop smoke suite",
        "desktop:test",
        "this app: the guard feed, the voice stack, the permission gate and the panels",
        "checks",
        StopsAtFirstFailure: true,
        TestSuiteOutputParser.ParseDesktopSmoke);

    public static IReadOnlyList<TestSuiteDefinition> All { get; } = [NodeSuite, DesktopSmokeSuite];
}

/// <summary>The command, or the named reason there isn't one. Never a guess.</summary>
public sealed record TestSuiteResolution(string? Command, string Reason);

/// <summary>
/// Reads the suite command out of the workspace's own package.json.
///
/// THE COMMAND IS NEVER HARDCODED HERE. If the repo renames or changes a test script,
/// this button changes with it; a copy of the command in C# would silently run the
/// old thing and report green for a suite that no longer exists.
/// </summary>
public static class TestSuiteCommandResolver
{
    public static TestSuiteResolution Resolve(string suiteRoot, TestSuiteDefinition suite)
    {
        ArgumentNullException.ThrowIfNull(suite);

        if (string.IsNullOrWhiteSpace(suiteRoot))
        {
            return new TestSuiteResolution(null, "no source root was resolved, so no package.json could be read");
        }

        var packagePath = Path.Combine(suiteRoot, "package.json");
        if (!File.Exists(packagePath))
        {
            return new TestSuiteResolution(null, $"there is no package.json at {packagePath}");
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(packagePath));
            if (!document.RootElement.TryGetProperty("scripts", out var scripts)
                || scripts.ValueKind != JsonValueKind.Object)
            {
                return new TestSuiteResolution(null, $"{packagePath} has no scripts section");
            }

            if (!scripts.TryGetProperty(suite.PackageScript, out var script)
                || script.ValueKind != JsonValueKind.String)
            {
                return new TestSuiteResolution(
                    null, $"{packagePath} defines no \"{suite.PackageScript}\" script");
            }

            var command = script.GetString();
            return string.IsNullOrWhiteSpace(command)
                ? new TestSuiteResolution(null, $"{packagePath} defines \"{suite.PackageScript}\" as an empty command")
                : new TestSuiteResolution(command, $"read from {packagePath}");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return new TestSuiteResolution(null, $"{packagePath} could not be read ({error.Message})");
        }
    }

    /// <summary>
    /// Finds the tree whose package.json defines these suites: the registered
    /// workspace when it has them, otherwise the Helmion source tree the app was
    /// built from. Returns null rather than guessing — a published build with no
    /// source tree beside it genuinely cannot run these, and must say so.
    /// </summary>
    public static string? FindSuiteRoot(string? registeredWorkspace, string binaryDirectory)
    {
        if (!string.IsNullOrWhiteSpace(registeredWorkspace)
            && File.Exists(Path.Combine(registeredWorkspace, "package.json"))
            && File.Exists(Path.Combine(registeredWorkspace, "bin", "helmion.mjs")))
        {
            return registeredWorkspace;
        }

        foreach (var start in new[] { binaryDirectory, Directory.GetCurrentDirectory() })
        {
            if (string.IsNullOrWhiteSpace(start)) continue;

            var dir = new DirectoryInfo(start);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "bin", "helmion.mjs"))
                    && File.Exists(Path.Combine(dir.FullName, "package.json")))
                {
                    return dir.FullName;
                }

                dir = dir.Parent;
            }
        }

        return null;
    }
}

/// <summary>
/// Turns a suite's own output into counts. Pure text in, numbers out — so the whole
/// of the counting logic is testable without starting a process, including against
/// outputs that must NOT be read as a pass.
/// </summary>
public static partial class TestSuiteOutputParser
{
    /// <summary>
    /// `node --test` summary lines. Matches both reporters it can pick: the spec
    /// reporter's "ℹ pass 861" and TAP's "# pass 861". The leading class absorbs
    /// whichever marker is in front — including a mangled one, when the console code
    /// page cannot represent the glyph. Anchored at end of line so a test whose NAME
    /// ends in "fail 3" cannot be read as a summary.
    ///
    /// TWO THINGS IN THIS PATTERN ARE LOAD-BEARING, AND BOTH WERE MEASURED, NOT
    /// REASONED ABOUT. The obvious spelling of it silently matched NOTHING, which
    /// would have reported every healthy run as "no counts could be read".
    ///
    ///  · IT IS `[^A-Za-z0-9]`, NOT `[^\w]`. U+2139 — the spec reporter's own "ℹ"
    ///    marker — is a WORD character as far as .NET is concerned
    ///    (`Regex.IsMatch("ℹ", @"^\w$")` returns True, measured). So `[^\w]*`
    ///    could not step over the very character it was written to step over.
    ///
    ///  · `\r` IS IN THE TRAILING CLASS. In multiline mode `$` matches the position
    ///    BEFORE the `\n`, which on Windows sits immediately after a `\r`. Leave it
    ///    out and the anchor can never be reached on the only platform this app runs
    ///    on.
    /// </summary>
    [GeneratedRegex(@"^[^A-Za-z0-9]*(tests|pass|fail|skipped|todo)[ \t]+(\d+)[ \t\r]*$",
        RegexOptions.Multiline | RegexOptions.IgnoreCase)]
    private static partial Regex NodeSummaryPattern();

    /// <summary>The desktop suite's per-suite tally: "Helmion guard feed checks passed (103 checks)."</summary>
    [GeneratedRegex(@"passed \((\d+) checks?\)", RegexOptions.IgnoreCase)]
    private static partial Regex DesktopTallyPattern();

    public static TestSuiteCounts ParseNode(string stdout)
    {
        if (string.IsNullOrEmpty(stdout)) return TestSuiteCounts.Unknown;

        int? total = null, pass = null, fail = null, skipped = null;

        // LAST WINS. Nested output can carry earlier partial summaries; the run's own
        // totals are the ones printed last.
        foreach (Match match in NodeSummaryPattern().Matches(stdout))
        {
            if (!int.TryParse(match.Groups[2].Value, out var value)) continue;
            switch (match.Groups[1].Value.ToLowerInvariant())
            {
                case "tests": total = value; break;
                case "pass": pass = value; break;
                case "fail": fail = value; break;
                case "skipped": skipped = value; break;
            }
        }

        return new TestSuiteCounts(total, pass, fail, skipped);
    }

    /// <summary>
    /// Sums the per-suite tallies the desktop suite prints.
    ///
    /// THE THING THE PANEL MUST NOT IMPLY. That suite's Check() throws on the first
    /// failure, so it stops dead rather than continuing and counting. A number
    /// produced here is therefore "checks that ran and passed BEFORE it stopped", and
    /// there is no such thing as a desktop failure COUNT — there is exactly one
    /// failure and then nothing. The Failed count is left null rather than reported as
    /// 1, because 1 would read as "one test is broken" when the truth is "one test is
    /// broken and the remaining hundreds did not run".
    /// </summary>
    public static TestSuiteCounts ParseDesktopSmoke(string stdout)
    {
        if (string.IsNullOrEmpty(stdout)) return TestSuiteCounts.Unknown;

        var matches = DesktopTallyPattern().Matches(stdout);
        if (matches.Count == 0) return TestSuiteCounts.Unknown;

        var passed = 0;
        foreach (Match match in matches)
        {
            if (int.TryParse(match.Groups[1].Value, out var value)) passed += value;
        }

        // TOTAL IS NULL, NOT `passed`. Nobody knows the total: the checks that never
        // ran were never counted. Reporting total == passed would render a run that
        // died a third of the way through as "605 checks, 605 passed".
        return new TestSuiteCounts(null, passed, null, null);
    }
}

/// <summary>One line of a suite's output, as it arrives.</summary>
public sealed record TestSuiteProgress(string SuiteId, string SuiteName, string Line);

/// <summary>What one suite did. Constructed only through the named factories below.</summary>
public sealed record TestSuiteOutcome(
    TestSuiteDefinition Suite,
    TestSuiteStatus Status,
    int? ExitCode,
    TimeSpan Duration,
    TestSuiteCounts Counts,
    string Detail,
    string RawOutput,
    IReadOnlyList<string>? Skips = null)
{
    /// <summary>The suites inside this one that announced they did not run. Never null.</summary>
    public IReadOnlyList<string> SkipList => Skips ?? [];

    public static TestSuiteOutcome Passed(
        TestSuiteDefinition suite, int exitCode, TimeSpan duration, TestSuiteCounts counts, string raw) =>
        new(suite, TestSuiteStatus.Passed, exitCode, duration, counts, "", raw);

    public static TestSuiteOutcome PassedWithSkips(
        TestSuiteDefinition suite, int exitCode, TimeSpan duration, TestSuiteCounts counts,
        string raw, IReadOnlyList<string> skips) =>
        new(suite, TestSuiteStatus.PassedWithSkips, exitCode, duration, counts, "", raw, skips);

    public static TestSuiteOutcome Failed(
        TestSuiteDefinition suite, int? exitCode, TimeSpan duration, TestSuiteCounts counts,
        string detail, string raw) =>
        new(suite, TestSuiteStatus.Failed, exitCode, duration, counts, detail, raw);

    public static TestSuiteOutcome Inconclusive(
        TestSuiteDefinition suite, int exitCode, TimeSpan duration, TestSuiteCounts counts,
        string detail, string raw) =>
        new(suite, TestSuiteStatus.Inconclusive, exitCode, duration, counts, detail, raw);

    public static TestSuiteOutcome CannotRun(TestSuiteDefinition suite, string reason) =>
        new(suite, TestSuiteStatus.CannotRun, null, TimeSpan.Zero, TestSuiteCounts.Unknown, reason, "");

    public static TestSuiteOutcome Cancelled(
        TestSuiteDefinition suite, TimeSpan duration, int passedSoFar, string detail) =>
        new(suite, TestSuiteStatus.Cancelled, null, duration,
            new TestSuiteCounts(null, passedSoFar > 0 ? passedSoFar : null, null, null), detail, "");

    /// <summary>The word on the panel. Only one of these is green, and it is spelled out.</summary>
    public string StatusWord => Status switch
    {
        TestSuiteStatus.Passed => "PASSED",
        TestSuiteStatus.Failed => "FAILED",
        TestSuiteStatus.CannotRun => "COULD NOT RUN",
        TestSuiteStatus.Cancelled => "STOPPED",
        TestSuiteStatus.Inconclusive => "NO RESULT",
        TestSuiteStatus.PassedWithSkips => "PASSED (INCOMPLETE)",
        _ => "UNKNOWN",
    };

    /// <summary>
    /// The one-line verdict, carrying the counts and the exit code every time — the
    /// requirement is "861 tests, 861 passed, exit 0", not a tick.
    /// </summary>
    public string Describe()
    {
        var exit = ExitCode is null ? "no exit code" : $"exit {FormatExitCode(ExitCode.Value)}";
        var counts = Counts.Describe(Suite.CountNoun);

        // A SUITE THAT ABORTS ON ITS FIRST FAILURE HAS NO PASS RATE, and phrasing it
        // as one is the difference between "605 checks, 605 passed" — which reads as
        // a clean run — and the truth, which is that it died and most checks never ran.
        var failureCounts = Suite.StopsAtFirstFailure
            ? Counts.Passed is > 0
                ? $"it stopped at the FIRST failing check; {Counts.Passed:N0} {Suite.CountNoun} "
                  + $"had passed before that and the rest never ran"
                : $"it stopped before any {Suite.CountNoun} passed"
            : counts;

        return Status switch
        {
            TestSuiteStatus.CannotRun => $"{Suite.Name} · COULD NOT RUN — {Detail}",
            TestSuiteStatus.Cancelled => $"{Suite.Name} · STOPPED — {Detail}"
                + (Counts.Passed is > 0 ? $"; {Counts.Passed:N0} {Suite.CountNoun} had passed by then" : "")
                + ". This says nothing about whether the code is good.",
            TestSuiteStatus.Passed => $"{Suite.Name} · PASSED — {counts}, {exit}, {Duration.TotalSeconds:0.0}s",
            TestSuiteStatus.PassedWithSkips =>
                $"{Suite.Name} · PASSED (INCOMPLETE) — {counts}, {exit}, {Duration.TotalSeconds:0.0}s"
                + $"{Environment.NewLine}    Everything that RAN passed. This is not green, because "
                + $"{SkipList.Count} part(s) did not run and nobody knows what they would have said:"
                + string.Concat(SkipList.Select(skip => $"{Environment.NewLine}    · DID NOT RUN — {skip}")),
            TestSuiteStatus.Inconclusive => $"{Suite.Name} · NO RESULT — {Detail} ({exit})",
            _ => $"{Suite.Name} · FAILED — {failureCounts}, {exit}, {Duration.TotalSeconds:0.0}s"
                + $"{Environment.NewLine}    {Detail}",
        };
    }

    /// <summary>
    /// The real exit code, plus what it means when it is one of the codes that is
    /// unreadable as a number. A .NET crash surfaces as -532462766, which is
    /// 0xE0434352 reinterpreted as a signed int; showing only the decimal tells the
    /// operator nothing, and hiding it would be dropping the exit code the panel
    /// promised to show.
    /// </summary>
    public static string FormatExitCode(int exitCode) => exitCode switch
    {
        -532462766 => "0xE0434352 (the suite crashed with an unhandled .NET exception)",
        -1073741510 => "0xC000013A (killed at the console)",
        9009 => "9009 (command not found)",
        _ => exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture),
    };
}

/// <summary>The whole run. <see cref="AllPassed"/> is the only thing allowed to turn the panel green.</summary>
public sealed record TestSuiteRunReport(string SuiteRoot, IReadOnlyList<TestSuiteOutcome> Outcomes)
{
    /// <summary>
    /// Green demands that EVERY suite passed. Not "none failed" — a run where one
    /// suite could not start and the other passed is not a green run, and an
    /// any-failures-are-red test would call it one.
    /// </summary>
    public bool AllPassed =>
        Outcomes.Count > 0 && Outcomes.All(outcome => outcome.Status == TestSuiteStatus.Passed);

    public bool WasCancelled => Outcomes.Any(outcome => outcome.Status == TestSuiteStatus.Cancelled);

    /// <summary>The block of text the panel shows when the run ends.</summary>
    public string Summarize()
    {
        var lines = new List<string>();

        if (AllPassed)
        {
            lines.Add("ALL SUITES PASSED.");
        }
        else if (Outcomes.Any(outcome => outcome.Status == TestSuiteStatus.PassedWithSkips)
            && Outcomes.All(outcome =>
                outcome.Status is TestSuiteStatus.Passed or TestSuiteStatus.PassedWithSkips))
        {
            // DELIBERATELY NOT "ALL SUITES PASSED". Everything that ran passed, and
            // something did not run. Both halves are said out loud.
            lines.Add("EVERYTHING THAT RAN PASSED — but part of the run was skipped, so this is NOT a clean green.");
        }
        else if (WasCancelled)
        {
            lines.Add("RUN STOPPED. A stopped run is not a pass and is not a failure.");
        }
        else
        {
            lines.Add("NOT GREEN. Read the reason on each suite below.");
        }

        foreach (var outcome in Outcomes)
        {
            lines.Add(outcome.Describe());
        }

        lines.Add($"Suites read from {Path.Combine(SuiteRoot, "package.json")}.");
        return string.Join(Environment.NewLine, lines);
    }
}

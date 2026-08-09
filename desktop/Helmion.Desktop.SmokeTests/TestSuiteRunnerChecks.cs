using System.Diagnostics;
using System.Text.Json;
using Helmion.Desktop.Core;

/// <summary>
/// THE "RUN TEST SUITE" BUTTON HAS TO ACTUALLY RUN THE TEST SUITE.
///
/// THE DEFECT THIS PINS. The guard panel's "Run test suite" button printed a block
/// of prose ending "This panel does not start processes, so nothing was run", then
/// listed npm commands for the operator to type into a terminal himself. It was a
/// help page wearing a button's clothes. It survived because the only thing holding
/// it was a WPF click handler, and a click handler cannot be asserted — so nothing
/// in ~900 checks ever noticed that the button did nothing.
///
/// THE FIX AND WHY THE CHECKS LOOK LIKE THIS. The behaviour now lives in
/// Helmion.Desktop.Core/TestSuiteRunner.cs, which is a plain library type this
/// headless suite can drive directly. The click handler is reduced to a call. So:
///
///   · the RUNNER is tested by running it (real processes, real exit codes);
///   · the WIRING is tested by reading MainWindow.GuardPanel.cs, because the one
///     line that connects them is still a click handler and still cannot be called
///     from here. That source scan is weaker than executing it, and this file says
///     so rather than implying the click has been observed.
///
/// A SCANNER THAT CANNOT FAIL PROVES NOTHING, so the wiring scan carries a POSITIVE
/// CONTROL: the same matcher is run over the old dead-button text and must reject it.
///
/// AND THE HONESTY CHECKS ARE THE POINT. A test runner that reports green when it
/// did not run, could not run, was cancelled, or could not find its counts is worse
/// than the prose it replaced — the prose at least never claimed to have run
/// anything. Most of the assertions below are about refusing to say "passed".
/// </summary>
public static class TestSuiteRunnerChecks
{
    public static void Run()
    {
        var checks = 0;

        checks += RunWiringChecks();
        checks += RunCatalogChecks();
        checks += RunWindowlessChecks();
        checks += RunParserChecks();
        checks += RunResolverChecks();
        checks += RunSuiteRootChecks();
        checks += RunRealProcessChecks();
        checks += RunCancellationChecks();
        checks += RunTimeoutChecks();
        checks += RunReportChecks();
        checks += RunVoiceProtectionChecks();

        Console.WriteLine($"Helmion test-suite runner checks passed ({checks} checks).");
    }

    // ───────────────────────────────────── the button targets the suites that exist

    /// <summary>
    /// The catalog must name REAL scripts in the REAL package.json. This is the check
    /// that stops anyone quietly adding a third, friendlier "sandbox suite" that
    /// passes on its own terms — the button is worthless the moment it can go green
    /// without the actual tests going green.
    /// </summary>
    private static int RunCatalogChecks()
    {
        var checks = 0;
        var root = FindRepoRoot()!;

        Assert(TestSuiteCatalog.All.Count == 2, "the catalog holds exactly two suites");
        Assert(TestSuiteCatalog.All.Any(suite => suite.PackageScript == "test"),
            "the node suite is the repo's own \"test\" script");
        Assert(TestSuiteCatalog.All.Any(suite => suite.PackageScript == "desktop:test"),
            "the desktop smoke suite is the repo's own \"desktop:test\" script");
        checks += 3;

        // AND THOSE SCRIPTS MUST ACTUALLY RESOLVE HERE. Naming a script that the repo
        // does not define would give a permanent, plausible-looking COULD NOT RUN.
        foreach (var suite in TestSuiteCatalog.All)
        {
            var resolution = TestSuiteCommandResolver.Resolve(root, suite);
            Assert(resolution.Command is not null,
                $"the repo's package.json defines \"{suite.PackageScript}\" ({resolution.Reason})");
            checks++;
        }

        return checks;
    }

    // ──────────────────────────────────── nothing it spawns can put up a window

    /// <summary>
    /// NOTHING MAY APPEAR ON THE OPERATOR'S SCREEN. Everything the runner starts goes
    /// through one factory, so this asserts against that factory rather than hoping
    /// each call site remembered.
    ///
    /// WHY THIS IS A PROPERTY CHECK AND NOT AN OBSERVATION. The only direct proof is
    /// to run it and watch nothing appear, and a failed fix would then cause exactly
    /// the harm the rule exists to prevent. So this pins the flags, and RunRealProcess
    /// below additionally proves those flags really do carry a process to completion.
    /// </summary>
    private static int RunWindowlessChecks()
    {
        var start = TestSuiteRunner.CreateStartInfo("echo hello", Path.GetTempPath());

        // UseShellExecute false is not a nicety: CreateNoWindow is IGNORED when
        // shell-executing, so this is the property that makes the next one mean
        // anything at all.
        Assert(!start.UseShellExecute, "processes are not shell-executed, so CreateNoWindow applies");
        Assert(start.CreateNoWindow, "no console is allocated for the process");
        Assert(start.WindowStyle == ProcessWindowStyle.Hidden, "the window style is Hidden as a second, independent guard");
        Assert(start.RedirectStandardOutput, "stdout is piped to the app rather than to a console");
        Assert(start.RedirectStandardError, "stderr is piped too, so a crash is read and not displayed");
        Assert(start.RedirectStandardInput, "stdin is piped, so a prompting child gets EOF instead of hanging on a hidden console");
        Assert(start.FileName.EndsWith("cmd.exe", StringComparison.OrdinalIgnoreCase),
            "the process started is the console interpreter, not a GUI binary");
        Assert(start.ArgumentList.Count == 4 && start.ArgumentList[0] == "/d",
            "/d is passed, so a machine-local AutoRun script cannot inject into the run");
        Assert(start.ArgumentList[2] == "/c" && start.ArgumentList[3] == "echo hello",
            "the command is passed as one argument, so quoting inside it survives");
        Assert(start.Environment["NO_COLOR"] == "1", "colour escapes are suppressed so the panel text stays readable");
        Assert(start.WorkingDirectory == Path.GetTempPath(), "the command runs in the suite root it was given");

        return 11;
    }

    // ─────────────────────────────────────────── counts are parsed, never invented

    private static int RunParserChecks()
    {
        var checks = 0;

        // The spec reporter, which is what `node --test` actually printed when this
        // was measured: 861 tests, 861 pass, 0 fail.
        var spec = string.Join(
            Environment.NewLine,
            "✔ a marker inside a fenced code block is NOT a hedge (0.0765ms)",
            "ℹ tests 861",
            "ℹ suites 10",
            "ℹ pass 861",
            "ℹ fail 0",
            "ℹ skipped 0",
            "ℹ duration_ms 14691.995");
        var specCounts = TestSuiteOutputParser.ParseNode(spec);
        Assert(specCounts.Total == 861 && specCounts.Passed == 861 && specCounts.Failed == 0,
            "the spec reporter's totals are read exactly");
        checks++;

        // TAP, which is what the same runner prints under other conditions. Both have
        // to work, because which one appears is not under this app's control.
        var tap = string.Join(Environment.NewLine, "# tests 12", "# pass 10", "# fail 2");
        var tapCounts = TestSuiteOutputParser.ParseNode(tap);
        Assert(tapCounts.Total == 12 && tapCounts.Passed == 10 && tapCounts.Failed == 2,
            "TAP totals are read exactly");
        checks++;

        // The realistic corruption: the console code page mangles the marker glyph.
        // The numbers still have to survive, or a healthy run reads as no result.
        var mangled = string.Join(Environment.NewLine, "?? tests 5", "?? pass 5", "?? fail 0");
        Assert(TestSuiteOutputParser.ParseNode(mangled).Passed == 5,
            "a mangled summary marker does not lose the counts behind it");
        checks++;

        // A TEST NAME IS NOT A SUMMARY. Without the end-of-line anchor, a test called
        // "handles fail 3 gracefully" would be read as three failures and turn a green
        // run red for no reason.
        var titles = string.Join(
            Environment.NewLine,
            "✔ it handles fail 3 gracefully and keeps going (1ms)",
            "ℹ pass 7",
            "ℹ fail 0");
        var titleCounts = TestSuiteOutputParser.ParseNode(titles);
        Assert(titleCounts.Failed == 0 && titleCounts.Passed == 7,
            "a count-shaped phrase inside a test NAME is not mistaken for the summary");
        checks++;

        Assert(TestSuiteOutputParser.ParseNode("").Passed is null,
            "empty output yields no counts rather than zero");
        Assert(TestSuiteOutputParser.ParseNode("nothing useful here").Passed is null,
            "unparseable output yields no counts rather than zero");
        checks += 2;

        // The desktop suite's real shape, copied from a measured run.
        var desktop = string.Join(
            Environment.NewLine,
            "Helmion ask-permission smoke tests passed (58 checks).",
            "Helmion voice engine smoke tests passed (39 checks).",
            "Helmion guard feed checks passed (103 checks).",
            "Helmion off-screen window checks passed (1 check).");
        var desktopCounts = TestSuiteOutputParser.ParseDesktopSmoke(desktop);
        Assert(desktopCounts.Passed == 201, "the desktop per-suite tallies are summed (58+39+103+1)");
        Assert(desktopCounts.Failed is null,
            "the desktop suite reports NO failure count, because it aborts on the first "
            + "failure and a 1 would imply the rest ran");
        Assert(desktopCounts.Total is null,
            "the desktop suite reports NO total, because the checks that never ran were never counted");
        checks += 3;

        // THE MEASURED REGRESSION THIS PINS. A real aborted run reported
        // "605 checks, 605 passed, exit -532462766" — which reads as a clean sweep and
        // an unintelligible number, for a run that died a third of the way in.
        var abortedRun = TestSuiteOutcome.Failed(
            TestSuiteCatalog.DesktopSmokeSuite, -532462766, TimeSpan.FromSeconds(19),
            TestSuiteOutputParser.ParseDesktopSmoke("Helmion guard feed checks passed (605 checks)."),
            "Lease inspector failed: the STALE detail says the holder process is gone", "");
        var described = abortedRun.Describe();
        Assert(described.Contains("stopped at the FIRST failing check", StringComparison.Ordinal),
            "an aborted desktop run says it stopped at the first failure rather than showing a pass rate");
        Assert(described.Contains("the rest never ran", StringComparison.Ordinal),
            "an aborted desktop run says the remaining checks never ran");
        Assert(!described.Contains("605 checks, 605 passed", StringComparison.Ordinal),
            "an aborted desktop run does NOT read as \"605 checks, 605 passed\"");
        Assert(described.Contains("unhandled .NET exception", StringComparison.Ordinal)
            && described.Contains("0xE0434352", StringComparison.Ordinal),
            "a .NET crash code is shown in a form that means something, without hiding the code");
        Assert(described.Contains("Lease inspector failed", StringComparison.Ordinal),
            "the real failure reason is on the verdict line");
        checks += 5;

        // The plain codes stay plain — this must not turn every number into prose.
        Assert(TestSuiteOutcome.FormatExitCode(1) == "1", "an ordinary exit code is shown as the plain number");
        Assert(TestSuiteOutcome.FormatExitCode(0) == "0", "exit 0 is shown as the plain number");
        checks += 2;

        Assert(TestSuiteOutputParser.ParseDesktopSmoke("Unhandled exception. System.Exception: boom").Passed is null,
            "a desktop run that printed no tallies yields no counts rather than zero");
        checks++;

        // The reason line the panel leads with, so the operator is not made to read a
        // stack trace to find out what broke.
        var crash = string.Join(
            Environment.NewLine,
            "Helmion guard feed checks passed (103 checks).",
            "Unhandled exception. System.InvalidOperationException: Lease inspector failed: the STALE detail says the holder process is gone",
            "   at LeaseInspectorChecks.Assert(Boolean condition, String what)");
        Assert(TestSuiteRunner.ExtractFailureReason(crash)
                .StartsWith("Lease inspector failed:", StringComparison.Ordinal),
            "the failure reason is lifted out of the exception line, not the stack trace");
        checks++;

        return checks;
    }

    // ───────────────────────────── the command comes from package.json, or not at all

    private static int RunResolverChecks()
    {
        var checks = 0;
        var suite = TestSuiteCatalog.NodeSuite;
        var sandbox = NewSandbox();

        try
        {
            var missing = TestSuiteCommandResolver.Resolve(sandbox, suite);
            Assert(missing.Command is null && missing.Reason.Contains("package.json", StringComparison.Ordinal),
                "a directory with no package.json names the missing file rather than guessing a command");
            checks++;

            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"name":"x"}""");
            var noScripts = TestSuiteCommandResolver.Resolve(sandbox, suite);
            Assert(noScripts.Command is null && noScripts.Reason.Contains("no scripts section", StringComparison.Ordinal),
                "a package.json with no scripts section says exactly that");
            checks++;

            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{"build":"x"}}""");
            var noSuchScript = TestSuiteCommandResolver.Resolve(sandbox, suite);
            Assert(noSuchScript.Command is null && noSuchScript.Reason.Contains("\"test\"", StringComparison.Ordinal),
                "a missing script is reported by name");
            checks++;

            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{"test":"   "}}""");
            Assert(TestSuiteCommandResolver.Resolve(sandbox, suite).Command is null,
                "a blank command is refused rather than run as an empty shell line");
            checks++;

            File.WriteAllText(Path.Combine(sandbox, "package.json"), "{ this is not json");
            Assert(TestSuiteCommandResolver.Resolve(sandbox, suite).Command is null,
                "a corrupt package.json is reported, not thrown out of the click handler");
            checks++;

            // AND THE COMMAND IS THE REPO'S, NOT A COPY. Change the script, and the
            // resolved command changes with it.
            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{"test":"node --test --concurrency=1"}}""");
            Assert(TestSuiteCommandResolver.Resolve(sandbox, suite).Command == "node --test --concurrency=1",
                "the command is taken verbatim from package.json rather than hardcoded in C#");
            checks++;

            Assert(TestSuiteCommandResolver.Resolve("", suite).Command is null,
                "an empty root resolves to no command instead of the process's current directory");
            checks++;
        }
        finally
        {
            Delete(sandbox);
        }

        return checks;
    }

    private static int RunSuiteRootChecks()
    {
        var checks = 0;
        var sandbox = NewSandbox();

        try
        {
            // A registered workspace only wins if it really is a Helmion tree. A
            // customer's own project is not, and running "its" tests would be both
            // wrong and, for the desktop script, impossible.
            //
            // ASSERTED AS "is not adopted", NOT AS "returns null". The search legitimately
            // falls back to other roots, and pinning null here would be pinning an
            // artefact of where the test process happened to be started.
            Assert(TestSuiteCommandResolver.FindSuiteRoot(sandbox, sandbox) != sandbox,
                "a bare directory is not adopted as the suite root");
            checks++;

            // BOTH MARKERS ARE REQUIRED. A package.json alone is not a Helmion tree —
            // almost every JavaScript project on the machine has one.
            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{"test":"x"}}""");
            Assert(TestSuiteCommandResolver.FindSuiteRoot(sandbox, sandbox) != sandbox,
                "a directory with a package.json but no bin/helmion.mjs is still not adopted");
            checks++;

            Directory.CreateDirectory(Path.Combine(sandbox, "bin"));
            File.WriteAllText(Path.Combine(sandbox, "bin", "helmion.mjs"), "// marker");
            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{}}""");
            Assert(TestSuiteCommandResolver.FindSuiteRoot(sandbox, sandbox) == sandbox,
                "a registered workspace that IS a Helmion tree is used");
            checks++;

            // The normal case: no registered workspace, walk up from the binary.
            var found = TestSuiteCommandResolver.FindSuiteRoot(null, AppContext.BaseDirectory);
            Assert(found is not null && File.Exists(Path.Combine(found, "bin", "helmion.mjs")),
                "with no registered workspace the source tree is found by walking up from the binary");
            checks++;
        }
        finally
        {
            Delete(sandbox);
        }

        return checks;
    }

    // ──────────────────────────────────── it really runs, and really tells the truth

    /// <summary>
    /// End-to-end through real hidden processes. The fixtures here are scripts in a
    /// throwaway package.json, NOT a third product suite — the catalog still holds
    /// only the two real ones (see <see cref="RunCatalogChecks"/>). A fixture is how
    /// the failure and cannot-run paths get exercised at all, since the real suites
    /// cannot be asked to fail on demand.
    /// </summary>
    private static int RunRealProcessChecks()
    {
        var checks = 0;
        var sandbox = NewSandbox();

        try
        {
            // PASS. Exit 0 with a legible summary.
            var passed = RunFixture(sandbox, "echo # tests 3& echo # pass 3& echo # fail 0");
            Assert(passed.Status == TestSuiteStatus.Passed, $"a clean fixture run is PASSED (got {passed.Status})");
            Assert(passed.ExitCode == 0, "the real exit code is carried, not assumed");
            Assert(passed.Counts.Passed == 3 && passed.Counts.Total == 3, "the real counts are carried");
            Assert(passed.Describe().Contains("exit 0", StringComparison.Ordinal)
                && passed.Describe().Contains("3 tests", StringComparison.Ordinal),
                "the one-line verdict states the counts AND the exit code, not a tick");
            checks += 4;

            // FAIL BY EXIT CODE. This is the one that matters most: the output SAYS
            // everything passed, and the process exited 1. Exit code wins.
            var lying = RunFixture(sandbox, "echo # tests 9& echo # pass 9& echo # fail 0& exit /b 1");
            Assert(lying.Status == TestSuiteStatus.Failed,
                $"a non-zero exit is FAILED even when the output claims every test passed (got {lying.Status})");
            Assert(lying.ExitCode == 1, "the failing exit code is shown as it was");
            checks += 2;

            // FAIL BY REPORTED FAILURES.
            var reportedFailures = RunFixture(sandbox, "echo # tests 9& echo # pass 7& echo # fail 2");
            Assert(reportedFailures.Status == TestSuiteStatus.Failed,
                "reported failures are FAILED even when the process exits 0");
            checks++;

            // THE FALSE GREEN. Exit 0, no tests. A filter that matched nothing looks
            // exactly like this, and must never render green.
            var silent = RunFixture(sandbox, "exit /b 0");
            Assert(silent.Status == TestSuiteStatus.Inconclusive,
                $"exit 0 with no test counts is NO RESULT, never PASSED (got {silent.Status})");
            checks++;

            // MISSING TOOL. Distinct from a failure: the operator installs something,
            // rather than going looking for a broken test.
            var missingTool = RunFixture(sandbox, "helmion-no-such-tool-9d3f --version");
            Assert(missingTool.Status == TestSuiteStatus.CannotRun,
                $"a tool that is not on PATH is COULD NOT RUN, not FAILED (got {missingTool.Status})");
            Assert(missingTool.Detail.Contains("PATH", StringComparison.Ordinal),
                "the cannot-run reason tells the operator what to do about it");
            checks += 2;

            // NO SCRIPT AT ALL — nothing spawned, and still an outcome rather than silence.
            File.WriteAllText(Path.Combine(sandbox, "package.json"), """{"scripts":{}}""");
            var noScript = TestSuiteRunner.RunOneAsync(sandbox, TestSuiteCatalog.NodeSuite, null, CancellationToken.None)
                .GetAwaiter().GetResult();
            Assert(noScript.Status == TestSuiteStatus.CannotRun && noScript.ExitCode is null,
                "a suite with no script reports COULD NOT RUN with no invented exit code");
            checks++;
        }
        finally
        {
            Delete(sandbox);
        }

        return checks;
    }

    // ───────────────────────────────────────────────── the operator can stop it

    private static int RunCancellationChecks()
    {
        var checks = 0;
        var sandbox = NewSandbox();

        try
        {
            // ping is the sleep that survives a redirected stdin; `timeout` refuses to
            // run at all when input is redirected, which it is, deliberately.
            WriteScript(sandbox, "ping -n 60 127.0.0.1 >nul");

            // THE GRANDCHILD IS THE POINT. `ping` is a child of cmd, not of us, so this
            // baseline is what proves the stop killed the whole PROCESS TREE rather
            // than just the shell — leaving a suite grinding away invisibly after the
            // operator believes he stopped it would be worse than not offering a stop.
            var pingBaseline = Process.GetProcessesByName("PING").Length;

            using var cancellation = new CancellationTokenSource();
            var started = Stopwatch.StartNew();
            var run = TestSuiteRunner.RunOneAsync(
                sandbox, TestSuiteCatalog.NodeSuite, null, cancellation.Token);

            Thread.Sleep(1200);
            Assert(!run.IsCompleted, "the fixture really was still running when it was stopped");
            Assert(Process.GetProcessesByName("PING").Length > pingBaseline,
                "the fixture's grandchild process really was alive before the stop");
            checks += 2;

            cancellation.Cancel();
            var outcome = run.GetAwaiter().GetResult();
            started.Stop();

            Assert(outcome.Status == TestSuiteStatus.Cancelled,
                $"stopping a run reports STOPPED (got {outcome.Status})");
            Assert(outcome.Status != TestSuiteStatus.Passed, "a stopped run is never reported as passing");
            Assert(outcome.ExitCode is null, "a stopped run invents no exit code");
            Assert(started.Elapsed < TimeSpan.FromSeconds(30),
                $"stopping returns promptly rather than waiting out the process ({started.Elapsed.TotalSeconds:0.0}s)");
            Assert(outcome.Describe().Contains("says nothing about whether the code is good", StringComparison.Ordinal),
                "the stopped verdict refuses to imply anything about the code");
            checks += 5;

            // AND IT IS ACTUALLY DEAD. Polled rather than asserted once, because
            // process teardown is not instantaneous and a bare assert here would be
            // flaky in exactly the direction that hides a real leak.
            var deadline = Stopwatch.StartNew();
            while (Process.GetProcessesByName("PING").Length > pingBaseline
                && deadline.Elapsed < TimeSpan.FromSeconds(10))
            {
                Thread.Sleep(200);
            }

            Assert(Process.GetProcessesByName("PING").Length <= pingBaseline,
                "stopping killed the whole process tree — the grandchild is gone, not orphaned");
            checks++;

            // A run stopped before a later suite starts must still ACCOUNT for that
            // suite. Dropping it silently would leave the panel showing one green
            // suite and no mention of the other.
            using var preCancelled = new CancellationTokenSource();
            preCancelled.Cancel();
            var report = TestSuiteRunner.RunAsync(
                sandbox, TestSuiteCatalog.All, null, preCancelled.Token).GetAwaiter().GetResult();
            Assert(report.Outcomes.Count == TestSuiteCatalog.All.Count,
                "every suite is accounted for even when the run was stopped before they started");
            Assert(report.Outcomes.All(o => o.Status == TestSuiteStatus.Cancelled),
                "suites that never started are reported as stopped, not as passed or skipped");
            Assert(!report.AllPassed, "a wholly cancelled run is not green");
            checks += 3;
        }
        finally
        {
            Delete(sandbox);
        }

        return checks;
    }

    private static int RunTimeoutChecks()
    {
        var sandbox = NewSandbox();
        try
        {
            WriteScript(sandbox, "ping -n 60 127.0.0.1 >nul");
            var outcome = TestSuiteRunner.RunOneAsync(
                sandbox, TestSuiteCatalog.NodeSuite, null, CancellationToken.None,
                TimeSpan.FromSeconds(2)).GetAwaiter().GetResult();

            // A HUNG SUITE IS RED, NOT STOPPED. Reporting it as "stopped" would read
            // as the operator's own doing and hide a real hang.
            Assert(outcome.Status == TestSuiteStatus.Failed,
                $"a suite that runs past its timeout is FAILED (got {outcome.Status})");
            Assert(outcome.Detail.Contains("timed out", StringComparison.Ordinal),
                "the timeout says it timed out, in those words");
            return 2;
        }
        finally
        {
            Delete(sandbox);
        }
    }

    // ──────────────────────────────────── only an all-green run renders green

    private static int RunReportChecks()
    {
        var suite = TestSuiteCatalog.NodeSuite;
        var counts = new TestSuiteCounts(5, 5, 0, 0);
        var pass = TestSuiteOutcome.Passed(suite, 0, TimeSpan.FromSeconds(1), counts, "");

        Assert(new TestSuiteRunReport("r", [pass, pass]).AllPassed, "two passing suites are green");

        // THE CASE A NAIVE "no failures" TEST WOULD GET WRONG. One suite passed, the
        // other never ran. Nothing FAILED — and it is still not a green run.
        Assert(!new TestSuiteRunReport("r", [pass, TestSuiteOutcome.CannotRun(suite, "no node")]).AllPassed,
            "passed + could-not-run is NOT green, even though nothing failed");
        Assert(!new TestSuiteRunReport("r", [pass, TestSuiteOutcome.Inconclusive(suite, 0, TimeSpan.Zero, TestSuiteCounts.Unknown, "no counts", "")]).AllPassed,
            "passed + no-result is NOT green");
        Assert(!new TestSuiteRunReport("r", []).AllPassed,
            "a run with no suites at all is NOT green");

        var mixed = new TestSuiteRunReport("r", [pass, TestSuiteOutcome.CannotRun(suite, "node is not installed")]);
        Assert(mixed.Summarize().Contains("NOT GREEN", StringComparison.Ordinal),
            "the summary leads with NOT GREEN rather than burying it");
        Assert(mixed.Summarize().Contains("node is not installed", StringComparison.Ordinal),
            "the summary names WHICH suite could not run and why");

        return 6;
    }

    // ────────────────────── it must not fight the operator's microphone, or lie about it

    /// <summary>
    /// The guard that stops the button competing with live dictation, and — more
    /// importantly — the guarantee that a skipped suite can never render green.
    /// </summary>
    private static int RunVoiceProtectionChecks()
    {
        var checks = 0;
        var sandbox = NewSandbox();

        try
        {
            // BOTH SIDES OF THE PROTOCOL ARE HERE, so a rename cannot break the loop
            // silently: Program.cs reads the variable and prints the marker, and both
            // constants come from this one class.
            var programPath = Path.Combine(
                FindRepoRoot()!, "desktop", "Helmion.Desktop.SmokeTests", "Program.cs");
            var program = File.ReadAllText(programPath);
            Assert(program.Contains("TestSuiteSkipContract.VoiceHostVariable", StringComparison.Ordinal),
                "the suite reads the skip variable from the shared contract, not a hardcoded copy");
            Assert(program.Contains("TestSuiteSkipContract.Marker", StringComparison.Ordinal),
                "the suite prints the skip marker from the shared contract, not a hardcoded copy");
            Assert(program.Contains("VoiceHostSmokeChecks.Run();", StringComparison.Ordinal),
                "the voice host check is still registered — the guard skips it, it does not delete it");
            checks += 3;

            // THE VARIABLE REACHES THE CHILD. Without this the guard is decorative.
            var withGuard = TestSuiteRunner.CreateStartInfo(
                "echo x", sandbox,
                new Dictionary<string, string> { [TestSuiteSkipContract.VoiceHostVariable] = "1" });
            Assert(withGuard.Environment[TestSuiteSkipContract.VoiceHostVariable] == "1",
                "the skip request is placed in the child process environment");
            var without = TestSuiteRunner.CreateStartInfo("echo x", sandbox);
            Assert(!without.Environment.ContainsKey(TestSuiteSkipContract.VoiceHostVariable),
                "the skip request is ABSENT when the voice host is not running, so a normal run is complete");
            checks += 2;

            // AND IT REALLY TRAVELS. Asserting the ProcessStartInfo dictionary proves
            // what was requested, not what the child received.
            WriteScript(sandbox, $"echo GUARD=%{TestSuiteSkipContract.VoiceHostVariable}%");
            var propagated = TestSuiteRunner.RunOneAsync(
                sandbox, TestSuiteCatalog.NodeSuite, null, CancellationToken.None,
                null, protectLiveVoiceHost: true).GetAwaiter().GetResult();
            Assert(propagated.RawOutput.Contains("GUARD=1", StringComparison.Ordinal),
                "the child process actually observes the skip variable");
            checks++;

            // THE SKIP IS READ BACK OUT OF THE SUITE'S OWN OUTPUT.
            var skipLine = TestSuiteSkipContract.Marker
                + "voice host round trip (VoiceHostSmokeChecks, 38 checks). 0 of its 38 checks ran.";
            var skips = TestSuiteRunner.ExtractSkips(
                $"Helmion guard feed checks passed (103 checks).{Environment.NewLine}{skipLine}");
            Assert(skips.Count == 1 && skips[0].StartsWith("voice host round trip", StringComparison.Ordinal),
                "a printed skip is read back out of the suite's output");
            Assert(TestSuiteRunner.ExtractSkips("Helmion guard feed checks passed (103 checks).").Count == 0,
                "a clean run reports no skips");
            checks += 2;

            // THE ONE THAT MATTERS. Exit 0, real passing counts, and a skip — this must
            // NOT be green, in the status, in the word, and in the report.
            var skipped = RunFixture(
                sandbox,
                "echo # tests 4& echo # pass 4& echo # fail 0& echo " + TestSuiteSkipContract.Marker
                + "voice host round trip (VoiceHostSmokeChecks, 38 checks). 0 of its 38 checks ran.");
            Assert(skipped.Status == TestSuiteStatus.PassedWithSkips,
                $"exit 0 + passing counts + a skip is PASSED (INCOMPLETE), not PASSED (got {skipped.Status})");
            Assert(skipped.Status != TestSuiteStatus.Passed, "a partly skipped suite is never PASSED");
            Assert(skipped.StatusWord == "PASSED (INCOMPLETE)", "the word on the panel says it is incomplete");
            Assert(skipped.SkipList.Count == 1, "the skipped part is carried on the outcome");
            Assert(skipped.Describe().Contains("DID NOT RUN", StringComparison.Ordinal)
                && skipped.Describe().Contains("VoiceHostSmokeChecks", StringComparison.Ordinal),
                "the verdict names WHICH part did not run");
            Assert(skipped.Describe().Contains("nobody knows what they would have said", StringComparison.Ordinal),
                "the verdict refuses to imply the skipped checks would have passed");
            checks += 6;

            var report = new TestSuiteRunReport(sandbox, [skipped]);
            Assert(!report.AllPassed, "a run containing a skipped suite is NOT green");
            Assert(!report.Summarize().Contains("ALL SUITES PASSED", StringComparison.Ordinal),
                "the summary does not claim all suites passed when one was partly skipped");
            Assert(report.Summarize().Contains("NOT a clean green", StringComparison.Ordinal),
                "the summary says out loud that this is not a clean green");
            checks += 3;

            // A REQUEST THE SUITE IGNORED IS NOT A SKIP. If an old binary never honours
            // the variable, the suite really did run everything, and calling that
            // incomplete would train the operator to ignore the warning.
            var ignoredRequest = RunFixture(sandbox, "echo # tests 4& echo # pass 4& echo # fail 0");
            Assert(ignoredRequest.Status == TestSuiteStatus.Passed,
                "a suite that ran everything is fully PASSED even when a skip was requested");
            checks++;

            // The probe answers about THIS machine without throwing. Its value depends
            // on whether Troy's voice host happens to be up, so the value is not pinned
            // — only that asking is safe and cheap.
            var probe = Stopwatch.StartNew();
            _ = TestSuiteRunner.LiveVoiceHostIsRunning();
            Assert(probe.Elapsed < TimeSpan.FromSeconds(5),
                "the live-voice-host probe answers quickly enough to run on a button press");
            checks++;
        }
        finally
        {
            Delete(sandbox);
        }

        return checks;
    }

    // ────────────────────────────────────────────────────────── fixture plumbing

    private static TestSuiteOutcome RunFixture(string sandbox, string script)
    {
        WriteScript(sandbox, script);
        return TestSuiteRunner
            .RunOneAsync(sandbox, TestSuiteCatalog.NodeSuite, null, CancellationToken.None)
            .GetAwaiter().GetResult();
    }

    private static void WriteScript(string sandbox, string script) =>
        File.WriteAllText(
            Path.Combine(sandbox, "package.json"),
            "{\"scripts\":{\"test\":" + JsonSerializer.Serialize(script) + "}}");

    private static string NewSandbox()
    {
        var path = Path.Combine(Path.GetTempPath(), $"helmion-suite-runner-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void Delete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    // ─────────────────────────────────────────────── the button is actually wired

    /// <summary>
    /// Reads the click handler out of the source and asserts it delegates to the
    /// runner instead of printing instructions.
    /// </summary>
    private static int RunWiringChecks()
    {
        var checks = 0;
        var root = FindRepoRoot();
        Assert(root is not null, "the repo root was located, so the click handler could be read");

        var handlerPath = Path.Combine(
            root!, "desktop", "Helmion.Desktop", "MainWindow.GuardPanel.cs");
        Assert(File.Exists(handlerPath), $"{handlerPath} exists");
        checks += 2;

        var handler = ExtractMember(File.ReadAllText(handlerPath), "void GuardRunTestSuite_Click(");
        Assert(handler is not null, "GuardRunTestSuite_Click's declaration exists and its body could be read");
        checks++;

        Assert(IsWiredToRunner(handler!), "the Run test suite click handler starts the runner");
        checks++;

        // POSITIVE CONTROL. The matcher above must reject the button as it stood
        // before this work, or it is not a matcher, it is a green light.
        const string DeadButton = """
            private void GuardRunTestSuite_Click(object sender, RoutedEventArgs e)
            {
                var lines = new List<string>
                {
                    "This panel does not start processes, so nothing was run."
                };
                lines.Add("Run one of these in a terminal you control.");
                ShowGuardFooterOutput(string.Join(Environment.NewLine, lines));
            }
            """;
        var control = ExtractMember(DeadButton, "void GuardRunTestSuite_Click(");
        Assert(control is not null, "the positive control fixture parses the same way real source does");
        Assert(!IsWiredToRunner(control!), "the wiring matcher REJECTS the dead button it replaced");
        checks += 2;

        return checks;
    }

    /// <summary>
    /// Wired means two things at once: it calls the entry point, and it no longer
    /// tells the operator nothing was run. Either half alone can be faked.
    /// </summary>
    private static bool IsWiredToRunner(string handlerBody) =>
        handlerBody.Contains("StartOrCancelGuardTestSuite(", StringComparison.Ordinal)
        && !handlerBody.Contains("does not start processes", StringComparison.Ordinal)
        && !handlerBody.Contains("in a terminal you control", StringComparison.Ordinal);

    // ────────────────────────────────────────────────────────────────── plumbing

    /// <summary>
    /// Returns the body of the member whose DECLARATION contains <paramref name="signature"/>,
    /// by brace matching. Matches the declaration rather than the first mention, so a
    /// call site earlier in the file cannot be read in place of the member itself.
    /// </summary>
    private static string? ExtractMember(string source, string signature)
    {
        var index = source.IndexOf(signature, StringComparison.Ordinal);
        while (index >= 0)
        {
            var open = source.IndexOf('{', index);
            var terminator = source.IndexOf(';', index);
            if (open < 0) return null;

            // A declaration reaches '{' before ';'. A call reaches ';' first.
            if (terminator < 0 || open < terminator)
            {
                var depth = 0;
                for (var scan = open; scan < source.Length; scan++)
                {
                    if (source[scan] == '{') depth++;
                    else if (source[scan] == '}' && --depth == 0)
                    {
                        return source[index..(scan + 1)];
                    }
                }

                return null;
            }

            index = source.IndexOf(signature, index + signature.Length, StringComparison.Ordinal);
        }

        return null;
    }

    /// <summary>
    /// Walks up from the binary, then from the working directory. Two starting
    /// points because the binary can sit outside the tree it is testing — the
    /// single-origin version of this returned null under a linked build and the
    /// resulting failure named the wrong cause.
    /// </summary>
    private static string? FindRepoRoot()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "bin", "helmion.mjs"))) return dir.FullName;
                dir = dir.Parent;
            }
        }

        return null;
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Test-suite runner check failed: {what}");
        }
    }
}

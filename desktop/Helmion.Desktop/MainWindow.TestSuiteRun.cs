using System.Diagnostics;
using System.IO;
using System.Windows.Threading;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// THE "RUN TEST SUITE" BUTTON'S UI SIDE, AND NOTHING ELSE.
///
/// All of the behaviour is in Helmion.Desktop.Core/TestSuiteRunner.cs, where the
/// headless smoke suite can drive it. What is left here is the part that genuinely
/// has to be here — a click, a timer, and the text on the panel — kept as thin as it
/// can be, because everything in this file is, by construction, untestable from the
/// suite.
///
/// THE THREE THINGS THIS FILE IS RESPONSIBLE FOR.
///
///  · NOT FREEZING. The run is awaited, never waited on. The UI thread returns to the
///    message loop immediately and the window stays draggable, scrollable and
///    closable for the whole run — which, with a full desktop build in front of it,
///    is minutes, not seconds.
///
///  · STOPPING. The same button becomes the stop button while a run is in flight, so
///    the control that started it is the control that ends it and there is nothing
///    new to find. Stopping kills the whole process tree, not just cmd.
///
///  · SHOWING PROGRESS WITHOUT DROWNING THE PANEL. The suites emit on the order of a
///    thousand lines. Rendering each one would spend the whole run in layout, so
///    lines land in a bounded buffer and a 200 ms timer paints the tail. The line
///    COUNT is shown alongside, so a slow-but-alive run is visibly distinct from a
///    hung one.
/// </summary>
public partial class MainWindow
{
    /// <summary>Non-null exactly while a run is in flight. This is also the "is running" flag.</summary>
    private CancellationTokenSource? _testSuiteCancellation;

    private DispatcherTimer? _testSuiteTicker;
    private TestSuiteConsoleBuffer? _testSuiteBuffer;
    private Stopwatch? _testSuiteClock;

    private const string RunTestSuiteLabel = "Run test suite";
    private const string StopTestSuiteLabel = "Stop test run";

    /// <summary>
    /// The whole of what the click handler does. Starts a run, or stops the one that
    /// is already going.
    /// </summary>
    private async void StartOrCancelGuardTestSuite()
    {
        if (_testSuiteCancellation is not null)
        {
            _testSuiteCancellation.Cancel();
            GuardTestSuiteButton.Content = "Stopping…";
            return;
        }

        var suiteRoot = TestSuiteCommandResolver.FindSuiteRoot(
            _registeredWorkspacePath ?? _currentWorkspaceInspection?.ProjectPath,
            AppContext.BaseDirectory);

        if (suiteRoot is null)
        {
            // NOT A SILENT NO-OP AND NOT A GREEN TICK. This build has no source tree
            // beside it, so the suites genuinely are not here to run.
            ShowGuardFooterOutput(string.Join(
                Environment.NewLine,
                "COULD NOT RUN — nothing was started.",
                "No Helmion source tree was found beside this app or at the registered "
                + "workspace, so there is no package.json defining the suites. A packaged "
                + "build without sources cannot run them; run from the repo instead."));
            return;
        }

        _testSuiteCancellation = new CancellationTokenSource();
        _testSuiteBuffer = new TestSuiteConsoleBuffer();
        _testSuiteClock = Stopwatch.StartNew();
        GuardTestSuiteButton.Content = StopTestSuiteLabel;

        _testSuiteTicker = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(200),
        };
        _testSuiteTicker.Tick += (_, _) => PaintTestSuiteProgress(suiteRoot);
        _testSuiteTicker.Start();
        PaintTestSuiteProgress(suiteRoot);

        try
        {
            var report = await TestSuiteRunner.RunAsync(
                suiteRoot,
                TestSuiteCatalog.All,
                _testSuiteBuffer,
                _testSuiteCancellation.Token).ConfigureAwait(true);

            ShowGuardFooterOutput(string.Join(
                Environment.NewLine,
                report.Summarize(),
                $"Finished in {_testSuiteClock.Elapsed.TotalSeconds:0}s. "
                + $"{_testSuiteBuffer.TotalLines:N0} lines of output were read."));
        }
        catch (Exception error)
        {
            // A CRASH IN THE RUNNER IS NOT A TEST RESULT, and must never be mistaken
            // for one in either direction.
            ShowGuardFooterOutput(string.Join(
                Environment.NewLine,
                "NO RESULT — the runner itself threw, so nothing here describes your tests.",
                $"{error.GetType().Name}: {error.Message}"));
        }
        finally
        {
            _testSuiteTicker.Stop();
            _testSuiteTicker = null;
            _testSuiteCancellation.Dispose();
            _testSuiteCancellation = null;
            _testSuiteClock = null;
            GuardTestSuiteButton.Content = RunTestSuiteLabel;
        }
    }

    /// <summary>Paints the live tail. Called on a timer, never per output line.</summary>
    private void PaintTestSuiteProgress(string suiteRoot)
    {
        if (_testSuiteBuffer is null || _testSuiteClock is null) return;

        var stopping = _testSuiteCancellation?.IsCancellationRequested == true;
        var header = stopping
            ? "STOPPING — waiting for the process tree to die."
            : $"RUNNING · {_testSuiteClock.Elapsed.TotalSeconds:0}s · "
              + $"{_testSuiteBuffer.CurrentSuiteName ?? "starting"} · "
              + $"{_testSuiteBuffer.TotalLines:N0} lines";

        ShowGuardFooterOutput(string.Join(
            Environment.NewLine,
            header,
            $"Running the real suites defined in {Path.Combine(suiteRoot, "package.json")}. "
            + "Nothing is shown on your screen and no audio is played; press the button "
            + "again to stop.",
            "",
            _testSuiteBuffer.Tail()));
    }

    /// <summary>
    /// Holds the last few output lines for display and counts every line that ever
    /// arrived. Bounded on purpose — a full run's output is far more text than a
    /// footer can show, and keeping all of it to display fourteen lines of it would be
    /// a leak that grows with the size of the test suite.
    /// </summary>
    private sealed class TestSuiteConsoleBuffer : IProgress<TestSuiteProgress>
    {
        private const int VisibleLines = 14;

        private readonly object _gate = new();
        private readonly Queue<string> _lines = new();
        private int _total;
        private string? _currentSuiteName;

        public int TotalLines { get { lock (_gate) { return _total; } } }

        public string? CurrentSuiteName { get { lock (_gate) { return _currentSuiteName; } } }

        /// <summary>Called from the process reader threads, not the UI thread.</summary>
        public void Report(TestSuiteProgress value)
        {
            if (value is null) return;

            lock (_gate)
            {
                _total++;
                _currentSuiteName = value.SuiteName;
                _lines.Enqueue(value.Line);
                while (_lines.Count > VisibleLines) _lines.Dequeue();
            }
        }

        public string Tail()
        {
            lock (_gate) { return string.Join(Environment.NewLine, _lines); }
        }
    }
}

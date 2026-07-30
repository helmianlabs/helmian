using System.Text;

/// <summary>
/// NOTHING MAY APPEAR ON THE USER'S SCREEN. This is the tripwire for that rule.
///
/// THE DEFECT THIS PINS. App.xaml.cs's CreateLaidOutWindow called window.Show() on
/// a 1440x900 borderless window with ShowInTaskbar = false, and publish.ps1 reaches
/// it twice per run (line 98 --smoke-test, line 103 --empty-workspace-audit). So
/// every publish presented two real windows with no close button and no taskbar
/// entry — undismissable by construction — while Troy was on sales calls. An hour
/// was spent telling sessions to stop doing something the build script did by
/// design.
///
/// WHY A SOURCE SCAN AND NOT A RUN. The only direct proof is to launch the exe and
/// watch nothing appear, and launching it is precisely what is forbidden — a failed
/// fix would cause the exact harm the rule exists to prevent. So this asserts the
/// guards are present in the source instead. That is weaker than observing it, and
/// this file says so rather than implying the behaviour has been witnessed.
///
/// A SCANNER THAT CANNOT FAIL PROVES NOTHING, so the checks below include a
/// POSITIVE CONTROL: the same scanner is run over a fixture containing a bare
/// Show() and must reject it. Without that, a broken scanner and a compliant file
/// look identical — which is the same trap that made the voice-host scanner match
/// the banned strings inside its own documentation.
/// </summary>
public static class OffscreenWindowChecks
{
    /// <summary>Any window further out than this is off every real display.</summary>
    private const double RequiredOffscreenLimit = -30000;

    public static void Run()
    {
        var checks = 0;
        var root = FindRepoRoot();
        if (root is null)
        {
            // Silent skips are how a check stops running without anyone noticing.
            throw new InvalidOperationException(
                "Off-screen window audit could not locate the repo root, so it could not "
                + "read App.xaml.cs. Refusing to pass a check it did not perform.");
        }

        var appPath = Path.Combine(root, "desktop", "Helmion.Desktop", "App.xaml.cs");
        Assert(File.Exists(appPath), $"App.xaml.cs is where this audit expects it ({appPath})");
        var source = StripCommentsAndStrings(File.ReadAllText(appPath));
        checks += 1;

        // ── THE HEADLESS WINDOW FACTORY MUST BE OFF-SCREEN AND NON-ACTIVATING ──
        // MATCH THE DECLARATION, NOT THE NAME. The first mention of
        // CreateLaidOutWindow in this file is a CALL inside OnStartup, and matching
        // that extracted OnStartup's body instead of the factory's — which then
        // failed for the right reason with a misleading message. A scanner that
        // reads the wrong span is indistinguishable from a real regression.
        var factory = ExtractMember(source, "MainWindow CreateLaidOutWindow(");
        Assert(factory is not null, "CreateLaidOutWindow's declaration exists and its body could be read");

        Assert(Mentions(factory!, "Left") && Mentions(factory!, "OffscreenOrigin"),
            "the headless window sets Left to the off-screen origin");
        Assert(Mentions(factory!, "Top"),
            "and Top as well — one axis off-screen still leaves it on a monitor");
        Assert(Mentions(factory!, "ShowActivated") && Mentions(factory!, "false"),
            "and does not activate, so it cannot take focus mid-call");
        Assert(Mentions(factory!, "ShowInTaskbar"),
            "and stays out of the taskbar");
        Assert(Mentions(factory!, "WindowStartupLocation") && Mentions(factory!, "Manual"),
            "with manual startup location, or WPF centres it on the primary display first");
        checks += 5;

        // The constant itself has to be far enough out to clear every display.
        var origin = ReadOffscreenOrigin(source);
        Assert(origin is not null, "the off-screen origin is a named constant, not a literal buried in a setter");
        Assert(origin!.Value <= RequiredOffscreenLimit,
            $"and it is at or beyond {RequiredOffscreenLimit} (found {origin.Value})");
        checks += 2;

        // ── NO NEW Show() MAY APPEAR WITHOUT SOMEONE DECIDING IT SHOULD ──
        // Exactly two are legitimate: the real application launch, and the
        // off-screen factory above. A third is a new way to put something on his
        // screen and should fail the build until a human has looked at it.
        var shows = CountOccurrences(source, ".Show()");
        Assert(shows == 2,
            $"App.xaml.cs contains exactly the 2 known Show() calls — the real launch and the "
            + $"off-screen factory (found {shows}). A new one must be reviewed, not absorbed.");
        checks += 1;

        // ── THE PATH THAT MUST NEVER BUILD A WINDOW AT ALL ──
        // --service-smoke-test returns before reaching the factory. Confirmed by
        // reading rather than assumed, and pinned here so a later edit cannot
        // quietly drop the early return and start showing a window on that path.
        // TWO SCANS, NOT ONE, and the difference matters. Calls are hunted in the
        // STRIPPED source so prose cannot fake them. Flag names are string
        // literals, so stripping erases exactly what we are looking for — those are
        // hunted in the RAW source. Using the stripped copy for both is what made
        // this check fail on a file that was correct.
        var startup = ExtractMember(source, "void OnStartup(");
        Assert(startup is not null, "OnStartup's body could be read");

        var rawStartup = ExtractMember(File.ReadAllText(appPath), "void OnStartup(");
        Assert(rawStartup is not null && rawStartup.Contains("--service-smoke-test", StringComparison.Ordinal),
            "the --service-smoke-test branch is still there");

        // The ordering guarantee is checked on CODE identifiers: the service branch
        // dispatches to RunServiceSmokeAsync and returns, and that must happen
        // before anything can reach the window factory.
        var serviceIndex = startup!.IndexOf("RunServiceSmokeAsync", StringComparison.Ordinal);
        var factoryIndex = startup.IndexOf("CreateLaidOutWindow", StringComparison.Ordinal);
        Assert(serviceIndex >= 0, "and it still dispatches to RunServiceSmokeAsync");
        Assert(factoryIndex < 0 || serviceIndex < factoryIndex,
            "and it is handled BEFORE any window is built, so it returns without one");
        checks += 4;

        // ── POSITIVE CONTROL: the scanner must reject a file that regressed ──
        var regressed = StripCommentsAndStrings(@"
            public partial class App : Application
            {
                private static MainWindow CreateLaidOutWindow()
                {
                    var window = new MainWindow { Width = 1440, Height = 900 };
                    window.Show();
                    return window;
                }
            }");
        var regressedFactory = ExtractMember(regressed, "CreateLaidOutWindow");
        Assert(regressedFactory is not null, "the control fixture parses");
        Assert(!Mentions(regressedFactory!, "OffscreenOrigin"),
            "and the scanner NOTICES the missing off-screen origin — so the pass above is real");
        Assert(!Mentions(regressedFactory!, "ShowActivated"),
            "and notices the missing ShowActivated guard too");
        checks += 3;

        // And it must not be fooled by prose. This whole file talks about Show()
        // constantly; a substring scan over unstripped source would match its own
        // documentation, which is exactly how the voice-host scanner failed.
        var proseOnly = StripCommentsAndStrings(@"
            // This comment mentions window.Show() and ShowActivated repeatedly.
            /* So does this block: window.Show(); window.Show(); */
            var message = ""never call window.Show() here"";");
        Assert(CountOccurrences(proseOnly, ".Show()") == 0,
            "Show() inside comments and string literals is not counted as a call");
        checks += 1;

        Console.WriteLine($"Helmion off-screen window checks passed ({checks} checks).");
    }

    /// <summary>
    /// Removes comments and string literals so a scan sees CODE, not prose.
    ///
    /// Deliberately conservative: it blanks the contents rather than deleting the
    /// span, so offsets stay comparable and the ordering assertions above remain
    /// meaningful.
    /// </summary>
    private static string StripCommentsAndStrings(string source)
    {
        var output = new StringBuilder(source.Length);
        var i = 0;

        while (i < source.Length)
        {
            var c = source[i];

            // Line comment
            if (c == '/' && i + 1 < source.Length && source[i + 1] == '/')
            {
                while (i < source.Length && source[i] != '\n') { output.Append(' '); i++; }
                continue;
            }

            // Block comment
            if (c == '/' && i + 1 < source.Length && source[i + 1] == '*')
            {
                while (i < source.Length && !(source[i] == '*' && i + 1 < source.Length && source[i + 1] == '/'))
                {
                    output.Append(source[i] == '\n' ? '\n' : ' ');
                    i++;
                }

                if (i < source.Length) { output.Append("  "); i += 2; }
                continue;
            }

            // Verbatim string, including the "" escape
            if (c == '@' && i + 1 < source.Length && source[i + 1] == '"')
            {
                output.Append("  ");
                i += 2;
                while (i < source.Length)
                {
                    if (source[i] == '"')
                    {
                        if (i + 1 < source.Length && source[i + 1] == '"') { output.Append("  "); i += 2; continue; }
                        output.Append(' '); i++; break;
                    }

                    output.Append(source[i] == '\n' ? '\n' : ' ');
                    i++;
                }

                continue;
            }

            // Regular string
            if (c == '"')
            {
                output.Append(' ');
                i++;
                while (i < source.Length && source[i] != '"')
                {
                    if (source[i] == '\\' && i + 1 < source.Length) { output.Append("  "); i += 2; continue; }
                    output.Append(source[i] == '\n' ? '\n' : ' ');
                    i++;
                }

                if (i < source.Length) { output.Append(' '); i++; }
                continue;
            }

            // Character literal
            if (c == '\'')
            {
                output.Append(' ');
                i++;
                while (i < source.Length && source[i] != '\'')
                {
                    if (source[i] == '\\' && i + 1 < source.Length) { output.Append("  "); i += 2; continue; }
                    output.Append(' ');
                    i++;
                }

                if (i < source.Length) { output.Append(' '); i++; }
                continue;
            }

            output.Append(c);
            i++;
        }

        return output.ToString();
    }

    /// <summary>The body of a named member, by brace matching from its declaration.</summary>
    private static string? ExtractMember(string source, string memberName)
    {
        var declaration = source.IndexOf(memberName, StringComparison.Ordinal);
        if (declaration < 0) return null;

        var open = source.IndexOf('{', declaration);
        if (open < 0) return null;

        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0) return source.Substring(open, i - open + 1);
            }
        }

        return null;
    }

    private static double? ReadOffscreenOrigin(string source)
    {
        var marker = source.IndexOf("OffscreenOrigin", StringComparison.Ordinal);
        if (marker < 0) return null;

        var equals = source.IndexOf('=', marker);
        var terminator = equals >= 0 ? source.IndexOf(';', equals) : -1;
        if (equals < 0 || terminator < 0) return null;

        var raw = source.Substring(equals + 1, terminator - equals - 1).Trim();
        return double.TryParse(raw, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    private static bool Mentions(string body, string token) =>
        body.Contains(token, StringComparison.Ordinal);

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    /// <summary>Walks up from the test binary to the repo root that holds bin/helmion.mjs.</summary>
    private static string? FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "bin", "helmion.mjs"))) return dir.FullName;
            dir = dir.Parent;
        }

        return null;
    }

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Off-screen window audit failed: {what}");
        }
    }
}

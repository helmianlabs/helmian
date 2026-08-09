using Helmion.Desktop.Core;

/// <summary>
/// The tripwire under the Pilot's top bar — the search box and the shortcuts the
/// UI claims to have.
///
/// WHY THIS FILE EXISTS. An audit on 2026-07-30 found that the project search
/// box's own tooltip said "Filter projects by name (Ctrl+K)" while the window's
/// only key handler had no K case at all: the app advertised a shortcut that had
/// never been bound. Nothing caught it because a WPF key handler cannot be
/// driven from a headless suite, so the chord table moved into Core
/// (ShellShortcuts) purely so this file could assert it.
///
/// The same audit found that opening a project re-rooted the shelf inside that
/// project, so every sibling disappeared on the next keystroke in the search
/// box. That rule now lives in Core too (ProjectShelfRoot).
///
/// WHAT THIS FILE CANNOT PROVE. That MainWindow_PreviewKeyDown actually calls
/// ShellShortcuts.Resolve, and that FocusProjectSearch really moves the caret.
/// Both need a window on screen. They are code-read only — see the report.
/// </summary>
internal static class TopBarChecks
{
    public static void Run()
    {
        var checks = 0;
        checks += CheckCtrlKFocusesTheSearchBox();
        checks += CheckExistingChordsSurvived();
        checks += CheckShelfSurvivesOpeningAProject();
        checks += CheckShellPanelsAndFullScreenAreIndependent();

        Console.WriteLine($"Helmion top-bar checks passed ({checks} checks).");
    }

    /// <summary>
    /// THE ONE THAT WAS FAILING. The search box promises Ctrl+K in its tooltip;
    /// this is the assertion that the promise is kept.
    /// </summary>
    private static int CheckCtrlKFocusesTheSearchBox()
    {
        Assert(
            ShellShortcuts.Resolve(control: true, ShellKey.K, consoleFullScreen: false)
                == ShellShortcut.FocusProjectSearch,
            "Ctrl+K focuses the project search box, which is what its tooltip promises");

        Assert(
            ShellShortcuts.Resolve(control: true, ShellKey.K, consoleFullScreen: true)
                == ShellShortcut.FocusProjectSearch,
            "Ctrl+K still reaches the search box while the console is full screen");

        // A bare K must fall through, or nobody can type the letter k.
        Assert(
            ShellShortcuts.Resolve(control: false, ShellKey.K, consoleFullScreen: false)
                == ShellShortcut.None,
            "K on its own is just a letter and is never swallowed");

        // Two chords must never resolve to the same action by accident — that is
        // how a table like this rots once somebody adds a row to it.
        Assert(Resolve(true, ShellKey.K) != Resolve(true, ShellKey.D0),
            "Ctrl+K and Ctrl+0 are different actions");
        return 4;
    }

    /// <summary>
    /// Moving the chord table into Core must not have quietly dropped a shortcut
    /// that already worked. Ctrl+wheel shares this ladder, and F11/Escape are the
    /// only way out of immersive mode.
    /// </summary>
    private static int CheckExistingChordsSurvived()
    {
        Assert(Resolve(true, ShellKey.OemPlus) == ShellShortcut.TextLarger, "Ctrl+= grows the text");
        Assert(Resolve(true, ShellKey.Add) == ShellShortcut.TextLarger, "Ctrl+numpad-plus grows the text");
        Assert(Resolve(true, ShellKey.OemMinus) == ShellShortcut.TextSmaller, "Ctrl+- shrinks the text");
        Assert(Resolve(true, ShellKey.Subtract) == ShellShortcut.TextSmaller, "Ctrl+numpad-minus shrinks the text");
        Assert(Resolve(true, ShellKey.D0) == ShellShortcut.TextDefault, "Ctrl+0 restores the default size");
        Assert(Resolve(true, ShellKey.NumPad0) == ShellShortcut.TextDefault, "Ctrl+numpad-0 restores the default size");
        Assert(Resolve(true, ShellKey.N) == ShellShortcut.NewProject, "Ctrl+N opens New Project");
        Assert(Resolve(true, ShellKey.O) == ShellShortcut.OpenProject, "Ctrl+O opens the project folder picker");
        Assert(Resolve(true, ShellKey.OemComma) == ShellShortcut.OpenSettings, "Ctrl+, opens Settings");
        Assert(Resolve(true, ShellKey.B) == ShellShortcut.ToggleSidebar, "Ctrl+B toggles the sidebar");
        Assert(Resolve(true, ShellKey.J) == ShellShortcut.ToggleBottomPanel, "Ctrl+J toggles the bottom panel");
        Assert(ShellShortcuts.Resolve(true, ShellKey.D, false, shift: true) == ShellShortcut.ToggleDetails,
            "Ctrl+Shift+D toggles details");

        Assert(Resolve(false, ShellKey.F11) == ShellShortcut.ToggleConsoleFullScreen,
            "F11 toggles immersive mode without a modifier");
        Assert(Resolve(true, ShellKey.F11) == ShellShortcut.ToggleConsoleFullScreen,
            "F11 still toggles while Ctrl happens to be held");

        // Escape belongs to whatever has focus unless we are immersive; swallowing
        // it always would break every text box and popup in the app.
        Assert(ShellShortcuts.Resolve(false, ShellKey.Escape, consoleFullScreen: true)
                == ShellShortcut.ExitConsoleFullScreen,
            "Escape leaves immersive mode");
        Assert(ShellShortcuts.Resolve(false, ShellKey.Escape, consoleFullScreen: false)
                == ShellShortcut.None,
            "Escape is left alone when the console is not immersive");

        Assert(Resolve(true, ShellKey.Other) == ShellShortcut.None, "an unmapped Ctrl chord is not ours");
        Assert(Resolve(false, ShellKey.Other) == ShellShortcut.None, "an unmapped key is not ours");
        return 18;
    }

    /// <summary>
    /// Opening a project sets the agent workspace to that project on purpose.
    /// The shelf must NOT follow it in, or every sibling project vanishes.
    /// </summary>
    private static int CheckShelfSurvivesOpeningAProject()
    {
        const string workspace = @"C:\work";
        const string project = @"C:\work\invoice-importer";

        Assert(ProjectShelfRoot.Resolve(null, workspace) == workspace,
            "the first workspace becomes the shelf root");

        // THE ONE THAT WAS FAILING.
        Assert(ProjectShelfRoot.Resolve(workspace, project) == workspace,
            "opening a project keeps the shelf on the parent, so its siblings stay listed");

        Assert(ProjectShelfRoot.Resolve(workspace, @"C:\work\invoice-importer\sprints\sprint-001") == workspace,
            "drilling deeper still keeps the shelf on the parent");

        Assert(ProjectShelfRoot.Resolve(workspace, workspace) == workspace,
            "re-resolving the same workspace is inert");

        // A genuinely different workspace DOES move the shelf — that is the whole
        // point of registering one, and pinning it would be the opposite bug.
        Assert(ProjectShelfRoot.Resolve(workspace, @"D:\other") == @"D:\other",
            "registering a different workspace moves the shelf to it");

        // Segment comparison, not a string prefix: these two are unrelated folders
        // that happen to share leading characters.
        Assert(ProjectShelfRoot.Resolve(@"C:\work\alpha", @"C:\work\alpha-two") == @"C:\work\alpha-two",
            "a sibling whose name merely starts with the root's name is a different workspace");

        Assert(ProjectShelfRoot.Resolve(workspace, @"c:\WORK\Invoice-Importer") == workspace,
            "the comparison is case-insensitive, as Windows paths are");
        Assert(ProjectShelfRoot.Resolve(workspace + @"\", project + @"\") == workspace,
            "a trailing separator does not make it a different folder");

        // Degenerate input must leave the shelf where it is rather than blanking it.
        Assert(ProjectShelfRoot.Resolve(workspace, null) == workspace, "a null workspace keeps the shelf root");
        Assert(ProjectShelfRoot.Resolve(workspace, "   ") == workspace, "a blank workspace keeps the shelf root");
        Assert(ProjectShelfRoot.Resolve(null, null) is null, "nothing in, nothing out");

        Assert(ProjectShelfRoot.IsAtOrBeneath(project, workspace), "a project is beneath its workspace");
        Assert(!ProjectShelfRoot.IsAtOrBeneath(workspace, project), "a workspace is not beneath its own project");
        return 13;
    }

    private static int CheckShellPanelsAndFullScreenAreIndependent()
    {
        var state = ShellLayoutState.Default;
        Assert(!state.IsFullScreen, "the shell starts in ordinary windowed mode");
        Assert(state.LeftPanelVisible && !state.RightPanelVisible, "the compact shell starts with Details closed");
        Assert(state.ShowWindowsCaption, "ordinary mode keeps Windows caption chrome");
        Assert(state.ShowAppHeaderAndFooter, "ordinary mode keeps the app header and footer");

        state = state.ToggleLeftPanel();
        Assert(!state.LeftPanelVisible, "the left panel can be hidden");
        Assert(!state.RightPanelVisible, "hiding the left panel does not reopen Details");

        state = state.WithFullScreen(true);
        Assert(state.IsFullScreen && !state.ShowWindowsCaption,
            "F11 requests true captionless full screen");
        Assert(!state.ShowAppHeaderAndFooter, "full screen hides Helmian header and footer chrome");
        Assert(!state.LeftPanelVisible && !state.RightPanelVisible,
            "entering full screen preserves independent panel choices");

        state = state.ToggleRightPanel();
        Assert(state.RightPanelVisible && !state.LeftPanelVisible,
            "the Details panel can be toggled independently while full screen");

        state = state.WithFullScreen(false);
        Assert(state.ShowWindowsCaption, "leaving F11 restores Windows caption chrome");
        Assert(!state.LeftPanelVisible && state.RightPanelVisible,
            "leaving F11 does not silently reopen either panel");
        return 12;
    }

    private static ShellShortcut Resolve(bool control, ShellKey key) =>
        ShellShortcuts.Resolve(control, key, consoleFullScreen: false);

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"Top bar failed: {what}");
        }
    }
}

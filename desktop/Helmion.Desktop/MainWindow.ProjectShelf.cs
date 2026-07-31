using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using Helmion.Desktop.Core;

namespace Helmion.Desktop;

/// <summary>
/// The left panel's project shelf, and the collapsed Pilot pages beneath it.
///
/// WHY THE PANEL LEADS WITH PROJECTS. Troy, 2026-07-30: "we don't need all the
/// stuff that we designed on the left panel… you can collapse them down into
/// settings maybe so under one button but I want to have the projects."
/// The nine page buttons are the app's own furniture; the projects are his work.
/// Work goes first, furniture goes behind one row.
///
/// AND DELIBERATELY NO "NEW SESSION" BUTTON. His words: "we don't need that cuz
/// we're going to buttons and so we tap the whatever it is claude codex whatever
/// button to open a new session… and it's not a new chat it's in addition to."
/// A session is started by a per-LLM pill and ADDS to what is running. Until that
/// lands the Sessions heading says it is not built rather than showing an empty
/// list that reads as broken.
/// </summary>
public partial class MainWindow
{
    /// <summary>
    /// Re-read the shelf from disk. Called on load and after a project is made.
    ///
    /// Reads the disk every time rather than caching: a project folder can be
    /// renamed, moved or deleted by anything on the machine, and a cached list
    /// would keep offering a folder that is no longer there.
    /// </summary>
    /// <summary>
    /// Populate on the control's own Loaded event rather than from the window
    /// constructor. MainWindow.xaml.cs is four thousand lines and is claimed by
    /// other work; nothing here needs to be in it.
    /// </summary>
    private void ProjectShelfList_Loaded(object sender, RoutedEventArgs e) => RefreshProjectShelf();

    private void RefreshProjectShelf()
    {
        if (ProjectShelfList is null) return;

        var root = ResolveProjectRoot();
        var filter = ProjectSearchBox?.Text ?? string.Empty;
        var projects = ProjectShelf.Discover(root, PinnedSlugs(), filter);
        ProjectShelfList.ItemsSource = projects;

        if (ProjectShelfEmpty is null) return;

        if (projects.Count > 0)
        {
            ProjectShelfEmpty.Visibility = Visibility.Collapsed;
            return;
        }

        // A filter that matched nothing is a DIFFERENT state from having no
        // projects, and saying "no projects" here would send somebody hunting for
        // a bug that is really just a typo in the search box.
        if (!string.IsNullOrWhiteSpace(filter))
        {
            ProjectShelfEmpty.Visibility = Visibility.Visible;
            ProjectShelfEmpty.Text = $"No project matches \"{filter.Trim()}\". Clear the box to see them all.";
            return;
        }

        // An empty shelf says WHERE it looked. "No projects" on its own sends
        // somebody hunting for a bug that is really just an unregistered folder.
        ProjectShelfEmpty.Visibility = Visibility.Visible;
        ProjectShelfEmpty.Text = string.IsNullOrWhiteSpace(root)
            ? "No workspace registered yet, so there is nowhere to look for projects. "
              + "Pick one on the Workspace page."
            : $"No projects in {root}. A project is a folder with a PROJECT.md in it — "
              + "press + New, or run: helmion project init \"Name\" --yes";
    }

    /// <summary>
    /// The folder the shelf is listing. Sticky across a drill-in: see
    /// <see cref="ProjectShelfRoot"/> for why this is not simply the agent
    /// workspace.
    /// </summary>
    private string? _projectShelfRoot;

    /// <summary>
    /// Where projects live.
    ///
    /// Starts from the registered workspace, but a workspace at or beneath the
    /// root already being shown does NOT move the shelf — that is somebody
    /// opening a project, and following them into it would hide every sibling
    /// project on the panel.
    /// </summary>
    private string? ResolveProjectRoot()
    {
        try
        {
            var workspace = ResolveAgentWorkspace();
            _projectShelfRoot = ProjectShelfRoot.Resolve(_projectShelfRoot, workspace);
            return string.IsNullOrWhiteSpace(_projectShelfRoot) || !Directory.Exists(_projectShelfRoot)
                ? null
                : _projectShelfRoot;
        }
        catch
        {
            return null;
        }
    }

    private void ProjectSearchBox_TextChanged(object sender, TextChangedEventArgs e) => RefreshProjectShelf();

    private IReadOnlyList<string> PinnedSlugs()
    {
        try
        {
            return _desktopSettings.PinnedProjects ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>
    /// Pin or unpin, and persist it.
    ///
    /// A pin is a PREFERENCE and lives in desktop settings; the project list
    /// itself still comes off the disk every refresh. So a pin naming a folder
    /// that has since been renamed or deleted simply never matches and costs
    /// nothing — which is exactly why this may be stored while the project list
    /// may not.
    /// </summary>
    private void ProjectPin_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string slug } || string.IsNullOrWhiteSpace(slug)) return;

        var pins = new List<string>(PinnedSlugs());
        if (pins.RemoveAll(existing => string.Equals(existing, slug, StringComparison.OrdinalIgnoreCase)) == 0)
        {
            pins.Add(slug);
        }

        try
        {
            _desktopSettings = _desktopSettings with { PinnedProjects = pins };
            DesktopSettingsStore.Save(_desktopSettings);
        }
        catch (Exception ex)
        {
            // A pin that could not be saved must not silently look saved.
            _plusMenu.Fail(
                _plusMenu.Begin(PlusMenuKind.Skill, "Pin project", "Saving the pin…"),
                $"The pin could not be saved: {ex.Message}");
        }

        RefreshProjectShelf();
    }

    private async void ProjectShelfItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string directory } || !Directory.Exists(directory)) return;

        // Opening a project means working in it, so the Workspace page is where
        // this goes. It does NOT launch a file explorer window — Troy's standing
        // correction is that Helmion must not auto-open things on his desktop.
        _registeredWorkspacePath = directory;

        // The shelf is re-read, not left showing whatever it had before this
        // click. It does NOT follow us into the project — ProjectShelfRoot keeps
        // it on the parent, so the sibling projects stay on the panel.
        RefreshProjectShelf();
        NavigateTo("Workspace");

        // Opening a project LAYS DOWN ITS STRUCTURE. Before this line, opening a
        // project was two statements — set a field, change page — and created
        // nothing, so the folder tree a zero-context session is supposed to read
        // never existed unless someone ran the CLI by hand.
        //
        // Safe on EVERY click, verified in the scaffolder rather than assumed:
        // project-scaffold.mjs:189-193 emits only create|preserve — there is no
        // update, append or overwrite action — and :213-218 writes with flag 'wx',
        // so a file that appears between plan and write is downgraded to preserve
        // instead of clobbered. Troy's own edits to planning/requirements.md
        // survive re-opening the project every day; that is pinned by a check that
        // compares the bytes before and after.
        //
        // It shells out to the SAME `helmion project init` the CLI runs. A second
        // implementation writing similar-looking files would drift from it.
        await ProjectOpenScaffold.EnsureStructureAsync(HelmionRootPath(), directory);
    }

    private void PilotPagesToggle_Changed(object sender, RoutedEventArgs e)
    {
        if (PilotPagesPanel is null || sender is not ToggleButton toggle) return;
        var open = toggle.IsChecked == true;
        PilotPagesPanel.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        toggle.Content = open ? "PILOT  ▴" : "PILOT  ▾";
    }

    /// <summary>
    /// Create a structured project folder.
    ///
    /// It runs the SAME code path as `helmion project init` rather than a second
    /// implementation that writes similar-looking files: the CLI is the source of
    /// truth for what a project contains, and two writers would drift.
    /// </summary>
    private async void NewProjectButton_Click(object sender, RoutedEventArgs e)
    {
        var root = ResolveProjectRoot();

        // WHERE THE NAME COMES FROM. This used to read ConsoleInputBox only — a box
        // on the Console PAGE, while the "+ New" button lives in the always-visible
        // sidebar. Troy, 2026-07-30: he typed a name into a box, pressed +, and got
        // an error telling him to type a name. He was typing in the wrong box, and
        // there was no way for him to know that, because the button is nowhere near
        // the box it reads.
        //
        // So it now reads the box DIRECTLY BENEATH THE BUTTON first
        // (ProjectSearchBox, MainWindow.xaml:1141) and only falls back to the
        // console box. Nothing about the old path breaks — anyone who was typing
        // into the console still gets what they expect — but the obvious thing now
        // works, which is the whole complaint.
        var typedHere = (ProjectSearchBox?.Text ?? string.Empty).Trim();
        var typedConsole = (ConsoleInputBox?.Text ?? string.Empty).Trim();
        var typed = typedHere.Length > 0 ? typedHere : typedConsole;

        // The row is created ONLY once we know something will be attempted. It used
        // to be created first, so every click on "+ New" with an empty box added
        // another bar. Troy's screenshot had eleven of them stacked in the console.
        if (!FirstRunStates.CanCreateProject(root, typed, out var projectRoot, out var name, out var notYet))
        {
            var hint = _plusMenu.Begin(PlusMenuKind.Skill, "New project", "Checking…");
            if (notYet is not null) _plusMenu.Settle(hint, notYet);
            else _plusMenu.Fail(hint, "Could not work out where to create the project.");
            return;
        }

        var row = _plusMenu.Begin(PlusMenuKind.Skill, "New project", "Writing the project folder…");

        // NEITHER OF THESE IS A FAILURE. Nothing was attempted: one is a workspace
        // the user has not picked yet, the other is a name they have not typed
        // yet. Both are hints about the next step, and both used to come back in
        // the same red as a scaffold that actually blew up. Red that fires on
        // normal first-run states is red the user learns to ignore.
        //
        // Both decisions live in Core so the headless suite can assert them; a
        // non-null result means nothing was attempted and the row is already settled.
        // (The check itself now runs ABOVE, before any row is created — see the
        // comment on where the name comes from.)

        try
        {
            var result = await ProjectScaffoldRunner.InitAsync(HelmionRootPath(), projectRoot, name);
            if (!result.Ok)
            {
                _plusMenu.Fail(row, result.Summary);
                return;
            }

            _plusMenu.Succeed(row, result.Summary);
            RefreshProjectShelf();
        }
        catch (Exception ex)
        {
            _plusMenu.Fail(row, $"Could not create the project: {ex.Message}");
        }
    }

    private string HelmionRootPath()
    {
        _agentBridge ??= new AgentBridge();
        return _agentBridge.HelmionRoot;
    }
}

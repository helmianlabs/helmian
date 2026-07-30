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

    /// <summary>Where projects live: the registered workspace.</summary>
    private string? ResolveProjectRoot()
    {
        try
        {
            var workspace = ResolveAgentWorkspace();
            return string.IsNullOrWhiteSpace(workspace) || !Directory.Exists(workspace) ? null : workspace;
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

    private void ProjectShelfItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string directory } || !Directory.Exists(directory)) return;

        // Opening a project means working in it, so the Workspace page is where
        // this goes. It does NOT launch a file explorer window — Troy's standing
        // correction is that Helmion must not auto-open things on his desktop.
        _registeredWorkspacePath = directory;
        NavigateTo("Workspace");
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
        var row = _plusMenu.Begin(PlusMenuKind.Skill, "New project", "Writing the project folder…");

        if (string.IsNullOrWhiteSpace(root))
        {
            _plusMenu.Fail(row, "No workspace is registered, so there is nowhere to create a project. "
                + "Pick one on the Workspace page first.");
            return;
        }

        var name = (ConsoleInputBox?.Text ?? string.Empty).Trim();
        if (name.Length == 0)
        {
            _plusMenu.Fail(row,
                "Type the project name into the box first, then press + New. "
                + "It becomes the folder name and the title inside PROJECT.md.");
            return;
        }

        try
        {
            var result = await ProjectScaffoldRunner.InitAsync(HelmionRootPath(), root, name);
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

using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
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
        var projects = ProjectShelf.Discover(
            root,
            PinnedSlugs(),
            filter,
            _registeredWorkspacePath);
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
            var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            var workspace = ProjectWorkspaceDefaults.Resolve(
                _registeredWorkspacePath,
                EnvironmentSettingsStore.LoadWorkspacePath(),
                _desktopSettings.LastWorkspacePath,
                documents);
            _projectShelfRoot = ProjectShelfRoot.Resolve(_projectShelfRoot, workspace);
            return string.IsNullOrWhiteSpace(_projectShelfRoot) ? null : _projectShelfRoot;
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

        await ActivateProjectAsync(directory, ensureStructure: true);
    }

    /// <summary>
    /// Make one shelf project the active work context and refresh every surface
    /// that names that context. This is shared by shelf clicks and successful
    /// creation so Create cannot leave Workspace and Console pointing at the
    /// previous folder.
    /// </summary>
    private async Task ActivateProjectAsync(string directory, bool ensureStructure)
    {
        if (!Directory.Exists(directory)) return;

        // Opening a project means working in it, so the Workspace page is where
        // this goes. It does NOT launch a file explorer window — Troy's standing
        // correction is that Helmion must not auto-open things on his desktop.
        _registeredWorkspacePath = directory;
        NotifyProjectScopedPanelsChanged();

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
        if (ensureStructure)
        {
            await ProjectOpenScaffold.EnsureStructureAsync(HelmionRootPath(), directory);
        }

        // Registration alone is not visible. Inspecting applies the project name
        // and path to Workspace and updates the Console workspace label in the
        // same handoff. The selection is session-local; this does not rewrite the
        // user's saved default workspace or move existing projects.
        await InspectWorkspaceAsync(directory, persistSelection: false);
        RefreshProjectWorkbench(forceCanvasReload: true);
    }

    private void PilotPagesToggle_Changed(object sender, RoutedEventArgs e)
    {
        if (PilotPagesPanel is null || sender is not ToggleButton toggle) return;
        var open = toggle.IsChecked == true;
        PilotPagesPanel.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        toggle.Content = open ? "PILOT  ▴" : "PILOT  ▾";
    }

    /// <summary>Open the dedicated project-name surface. This performs no write.</summary>
    private void NewProjectButton_Click(object sender, RoutedEventArgs e)
    {
        if (NewProjectPanel is null || NewProjectNameBox is null) return;
        NewProjectPanel.Visibility = Visibility.Visible;
        HideNewProjectValidation();
        NewProjectNameBox.Focus();
        NewProjectNameBox.SelectAll();
    }

    private async void CreateProjectButton_Click(object sender, RoutedEventArgs e) =>
        await CreateProjectFromPanelAsync();

    private void CancelNewProjectButton_Click(object sender, RoutedEventArgs e) =>
        CloseNewProjectPanel();

    private void ChooseExistingProjectButton_Click(object sender, RoutedEventArgs e)
    {
        CloseNewProjectPanel();
        MenuOpenProject_Click(sender, e);
    }

    private async void NewProjectNameBox_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            CloseNewProjectPanel();
            return;
        }

        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            await CreateProjectFromPanelAsync();
        }
    }

    /// <summary>
    /// Create from the dedicated entry only. The project filter and Console chat
    /// composer never supply a project name, and all validation stays beside the
    /// field instead of appearing as an unrelated Console action strip.
    /// </summary>
    private async Task CreateProjectFromPanelAsync()
    {
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        var root = ProjectWorkspaceDefaults.CustomerRoot(documents);
        var typed = (NewProjectNameBox?.Text ?? string.Empty).Trim();
        if (!FirstRunStates.CanCreateProject(
                root, typed, out var projectRoot, out var name, out var notYet))
        {
            ShowNewProjectValidation(
                notYet?.Message ?? "Could not determine where to create the project.");
            NewProjectNameBox?.Focus();
            return;
        }

        try
        {
            if (!Directory.Exists(projectRoot)
                && ProjectWorkspaceDefaults.IsCustomerRoot(projectRoot, documents))
            {
                // The default remains read-only until Create is explicitly
                // confirmed. This is the sole point that materializes it.
                Directory.CreateDirectory(projectRoot);
            }

            var result = await ProjectScaffoldRunner.InitAsync(HelmionRootPath(), projectRoot, name);
            if (!result.Ok)
            {
                ShowNewProjectValidation(result.Summary);
                return;
            }

            if (string.IsNullOrWhiteSpace(result.Directory)
                || !Directory.Exists(result.Directory))
            {
                RefreshProjectShelf();
                ShowNewProjectValidation(
                    $"{result.Summary} Helmian did not receive the created folder path, "
                    + "so it was not selected automatically.");
                return;
            }

            CloseNewProjectPanel();
            await ActivateProjectAsync(result.Directory, ensureStructure: false);
        }
        catch (Exception ex)
        {
            ShowNewProjectValidation($"Could not create the project: {ex.Message}");
        }
    }

    private void ShowNewProjectValidation(string message)
    {
        if (NewProjectValidationText is null) return;
        NewProjectValidationText.Text = message;
        NewProjectValidationText.Visibility = Visibility.Visible;
    }

    private void HideNewProjectValidation()
    {
        if (NewProjectValidationText is null) return;
        NewProjectValidationText.Text = string.Empty;
        NewProjectValidationText.Visibility = Visibility.Collapsed;
    }

    private void CloseNewProjectPanel()
    {
        if (NewProjectNameBox is not null) NewProjectNameBox.Text = string.Empty;
        HideNewProjectValidation();
        if (NewProjectPanel is not null) NewProjectPanel.Visibility = Visibility.Collapsed;
        NewProjectButton?.Focus();
    }

    private string HelmionRootPath()
    {
        _agentBridge ??= new AgentBridge();
        return _agentBridge.HelmionRoot;
    }
}

using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using Helmion.Desktop.Core;
using Microsoft.Web.WebView2.Core;

namespace Helmion.Desktop;

internal sealed record EmbeddedBrowserRenderResult(
    string Address,
    string Title,
    long PngBytes);

public partial class MainWindow
{
    private static readonly BrowserReferenceReader BrowserReader = new();
    private readonly EmbeddedBrowserPolicy _embeddedBrowserPolicy = new();
    private string? _loadedWorkbenchProject;
    private bool _browserReadInProgress;
    private bool _browserWebViewReady;
    private bool _browserWebViewInitializing;
    private string? _authorizedBrowserNavigation;
    private int _browserNavigationAttempt;
    private IReadOnlyList<ProjectArtifact> _projectArtifacts = [];

    private void ApplyAgentWorkbenchResult(AgentBridgeEvent ev)
    {
        if (string.IsNullOrWhiteSpace(ev.ResultJson)
            || !TryGetActiveWorkbenchProjectSilently(out var project)) return;

        try
        {
            using var document = JsonDocument.Parse(ev.ResultJson);
            var root = document.RootElement;
            if (Text(root, "contract") != "helmion.workbench.v1") return;
            var kind = Text(root, "kind") ?? "workbench";
            var status = Text(root, "status") ?? "unknown";
            var path = Text(root, "path");
            var hash = Text(root, "sha256");

            string title;
            string detail;
            if (kind == "file_change")
            {
                var operation = Text(root, "operation") ?? "changed";
                title = $"Agent {operation} {path ?? "a project file"}";
                detail = $"{operation} · {path ?? "unknown path"} · {Number(root, "bytes")} bytes";
                AppendConsoleLine($"Workbench · {operation} · {path}");
            }
            else if (kind == "task_run")
            {
                var taskLabel = root.TryGetProperty("task", out var task)
                    ? Text(task, "label") ?? Text(task, "id") ?? "project task"
                    : "project task";
                var exitCode = root.TryGetProperty("exitCode", out var exit)
                    && exit.ValueKind == JsonValueKind.Number ? exit.GetInt32().ToString() : "none";
                var artifacts = root.TryGetProperty("artifacts", out var artifactItems)
                    && artifactItems.ValueKind == JsonValueKind.Array ? artifactItems.GetArrayLength() : 0;
                title = $"Agent ran {taskLabel}";
                detail = $"{status} · exit {exitCode} · {artifacts} artifact(s) discovered";
                AppendConsoleLine($"Workbench · {taskLabel} · {status} · exit {exitCode}");
            }
            else if (kind == "preview")
            {
                title = status == "ready" ? "Agent started local preview" : "Agent stopped local preview";
                detail = status == "ready"
                    ? $"Loopback-only static preview · {path ?? "project output"}"
                    : "The session-owned loopback preview stopped.";
                AppendConsoleLine($"Workbench · preview {status}{(path is null ? string.Empty : $" · {path}")}");
                var url = Text(root, "url");
                if (status == "ready" && !string.IsNullOrWhiteSpace(url))
                {
                    _ = OpenLocalWorkbenchPreviewAsync(url);
                }
            }
            else if (kind == "workspace_context")
            {
                var fileCount = root.TryGetProperty("files", out var files)
                    && files.ValueKind == JsonValueKind.Array ? files.GetArrayLength() : 0;
                title = "Agent inspected workspace context";
                detail = $"Read {fileCount} bounded file entries; private configuration was excluded.";
            }
            else return;

            ProjectWorkbenchStore.RecordAgentWorkbenchEvent(
                project, title, detail, status, hash);
            RefreshProjectWorkbench(forceCanvasReload: false);
        }
        catch (JsonException)
        {
            // A malformed optional status payload never changes the provider turn.
        }
    }

    private async Task OpenLocalWorkbenchPreviewAsync(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttp
            || !uri.IsLoopback
            || uri.Port is < 1 or > 65535)
        {
            AppendConsoleLine("Workbench · preview refused because the address was not loopback HTTP.");
            return;
        }

        // Show the right rail and Browser tab (Claude-style side preview) — never leave the panel collapsed.
        if (!_shellLayout.RightPanelVisible)
        {
            _shellLayout = _shellLayout.ToggleRightPanel();
            ApplyShellPanelVisibility();
        }

        SelectWorkbenchSurface("browser");
        await EnsureEmbeddedBrowserAsync();
        if (!_browserWebViewReady)
        {
            AppendConsoleLine(
                "Workbench · preview URL is ready but WebView2 did not start. Install Edge WebView2 Runtime, then open Browser on the right.");
            if (BrowserStatusText is not null)
                BrowserStatusText.Text = $"Preview ready at {uri.AbsoluteUri} — WebView2 not available yet.";
            return;
        }

        _authorizedBrowserNavigation = uri.AbsoluteUri;
        BrowserWebAddressBox.Text = uri.AbsoluteUri;
        BrowserStatusText.Text =
            "Agent loopback preview · 127.0.0.1 only · no external bind. Hide with › on the panel.";
        BrowserWebView.CoreWebView2.Navigate(uri.AbsoluteUri);
        AppendConsoleLine($"Workbench · opened in Browser panel · {uri.AbsoluteUri}");
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static long Number(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64()
            : 0;

    private void WorkbenchTab_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not ToggleButton { Tag: string id }
            || WorkbenchSurfaceCatalog.Find(id) is null)
        {
            return;
        }

        SelectWorkbenchSurface(id);
    }

    private void SelectWorkbenchSurface(string id)
    {
        if (GuardWorkbenchSurface is null) return;

        GuardWorkbenchSurface.Visibility = id == "guard" ? Visibility.Visible : Visibility.Collapsed;
        BrowserWorkbenchSurface.Visibility = id == "browser" ? Visibility.Visible : Visibility.Collapsed;
        CanvasWorkbenchSurface.Visibility = id == "canvas" ? Visibility.Visible : Visibility.Collapsed;
        PreviewWorkbenchSurface.Visibility = id == "preview" ? Visibility.Visible : Visibility.Collapsed;
        CreateWorkbenchSurface.Visibility = id == "create" ? Visibility.Visible : Visibility.Collapsed;

        foreach (var tab in new[]
                 {
                     GuardWorkbenchTab, BrowserWorkbenchTab, CanvasWorkbenchTab,
                     PreviewWorkbenchTab, CreateWorkbenchTab
                 })
        {
            tab.IsChecked = string.Equals(tab.Tag as string, id, StringComparison.Ordinal);
        }

        if (id is "canvas" or "preview" or "create")
        {
            RefreshProjectWorkbench(forceCanvasReload: false);
        }
        if (id == "browser")
        {
            _ = EnsureEmbeddedBrowserAsync();
        }
        if (id == "create")
        {
            RefreshArtifactStudio();
        }
    }

    internal void SelectWorkbenchSurfaceForPreview(string id)
    {
        if (!_shellLayout.RightPanelVisible)
        {
            _shellLayout = _shellLayout.ToggleRightPanel();
            ApplyShellPanelVisibility();
        }

        SelectWorkbenchSurface(id);
    }

    private async Task EnsureEmbeddedBrowserAsync()
    {
        if (_browserWebViewReady) return;
        if (_browserWebViewInitializing)
        {
            while (_browserWebViewInitializing)
            {
                await Task.Delay(20);
            }
            return;
        }

        _browserWebViewInitializing = true;
        BrowserGoButton.IsEnabled = false;
        BrowserStatusText.Text = "Starting the embedded browser…";

        try
        {
            var profileFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Helmian",
                "BrowserProfile");
            var environment = await CoreWebView2Environment.CreateAsync(null, profileFolder);
            await BrowserWebView.EnsureCoreWebView2Async(environment);

            var core = BrowserWebView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;

            core.DownloadStarting += (_, args) =>
            {
                args.Cancel = true;
                BrowserStatusText.Text =
                    "Download blocked. Review external items before they enter Helmian or Windows.";
            };
            core.PermissionRequested += (_, args) =>
            {
                args.State = CoreWebView2PermissionState.Deny;
                args.Handled = true;
                BrowserStatusText.Text =
                    $"Website permission blocked ({args.PermissionKind}). Helmian did not change Windows permissions.";
            };
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                _ = NavigateEmbeddedBrowserAsync(args.Uri, "Website requested a new window; opened here instead.");
            };
            core.DocumentTitleChanged += (_, _) => UpdateEmbeddedBrowserTitle();
            core.HistoryChanged += (_, _) => UpdateEmbeddedBrowserNavigationButtons();
            core.SourceChanged += (_, _) => UpdateEmbeddedBrowserAddress();
            core.ProcessFailed += (_, args) =>
            {
                BrowserStatusText.Text =
                    $"The embedded browser process stopped ({args.ProcessFailedKind}). Reload the page to retry.";
            };

            _browserWebViewReady = true;
            BrowserReloadButton.IsEnabled = true;
            BrowserStatusText.Text =
                "Ready. Public HTTPS sites render here with normal page code; downloads and permissions remain blocked.";
        }
        catch (WebView2RuntimeNotFoundException)
        {
            BrowserStatusText.Text =
                "Microsoft Edge WebView2 Runtime is required but was not found. Helmian did not install or change anything.";
        }
        catch (Exception ex)
        {
            BrowserStatusText.Text = $"The embedded browser could not start: {ex.Message}";
        }
        finally
        {
            _browserWebViewInitializing = false;
            BrowserGoButton.IsEnabled = true;
        }
    }

    private async void BrowserGoButton_Click(object sender, RoutedEventArgs e) =>
        await NavigateEmbeddedBrowserAsync(BrowserWebAddressBox.Text);

    private async void BrowserWebAddressBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        await NavigateEmbeddedBrowserAsync(BrowserWebAddressBox.Text);
    }

    private void BrowserBackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_browserWebViewReady && BrowserWebView.CoreWebView2.CanGoBack)
        {
            BrowserWebView.CoreWebView2.GoBack();
        }
    }

    private void BrowserForwardButton_Click(object sender, RoutedEventArgs e)
    {
        if (_browserWebViewReady && BrowserWebView.CoreWebView2.CanGoForward)
        {
            BrowserWebView.CoreWebView2.GoForward();
        }
    }

    private void BrowserReloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (_browserWebViewReady)
        {
            BrowserWebView.CoreWebView2.Reload();
            BrowserStatusText.Text = "Reloading rendered website…";
        }
    }

    /// <summary>
    /// Blank the embedded browser. Bypasses HTTPS policy (about:blank only) so
    /// Troy can dismiss a local preview without fighting the address bar.
    /// </summary>
    private void BrowserClearButton_Click(object sender, RoutedEventArgs e)
    {
        _browserNavigationAttempt++;
        if (BrowserWebAddressBox is not null)
            BrowserWebAddressBox.Text = string.Empty;

        if (_browserWebViewReady && BrowserWebView.CoreWebView2 is not null)
        {
            try
            {
                BrowserWebView.CoreWebView2.Stop();
                BrowserWebView.CoreWebView2.Navigate("about:blank");
            }
            catch (Exception ex)
            {
                if (BrowserStatusText is not null)
                    BrowserStatusText.Text = "Could not clear: " + ex.Message;
                return;
            }
        }

        if (BrowserStatusText is not null)
            BrowserStatusText.Text = "Cleared.";
        if (BrowserBackButton is not null) BrowserBackButton.IsEnabled = false;
        if (BrowserForwardButton is not null) BrowserForwardButton.IsEnabled = false;
    }

    private void CanvasClearButton_Click(object sender, RoutedEventArgs e)
    {
        if (CanvasNoteBox is not null)
            CanvasNoteBox.Text = string.Empty;
        if (CanvasDecisionBox is not null)
            CanvasDecisionBox.Text = string.Empty;
        if (CanvasStatusText is not null)
            CanvasStatusText.Text = "Canvas fields cleared on screen. Saved files unchanged until you Save.";
    }

    private async Task NavigateEmbeddedBrowserAsync(string? value, string? context = null)
    {
        await EnsureEmbeddedBrowserAsync();
        if (!_browserWebViewReady) return;

        var attempt = ++_browserNavigationAttempt;
        BrowserGoButton.IsEnabled = false;
        BrowserStatusText.Text = "Checking the public website boundary…";

        try
        {
            var decision = await _embeddedBrowserPolicy.ValidateAsync(value);
            if (attempt != _browserNavigationAttempt) return;

            if (!decision.Allowed || decision.Address is null)
            {
                BrowserStatusText.Text = decision.Message;
                BrowserWebAddressBox.Focus();
                return;
            }

            _authorizedBrowserNavigation = decision.Address.AbsoluteUri;
            BrowserWebAddressBox.Text = decision.Address.AbsoluteUri;
            BrowserStatusText.Text = context ??
                "Opening external website. Page code stays inside the browser boundary.";
            BrowserWebView.CoreWebView2.Navigate(decision.Address.AbsoluteUri);
        }
        catch (OperationCanceledException)
        {
            BrowserStatusText.Text = "Website navigation was canceled.";
        }
        finally
        {
            BrowserGoButton.IsEnabled = true;
        }
    }

    private async void BrowserWebView_NavigationStarting(
        object sender,
        CoreWebView2NavigationStartingEventArgs e)
    {
        if (string.Equals(
                _authorizedBrowserNavigation,
                e.Uri,
                StringComparison.OrdinalIgnoreCase))
        {
            _authorizedBrowserNavigation = null;
            BrowserStatusText.Text = "Loading rendered website…";
            return;
        }

        e.Cancel = true;
        await NavigateEmbeddedBrowserAsync(e.Uri);
    }

    private void BrowserWebView_NavigationCompleted(
        object sender,
        CoreWebView2NavigationCompletedEventArgs e)
    {
        UpdateEmbeddedBrowserAddress();
        UpdateEmbeddedBrowserNavigationButtons();
        UpdateEmbeddedBrowserTitle();
        BrowserStatusText.Text = e.IsSuccess
            ? "Rendered website loaded. External page code has no Helmian tool or project access."
            : $"Website navigation failed: {e.WebErrorStatus}.";
    }

    private void UpdateEmbeddedBrowserNavigationButtons()
    {
        if (!_browserWebViewReady) return;
        BrowserBackButton.IsEnabled = BrowserWebView.CoreWebView2.CanGoBack;
        BrowserForwardButton.IsEnabled = BrowserWebView.CoreWebView2.CanGoForward;
        BrowserReloadButton.IsEnabled = true;
    }

    private void UpdateEmbeddedBrowserAddress()
    {
        if (!_browserWebViewReady) return;
        var source = BrowserWebView.Source?.AbsoluteUri;
        if (!string.IsNullOrWhiteSpace(source)
            && !string.Equals(source, "about:blank", StringComparison.OrdinalIgnoreCase))
        {
            BrowserWebAddressBox.Text = source;
        }
    }

    private void UpdateEmbeddedBrowserTitle()
    {
        if (!_browserWebViewReady) return;
        var title = BrowserWebView.CoreWebView2.DocumentTitle;
        BrowserWebView.SetValue(
            System.Windows.Automation.AutomationProperties.HelpTextProperty,
            string.IsNullOrWhiteSpace(title) ? "Rendered website content" : title);
    }

    internal async Task<EmbeddedBrowserRenderResult> RunEmbeddedBrowserRenderSmokeAsync(
        string address,
        string outputPath)
    {
        SelectWorkbenchSurface("browser");
        await EnsureEmbeddedBrowserAsync();
        if (!_browserWebViewReady)
        {
            throw new InvalidOperationException(BrowserStatusText.Text);
        }

        var completion = new TaskCompletionSource<CoreWebView2NavigationCompletedEventArgs>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void Completed(object? _, CoreWebView2NavigationCompletedEventArgs args) =>
            completion.TrySetResult(args);

        BrowserWebView.NavigationCompleted += Completed;
        try
        {
            await NavigateEmbeddedBrowserAsync(address);
            var navigation = await completion.Task.WaitAsync(TimeSpan.FromSeconds(35));
            if (!navigation.IsSuccess)
            {
                throw new InvalidOperationException(
                    $"Rendered navigation failed: {navigation.WebErrorStatus}.");
            }

            await BrowserWebView.CoreWebView2.ExecuteScriptAsync(
                "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

            var target = Path.GetFullPath(outputPath);
            Directory.CreateDirectory(Path.GetDirectoryName(target)
                ?? throw new InvalidOperationException("Browser render output has no parent directory."));
            await using (var stream = new FileStream(
                             target,
                             FileMode.Create,
                             FileAccess.Write,
                             FileShare.None))
            {
                await BrowserWebView.CoreWebView2.CapturePreviewAsync(
                    CoreWebView2CapturePreviewImageFormat.Png,
                    stream);
            }

            var file = new FileInfo(target);
            if (!file.Exists || file.Length == 0)
            {
                throw new InvalidOperationException("WebView2 returned no rendered preview pixels.");
            }

            return new EmbeddedBrowserRenderResult(
                BrowserWebView.Source?.AbsoluteUri ?? address,
                BrowserWebView.CoreWebView2.DocumentTitle,
                file.Length);
        }
        finally
        {
            BrowserWebView.NavigationCompleted -= Completed;
        }
    }

    private void RefreshProjectWorkbench(bool forceCanvasReload)
    {
        if (CanvasProjectText is null || ProjectActivityList is null) return;

        var project = _registeredWorkspacePath;
        if (string.IsNullOrWhiteSpace(project) || !Directory.Exists(project))
        {
            _loadedWorkbenchProject = null;
            CanvasProjectText.Text = "Select a project to use Canvas.";
            CanvasNoteBox.Text = string.Empty;
            CanvasNoteBox.IsEnabled = false;
            CanvasDecisionBox.Text = string.Empty;
            CanvasDecisionBox.IsEnabled = false;
            CanvasSaveButton.IsEnabled = false;
            CanvasDecisionButton.IsEnabled = false;
            CanvasStatusText.Text = "Canvas is local and project-scoped. No project is selected.";
            ProjectActivityList.ItemsSource = null;
            ProjectActivityEmptyText.Visibility = Visibility.Visible;
            ResetArtifactPreview("Select a project to view its artifact history.");
            return;
        }

        var fullProject = Path.GetFullPath(project);
        var projectChanged = !string.Equals(
            _loadedWorkbenchProject,
            fullProject,
            StringComparison.OrdinalIgnoreCase);
        _loadedWorkbenchProject = fullProject;

        CanvasProjectText.Text = $"Active project · {Path.GetFileName(fullProject)}";
        CanvasNoteBox.IsEnabled = true;
        CanvasDecisionBox.IsEnabled = true;
        CanvasSaveButton.IsEnabled = true;
        CanvasDecisionButton.IsEnabled = true;

        try
        {
            if (projectChanged || forceCanvasReload)
            {
                var canvas = ProjectWorkbenchStore.LoadCanvas(fullProject);
                CanvasNoteBox.Text = canvas.Text;
                CanvasStatusText.Text = canvas.ModifiedAtUtc is null
                    ? $"No Canvas file yet. Save creates {ProjectWorkbenchStore.CanvasRelativePath}."
                    : $"Loaded {ProjectWorkbenchStore.CanvasRelativePath} · {canvas.ModifiedAtUtc.Value.ToLocalTime():g}";
            }

            var activity = ProjectWorkbenchStore.ReadActivity(fullProject, limit: 80);
            ProjectActivityList.ItemsSource = activity;
            ProjectActivityEmptyText.Visibility = activity.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;

            if (projectChanged || PreviewWorkbenchSurface.Visibility == Visibility.Visible)
            {
                RefreshArtifactPreview(fullProject);
            }
        }
        catch (Exception ex)
        {
            CanvasStatusText.Text = $"Canvas could not be read: {ex.Message}";
            ProjectActivityList.ItemsSource = null;
            ProjectActivityEmptyText.Visibility = Visibility.Visible;
        }
    }

    private async void BrowserReferenceLoadButton_Click(object sender, RoutedEventArgs e)
    {
        if (_browserReadInProgress) return;

        var validation = BrowserReferenceReader.ValidateAddress(BrowserReferenceAddressBox.Text);
        if (!validation.Allowed)
        {
            BrowserReferenceStatusText.Text = validation.Message;
            BrowserReferenceResultCard.Visibility = Visibility.Collapsed;
            BrowserReferenceAddressBox.Focus();
            return;
        }

        _browserReadInProgress = true;
        BrowserReferenceLoadButton.IsEnabled = false;
        BrowserReferenceLoadButton.Content = "Reading…";
        BrowserReferenceStatusText.Text = "Resolving and reading public HTTPS text…";
        BrowserReferenceResultCard.Visibility = Visibility.Collapsed;

        try
        {
            var result = await BrowserReader.ReadAsync(BrowserReferenceAddressBox.Text);
            BrowserReferenceTitleText.Text = result.Title;
            BrowserReferenceLocationText.Text = result.DisplayAddress;
            BrowserReferenceContentBox.Text = result.Text.Length == 0
                ? "[The page returned no readable text.]"
                : result.Text;
            BrowserReferenceResultCard.Visibility = Visibility.Visible;

            var projectEvidence = "No project activity was written because no project is selected.";
            if (TryGetActiveWorkbenchProjectSilently(out var project))
            {
                ProjectWorkbenchStore.RecordBrowserReference(
                    project,
                    result.DisplayAddress,
                    result.Title,
                    result.CharacterCount,
                    result.EvidenceHash,
                    result.LoadedAtUtc);
                projectEvidence = "Recorded in this project's activity history.";
                RefreshProjectWorkbench(forceCanvasReload: false);
            }

            var truncation = result.WasTruncated ? " Display text was truncated." : string.Empty;
            BrowserReferenceStatusText.Text =
                $"Read {result.CharacterCount:N0} inert text characters · {result.ContentType}. "
                + projectEvidence
                + truncation;
        }
        catch (BrowserReferenceException ex)
        {
            BrowserReferenceStatusText.Text = ex.Message;
            BrowserReferenceResultCard.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            BrowserReferenceStatusText.Text = $"The page could not be read: {ex.Message}";
            BrowserReferenceResultCard.Visibility = Visibility.Collapsed;
        }
        finally
        {
            _browserReadInProgress = false;
            BrowserReferenceLoadButton.IsEnabled = true;
            BrowserReferenceLoadButton.Content = "Read inert text";
        }
    }

    private void PreviewRefreshButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryGetActiveWorkbenchProject(out var project))
        {
            ResetArtifactPreview("Select a project to view its artifact history.");
            return;
        }

        RefreshArtifactPreview(project);
    }

    private void RefreshArtifactPreview(string project)
    {
        try
        {
            _projectArtifacts = ProjectArtifactStore.Discover(project);
            PreviewProjectText.Text =
                $"Active project · {Path.GetFileName(project)} · {ProjectArtifactStore.ArtifactRelativeDirectory}";
            PreviewArtifactList.ItemsSource = _projectArtifacts;
            PreviewArtifactEmptyText.Visibility = _projectArtifacts.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
            PreviewStatusText.Text = _projectArtifacts.Count == 0
                ? $"No supported outputs yet. Preview does not create {ProjectArtifactStore.ArtifactRelativeDirectory}."
                : $"{_projectArtifacts.Count} project artifact{(_projectArtifacts.Count == 1 ? string.Empty : "s")} · newest first";
            ClearArtifactDetail();
        }
        catch (Exception ex)
        {
            ResetArtifactPreview($"Artifact history could not be read: {ex.Message}");
        }
    }

    private void ArtifactPreviewButton_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string fullPath }) return;
        var artifact = _projectArtifacts.FirstOrDefault(item =>
            string.Equals(item.FullPath, fullPath, StringComparison.OrdinalIgnoreCase));
        if (artifact is null) return;

        ClearArtifactDetail();
        PreviewArtifactNameText.Text = artifact.Name;
        PreviewArtifactMetadataText.Text =
            $"{artifact.Kind} · {artifact.SizeLabel} · {artifact.ModifiedLabel}\n"
            + $"{artifact.RelativePath}\nSHA-256 {artifact.Sha256}";

        try
        {
            if (artifact.PreviewKind == "image")
            {
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.DecodePixelWidth = 1200;
                bitmap.UriSource = new Uri(artifact.FullPath, UriKind.Absolute);
                bitmap.EndInit();
                bitmap.Freeze();
                PreviewArtifactImage.Source = bitmap;
                PreviewArtifactImage.Visibility = Visibility.Visible;
                PreviewArtifactBoundaryText.Text =
                    "Rendered from the selected project file. No provider call or external application.";
                return;
            }

            if (artifact.PreviewKind == "text")
            {
                PreviewArtifactText.Text = artifact.TextPreview ?? string.Empty;
                PreviewArtifactText.Visibility = Visibility.Visible;
                PreviewArtifactBoundaryText.Text =
                    "Read-only text preview. Links, scripts, and embedded content are not executed.";
                return;
            }

            PreviewArtifactBoundaryText.Text =
                "Metadata-only preview for this file type. Helmian does not open or execute it here.";
        }
        catch (Exception ex)
        {
            PreviewArtifactBoundaryText.Text = $"Preview unavailable: {ex.Message}";
        }
    }

    private void ResetArtifactPreview(string status)
    {
        _projectArtifacts = [];
        if (PreviewProjectText is null) return;
        PreviewProjectText.Text = "No project selected.";
        PreviewArtifactList.ItemsSource = null;
        PreviewArtifactEmptyText.Visibility = Visibility.Visible;
        PreviewStatusText.Text = status;
        ClearArtifactDetail();
    }

    private void ClearArtifactDetail()
    {
        if (PreviewArtifactNameText is null) return;
        PreviewArtifactNameText.Text = "Select an artifact";
        PreviewArtifactMetadataText.Text = string.Empty;
        PreviewArtifactBoundaryText.Text =
            "Preview reads supported project outputs only. It never executes embedded content.";
        PreviewArtifactImage.Source = null;
        PreviewArtifactImage.Visibility = Visibility.Collapsed;
        PreviewArtifactText.Text = string.Empty;
        PreviewArtifactText.Visibility = Visibility.Collapsed;
    }

    /// <summary>Clear the detail pane only — keeps the artifact list. Does not delete files.</summary>
    private void PreviewClearButton_Click(object sender, RoutedEventArgs e)
    {
        ClearArtifactDetail();
        if (PreviewStatusText is not null)
            PreviewStatusText.Text = "Preview cleared. Pick an artifact again or Refresh the list.";
    }

    private void CanvasSaveButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryGetActiveWorkbenchProject(out var project)) return;

        try
        {
            var entry = ProjectWorkbenchStore.SaveCanvas(project, CanvasNoteBox.Text);
            CanvasStatusText.Text = $"Saved locally · {entry.TimeLabel} · no provider call";
            RefreshProjectWorkbench(forceCanvasReload: false);
        }
        catch (Exception ex)
        {
            CanvasStatusText.Text = $"Canvas was not saved: {ex.Message}";
        }
    }

    private void CanvasDecisionButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryGetActiveWorkbenchProject(out var project)) return;

        try
        {
            var entry = ProjectWorkbenchStore.RecordDecision(project, CanvasDecisionBox.Text);
            CanvasDecisionBox.Text = string.Empty;
            CanvasStatusText.Text = $"Decision recorded locally · {entry.TimeLabel}";
            RefreshProjectWorkbench(forceCanvasReload: false);
        }
        catch (Exception ex)
        {
            CanvasStatusText.Text = $"Decision was not recorded: {ex.Message}";
            CanvasDecisionBox.Focus();
        }
    }

    private bool TryGetActiveWorkbenchProject(out string project)
    {
        project = _registeredWorkspacePath ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(project) && Directory.Exists(project)) return true;

        CanvasStatusText.Text = "Select a project before writing Canvas notes or decisions.";
        return false;
    }

    private bool TryGetActiveWorkbenchProjectSilently(out string project)
    {
        project = _registeredWorkspacePath ?? string.Empty;
        return !string.IsNullOrWhiteSpace(project) && Directory.Exists(project);
    }
}

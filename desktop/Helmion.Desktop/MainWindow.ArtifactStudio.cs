using System.IO;
using System.Windows;
using System.Windows.Controls;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

public partial class MainWindow
{
    private sealed record ArtifactOutputOption(string Id, string Name);

    private static readonly IReadOnlyList<ArtifactOutputOption> ArtifactOutputOptions =
    [
        new(ArtifactStudioIntentPlanner.AutoKind, "Choose automatically"),
        new(ArtifactStudioKinds.Image, "Image"),
        new(ArtifactStudioKinds.DesignAsset, "Design asset"),
        new(ArtifactStudioKinds.Pdf, "PDF"),
        new(ArtifactStudioKinds.Document, "Document"),
        new(ArtifactStudioKinds.Slides, "Slides"),
        new(ArtifactStudioKinds.Spreadsheet, "Spreadsheet")
    ];

    private IReadOnlyList<ArtifactStudioRequest> _artifactStudioRequests = [];
    private string? _selectedArtifactStudioRequestId;
    private bool _artifactStudioControlsReady;
    private bool _artifactGenerationInProgress;

    private void RefreshArtifactStudio(string? selectRequestId = null)
    {
        if (ArtifactOutputCombo is null || ArtifactRequestHistoryList is null) return;

        if (!_artifactStudioControlsReady)
        {
            _artifactStudioControlsReady = true;
            ArtifactOutputCombo.ItemsSource = ArtifactOutputOptions;
            ArtifactOutputCombo.SelectedIndex = 0;
        }

        UpdateArtifactProviderBoundary();
        if (!TryGetActiveWorkbenchProjectSilently(out var project))
        {
            ArtifactStudioProjectText.Text = "Select a project to prepare an artifact request.";
            ArtifactPrepareButton.IsEnabled = false;
            ArtifactRequestHistoryList.ItemsSource = null;
            ArtifactHistoryEmptyText.Visibility = Visibility.Visible;
            ArtifactReviewPanel.Visibility = Visibility.Collapsed;
            ArtifactGenerateButton.Visibility = Visibility.Collapsed;
            ArtifactStudioStatusText.Text = "Nothing can be prepared or delivered without an active project.";
            _artifactStudioRequests = [];
            _selectedArtifactStudioRequestId = null;
            return;
        }

        ArtifactStudioProjectText.Text = $"Active project · {Path.GetFileName(project)}";
        ArtifactPrepareButton.IsEnabled = true;
        try
        {
            _artifactStudioRequests = ArtifactStudioWorkflow.ReadHistory(project, 100);
            ArtifactRequestHistoryList.ItemsSource = _artifactStudioRequests;
            ArtifactHistoryEmptyText.Visibility = _artifactStudioRequests.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;

            var requestedId = selectRequestId ?? _selectedArtifactStudioRequestId;
            var selected = _artifactStudioRequests.FirstOrDefault(item => item.Id == requestedId);
            if (selected is not null)
            {
                ShowArtifactStudioRequest(selected);
            }
            else
            {
                ArtifactReviewPanel.Visibility = Visibility.Collapsed;
                _selectedArtifactStudioRequestId = null;
            }
        }
        catch (Exception error)
        {
            ArtifactStudioStatusText.Text = $"Artifact Studio history could not be read: {error.Message}";
            ArtifactRequestHistoryList.ItemsSource = null;
            ArtifactHistoryEmptyText.Visibility = Visibility.Visible;
            ArtifactReviewPanel.Visibility = Visibility.Collapsed;
        }
    }

    private void ArtifactPrepareButton_Click(object sender, RoutedEventArgs e)
    {
        if (!TryGetActiveWorkbenchProjectSilently(out var project))
        {
            ArtifactStudioStatusText.Text = "Select a project before preparing an artifact request.";
            return;
        }
        if (ArtifactOutputCombo.SelectedItem is not ArtifactOutputOption output)
        {
            ArtifactStudioStatusText.Text = "Choose an output type or let Helmian choose automatically.";
            return;
        }

        try
        {
            var request = ArtifactStudioIntentPlanner.CreateRequest(
                project,
                ArtifactDescriptionBox.Text,
                output.Id);
            ArtifactStudioStatusText.Text =
                "Review prepared locally. Helmian created the title, route, destination and audit metadata behind the scenes. Nothing was sent or generated.";
            RefreshProjectWorkbench(forceCanvasReload: false);
            RefreshArtifactStudio(request.Id);
        }
        catch (Exception error)
        {
            ArtifactStudioStatusText.Text = $"Request was not prepared: {error.Message}";
        }
    }

    private void ArtifactHistoryItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string id }) return;
        var request = _artifactStudioRequests.FirstOrDefault(item => item.Id == id);
        if (request is not null) ShowArtifactStudioRequest(request);
    }

    private void ShowArtifactStudioRequest(ArtifactStudioRequest request)
    {
        _selectedArtifactStudioRequestId = request.Id;
        ArtifactReviewPanel.Visibility = Visibility.Visible;
        ArtifactReviewTitleText.Text = $"{request.KindLabel} · {request.Title}";
        ArtifactReviewRouteText.Text =
            $"Use {request.ProviderName} when connected · save automatically to this project's artifact history as {Path.GetFileName(request.Destination)}";
        ArtifactReviewScopeText.Text =
            "What leaves this computer: only the description shown below. No project files, notes, credentials or hidden context.";
        ArtifactReviewInstructionsText.Text = $"You asked: {request.Instructions}";
        ArtifactReviewStateText.Text = request.StatusDetail;
        ArtifactApproveButton.Content = "Approve plan";
        ArtifactApproveButton.ToolTip =
            "Record approval locally. This does not call the provider.";
        ArtifactApproveButton.IsEnabled = request.CanDecide;
        ArtifactDenyButton.IsEnabled = request.CanDecide;
        var approved = request.ApprovalState == ArtifactStudioStates.Approved;
        ArtifactGenerateButton.Visibility = approved ? Visibility.Visible : Visibility.Collapsed;
        ArtifactGenerateButton.IsEnabled = approved
            && !_artifactGenerationInProgress
            && request.DeliveryState is not (ArtifactStudioStates.Sending or ArtifactStudioStates.Delivered);
        ArtifactGenerateButton.Content = _artifactGenerationInProgress
            ? "Generating…"
            : "Generate approved artifact";
    }

    private void ArtifactApproveButton_Click(object sender, RoutedEventArgs e) =>
        DecideSelectedArtifactRequest(approve: true);

    private void ArtifactDenyButton_Click(object sender, RoutedEventArgs e) =>
        DecideSelectedArtifactRequest(approve: false);

    private async void DecideSelectedArtifactRequest(bool approve)
    {
        if (!TryGetActiveWorkbenchProjectSilently(out var project)
            || string.IsNullOrWhiteSpace(_selectedArtifactStudioRequestId))
        {
            ArtifactStudioStatusText.Text = "Select a current project request first.";
            return;
        }

        try
        {
            var selected = _artifactStudioRequests.FirstOrDefault(
                item => item.Id == _selectedArtifactStudioRequestId)
                ?? throw new InvalidOperationException("The selected request is no longer in this project history.");
            var provider = ArtifactStudioProviderCatalog.Require(selected.ProviderId);
            ArtifactStudioProviderReadiness readiness;
            string? connectionDetail = null;
            try
            {
                var status = await _serviceConnector.GetArtifactProviderStatusAsync();
                readiness = new ArtifactStudioProviderReadiness(
                    status.CredentialConfigured,
                    status.AdapterInstalled);
            }
            catch (Exception error) when (error is IOException
                                          or TimeoutException
                                          or UnauthorizedAccessException
                                          or LocalServiceResponseException
                                          or InvalidDataException)
            {
                readiness = new ArtifactStudioProviderReadiness(false, provider.AdapterInstalled);
                connectionDetail = error.Message;
            }
            var result = ArtifactStudioWorkflow.Decide(
                project,
                _selectedArtifactStudioRequestId,
                approve,
                readiness);
            ArtifactStudioStatusText.Text = connectionDetail is null
                ? result.StatusDetail
                : $"{result.StatusDetail} Local service connection unavailable: {connectionDetail}";
            RefreshProjectWorkbench(forceCanvasReload: false);
            RefreshArtifactStudio(result.Id);
        }
        catch (Exception error)
        {
            ArtifactStudioStatusText.Text = $"The decision was not recorded: {error.Message}";
        }
    }

    private void ArtifactHistoryRefreshButton_Click(object sender, RoutedEventArgs e) =>
        RefreshArtifactStudio();

    private async void UpdateArtifactProviderBoundary()
    {
        if (ArtifactProviderBoundaryText is null)
        {
            return;
        }

        ArtifactProviderBoundaryText.Text = "Checking…";
        if (ArtifactEnrollImagesButton is not null)
            ArtifactEnrollImagesButton.Visibility = Visibility.Collapsed;
        try
        {
            var status = await _serviceConnector.GetArtifactProviderStatusAsync();
            // Short status only — no enrollment essay on the face of Create.
            var ready = status.Capabilities?
                .Any(c => c.Kind == MediaProviderCapabilityKinds.ImageGeneration
                          && c.ProviderAvailable
                          && c.CredentialConfigured
                          && c.AdapterInstalled) == true;
            if (ready)
            {
                ArtifactProviderBoundaryText.Text = "OpenAI Images ready";
                ArtifactProviderBoundaryText.Foreground =
                    (System.Windows.Media.Brush)FindResource("AccentBrush");
            }
            else
            {
                ArtifactProviderBoundaryText.Text = "Images not set up";
                ArtifactProviderBoundaryText.Foreground =
                    (System.Windows.Media.Brush)FindResource("AmberBrush");
                if (ArtifactEnrollImagesButton is not null)
                    ArtifactEnrollImagesButton.Visibility = Visibility.Visible;
            }
        }
        catch (Exception error) when (error is IOException
                                      or TimeoutException
                                      or UnauthorizedAccessException
                                      or LocalServiceResponseException
                                      or InvalidDataException)
        {
            ArtifactProviderBoundaryText.Text = "Service offline";
            ArtifactProviderBoundaryText.Foreground =
                (System.Windows.Media.Brush)FindResource("AmberBrush");
            if (ArtifactEnrollImagesButton is not null)
                ArtifactEnrollImagesButton.Visibility = Visibility.Visible;
        }
    }

    private void ArtifactEnrollImagesButton_Click(object sender, RoutedEventArgs e)
    {
        NavigateTo("Integrations");
        IntegrationsOpenAiImagesKeyBox?.Focus();
        if (ArtifactStudioStatusText is not null)
        {
            ArtifactStudioStatusText.Text = "Paste OpenAI key on Integrations → Save key → return here → Review → Generate.";
        }
    }

    private async void IntegrationsEnrollImagesButton_Click(object sender, RoutedEventArgs e)
    {
        if (IntegrationsOpenAiImagesKeyBox is null || IntegrationsEnrollImagesButton is null)
        {
            return;
        }

        var key = IntegrationsOpenAiImagesKeyBox.Password.Trim();
        if (string.IsNullOrEmpty(key))
        {
            SetIntegrationsImagesEnrollStatus("Paste an OpenAI API key first.", amber: true);
            IntegrationsOpenAiImagesKeyBox.Focus();
            return;
        }

        if (!key.StartsWith("sk-", StringComparison.Ordinal))
        {
            SetIntegrationsImagesEnrollStatus("Key usually starts with sk- — check the paste.", amber: true);
        }

        IntegrationsEnrollImagesButton.IsEnabled = false;
        SetIntegrationsImagesEnrollStatus("Saving…", amber: false);
        try
        {
            await EnrollOpenAiImagesCredentialAsync(key).ConfigureAwait(true);
            IntegrationsOpenAiImagesKeyBox.Clear();
            SetIntegrationsImagesEnrollStatus("Key saved for this Windows user. Open Create → Review → Generate.", amber: false);
            UpdateMediaProviderCapabilities();
            UpdateArtifactProviderBoundary();
        }
        catch (Exception error) when (error is IOException
                                      or InvalidOperationException
                                      or InvalidDataException
                                      or UnauthorizedAccessException
                                      or TimeoutException
                                      or System.ComponentModel.Win32Exception)
        {
            SetIntegrationsImagesEnrollStatus($"Could not save key: {error.Message}", amber: true);
        }
        finally
        {
            IntegrationsEnrollImagesButton.IsEnabled = true;
        }
    }

    private void SetIntegrationsImagesEnrollStatus(string text, bool amber)
    {
        if (IntegrationsImagesEnrollStatusText is null)
        {
            return;
        }

        IntegrationsImagesEnrollStatusText.Text = text;
        IntegrationsImagesEnrollStatusText.Foreground = amber
            ? (System.Windows.Media.Brush)FindResource("AmberBrush")
            : (System.Windows.Media.Brush)FindResource("MutedTextBrush");
    }

    private async Task EnrollOpenAiImagesCredentialAsync(string apiKey)
    {
        var servicePath = _serviceConnector.ServiceExecutable;
        if (string.IsNullOrWhiteSpace(servicePath) || !File.Exists(servicePath))
        {
            throw new InvalidOperationException("Helmion Local Service not found. Start Helmian from a pilot pack.");
        }

        var start = new System.Diagnostics.ProcessStartInfo
        {
            FileName = servicePath,
            Arguments = "--enroll-openai-images-from-stdin",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };

        using var process = System.Diagnostics.Process.Start(start)
            ?? throw new InvalidOperationException("Could not start Local Service enrollment.");
        try
        {
            await process.StandardInput.WriteAsync(apiKey).ConfigureAwait(true);
            await process.StandardInput.WriteAsync('\n').ConfigureAwait(true);
            process.StandardInput.Close();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await process.WaitForExitAsync(cts.Token).ConfigureAwait(true);
            if (process.ExitCode != 0)
            {
                var err = await process.StandardError.ReadToEndAsync().ConfigureAwait(true);
                throw new InvalidDataException(
                    string.IsNullOrWhiteSpace(err)
                        ? $"Enrollment rejected (exit {process.ExitCode})."
                        : err.Trim());
            }
        }
        finally
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // best-effort cleanup
            }
        }
    }

    private async void UpdateMediaProviderCapabilities()
    {
        if (ImageProviderStatusText is null || VideoProviderStatusText is null)
        {
            return;
        }

        ImageProviderStatusText.Text = "…";
        ImageProviderDetailText.Text = "";
        try
        {
            var status = await _serviceConnector.GetArtifactProviderStatusAsync();
            var capabilities = status.Capabilities
                ?? throw new InvalidDataException("Local service omitted media provider capability status.");
            var image = capabilities.FirstOrDefault(item =>
                item.Kind == MediaProviderCapabilityKinds.ImageGeneration)
                ?? throw new InvalidDataException("Local service omitted image provider capability status.");
            var video = capabilities.FirstOrDefault(item =>
                item.Kind == MediaProviderCapabilityKinds.VideoGeneration)
                ?? throw new InvalidDataException("Local service omitted video provider capability status.");

            ImageProviderStatusText.Text = AvailabilityLabel(image.Availability);
            ImageProviderIdentityText.Text = image.ProviderName ?? "OpenAI Images";
            ImageProviderDetailText.Text = image.CredentialConfigured
                ? (image.ProviderAvailable ? "Ready for Create" : "Key saved")
                : "Paste key below to enable images";
            if (ImageProviderGuardText is not null)
                ImageProviderGuardText.Text = "";

            VideoProviderStatusText.Text = AvailabilityLabel(video.Availability);
            VideoProviderIdentityText.Text = video.ProviderId is null ? "Not in this build" : (video.ProviderName ?? "Video");
            VideoProviderDetailText.Text = "";
            if (VideoProviderGuardText is not null)
                VideoProviderGuardText.Text = "";
        }
        catch (Exception error) when (error is IOException
                                      or TimeoutException
                                      or UnauthorizedAccessException
                                      or LocalServiceResponseException
                                      or InvalidDataException)
        {
            ImageProviderStatusText.Text = "Offline";
            ImageProviderDetailText.Text = "Local Service not running";
            VideoProviderStatusText.Text = "Off";
            VideoProviderIdentityText.Text = "Not in this build";
            VideoProviderDetailText.Text = "";
        }
    }

    private static string AvailabilityLabel(string availability) => availability switch
    {
        MediaProviderAvailability.Available => "Ready",
        MediaProviderAvailability.ConfiguredNotTested => "Key saved",
        MediaProviderAvailability.ConfigurationRequired => "Needs key",
        MediaProviderAvailability.ProviderNotSelected => "Off",
        _ => "Off"
    };

    private void OpenImageCreation_Click(object sender, RoutedEventArgs e) =>
        SelectWorkbenchSurfaceForPreview("create");

    private async void ArtifactGenerateButton_Click(object sender, RoutedEventArgs e)
    {
        if (_artifactGenerationInProgress
            || !TryGetActiveWorkbenchProjectSilently(out var project)
            || string.IsNullOrWhiteSpace(_selectedArtifactStudioRequestId))
        {
            return;
        }

        var selected = _artifactStudioRequests.FirstOrDefault(
            item => item.Id == _selectedArtifactStudioRequestId);
        if (selected is null || selected.ApprovalState != ArtifactStudioStates.Approved)
        {
            ArtifactStudioStatusText.Text = "Approve this exact request before generation.";
            return;
        }

        _artifactGenerationInProgress = true;
        ShowArtifactStudioRequest(selected);
        ArtifactStudioStatusText.Text = "Generating through the Helmion Local Service. The approved prompt is being sent to OpenAI Images.";
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(3));
            var result = await _serviceConnector.GenerateApprovedArtifactAsync(
                project,
                selected.Id,
                selected.EvidenceHash,
                timeout.Token);
            ArtifactStudioStatusText.Text = result.StatusDetail;
            RefreshProjectWorkbench(forceCanvasReload: false);
            RefreshArtifactPreview(project);
            RefreshArtifactStudio(result.RequestId);
        }
        catch (OperationCanceledException)
        {
            ArtifactStudioStatusText.Text =
                "The generation connection timed out or was canceled. No success is claimed; refresh request history before retrying.";
        }
        catch (Exception error) when (error is IOException
                                      or TimeoutException
                                      or UnauthorizedAccessException
                                      or LocalServiceResponseException
                                      or InvalidDataException)
        {
            ArtifactStudioStatusText.Text = $"Generation did not complete: {error.Message}";
            RefreshArtifactStudio(selected.Id);
        }
        finally
        {
            _artifactGenerationInProgress = false;
            var current = _artifactStudioRequests.FirstOrDefault(item => item.Id == selected.Id);
            if (current is not null) ShowArtifactStudioRequest(current);
        }
    }
}

using System.IO;
using System.Windows.Threading;
using Helmion.Desktop.Core;
using Helmion.LocalService.Protocol;

namespace Helmion.Desktop;

/// <summary>
/// Read-only adapter from the selected Helmian project/session into the sanitized
/// account-owned Remote Control contract. It starts no enrollment, presence loop,
/// provider call, legacy Herald process, named pipe, or voice-host operation.
/// </summary>
public partial class MainWindow
{
    private CancellationTokenSource? _remoteControlGatewayCancellation;
    private Task? _remoteControlGatewayTask;
    private DispatcherTimer? _remoteControlSessionTimer;
    private bool _remoteControlSyncBusy;
    /// <summary>
    /// Installation id used to mint RemoteControlProjectIdentity hashes.
    /// Must stay aligned with heartbeat project ids the phone receives.
    /// </summary>
    private string? _remoteControlInstallationId;

    internal void EnsureRemoteControlDesktopGatewayStarted()
    {
        if (_remoteControlGatewayTask is { IsCompleted: false }) return;
        _remoteControlGatewayCancellation?.Dispose();
        var cancellation = new CancellationTokenSource();
        _remoteControlGatewayCancellation = cancellation;
        var server = new HeraldDesktopPipeServer(
            HeraldDesktopPipeServer.PipeNameForCurrentUser(), HeraldGateway);
        _remoteControlGatewayTask = Task.Run(async () =>
        {
            try { await server.RunAsync(cancellation.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        });

        _remoteControlSessionTimer ??= new DispatcherTimer(
            TimeSpan.FromSeconds(10), DispatcherPriority.Background,
            async (_, _) => await SyncRemoteControlSessionAsync(), Dispatcher);
        _remoteControlSessionTimer.Start();
        _ = SyncRemoteControlSessionAsync();
    }

    internal void StopRemoteControlDesktopGateway()
    {
        _remoteControlSessionTimer?.Stop();
        _remoteControlGatewayCancellation?.Cancel();
    }

    private async Task SyncRemoteControlSessionAsync()
    {
        if (_remoteControlSyncBusy) return;
        _remoteControlSyncBusy = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var state = await LocalServiceHost.Connector.GetRemoteControlStatusAsync(timeout.Token);
            ApplyRemoteControlStatus(state);
            var installationId = state.Enrollment.InstallationId;
            if (!state.Enrollment.AccountOwned || string.IsNullOrWhiteSpace(installationId)) return;
            // Cache for Herald gateway identity — phone sees the opaque
            // project-{hash} id from heartbeats; CurrentHeraldSnapshot must
            // use the same id or every instruction is refused as a mismatch.
            _remoteControlInstallationId = installationId;
            var selected = CurrentRemoteControlSessionMetadata(installationId)
                ?? EnsureMobileControlSession(installationId);
            if (selected is null)
            {
                if (state.SelectedSessionId is not null)
                    await LocalServiceHost.Connector.ClearRemoteControlSessionAsync(timeout.Token);
            }
            else
            {
                await LocalServiceHost.Connector.PublishRemoteControlSessionAsync(selected, timeout.Token);
            }
        }
        catch (Exception error)
        {
            // The service scheduler owns and reports offline/backoff state. The
            // Desktop renderer never manufactures a live Remote Control claim.
            try
            {
                var log = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Helmion", "remote-control-desktop.log");
                Directory.CreateDirectory(Path.GetDirectoryName(log)!);
                File.AppendAllText(log, $"{DateTimeOffset.UtcNow:O} {error.GetType().Name}: {error.Message}{Environment.NewLine}");
            }
            catch { }
        }
        finally { _remoteControlSyncBusy = false; }
    }

    private async void RemoteControlEnrollButton_Click(object sender, System.Windows.RoutedEventArgs e)
    {
        RemoteControlEnrollButton.IsEnabled = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var result = await LocalServiceHost.Connector.RequestRemoteControlEnrollmentAsync(
                "My Helmian Desktop", timeout.Token);
            RemoteControlEnrollmentCodeText.Text = result.Challenge.UserCode;
            RemoteControlEnrollmentUriText.Text = result.Challenge.VerificationUri;
            RemoteControlEnrollmentPanel.Visibility = System.Windows.Visibility.Visible;
            RemoteControlRedeemButton.Visibility = System.Windows.Visibility.Visible;
            ApplyRemoteControlStatus(result.Status);
        }
        catch (Exception error)
        {
            IntegrationConnectionStatusText.Text = "Enrollment unavailable";
            RemoteControlDetailText.Text = error.Message;
        }
        finally { RemoteControlEnrollButton.IsEnabled = true; }
    }

    private async void RemoteControlRedeemButton_Click(object sender, System.Windows.RoutedEventArgs e)
    {
        RemoteControlRedeemButton.IsEnabled = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var state = await LocalServiceHost.Connector.RedeemRemoteControlEnrollmentAsync(timeout.Token);
            ApplyRemoteControlStatus(state);
            if (!state.Enrollment.AccountOwned)
            {
                RemoteControlDetailText.Text = state.Enrollment.Detail
                    + " Confirm the code in Helmian web, then try again.";
            }
        }
        catch (Exception error)
        {
            IntegrationConnectionStatusText.Text = "Not confirmed";
            RemoteControlDetailText.Text = error.Message;
        }
        finally { RemoteControlRedeemButton.IsEnabled = true; }
    }

    private void ApplyRemoteControlStatus(RemoteControlLocalStatus state)
    {
        IntegrationConnectionStatusText.Text = state.Enrollment.AccountOwned
            ? state.SchedulerState == "online" ? "Connected" : "Enrolled"
            : state.Enrollment.Stage == RemoteEnrollmentStage.AwaitingAccountConfirmation
                ? "Waiting for confirmation"
                : "Not enrolled";
        RemoteControlDetailText.Text = state.Detail;
        if (state.Enrollment.AccountOwned)
        {
            RemoteControlEnrollmentPanel.Visibility = System.Windows.Visibility.Collapsed;
            RemoteControlRedeemButton.Visibility = System.Windows.Visibility.Collapsed;
            RemoteControlEnrollButton.Visibility = System.Windows.Visibility.Collapsed;
        }
        else
        {
            RemoteControlEnrollButton.Visibility = System.Windows.Visibility.Visible;
        }
    }

    internal RemoteSelectedSessionMetadata? CurrentRemoteControlSessionMetadata(
        string installationId)
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.Invoke(
                () => CurrentRemoteControlSessionMetadata(installationId),
                DispatcherPriority.Send);
        }

        var session = _sessions.Selected;
        if (session is null)
        {
            return null;
        }

        // Remote Control must survive a clean desktop restart. A named local
        // session can be selected before the operator opens a customer project;
        // represent that safe shell state as the Helmion Desktop project rather
        // than leaving the paired phone permanently offline.
        var workspace = !string.IsNullOrWhiteSpace(_registeredWorkspacePath)
            && Directory.Exists(_registeredWorkspacePath)
            ? _registeredWorkspacePath
            : AppContext.BaseDirectory;
        var project = ProjectShelf.Describe(workspace);
        var projectName = project?.Name ?? "Helmion Desktop";

        return new RemoteSelectedSessionMetadata(
            RemoteControlProjectIdentity.FromProjectRoot(workspace, installationId),
            projectName,
            session.Id,
            session.Name,
            RemoteControlAgentIdentity.FromDisplayName(session.PillLabel),
            session.PillLabel,
            session.IsBusy
                ? RemoteSessionActivityState.Working
                : RemoteSessionActivityState.Ready,
            session.Level switch
            {
                GuardLevel.Normal => RemoteGuardState.Normal,
                GuardLevel.Warning => RemoteGuardState.Warning,
                GuardLevel.Critical => RemoteGuardState.Critical,
                _ => RemoteGuardState.Unknown
            },
            string.IsNullOrWhiteSpace(_pendingApprovalId) ? 0 : 1,
            session.CreatedAt.ToUniversalTime());
    }

    /// <summary>
    /// A service restart must not silently strand an already enrolled phone behind
    /// an empty session shelf. This lightweight named session costs nothing until a
    /// real instruction is sent, and the operator can replace it by selecting any
    /// normal named session in the Console.
    /// </summary>
    private RemoteSelectedSessionMetadata? EnsureMobileControlSession(string installationId)
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.Invoke(
                () => EnsureMobileControlSession(installationId), DispatcherPriority.Send);
        }

        if (_sessions.Selected is null)
        {
            var session = _sessions.Create("Gemini", "Mobile control", DateTimeOffset.Now);
            ReportSessionPreflight(session);
            ShowSessionTranscript(session);
            RefreshSessionShelfChrome();
        }

        return CurrentRemoteControlSessionMetadata(installationId);
    }
}

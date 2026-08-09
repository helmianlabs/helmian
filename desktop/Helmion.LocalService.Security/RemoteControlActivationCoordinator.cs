using System.Security.Cryptography;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

public interface IRemoteDesktopRequestDispatcher
{
    Task<RemoteControlResultEnvelope> DispatchAsync(
        RemoteControlRequestEnvelope request,
        CancellationToken cancellationToken);
}

/// <summary>
/// Sole owner of account enrollment credentials, heartbeat scheduling and the
/// scoped Desktop realtime client. The WPF process supplies only sanitized
/// selected-session state and receives fixed gateway commands over local IPC.
/// </summary>
public sealed class RemoteControlActivationCoordinator : IRemoteControlLocalCommands
{
    private readonly IRemoteDesktopEnrollmentClient _enrollment;
    private readonly IRemoteDesktopCredentialStore _store;
    private readonly IRemoteControlPresenceApi _presence;
    private readonly IRemoteControlRealtimeTokenApi _tokens;
    private readonly IRemoteControlRealtimeClient _realtime;
    private readonly IRemoteDesktopRequestDispatcher _dispatcher;
    private readonly Func<DateTimeOffset> _clock;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CancellationTokenSource? _realtimeCancellation;
    private Task? _realtimeTask;
    private RemoteSelectedSessionMetadata? _selected;
    private string _schedulerState = "starting";
    private string _realtimeState = "stopped";
    private string _detail = "Remote Control has not completed its first local status check.";
    private string? _realtimeChannelFingerprint;
    private int _failures;
    private DateTimeOffset? _nextAttempt;
    private bool _initialized;

    public RemoteControlActivationCoordinator(
        IRemoteDesktopEnrollmentClient enrollment,
        IRemoteDesktopCredentialStore store,
        IRemoteControlPresenceApi presence,
        IRemoteControlRealtimeTokenApi tokens,
        IRemoteControlRealtimeClient realtime,
        IRemoteDesktopRequestDispatcher dispatcher,
        Func<DateTimeOffset>? clock = null)
    {
        _enrollment = enrollment;
        _store = store;
        _presence = presence;
        _tokens = tokens;
        _realtime = realtime;
        _dispatcher = dispatcher;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var delay = await RunCycleAsync(cancellationToken).ConfigureAwait(false);
            try { await Task.Delay(delay, cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }
        await StopRealtimeAsync().ConfigureAwait(false);
    }

    public async Task<TimeSpan> RunCycleAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            if (!_enrollment.Current.AccountOwned)
            {
                await StopRealtimeAsync().ConfigureAwait(false);
                _schedulerState = "unenrolled";
                _detail = _enrollment.Current.Detail;
                _failures = 0;
                _nextAttempt = null;
                return TimeSpan.FromSeconds(30);
            }

            try
            {
                if (_selected is null)
                {
                    await _enrollment.ObserveRegistrationAsync(_presence, cancellationToken)
                        .ConfigureAwait(false);
                    await StopRealtimeAsync().ConfigureAwait(false);
                    _schedulerState = "online-no-session";
                    _detail = "Desktop registration is valid; no local session is selected.";
                }
                else
                {
                    await HeartbeatAsync(_selected, cancellationToken).ConfigureAwait(false);
                    _schedulerState = "online";
                    _detail = "Selected session heartbeat was accepted by the account control plane.";
                }
                _failures = 0;
                // Keep the phone-selected reply channel fresh. A phone can select
                // a new live session / mint a new control grant while Desktop is
                // already connected; a long-lived token for the old grant cannot
                // acknowledge it. One second is enough to pick up new grants
                // without hammering the control plane.
                var delaySeconds = string.Equals(_realtimeState, "waiting-for-selection", StringComparison.Ordinal)
                    ? 1
                    : 2;
                _nextAttempt = _clock().AddSeconds(delaySeconds);
                return TimeSpan.FromSeconds(delaySeconds);
            }
            catch (RemoteControlApiException error) when (error.RegistrationIsDenied)
            {
                await StopRealtimeAsync().ConfigureAwait(false);
                await _enrollment.ObserveRegistrationAsync(_presence, cancellationToken)
                    .ConfigureAwait(false);
                _schedulerState = "revoked";
                _detail = "The server revoked or expired this Desktop registration. Remote Control is disabled.";
                _failures = 0;
                _nextAttempt = null;
                return TimeSpan.FromSeconds(30);
            }
            catch (Exception error) when (error is RemoteControlApiException
                or HttpRequestException or IOException or TaskCanceledException)
            {
                await StopRealtimeAsync().ConfigureAwait(false);
                _failures = Math.Min(_failures + 1, 16);
                var seconds = Math.Min(30, 1 << Math.Min(_failures - 1, 5));
                _schedulerState = "backoff";
                _realtimeState = "offline";
                var diagnostic = error.Message
                    .Replace("\r", " ", StringComparison.Ordinal)
                    .Replace("\n", " ", StringComparison.Ordinal);
                if (diagnostic.Length > 180) diagnostic = diagnostic[..180];
                _detail = $"Remote Control transport is offline: {diagnostic}";
                _nextAttempt = _clock().AddSeconds(seconds);
                return TimeSpan.FromSeconds(seconds);
            }
            catch (Exception error) when (error is CryptographicException
                or InvalidDataException or InvalidOperationException or UnauthorizedAccessException)
            {
                await StopRealtimeAsync().ConfigureAwait(false);
                _failures = Math.Min(_failures + 1, 16);
                _schedulerState = "failed-closed";
                _realtimeState = "stopped";
                _detail = "Remote Control local state could not be verified safely. Remote use is disabled.";
                _nextAttempt = _clock().AddSeconds(30);
                return TimeSpan.FromSeconds(30);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RemoteControlLocalStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            ObserveRealtimeTask();
            return Status();
        }
        finally { _gate.Release(); }
    }

    public async Task<(RemoteControlLocalStatus Status, RemoteEnrollmentChallenge Challenge)> RequestEnrollmentAsync(
        string installationId, string desktopDisplayName, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            await StopRealtimeAsync().ConfigureAwait(false);
            var result = await _enrollment.RequestEnrollmentAsync(
                installationId, desktopDisplayName, cancellationToken).ConfigureAwait(false);
            _schedulerState = "awaiting-confirmation";
            _detail = result.State.Detail;
            return (Status(), result.Challenge);
        }
        finally { _gate.Release(); }
    }

    public async Task<RemoteControlLocalStatus> RedeemEnrollmentAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            await _enrollment.RedeemEnrollmentAsync(cancellationToken).ConfigureAwait(false);
            _schedulerState = _enrollment.Current.AccountOwned ? "enrolled" : "awaiting-confirmation";
            _detail = _enrollment.Current.Detail;
            _nextAttempt = _clock();
            return Status();
        }
        finally { _gate.Release(); }
    }

    public async Task<RemoteControlLocalStatus> PublishSessionAsync(
        RemoteSelectedSessionMetadata session, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            ValidateSession(session);
            if (_selected is not null && !string.Equals(_selected.SessionId, session.SessionId, StringComparison.Ordinal))
            {
                await StopSessionCoreAsync(_selected.SessionId, cancellationToken).ConfigureAwait(false);
            }
            _selected = session;
            _nextAttempt = _clock();
            _detail = _enrollment.Current.AccountOwned
                ? "Local selected-session state is ready for the next heartbeat."
                : "Local selected-session state is held, but this Desktop is not enrolled.";
            return Status();
        }
        finally { _gate.Release(); }
    }

    public async Task<RemoteControlLocalStatus> ClearSessionAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            if (_selected is not null && _enrollment.Current.AccountOwned)
            {
                await StopSessionCoreAsync(_selected.SessionId, cancellationToken).ConfigureAwait(false);
            }
            _selected = null;
            await StopRealtimeAsync().ConfigureAwait(false);
            _schedulerState = _enrollment.Current.AccountOwned ? "online-no-session" : "unenrolled";
            _detail = "No local Desktop session is published for remote selection.";
            return Status();
        }
        finally { _gate.Release(); }
    }

    private async Task HeartbeatAsync(RemoteSelectedSessionMetadata selected, CancellationToken cancellationToken)
    {
        var authentication = await _store.LoadAuthenticationForServiceAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var response = await _presence.PublishHeartbeatAsync(
                authentication, HeartbeatRequest(authentication.DesktopId, selected), cancellationToken)
                .ConfigureAwait(false);
            // Ask the control plane for the current scoped channels on every
            // heartbeat. Reconnect only when that scope actually changed.
            RemoteDesktopRealtimeGrant grant;
            try
            {
                grant = await _tokens.RequestDesktopTokenAsync(
                    authentication,
                    new RemoteDesktopTokenRequest(authentication.DesktopId, response.Session.SessionId),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (RemoteControlApiException error)
                when (string.Equals(error.ErrorCode, "realtime_not_selected", StringComparison.Ordinal))
            {
                // Phone has not selected this Desktop yet — poll quickly so the
                // first selection does not wait a long idle gap.
                _realtimeState = "waiting-for-selection";
                _detail = "Desktop is online. Waiting for Herald (phone/web) to select this session.";
                return;
            }

            var fingerprint = string.Join("|", grant.Channels.Results)
                + "|" + grant.Channels.Requests;
            var requiresReconnect = _realtimeTask is null
                || _realtimeTask.IsCompleted
                || !string.Equals(_realtimeChannelFingerprint, fingerprint, StringComparison.Ordinal);
            if (requiresReconnect)
            {
                var realtimeFailed = _realtimeTask?.IsFaulted == true;
                ObserveRealtimeTask();
                if (realtimeFailed)
                {
                    var reason = _realtimeTask?.Exception?.GetBaseException().Message;
                    throw new IOException(string.IsNullOrWhiteSpace(reason)
                        ? "The scoped realtime connection ended unexpectedly."
                        : $"The scoped realtime connection ended unexpectedly: {reason}");
                }
                await StopRealtimeAsync().ConfigureAwait(false);
                _realtimeCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var refreshAfter = grant.ExpiresAt - _clock() - TimeSpan.FromSeconds(2);
                _realtimeCancellation.CancelAfter(refreshAfter > TimeSpan.Zero
                    ? refreshAfter
                    : TimeSpan.FromSeconds(1));
                _realtimeState = "connecting";
                _realtimeTask = _realtime.RunAsync(
                    grant, _dispatcher.DispatchAsync, _realtimeCancellation.Token);
                _realtimeChannelFingerprint = fingerprint;
                _realtimeState = "active";
                _detail = $"Remote Control realtime active with {grant.Channels.Results.Count} control grant channel(s).";
            }
        }
        finally { CryptographicOperations.ZeroMemory(authentication.BearerCredential); }
    }

    private async Task StopSessionCoreAsync(string sessionId, CancellationToken cancellationToken)
    {
        await StopRealtimeAsync().ConfigureAwait(false);
        if (!_enrollment.Current.AccountOwned) return;
        var authentication = await _store.LoadAuthenticationForServiceAsync(cancellationToken)
            .ConfigureAwait(false);
        try
        {
            await _presence.StopSelectedSessionAsync(authentication,
                new RemoteRegisteredDesktopStopSessionRequest(
                    RemoteControlApiRoutes.StopSessionAction, authentication.DesktopId, sessionId),
                cancellationToken).ConfigureAwait(false);
        }
        finally { CryptographicOperations.ZeroMemory(authentication.BearerCredential); }
    }

    private static RemoteRegisteredDesktopHeartbeatRequest HeartbeatRequest(
        string desktopId, RemoteSelectedSessionMetadata value) => new(
        RemoteControlApiRoutes.HeartbeatAction,
        desktopId,
        new RemoteHeartbeatSession(
            value.SessionId,
            new RemoteHeartbeatProject(value.ProjectId, value.ProjectDisplayName),
            value.SessionDisplayName,
            value.ActivityState == RemoteSessionActivityState.Working ? "working" : "ready",
            new RemoteHeartbeatAgent(value.AgentId, value.AgentDisplayName,
                value.ActivityState == RemoteSessionActivityState.Working ? "working" : "idle"),
            new RemoteHeartbeatGuard(value.GuardState switch
            {
                RemoteGuardState.Normal => "quiet",
                RemoteGuardState.Warning => "attention",
                RemoteGuardState.Critical => "blocked",
                _ => "unknown"
            }, null)));

    private static void ValidateSession(RemoteSelectedSessionMetadata value)
    {
        RemoteControlContractValidation.RequireIdentifier(value.ProjectId, nameof(value.ProjectId));
        RemoteControlContractValidation.RequireIdentifier(value.SessionId, nameof(value.SessionId));
        RemoteControlContractValidation.RequireIdentifier(value.AgentId, nameof(value.AgentId));
        RemoteControlContractValidation.NormalizeDisplayName(value.ProjectDisplayName, nameof(value.ProjectDisplayName));
        RemoteControlContractValidation.NormalizeDisplayName(value.SessionDisplayName, nameof(value.SessionDisplayName));
        RemoteControlContractValidation.NormalizeDisplayName(value.AgentDisplayName, nameof(value.AgentDisplayName));
        if (value.PendingApprovalCount is < 0 or > 1_000) throw new ArgumentOutOfRangeException(nameof(value));
    }

    private async Task InitializeCoreAsync(CancellationToken cancellationToken)
    {
        if (_initialized) return;
        await _enrollment.InitializeAsync(cancellationToken).ConfigureAwait(false);
        _initialized = true;
        _schedulerState = _enrollment.Current.AccountOwned ? "ready" : "unenrolled";
        _detail = _enrollment.Current.Detail;
    }

    private void ObserveRealtimeTask()
    {
        if (_realtimeTask is null) return;
        _realtimeState = _realtime.State;
        if (!_realtimeTask.IsCompleted) return;
        _realtimeState = _realtimeTask.IsFaulted ? "offline" : _realtime.State;
        _realtimeCancellation?.Dispose();
        _realtimeCancellation = null;
        _realtimeTask = null;
    }

    private async Task StopRealtimeAsync()
    {
        if (_realtimeCancellation is null && _realtimeTask is null)
        {
            _realtimeState = "stopped";
            return;
        }
        _realtimeCancellation?.Cancel();
        try { if (_realtimeTask is not null) await _realtimeTask.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
        catch { }
        _realtimeCancellation?.Dispose();
        _realtimeCancellation = null;
        _realtimeTask = null;
        _realtimeChannelFingerprint = null;
        _realtimeState = "stopped";
    }

    private RemoteControlLocalStatus Status()
    {
        if (_realtimeTask is { IsCompleted: false }) _realtimeState = _realtime.State;
        return new RemoteControlLocalStatus(
            _enrollment.Current, _schedulerState, _realtimeState, _detail,
            _clock().ToUniversalTime(), _failures, _nextAttempt, _selected?.SessionId);
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            await StopRealtimeAsync().ConfigureAwait(false);
            await _realtime.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
            _gate.Dispose();
        }
    }
}

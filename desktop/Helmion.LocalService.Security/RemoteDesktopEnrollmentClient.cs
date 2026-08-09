using System.Security.Cryptography;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

/// <summary>
/// Fail-closed device-code style enrollment orchestration. The desktop remains
/// unowned during request, account confirmation and redemption. Ownership is
/// exposed only after the control plane returns a bound credential and DPAPI
/// storage succeeds. No HTTP implementation lives here; tests and the future
/// local-service adapter supply the transport interface.
/// </summary>
public sealed class RemoteDesktopEnrollmentClient : IRemoteDesktopEnrollmentClient, IAsyncDisposable
{
    private readonly IRemoteControlEnrollmentApi _api;
    private readonly IRemoteDesktopCredentialStore _store;
    private readonly Func<DateTimeOffset> _clock;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private PendingEnrollment? _pending;
    private bool _initialized;

    public RemoteDesktopEnrollmentClient(
        IRemoteControlEnrollmentApi api,
        IRemoteDesktopCredentialStore store,
        Func<DateTimeOffset>? clock = null)
    {
        _api = api ?? throw new ArgumentNullException(nameof(api));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        Current = RemoteDesktopEnrollmentDescriptor.Unenrolled(_clock());
    }

    public RemoteDesktopEnrollmentDescriptor Current { get; private set; }

    public async Task<RemoteDesktopEnrollmentDescriptor> InitializeAsync(
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RemoteEnrollmentStartResult> RequestEnrollmentAsync(
        string installationId,
        string desktopDisplayName,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            if (Current.AccountOwned
                || Current.Stage is RemoteEnrollmentStage.Revoking
                    or RemoteEnrollmentStage.Failed)
            {
                throw new InvalidOperationException(
                    "Revoke the current account-owned desktop enrollment before requesting another.");
            }

            ClearPending();
            var normalizedInstallation = RemoteControlContractValidation.RequireIdentifier(
                installationId, nameof(installationId));
            var normalizedName = RemoteControlContractValidation.NormalizeDisplayName(
                desktopDisplayName, nameof(desktopDisplayName));
            Current = new RemoteDesktopEnrollmentDescriptor(
                RemoteEnrollmentStage.Requesting,
                normalizedInstallation,
                null,
                null,
                null,
                "Requesting a one-time account confirmation. This desktop is not owned yet.",
                _clock().ToUniversalTime());

            RemoteEnrollmentRequestResponse? response = null;
            try
            {
                response = await _api.RequestEnrollmentAsync(
                    new RemoteEnrollmentRequest(
                        normalizedInstallation,
                        normalizedName,
                        RemoteControlApiRoutes.ContractVersion),
                    cancellationToken).ConfigureAwait(false);
                var requestId = RemoteControlContractValidation.RequireIdentifier(
                    response.EnrollmentRequestId, nameof(response.EnrollmentRequestId));
                var userCode = RequireUserCode(response.UserCode);
                var verificationUri = RemoteControlContractValidation.RequireHttpsUri(
                    response.VerificationUri, nameof(response.VerificationUri));
                var expiry = RemoteControlContractValidation.RequireFutureExpiry(
                    response.ExpiresAtUtc, _clock(), nameof(response.ExpiresAtUtc));
                var nonce = RemoteControlContractValidation.RequireSecret(
                    response.RedemptionNonce, nameof(response.RedemptionNonce));

                _pending = new PendingEnrollment(
                    requestId,
                    normalizedInstallation,
                    nonce,
                    expiry);
                Current = new RemoteDesktopEnrollmentDescriptor(
                    RemoteEnrollmentStage.AwaitingAccountConfirmation,
                    normalizedInstallation,
                    requestId,
                    null,
                    expiry,
                    "Waiting for the signed-in web account to confirm this one-time enrollment.",
                    _clock().ToUniversalTime());
                return new RemoteEnrollmentStartResult(
                    Current,
                    new RemoteEnrollmentChallenge(requestId, userCode, verificationUri, expiry));
            }
            catch
            {
                if (_pending is null && response?.RedemptionNonce is { Length: > 0 })
                {
                    CryptographicOperations.ZeroMemory(response.RedemptionNonce);
                }
                ClearPending();
                Current = Failed(
                    normalizedInstallation,
                    "Enrollment request failed. This desktop remains unowned.");
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> RedeemEnrollmentAsync(
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            var pending = _pending
                ?? throw new InvalidOperationException("No one-time enrollment is waiting for redemption.");
            if (pending.ExpiresAtUtc <= _clock().ToUniversalTime())
            {
                Current = Current with
                {
                    Stage = RemoteEnrollmentStage.Expired,
                    Detail = "The one-time enrollment expired. This desktop remains unowned.",
                    UpdatedAtUtc = _clock().ToUniversalTime()
                };
                ClearPending();
                return Current;
            }

            Current = Current with
            {
                Stage = RemoteEnrollmentStage.Redeeming,
                Detail = "Checking for account-confirmed redemption. This desktop is not owned yet.",
                UpdatedAtUtc = _clock().ToUniversalTime()
            };
            var requestNonce = pending.RedemptionNonce.ToArray();
            RemoteEnrollmentRedemptionResponse response;
            try
            {
                response = await _api.RedeemEnrollmentAsync(
                    new RemoteEnrollmentRedemptionRequest(
                        pending.EnrollmentRequestId,
                        pending.InstallationId,
                        requestNonce,
                        RemoteControlApiRoutes.ContractVersion),
                    cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Current = Failed(
                    pending.InstallationId,
                    "Enrollment redemption failed. This desktop remains unowned.",
                    pending.EnrollmentRequestId);
                throw;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(requestNonce);
            }

            if (response.Status == RemoteEnrollmentRedemptionStatus.PendingAccountConfirmation)
            {
                if (response.Grant is not null)
                {
                    ZeroGrant(response.Grant);
                    throw FailInvalidRedemption(pending, "Pending redemption included a credential grant.");
                }
                Current = Current with
                {
                    Stage = RemoteEnrollmentStage.AwaitingAccountConfirmation,
                    Detail = "The signed-in web account has not confirmed this enrollment yet.",
                    UpdatedAtUtc = _clock().ToUniversalTime()
                };
                return Current;
            }

            if (response.Status is RemoteEnrollmentRedemptionStatus.Denied
                or RemoteEnrollmentRedemptionStatus.Expired)
            {
                if (response.Grant is not null)
                {
                    ZeroGrant(response.Grant);
                    throw FailInvalidRedemption(pending, "Terminal redemption included a credential grant.");
                }
                Current = Current with
                {
                    Stage = response.Status == RemoteEnrollmentRedemptionStatus.Denied
                        ? RemoteEnrollmentStage.Denied
                        : RemoteEnrollmentStage.Expired,
                    Detail = response.Status == RemoteEnrollmentRedemptionStatus.Denied
                        ? "The signed-in account denied enrollment. This desktop remains unowned."
                        : "The one-time enrollment expired. This desktop remains unowned.",
                    UpdatedAtUtc = _clock().ToUniversalTime()
                };
                ClearPending();
                return Current;
            }

            if (response.Status != RemoteEnrollmentRedemptionStatus.Redeemed)
            {
                if (response.Grant is not null) ZeroGrant(response.Grant);
                throw FailInvalidRedemption(pending, "Redemption returned an unknown status.");
            }

            var grant = response.Grant
                ?? throw FailInvalidRedemption(pending, "Redeemed response omitted its credential grant.");
            try
            {
                ValidateGrant(grant, pending);
                var stored = await _store.SaveRedeemedGrantAsync(grant, cancellationToken)
                    .ConfigureAwait(false);
                if (!stored.AccountOwned)
                {
                    throw new InvalidDataException(
                        "Protected storage did not return an enrolled account-owned descriptor.");
                }
                Current = stored;
                ClearPending();
                return Current;
            }
            catch
            {
                ClearPending();
                Current = Failed(
                    pending.InstallationId,
                    "Server redemption could not be stored safely. This process remains unowned.",
                    pending.EnrollmentRequestId);
                throw;
            }
            finally
            {
                ZeroGrant(grant);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> BeginRevocationAsync(
        string reason,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            if ((!Current.AccountOwned && Current.Stage != RemoteEnrollmentStage.Revoking)
                || Current.DesktopId is null)
            {
                throw new InvalidOperationException("No account-owned desktop enrollment can be revoked.");
            }
            RemoteControlContractValidation.RequireDetail(reason, nameof(reason));
            var desktopId = Current.DesktopId;
            Current = await _store.MarkRevocationPendingAsync(
                desktopId,
                _clock().ToUniversalTime(),
                cancellationToken).ConfigureAwait(false);
            return Current;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Observes server revocation even when no session is active. Only the
    /// canonical desktop_denied response removes local credential material;
    /// replay_denied, service failure and transport errors preserve enrollment.
    /// A revoked result tells the host to stop all presence/realtime work.
    /// </summary>
    public async Task<RemoteDesktopEnrollmentDescriptor> ObserveRegistrationAsync(
        IRemoteControlPresenceApi presenceApi,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(presenceApi);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            if (!Current.AccountOwned || Current.DesktopId is null)
            {
                throw new InvalidOperationException(
                    "Only an enrolled account-owned Desktop can observe registration status.");
            }
            var desktopId = Current.DesktopId;
            var authentication = await _store.LoadAuthenticationForServiceAsync(cancellationToken)
                .ConfigureAwait(false);
            try
            {
                await presenceApi.ObserveStatusAsync(authentication, cancellationToken)
                    .ConfigureAwait(false);
                return Current;
            }
            catch (RemoteControlApiException exception) when (exception.RegistrationIsDenied)
            {
                Current = await _store.MarkRevocationPendingAsync(
                    desktopId, _clock().ToUniversalTime(), cancellationToken).ConfigureAwait(false);
                Current = await _store.RemoveAfterServerRevocationAsync(
                    desktopId, _clock().ToUniversalTime(), cancellationToken).ConfigureAwait(false);
                return Current;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(authentication.BearerCredential);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RemoteDesktopEnrollmentDescriptor> ConfirmServerRevocationAsync(
        string desktopId,
        DateTimeOffset confirmedAtUtc,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await InitializeCoreAsync(cancellationToken).ConfigureAwait(false);
            var normalizedDesktopId = RemoteControlContractValidation.RequireIdentifier(
                desktopId, nameof(desktopId));
            if (Current.Stage != RemoteEnrollmentStage.Revoking
                || !string.Equals(Current.DesktopId, normalizedDesktopId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Only a matching pending revocation can accept control-plane confirmation.");
            }
            Current = await _store.RemoveAfterServerRevocationAsync(
                normalizedDesktopId,
                confirmedAtUtc,
                cancellationToken).ConfigureAwait(false);
            return Current;
        }
        finally
        {
            _gate.Release();
        }
    }

    public ValueTask DisposeAsync()
    {
        ClearPending();
        _gate.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<RemoteDesktopEnrollmentDescriptor> InitializeCoreAsync(
        CancellationToken cancellationToken)
    {
        if (_initialized) return Current;
        try
        {
            Current = await _store.ReadDescriptorAsync(cancellationToken).ConfigureAwait(false);
            _initialized = true;
            return Current;
        }
        catch
        {
            Current = Failed(null, "Protected enrollment state could not be verified. Remote use is disabled.");
            _initialized = true;
            throw;
        }
    }

    private static void ValidateGrant(
        RemoteDesktopCredentialGrant grant,
        PendingEnrollment pending)
    {
        if (!string.Equals(grant.InstallationId, pending.InstallationId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Redeemed credential belongs to another installation.");
        }
        RemoteControlContractValidation.RequireIdentifier(grant.DesktopId, nameof(grant.DesktopId));
        RemoteControlContractValidation.RequireSecret(
            grant.BearerCredential, nameof(grant.BearerCredential));
        RemoteControlContractValidation.RequireFutureExpiry(
            grant.ExpiresAtUtc, grant.IssuedAtUtc, nameof(grant.ExpiresAtUtc));
    }

    private InvalidDataException FailInvalidRedemption(PendingEnrollment pending, string detail)
    {
        ClearPending();
        Current = Failed(
            pending.InstallationId,
            "The redemption response was invalid. This desktop remains unowned.",
            pending.EnrollmentRequestId);
        return new InvalidDataException(detail);
    }

    private RemoteDesktopEnrollmentDescriptor Failed(
        string? installationId,
        string detail,
        string? requestId = null) => new(
            RemoteEnrollmentStage.Failed,
            installationId,
            requestId,
            null,
            null,
            detail,
            _clock().ToUniversalTime());

    private static string RequireUserCode(string? userCode)
    {
        var normalized = userCode?.Trim().ToUpperInvariant() ?? string.Empty;
        if (normalized.Length is < 4 or > 32
            || !normalized.All(character => char.IsAsciiLetterOrDigit(character) || character == '-'))
        {
            throw new InvalidDataException("Enrollment user code is invalid.");
        }
        return normalized;
    }

    private static void ZeroGrant(RemoteDesktopCredentialGrant grant)
    {
        if (grant.BearerCredential.Length > 0)
        {
            CryptographicOperations.ZeroMemory(grant.BearerCredential);
        }
    }

    private void ClearPending()
    {
        if (_pending is null) return;
        CryptographicOperations.ZeroMemory(_pending.RedemptionNonce);
        _pending = null;
    }

    private sealed record PendingEnrollment(
        string EnrollmentRequestId,
        string InstallationId,
        byte[] RedemptionNonce,
        DateTimeOffset ExpiresAtUtc);
}

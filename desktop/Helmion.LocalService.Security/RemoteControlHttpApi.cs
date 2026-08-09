using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Helmion.LocalService.Protocol;

namespace Helmion.LocalService.Security;

public enum RemoteControlApiFailure
{
    EnrollmentPending,
    EnrollmentDenied,
    DesktopDenied,
    ReplayDenied,
    ServiceUnavailable,
    Rejected,
    InvalidResponse
}

public sealed class RemoteControlApiException : Exception
{
    public RemoteControlApiException(
        RemoteControlApiFailure failure,
        HttpStatusCode? statusCode,
        string? errorCode,
        string message,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Failure = failure;
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }

    public RemoteControlApiFailure Failure { get; }
    public HttpStatusCode? StatusCode { get; }
    public string? ErrorCode { get; }
    public bool RegistrationIsDenied => Failure == RemoteControlApiFailure.DesktopDenied;
}

/// <summary>
/// HTTPS transport for the canonical account-owned Remote Control v1 contract.
/// Constructing this adapter starts no request; each method performs only its
/// named operation and registered-Desktop calls always use a fresh nonce.
/// </summary>
public sealed class RemoteControlHttpApi : IRemoteControlEnrollmentApi, IRemoteControlPresenceApi,
    IRemoteControlRealtimeTokenApi
{
    private const int MaxRequestBytes = 16 * 1024;
    private const int MaxResponseBytes = 64 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly HttpClient _http;
    private readonly Uri _origin;
    private readonly string _verificationUri;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Func<string> _nonceFactory;

    public RemoteControlHttpApi(
        HttpClient http,
        string origin,
        string verificationUri,
        Func<DateTimeOffset>? clock = null,
        Func<string>? nonceFactory = null)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _origin = RequireControlPlaneOrigin(origin);
        _verificationUri = RemoteControlContractValidation.RequireHttpsUri(
            verificationUri, nameof(verificationUri));
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _nonceFactory = nonceFactory ?? CreateNonce;
    }

    public async Task<RemoteEnrollmentRequestResponse> RequestEnrollmentAsync(
        RemoteEnrollmentRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!string.Equals(
            request.ContractVersion,
            RemoteControlApiRoutes.ContractVersion,
            StringComparison.Ordinal))
        {
            throw new ArgumentException("Remote Control contract version is unsupported.", nameof(request));
        }
        var displayName = RemoteControlContractValidation.NormalizeDisplayName(
            request.DesktopDisplayName, nameof(request.DesktopDisplayName));
        var enrollmentId = $"enroll_{Base64Url(RandomNumberGenerator.GetBytes(18))}";
        var proof = RandomNumberGenerator.GetBytes(32);
        var confirmationCode = RandomNumberGenerator.GetInt32(100_000_000).ToString("D8");
        try
        {
            var wire = new RemoteEnrollmentWireRequest(
                RemoteControlApiRoutes.RequestEnrollmentAction,
                enrollmentId,
                Base64Url(proof),
                confirmationCode,
                displayName);
            var result = await PostAsync<RemoteEnrollmentWireRequest, RemoteEnrollmentWirePendingResponse>(
                RemoteControlApiRoutes.Enrollment,
                wire,
                authentication: null,
                includeNonce: false,
                cancellationToken).ConfigureAwait(false);
            if (!result.Pending
                || !result.ConfirmationRequired
                || !string.Equals(result.EnrollmentId, enrollmentId, StringComparison.Ordinal))
            {
                throw InvalidResponse("Enrollment request was not accepted as pending confirmation.");
            }
            var expiry = RemoteControlContractValidation.RequireFutureExpiry(
                result.ExpiresAt, _clock(), nameof(result.ExpiresAt));
            return new RemoteEnrollmentRequestResponse(
                enrollmentId,
                confirmationCode,
                _verificationUri,
                proof,
                expiry);
        }
        catch
        {
            CryptographicOperations.ZeroMemory(proof);
            throw;
        }
    }

    public async Task<RemoteEnrollmentRedemptionResponse> RedeemEnrollmentAsync(
        RemoteEnrollmentRedemptionRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var enrollmentId = RequireEnrollmentId(request.EnrollmentRequestId);
        var proof = RemoteControlContractValidation.RequireSecret(
            request.RedemptionNonce, nameof(request.RedemptionNonce));
        try
        {
            var wire = new RemoteEnrollmentWireRedemptionRequest(
                RemoteControlApiRoutes.RedeemEnrollmentAction,
                enrollmentId,
                Base64Url(proof));
            var result = await PostAsync<RemoteEnrollmentWireRedemptionRequest, RemoteEnrollmentWireRedeemedResponse>(
                RemoteControlApiRoutes.Enrollment,
                wire,
                authentication: null,
                includeNonce: false,
                cancellationToken).ConfigureAwait(false);
            if (!result.Enrolled)
            {
                throw InvalidResponse("Enrollment redemption did not return an enrolled Desktop.");
            }
            var desktopId = RemoteControlContractValidation.RequireIdentifier(
                result.DesktopId, nameof(result.DesktopId));
            var token = DecodeBase64UrlSecret(result.RegistrationToken, nameof(result.RegistrationToken));
            var expiresAt = RemoteControlContractValidation.RequireFutureExpiry(
                result.CredentialExpiresAt, _clock(), nameof(result.CredentialExpiresAt));
            return new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.Redeemed,
                new RemoteDesktopCredentialGrant(
                    RemoteControlContractValidation.RequireIdentifier(
                        request.InstallationId, nameof(request.InstallationId)),
                    desktopId,
                    token,
                    _clock().ToUniversalTime(),
                    expiresAt),
                "The signed-in account confirmed this Desktop enrollment.");
        }
        catch (RemoteControlApiException exception)
            when (exception.Failure == RemoteControlApiFailure.EnrollmentPending)
        {
            return new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.PendingAccountConfirmation,
                null,
                "The signed-in account has not confirmed this enrollment yet.");
        }
        catch (RemoteControlApiException exception)
            when (exception.Failure == RemoteControlApiFailure.EnrollmentDenied)
        {
            return new RemoteEnrollmentRedemptionResponse(
                RemoteEnrollmentRedemptionStatus.Denied,
                null,
                "Enrollment was denied, expired, or already redeemed.");
        }
    }

    public async Task<RemoteRegisteredDesktopStatusResponse> ObserveStatusAsync(
        RemoteDesktopAuthentication authentication,
        CancellationToken cancellationToken)
    {
        ValidateAuthentication(authentication);
        var result = await PostAsync<RemoteRegisteredDesktopStatusRequest, RemoteRegisteredDesktopStatusResponse>(
            RemoteControlApiRoutes.RegisteredDesktop,
            new RemoteRegisteredDesktopStatusRequest(
                RemoteControlApiRoutes.StatusAction,
                authentication.DesktopId),
            authentication,
            includeNonce: true,
            cancellationToken).ConfigureAwait(false);
        ValidateRegisteredResponse(result.Registered, result.DesktopId, authentication.DesktopId);
        RemoteControlContractValidation.RequireFutureExpiry(
            result.CredentialExpiresAt, result.ServerTime, nameof(result.CredentialExpiresAt));
        return result;
    }

    public async Task<RemoteRegisteredDesktopHeartbeatResponse> PublishHeartbeatAsync(
        RemoteDesktopAuthentication authentication,
        RemoteRegisteredDesktopHeartbeatRequest request,
        CancellationToken cancellationToken)
    {
        ValidateAuthentication(authentication);
        ArgumentNullException.ThrowIfNull(request);
        ValidateDesktopRequest(authentication.DesktopId, request.DesktopId, request.Action,
            RemoteControlApiRoutes.HeartbeatAction);
        var result = await PostAsync<RemoteRegisteredDesktopHeartbeatRequest, RemoteRegisteredDesktopHeartbeatResponse>(
            RemoteControlApiRoutes.RegisteredDesktop,
            request,
            authentication,
            includeNonce: true,
            cancellationToken).ConfigureAwait(false);
        ValidateRegisteredResponse(result.Registered, result.DesktopId, authentication.DesktopId);
        if (!string.Equals(result.Session.SessionId, request.Session.SessionId, StringComparison.Ordinal))
        {
            throw InvalidResponse("Heartbeat response changed the selected session identity.");
        }
        return result;
    }

    public async Task<RemoteRegisteredDesktopStopSessionResponse> StopSelectedSessionAsync(
        RemoteDesktopAuthentication authentication,
        RemoteRegisteredDesktopStopSessionRequest request,
        CancellationToken cancellationToken)
    {
        ValidateAuthentication(authentication);
        ArgumentNullException.ThrowIfNull(request);
        ValidateDesktopRequest(authentication.DesktopId, request.DesktopId, request.Action,
            RemoteControlApiRoutes.StopSessionAction);
        var result = await PostAsync<RemoteRegisteredDesktopStopSessionRequest, RemoteRegisteredDesktopStopSessionResponse>(
            RemoteControlApiRoutes.RegisteredDesktop,
            request,
            authentication,
            includeNonce: true,
            cancellationToken).ConfigureAwait(false);
        if (!result.Stopped
            || !string.Equals(result.DesktopId, authentication.DesktopId, StringComparison.Ordinal)
            || !string.Equals(result.SessionId, request.SessionId, StringComparison.Ordinal))
        {
            throw InvalidResponse("Stop-session response did not confirm the selected session.");
        }
        return result;
    }

    public async Task<RemoteDesktopRealtimeGrant> RequestDesktopTokenAsync(
        RemoteDesktopAuthentication authentication,
        RemoteDesktopTokenRequest request,
        CancellationToken cancellationToken)
    {
        ValidateAuthentication(authentication);
        ArgumentNullException.ThrowIfNull(request);
        if (!string.Equals(authentication.DesktopId, request.DesktopId, StringComparison.Ordinal))
        {
            throw new ArgumentException("Realtime token request belongs to another Desktop.", nameof(request));
        }
        RemoteControlContractValidation.RequireIdentifier(request.SessionId, nameof(request.SessionId));
        var grant = await PostAsync<RemoteDesktopTokenRequest, RemoteDesktopRealtimeGrant>(
            RemoteControlApiRoutes.DesktopRealtimeToken,
            request,
            authentication,
            includeNonce: true,
            cancellationToken).ConfigureAwait(false);
        if (!grant.Realtime
            || !string.Equals(grant.Provider, "ably", StringComparison.Ordinal)
            || !string.Equals(grant.Role, "registered-desktop", StringComparison.Ordinal)
            || grant.ExpiresAt <= _clock().ToUniversalTime()
            || string.IsNullOrWhiteSpace(grant.Channels.Requests)
            || grant.Channels.Results.Count is < 1 or > 16
            || grant.TokenRequest.Ttl is < 30_000 or > 300_000
            || grant.TokenRequest.Timestamp <= 0
            || string.IsNullOrWhiteSpace(grant.TokenRequest.Mac))
        {
            throw InvalidResponse("Desktop realtime token scope is invalid.");
        }
        return grant;
    }

    private async Task<TResponse> PostAsync<TRequest, TResponse>(
        string route,
        TRequest body,
        RemoteDesktopAuthentication? authentication,
        bool includeNonce,
        CancellationToken cancellationToken)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(body, JsonOptions);
        if (json.Length > MaxRequestBytes)
        {
            CryptographicOperations.ZeroMemory(json);
            throw new ArgumentException("Remote Control request exceeds the 16 KiB contract limit.", nameof(body));
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(_origin, route))
            {
                Content = new ByteArrayContent(json)
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            if (authentication is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue(
                    "Bearer", Base64Url(authentication.BearerCredential));
            }
            if (includeNonce)
            {
                var nonce = RequireNonce(_nonceFactory());
                request.Headers.TryAddWithoutValidation(RemoteControlApiRoutes.NonceHeader, nonce);
            }

            using var response = await _http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            var payload = await ReadBoundedAsync(response, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw ToApiException(response.StatusCode, payload);
            }
            try
            {
                return JsonSerializer.Deserialize<TResponse>(payload, JsonOptions)
                    ?? throw InvalidResponse("Remote Control response body was empty.");
            }
            catch (JsonException exception)
            {
                throw InvalidResponse("Remote Control response JSON was invalid.", exception);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(payload);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(json);
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength is > MaxResponseBytes)
        {
            throw InvalidResponse("Remote Control response exceeded the size limit.");
        }
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);
        using var output = new MemoryStream();
        var buffer = new byte[8 * 1024];
        try
        {
            while (true)
            {
                var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                if (output.Length + read > MaxResponseBytes)
                {
                    throw InvalidResponse("Remote Control response exceeded the size limit.");
                }
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
        }
    }

    private static RemoteControlApiException ToApiException(
        HttpStatusCode statusCode,
        byte[] payload)
    {
        RemoteControlApiErrorResponse? error = null;
        try
        {
            error = JsonSerializer.Deserialize<RemoteControlApiErrorResponse>(payload, JsonOptions);
        }
        catch (JsonException)
        {
            // The status still fails closed even when an intermediary returns non-JSON.
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
        var code = error?.Error;
        var failure = (statusCode, code) switch
        {
            (HttpStatusCode.Conflict, "enrollment_pending") => RemoteControlApiFailure.EnrollmentPending,
            (HttpStatusCode.Unauthorized, "enrollment_denied") => RemoteControlApiFailure.EnrollmentDenied,
            (HttpStatusCode.Unauthorized, "desktop_denied") => RemoteControlApiFailure.DesktopDenied,
            (HttpStatusCode.Unauthorized, "replay_denied") => RemoteControlApiFailure.ReplayDenied,
            (HttpStatusCode.ServiceUnavailable, _) => RemoteControlApiFailure.ServiceUnavailable,
            _ => RemoteControlApiFailure.Rejected
        };
        return new RemoteControlApiException(
            failure,
            statusCode,
            code,
            error?.Message ?? $"Remote Control request failed with HTTP {(int)statusCode}.");
    }

    private static void ValidateAuthentication(RemoteDesktopAuthentication authentication)
    {
        ArgumentNullException.ThrowIfNull(authentication);
        RemoteControlContractValidation.RequireIdentifier(
            authentication.DesktopId, nameof(authentication.DesktopId));
        RemoteControlContractValidation.RequireSecret(
            authentication.BearerCredential, nameof(authentication.BearerCredential));
    }

    private static void ValidateDesktopRequest(
        string authenticatedDesktopId,
        string requestedDesktopId,
        string action,
        string requiredAction)
    {
        if (!string.Equals(authenticatedDesktopId, requestedDesktopId, StringComparison.Ordinal)
            || !string.Equals(action, requiredAction, StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Remote Control request action and Desktop identity must match authentication.");
        }
    }

    private static void ValidateRegisteredResponse(
        bool registered,
        string responseDesktopId,
        string expectedDesktopId)
    {
        if (!registered
            || !string.Equals(responseDesktopId, expectedDesktopId, StringComparison.Ordinal))
        {
            throw InvalidResponse("Registered-Desktop response did not match authentication.");
        }
    }

    private static string RequireEnrollmentId(string value)
    {
        if (!value.StartsWith("enroll_", StringComparison.Ordinal)
            || value.Length is < 27 or > 87
            || value[7..].Any(character => !IsBase64Url(character)))
        {
            throw new ArgumentException("Remote Control enrollment identity is invalid.", nameof(value));
        }
        return value;
    }

    private static byte[] DecodeBase64UrlSecret(string value, string parameterName)
    {
        if (value.Length is < 43 or > 128 || value.Any(character => !IsBase64Url(character)))
        {
            throw new ArgumentException("Remote Control registration token is invalid.", parameterName);
        }
        try
        {
            var padded = value.Replace('-', '+').Replace('_', '/');
            padded += new string('=', (4 - padded.Length % 4) % 4);
            var decoded = Convert.FromBase64String(padded);
            return RemoteControlContractValidation.RequireSecret(decoded, parameterName);
        }
        catch (FormatException exception)
        {
            throw new ArgumentException("Remote Control registration token is invalid.", parameterName, exception);
        }
    }

    private static string RequireNonce(string value)
    {
        if (value.Length is < 16 or > 160
            || value.Any(character => !(char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or ':' or '-')))
        {
            throw new InvalidOperationException("Remote Control nonce factory returned an invalid nonce.");
        }
        return value;
    }

    private static string CreateNonce() => Base64Url(RandomNumberGenerator.GetBytes(24));

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value)
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    private static bool IsBase64Url(char character) =>
        char.IsAsciiLetterOrDigit(character) || character is '-' or '_';

    private static Uri RequireControlPlaneOrigin(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || (uri.Scheme != Uri.UriSchemeHttps
                && !(uri.Scheme == Uri.UriSchemeHttp
                    && (uri.IsLoopback
                        || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)))))
        {
            throw new ArgumentException(
                "Remote Control origin must be HTTPS, except for an explicit loopback test origin.",
                nameof(value));
        }
        return new Uri(uri.GetLeftPart(UriPartial.Authority) + "/", UriKind.Absolute);
    }

    private static RemoteControlApiException InvalidResponse(
        string message,
        Exception? innerException = null) => new(
            RemoteControlApiFailure.InvalidResponse,
            null,
            null,
            message,
            innerException);
}

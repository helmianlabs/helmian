namespace Helmion.Desktop.Core;

/// <summary>How the next Grok request will authenticate. Drives the status text in Settings.</summary>
public enum GrokAuthMode
{
    /// <summary>Neither a SuperGrok session nor an API key is available.</summary>
    None,

    /// <summary>Signed in with a SuperGrok subscription (OAuth bearer token).</summary>
    SuperGrok,

    /// <summary>Falling back to the pasted xAI API key.</summary>
    ApiKey,
}

/// <summary>
/// The resolved credential for one Grok request: which mode won, the bearer value to send, and
/// the sentence to show the user. <see cref="Token"/> is a secret — it is never part of
/// <see cref="StatusLabel"/>.
/// </summary>
public sealed record GrokCredential(GrokAuthMode Mode, string? Token, string StatusLabel)
{
    public bool CanSend => Mode != GrokAuthMode.None && !string.IsNullOrWhiteSpace(Token);
}

/// <summary>
/// Decides, per request, whether Grok calls go out on the user's SuperGrok subscription or on
/// their API key, and keeps the SuperGrok token fresh.
///
/// <para>
/// Order is fixed: a valid SuperGrok token wins; an expired one is refreshed once; if the
/// refresh fails the session is cleared and the API key takes over. Falling back is never
/// silent — <see cref="LastAuthMessage"/> carries the reason, and the Settings panel shows it.
/// </para>
/// </summary>
public sealed class SuperGrokCredentialProvider : IDisposable
{
    private readonly SuperGrokTokenStore _store;
    private readonly SuperGrokOAuthClient _oauth;
    private readonly bool _ownsOAuth;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private SuperGrokTokens? _tokens;

    public SuperGrokCredentialProvider(
        SuperGrokTokenStore? store = null,
        SuperGrokOAuthClient? oauth = null)
    {
        _store = store ?? new SuperGrokTokenStore();
        _ownsOAuth = oauth is null;
        _oauth = oauth ?? new SuperGrokOAuthClient();
        _tokens = _store.Load();
    }

    /// <summary>True when a SuperGrok session is stored, whether or not it is currently fresh.</summary>
    public bool IsSignedIn => _tokens is not null;

    public string? SignedInEmail => _tokens?.Email;

    public DateTimeOffset? SessionExpiresAt => _tokens?.ExpiresAt;

    /// <summary>Where the stored session came from: Helmion's own login, or the Grok CLI.</summary>
    public string? SessionOrigin => _tokens?.Origin;

    /// <summary>
    /// Why the last resolve fell back or failed. Null when the last resolve was clean. This is
    /// what keeps an expired or revoked session from failing silently.
    /// </summary>
    public string? LastAuthMessage { get; private set; }

    /// <summary>Adopt a session — from the device flow, or from the Grok CLI — and persist it.</summary>
    public void Adopt(SuperGrokTokens tokens)
    {
        ArgumentNullException.ThrowIfNull(tokens);
        _tokens = tokens;
        LastAuthMessage = null;
        _store.Save(tokens);
    }

    public void SignOut()
    {
        _tokens = null;
        LastAuthMessage = null;
        _store.Clear();
    }

    /// <summary>
    /// Pick the credential for the next request. <paramref name="apiKey"/> is the fallback from
    /// the Settings API-key field.
    /// </summary>
    public async Task<GrokCredential> ResolveAsync(
        string? apiKey,
        CancellationToken cancellationToken = default)
    {
        var hasApiKey = !string.IsNullOrWhiteSpace(apiKey);

        if (_tokens is null)
        {
            return hasApiKey
                ? new GrokCredential(GrokAuthMode.ApiKey, apiKey, ApiKeyLabel)
                : new GrokCredential(
                    GrokAuthMode.None,
                    null,
                    "Not signed in — press \"Login with SuperGrok\", or paste an xAI API key.");
        }

        if (!_tokens.IsExpired(DateTimeOffset.UtcNow))
        {
            LastAuthMessage = null;
            return new GrokCredential(GrokAuthMode.SuperGrok, _tokens.AccessToken, SuperGrokLabel());
        }

        var refreshed = await TryRefreshAsync(cancellationToken);
        if (refreshed is not null)
        {
            return new GrokCredential(GrokAuthMode.SuperGrok, refreshed.AccessToken, SuperGrokLabel());
        }

        // Refresh failed and TryRefreshAsync already recorded why and cleared the session.
        return hasApiKey
            ? new GrokCredential(
                GrokAuthMode.ApiKey,
                apiKey,
                $"{ApiKeyLabel} — {LastAuthMessage}")
            : new GrokCredential(
                GrokAuthMode.None,
                null,
                $"{LastAuthMessage} There is no API key to fall back to.");
    }

    private async Task<SuperGrokTokens?> TryRefreshAsync(CancellationToken cancellationToken)
    {
        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            // A parallel request may have refreshed while this one waited.
            var current = _tokens;
            if (current is null) return null;
            if (!current.IsExpired(DateTimeOffset.UtcNow)) return current;

            if (current.RefreshToken is null)
            {
                SignOutWithReason(
                    "Your SuperGrok session expired and cannot be renewed automatically. "
                    + "Sign in again.");
                return null;
            }

            try
            {
                var refreshed = await _oauth.RefreshAsync(current.RefreshToken, cancellationToken);
                _tokens = refreshed;
                LastAuthMessage = null;
                _store.Save(refreshed);
                return refreshed;
            }
            catch (SuperGrokAuthException ex) when (ex.ErrorCode is "invalid_grant" or "access_denied")
            {
                // Terminal: revoked or rotated away. Keeping the dead token would just fail
                // every request from here on, so drop it and let the API key take over.
                SignOutWithReason(ex.Message);
                return null;
            }
            catch (SuperGrokAuthException ex)
            {
                // Transient (network, 5xx). Keep the session so it can retry when the network
                // comes back, but report the reason for this request's fallback.
                LastAuthMessage = ex.Message;
                return null;
            }
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private void SignOutWithReason(string reason)
    {
        _tokens = null;
        _store.Clear();
        LastAuthMessage = reason;
    }

    private const string ApiKeyLabel = "Using API key";

    private string SuperGrokLabel()
    {
        var who = string.IsNullOrWhiteSpace(_tokens?.Email) ? "" : $" ({_tokens!.Email})";
        var via = _tokens?.Origin == SuperGrokTokens.OriginGrokCli ? " · adopted from Grok CLI" : "";
        return $"Using SuperGrok subscription{who}{via}";
    }

    public void Dispose()
    {
        _refreshGate.Dispose();
        if (_ownsOAuth) _oauth.Dispose();
    }
}

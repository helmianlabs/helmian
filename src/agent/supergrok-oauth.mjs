/**
 * SuperGrok device-flow sign-in for the agent bridge (Node port of
 * desktop/Helmion.Desktop.Core/SuperGrokOAuth.cs — same endpoints, same
 * public client id, same scope, same plain-language error mapping).
 *
 * OAuth 2.0 Device Authorization Grant (RFC 8628) against xAI's auth server,
 * so a SuperGrok subscription can power the cloud Grok seat the same way it
 * powers the desktop seat: a program asks for a code, the user approves it in
 * their browser, and the token comes back to live in the runner vault. The
 * sign-in itself is only ever started by an operator running the login
 * script (bin path on the box: /opt/helmian-cloud-agents/grok-login.mjs) —
 * nothing in the turn path ever requests a device code.
 *
 * The client id is xAI's own first-party device client — the same one the
 * official Grok CLI uses. It is not a secret and there is nothing to
 * register: this is a public-client device flow, so there is no client
 * secret anywhere in this file by design.
 *
 * Tokens are secrets: this module never logs them, and its errors carry only
 * the OAuth error code and a plain-language explanation.
 */

export const SUPERGROK_ISSUER = 'https://auth.x.ai';
export const SUPERGROK_DEVICE_CODE_URL = `${SUPERGROK_ISSUER}/oauth2/device/code`;
export const SUPERGROK_TOKEN_URL = `${SUPERGROK_ISSUER}/oauth2/token`;
export const SUPERGROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const SUPERGROK_SCOPE = 'openid profile email offline_access api:access';
export const SUPERGROK_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** The client marker a subscription bearer token must travel with (see GrokChatSession.cs). */
export const SUPERGROK_TOKEN_AUTH_HEADER = 'X-XAI-Token-Auth';
export const SUPERGROK_TOKEN_AUTH_VALUE = 'xai-grok-cli';

/**
 * Raised when SuperGrok sign-in cannot continue. The message is written to be
 * shown to the user verbatim — no stack traces, no OAuth jargon without a
 * plain translation. `code` is the raw OAuth error code when the auth server
 * supplied one.
 */
export class SuperGrokAuthError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'SuperGrokAuthError';
    this.code = code;
  }
}

function describeAuthError(code, root, status) {
  switch (code) {
    // Not user-facing on their own: pollForToken catches these two first.
    case 'authorization_pending': return 'Waiting for approval.';
    case 'slow_down': return 'Polling too fast.';
    case 'access_denied':
      return 'The sign-in was declined in the browser. Nothing was changed — '
        + 'run the Grok sign-in again to try again.';
    case 'expired_token':
      return 'The sign-in code expired before it was approved. Run the Grok '
        + 'sign-in again to get a new one.';
    case 'invalid_grant':
      return 'This SuperGrok session is no longer valid — it was revoked, or '
        + 'it expired. Sign in again, or use an API key.';
    case 'invalid_client':
      return "xAI rejected Helmian's sign-in client. Use an API key until this is fixed.";
    default: {
      const detail = readString(root, 'error_description');
      return `xAI's sign-in service returned ${code ? `'${code}'` : `HTTP ${status}`}`
        + `${detail ? `: ${detail}` : ''}.`;
    }
  }
}

function readString(root, name) {
  const value = root?.[name];
  return typeof value === 'string' ? value : null;
}

function readPositiveInt(root, name) {
  const value = root?.[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Reads the unsigned, non-sensitive claims out of an access token so callers
 * can say WHO is signed in and WHEN the session lapses (port of
 * SuperGrokTokenReader). Deliberately not a validating JWT parse: Helmian is
 * not the audience and has no business asserting the signature. If the token
 * is opaque or malformed, every reader returns null.
 */
function readTokenPayload(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function readTokenEmail(accessToken) {
  const payload = readTokenPayload(accessToken);
  return typeof payload?.email === 'string' ? payload.email : null;
}

/** Expiry from the token's own `exp` claim as an ISO string, or null. */
export function readTokenExpiry(accessToken) {
  const payload = readTokenPayload(accessToken);
  return typeof payload?.exp === 'number' && Number.isFinite(payload.exp)
    ? new Date(payload.exp * 1000).toISOString()
    : null;
}

/**
 * Creates the device-flow client. fetch/sleep/now are injectable so tests can
 * drive the whole flow against a stubbed token endpoint.
 *
 * Token bundles use one shape everywhere (client, vault, resolvers):
 *   { accessToken, refreshToken|null, expiresAt (ISO string), email|null, origin }
 */
export function createSuperGrokOAuthClient({
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deviceCodeUrl = SUPERGROK_DEVICE_CODE_URL,
  tokenUrl = SUPERGROK_TOKEN_URL,
  clientId = SUPERGROK_CLIENT_ID,
} = {}) {
  async function postForm(url, form) {
    let response;
    let body;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      body = await response.text();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new SuperGrokAuthError(
          "xAI's sign-in service did not answer in time. Check the connection and try again.",
        );
      }
      throw new SuperGrokAuthError(
        `Could not reach xAI's sign-in service (${err?.message || 'network error'}). `
        + 'Check the connection, then try again.',
      );
    }
    let root;
    try {
      root = JSON.parse(body);
    } catch {
      throw new SuperGrokAuthError(
        `xAI's sign-in service returned an unreadable reply (HTTP ${response.status}).`,
      );
    }
    if (response.ok && !(root && typeof root === 'object' && 'error' in root)) {
      return root;
    }
    const code = readString(root, 'error');
    throw new SuperGrokAuthError(describeAuthError(code, root, response.status), code);
  }

  function readTokens(root, origin) {
    const accessToken = readString(root, 'access_token');
    if (!accessToken) {
      throw new SuperGrokAuthError(
        'xAI approved the sign-in but returned no access token. Try signing in again.',
      );
    }
    const lifetimeSeconds = readPositiveInt(root, 'expires_in') ?? 3600;
    return {
      accessToken,
      refreshToken: readString(root, 'refresh_token'),
      expiresAt: new Date(now() + lifetimeSeconds * 1000).toISOString(),
      email: readTokenEmail(accessToken),
      origin,
    };
  }

  /** Step 1 — ask xAI for a user code and the page the user types it into. */
  async function requestDeviceCode() {
    const root = await postForm(deviceCodeUrl, {
      client_id: clientId,
      scope: SUPERGROK_SCOPE,
    });
    const deviceCode = readString(root, 'device_code');
    const userCode = readString(root, 'user_code');
    const verificationUrl = readString(root, 'verification_uri');
    if (!deviceCode || !userCode || !verificationUrl) {
      throw new SuperGrokAuthError(
        "xAI's sign-in service answered, but the response was missing the device code. "
        + 'Try again, or use an API key instead.',
      );
    }
    const intervalSeconds = readPositiveInt(root, 'interval') ?? 5;
    const expiresIn = readPositiveInt(root, 'expires_in') ?? 900;
    return {
      deviceCode,
      userCode,
      verificationUrl,
      verificationUrlComplete: readString(root, 'verification_uri_complete') || verificationUrl,
      expiresIn,
      expiresAt: new Date(now() + expiresIn * 1000).toISOString(),
      interval: intervalSeconds,
    };
  }

  /**
   * Step 2 — poll until the user finishes in the browser. Honours the
   * RFC 8628 slow_down backoff (+5 s), and stops on every terminal error
   * rather than spinning.
   */
  async function pollForToken(device, { onProgress = null } = {}) {
    let intervalSeconds = device.interval;
    for (;;) {
      if (now() >= Date.parse(device.expiresAt)) {
        throw new SuperGrokAuthError(
          'The sign-in code expired before it was approved. Run the Grok sign-in again to get a new one.',
          'expired_token',
        );
      }
      await sleep(intervalSeconds * 1000);
      let root;
      try {
        root = await postForm(tokenUrl, {
          grant_type: SUPERGROK_DEVICE_GRANT_TYPE,
          client_id: clientId,
          device_code: device.deviceCode,
        });
      } catch (err) {
        if (err instanceof SuperGrokAuthError && err.code === 'authorization_pending') {
          onProgress?.('Waiting for you to approve the sign-in in your browser…');
          continue;
        }
        if (err instanceof SuperGrokAuthError && err.code === 'slow_down') {
          intervalSeconds += 5;
          onProgress?.('xAI asked us to slow down — still waiting for approval…');
          continue;
        }
        throw err;
      }
      return readTokens(root, 'device-flow');
    }
  }

  /**
   * Exchange a refresh token for a fresh access token. xAI issues refresh
   * tokens under the offline_access scope, which the device flow requests;
   * when a response omits refresh_token the caller keeps the one it had.
   */
  async function refresh(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new SuperGrokAuthError(
        'This SuperGrok session has no refresh token, so it cannot be renewed. Sign in again.',
        'invalid_grant',
      );
    }
    const root = await postForm(tokenUrl, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const refreshed = readTokens(root, 'device-flow');
    return refreshed.refreshToken ? refreshed : { ...refreshed, refreshToken };
  }

  return { requestDeviceCode, pollForToken, refresh };
}

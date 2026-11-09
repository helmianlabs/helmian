/**
 * Scribe door token minting for armed connector turns (connectors bite 4R2).
 *
 * WHY THIS MODULE EXISTS. The Scribe door (connect.helmian.cloud) accepts
 * no unauthenticated calls: it is OAuth-only — authorization-code + PKCE,
 * approved once by the person on the door's consent page with the Scribe
 * passphrase, issuing a one-hour access key and a thirty-day renewal key
 * (connectors bite 4R's step-0 finding, proven against the live door and
 * its discovery documents). Anthropic's MCP connector — the Pattern-A
 * hand-off — accepts exactly one credential form per server: the static
 * string `mcp_servers[].authorization_token`. Anthropic's cloud cannot
 * run the door's flow, cannot consent, and cannot refresh. Helmian
 * therefore PRE-MINTS: before an armed turn, the runner exchanges the
 * connection's renewal key at the door's /token endpoint for a fresh
 * one-hour access key and hands THAT string to the adapter
 * (src/agent/providers.mjs anthropicTurn).
 *
 * CUSTODY follows the runner vault's own principle — credentials live
 * with the compute that calls out. The renewal key sits in the runner
 * vault (src/runner/vault.mjs) under the 'scribe' slot: an OAuth bundle
 * written by the door's connect road (setOAuth, the SuperGrok pattern),
 * or a bare renewal key stored with the runner-vault CLI. The cloud
 * library's connection record holds only vault REFERENCES
 * (connector-library.mjs); resolving a reference on the runner side
 * means reading this runner's vault — the same contract the SuperGrok
 * resolver speaks for xAI (src/agent/supergrok-credentials.mjs).
 *
 * FAILURE LAW. Minting never throws into a turn and never fakes an
 * armed state. No connection, no renewal key, a door refusal, a
 * timeout — each returns { ok: false, code, reason } and the caller
 * proceeds with that connector UNARMED, the failure recorded on the
 * turn (src/agent/attachments.mjs connectorOutcomes).
 *
 * Tokens are secrets: nothing in this module logs one, returns one
 * anywhere but the minted access key to its caller, or puts one in an
 * error. Errors carry only the door's OAuth error code and a plain
 * explanation.
 */

export const SCRIBE_DOOR_BASE_URL = 'https://connect.helmian.cloud';
export const SCRIBE_TOKEN_URL = `${SCRIBE_DOOR_BASE_URL}/token`;
export const SCRIBE_MCP_URL = `${SCRIBE_DOOR_BASE_URL}/mcp`;
export const SCRIBE_VAULT_PROVIDER = 'scribe';

/** The refresh call's bound: a stuck door must never hold a turn hostage. */
export const SCRIBE_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Raised when the door cannot mint. The message is written to be shown
 * verbatim — no stack traces, no token material. `code` is the door's
 * raw OAuth error code when it supplied one.
 */
export class ScribeDoorError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'ScribeDoorError';
    this.code = code;
  }
}

function describeDoorError(code, root, status) {
  switch (code) {
    case 'invalid_grant':
      return 'The Scribe renewal key is no longer valid — it was revoked, or '
        + 'it expired. Connect Scribe again to arm it for a turn.';
    case 'invalid_client':
      return "The door rejected Helmian's runner client registration. "
        + 'Scribe cannot be armed until the registration is fixed.';
    case 'access_denied':
      return 'The Scribe approval was declined at the door. Nothing was armed.';
    case 'expired_token':
      return 'The Scribe renewal key has expired. Connect Scribe again to arm it for a turn.';
    default: {
      const detail = typeof root?.error_description === 'string' ? root.error_description : null;
      return `The Scribe door returned ${code ? `'${code}'` : `HTTP ${status}`}`
        + `${detail ? `: ${detail}` : ''}.`;
    }
  }
}

function readString(root, name) {
  const value = root?.[name];
  return typeof value === 'string' && value ? value : null;
}

function readPositiveInt(root, name) {
  const value = root?.[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * The door's token-endpoint client. fetch/now are injectable so tests
 * drive the whole exchange against a stubbed endpoint. The door's
 * registered token-endpoint auth method for a runner client is 'none'
 * (public client, PKCE at consent time) — no client secret exists
 * anywhere in this flow by design; `clientId` is sent when the caller
 * knows the registration's id.
 */
export function createScribeDoorClient({
  fetchImpl = fetch,
  now = () => Date.now(),
  tokenUrl = SCRIBE_TOKEN_URL,
  timeoutMs = SCRIBE_REFRESH_TIMEOUT_MS,
} = {}) {
  /**
   * Exchange a renewal key for a fresh one-hour access key.
   * Returns { accessToken, refreshToken|null, expiresAt } — the door
   * rotates renewal keys when it issues one; a response without a new
   * renewal key returns null for it and the caller keeps the old key.
   * Throws ScribeDoorError on any failure.
   */
  async function refreshAccessToken({ refreshToken, clientId = null } = {}) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new ScribeDoorError(
        'There is no Scribe renewal key to exchange, so no access key can be minted. Connect Scribe first.',
        'missing_refresh_token',
      );
    }
    const form = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(clientId ? { client_id: String(clientId) } : {}),
    };
    let response;
    let body;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.text();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new ScribeDoorError(
          'The Scribe door did not answer in time, so no access key was minted for this turn.',
          'door_timeout',
        );
      }
      throw new ScribeDoorError(
        `Could not reach the Scribe door (${err?.message || 'network error'}), so no access key was minted for this turn.`,
        'door_unreachable',
      );
    }
    let root;
    try {
      root = JSON.parse(body);
    } catch {
      throw new ScribeDoorError(
        `The Scribe door returned an unreadable reply (HTTP ${response.status}), so no access key was minted for this turn.`,
        'door_bad_response',
      );
    }
    if (!response.ok || (root && typeof root === 'object' && 'error' in root)) {
      const code = readString(root, 'error');
      throw new ScribeDoorError(describeDoorError(code, root, response.status), code);
    }
    const accessToken = readString(root, 'access_token');
    if (!accessToken) {
      throw new ScribeDoorError(
        'The Scribe door answered the renewal but returned no access key, so nothing was armed for this turn.',
        'door_no_access_token',
      );
    }
    const lifetimeSeconds = readPositiveInt(root, 'expires_in') ?? 3600;
    return {
      accessToken,
      refreshToken: readString(root, 'refresh_token'),
      expiresAt: new Date(now() + lifetimeSeconds * 1000).toISOString(),
    };
  }

  return { refreshAccessToken };
}

/**
 * Resolves the connection's renewal key from the runner vault — the
 * vault pattern every runner credential follows (the SuperGrok
 * resolver reads its bundle exactly this way). The connection's
 * refreshTokenRef identifies WHICH connection is being armed; the
 * runner's custody of that connection's renewal key is the vault
 * record under the 'scribe' slot: an OAuth bundle's refreshToken when
 * the connect road stored one, otherwise a bare renewal key stored as
 * a key record (the runner-vault CLI's `store scribe`). A vault that
 * cannot be read (unpaired, wrong master secret) resolves to null
 * here only when the record is absent; a decrypt failure throws, so
 * the minter records a real failure instead of a misleading "absent".
 */
export function createRunnerVaultScribeResolver({ vault } = {}) {
  return async function resolveScribeRefreshToken() {
    if (!vault) return null;
    const bundle = typeof vault.getOAuth === 'function' ? await vault.getOAuth(SCRIBE_VAULT_PROVIDER) : null;
    if (bundle?.refreshToken) return bundle.refreshToken;
    if (bundle?.accessToken && !bundle?.refreshToken) return null;
    const bare = typeof vault.get === 'function' ? await vault.get(SCRIBE_VAULT_PROVIDER) : null;
    return typeof bare === 'string' && bare ? bare : null;
  };
}

/** True when this runner holds any Scribe credential for the door. */
export async function runnerVaultHasScribe(vault) {
  if (!vault) return false;
  try {
    const bundle = typeof vault.getOAuth === 'function' ? await vault.getOAuth(SCRIBE_VAULT_PROVIDER) : null;
    if (bundle?.refreshToken || bundle?.accessToken) return true;
    const bare = typeof vault.get === 'function' ? await vault.get(SCRIBE_VAULT_PROVIDER) : null;
    return typeof bare === 'string' && Boolean(bare);
  } catch {
    return false;
  }
}

/**
 * The turn-time minter the arming seam uses. NEVER throws: every
 * failure is a recorded { ok: false, code, reason }, and the turn
 * proceeds with the connector unarmed.
 *
 * - resolveRefreshToken(refreshTokenRef) → the renewal key string, or
 *   null when this runner holds none for the connection. Injected: in
 *   production it is createRunnerVaultScribeResolver over the bridge's
 *   opened vault; tests inject fakes.
 */
export function createScribeAccessTokenMinter({
  doorClient = null,
  resolveRefreshToken = null,
  onProblem = null,
} = {}) {
  const client = doorClient ?? createScribeDoorClient();
  return async function mintScribeAccessToken({ refreshTokenRef = null, clientId = null } = {}) {
    if (typeof resolveRefreshToken !== 'function') {
      return { ok: false, code: 'no_refresh_resolver', reason: 'No road is wired on this runner to read the Scribe renewal key, so the connector cannot be armed.' };
    }
    let refreshToken = null;
    try {
      refreshToken = await resolveRefreshToken(refreshTokenRef);
    } catch (err) {
      const reason = `The Scribe renewal key could not be read on this runner (${err?.message || 'vault error'}), so the connector was not armed.`;
      onProblem?.(reason);
      return { ok: false, code: 'refresh_resolve_failed', reason };
    }
    if (!refreshToken) {
      return { ok: false, code: 'no_refresh_token', reason: 'This runner holds no Scribe renewal key for the connection, so the connector was not armed. Connect Scribe on this runner first.' };
    }
    try {
      const minted = await client.refreshAccessToken({ refreshToken, clientId });
      return { ok: true, accessToken: minted.accessToken, expiresAt: minted.expiresAt };
    } catch (err) {
      const reason = err?.message || 'The Scribe door could not mint an access key, so the connector was not armed.';
      onProblem?.(reason);
      return { ok: false, code: err?.code ?? 'door_error', reason };
    }
  };
}

/**
 * Composes the arming seam resolveTurnAttachments consumes
 * ({ connectionFor, mintAccessToken }) for the Scribe door:
 * connectionFor stays the caller's — it depends on what the turn
 * carries — while mintAccessToken is the door minter over the runner
 * vault. bridge.mjs is the production caller.
 */
export function createScribeArming({ vault = null, doorClient = null, connectionFor = null, onProblem = null } = {}) {
  const mintAccessToken = createScribeAccessTokenMinter({
    doorClient,
    resolveRefreshToken: createRunnerVaultScribeResolver({ vault }),
    onProblem,
  });
  return { connectionFor, mintAccessToken };
}

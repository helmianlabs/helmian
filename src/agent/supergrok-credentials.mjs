/**
 * SuperGrok credential resolution for the agent bridge: turns the runner
 * vault's Grok OAuth record into the credential a turn actually sends.
 *
 * Semantics mirror the desktop SuperGrokCredentialProvider:
 * - a stored session beats a pasted API key (the caller falls back to the key
 *   whenever this resolver returns null — that fallback lives in
 *   chatWithTools);
 * - a token inside the 60 s expiry window is refreshed BEFORE it is handed
 *   out, so a request never leaves with a token that dies in flight, and the
 *   refreshed bundle is saved back to the vault;
 * - a terminal refresh failure (invalid_grant / access_denied — revoked or
 *   signed out elsewhere) CLEARS the session and surfaces a plain reason, so
 *   a dead sign-in never fails silently turn after turn;
 * - a transient refresh failure keeps the session and still hands out the
 *   current token (it is inside its final minute at worst), with the reason
 *   surfaced the same way.
 *
 * Nothing here ever logs or returns anything but the access token itself,
 * through the resolver contract chatWithTools already speaks.
 */
import { createSuperGrokOAuthClient, SuperGrokAuthError } from './supergrok-oauth.mjs';
import { PROVIDER_KEY_ENV } from '../runner/vault.mjs';

/** Refresh this early so a token never dies in flight (the EXE's 60 s rule). */
export const SUPERGROK_REFRESH_WINDOW_MS = 60_000;

const TERMINAL_REFRESH_CODES = new Set(['invalid_grant', 'access_denied']);
const GROK_PROVIDER_IDS = new Set(['xai', 'grok']);

function isGrokProvider(providerId) {
  return GROK_PROVIDER_IDS.has(String(providerId || '').toLowerCase());
}

/**
 * The one place token freshness is decided. Returns the bundle a turn should
 * use (refreshing + saving back when inside the window or when forced), or
 * null when there is no usable session. `onAuthProblem` receives the plain
 * reason whenever the session could not be renewed cleanly.
 */
export async function getFreshSuperGrokTokens({
  vault,
  client,
  now = () => Date.now(),
  forceRefresh = false,
  onAuthProblem = null,
} = {}) {
  const tokens = await vault.getOAuth('grok');
  if (!tokens) return null;
  const expiresMs = Date.parse(tokens.expiresAt || '');
  const fresh = Number.isFinite(expiresMs) && expiresMs - SUPERGROK_REFRESH_WINDOW_MS > now();
  if (fresh && !forceRefresh) return tokens;

  if (!tokens.refreshToken) {
    await vault.wipe('grok');
    onAuthProblem?.('Your SuperGrok session cannot be renewed (it has no refresh token). Sign in again.');
    return null;
  }
  try {
    const refreshed = await client.refresh(tokens.refreshToken);
    await vault.setOAuth('grok', refreshed);
    return refreshed;
  } catch (err) {
    if (err instanceof SuperGrokAuthError && TERMINAL_REFRESH_CODES.has(err.code)) {
      await vault.wipe('grok');
      onAuthProblem?.(err.message);
      return null;
    }
    // Transient (network, 5xx, unreadable reply): keep the session, hand out
    // the current token, and say why — the same posture as the EXE.
    onAuthProblem?.(err?.message || 'The SuperGrok session could not be renewed just now.');
    return tokens;
  }
}

/**
 * Builds the credentialResolver chatWithTools speaks, backed by the runner
 * vault's Grok OAuth record. Returns null when no vault is available, so
 * callers can wire it unconditionally and keep today's env-key behavior.
 *
 * The returned function also carries:
 * - refreshCredential({providerId}) — the 401 hook chatWithTools calls once
 *   when xAI rejects a subscription credential: force a refresh and hand
 *   back the fresh token (or null when the session is gone);
 * - hasSession() / hasSessionSync() — presence for startup/config checks
 *   (the sync form returns the last state the resolver itself observed).
 */
export function createSuperGrokCredentialResolver({
  vault,
  client = null,
  now = () => Date.now(),
  onAuthProblem = null,
} = {}) {
  if (!vault || typeof vault.getOAuth !== 'function') return null;
  const oauthClient = client || createSuperGrokOAuthClient();
  let sessionKnown = false;

  async function resolveFresh(forceRefresh) {
    const tokens = await getFreshSuperGrokTokens({
      vault, client: oauthClient, now, forceRefresh, onAuthProblem,
    });
    sessionKnown = Boolean(tokens);
    if (!tokens) return null;
    return { credential: tokens.accessToken, tokenType: 'oauth' };
  }

  const resolver = async ({ providerId } = {}) => {
    if (!isGrokProvider(providerId)) return null;
    return resolveFresh(false);
  };

  resolver.refreshCredential = async ({ providerId } = {}) => {
    if (!isGrokProvider(providerId)) return null;
    return resolveFresh(true);
  };

  resolver.hasSession = async () => {
    sessionKnown = Boolean(await vault.getOAuth('grok'));
    return sessionKnown;
  };
  resolver.hasSessionSync = () => sessionKnown;

  return resolver;
}

/**
 * The pc-bridge parent seam: the bridge injects vault credentials into the
 * agent child's environment at spawn. A Grok OAuth session resolves to its
 * fresh access token plus the marker env the child reads back as "this key
 * is a subscription credential" (HELMION_XAI_CREDENTIAL_TYPE=oauth, see
 * src/agent/env.mjs). Returns null when there is no usable session, leaving
 * the plain environment fallback in charge. Never returns the stored bundle
 * itself — an OAuth record must never be injected as if it were a key.
 */
export async function resolveGrokVaultInjection({
  vault,
  client = null,
  now = () => Date.now(),
  onAuthProblem = null,
} = {}) {
  if (!vault || typeof vault.getOAuth !== 'function') return null;
  const oauthClient = client || createSuperGrokOAuthClient();
  const tokens = await getFreshSuperGrokTokens({
    vault, client: oauthClient, now, onAuthProblem,
  });
  if (!tokens) return null;
  const injection = { HELMION_XAI_CREDENTIAL_TYPE: 'oauth' };
  injection[PROVIDER_KEY_ENV.grok] = tokens.accessToken;
  return injection;
}

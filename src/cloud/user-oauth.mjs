// User-level OAuth for AI providers — the Gemini road is RESTORED
// (Troy's order, 2026-11-17, Scribe letter 935); the rest stays
// retired.
//
// History: this module used to serve the user-level connect flows
// under /api/provider-oauth/* until the one-road removal pass (Bite
// 12, 2026-11-02) retired them all in favour of the password road.
// The 2026-11-17 order reverses the password law: Helmian stops
// storing customers' AI account passwords and moves to official
// OAuth or API keys. Per-provider roads were verified against
// provider documentation on 2026-11-18: Gemini's documented Google
// OAuth 2.0 is the one genuine self-serve OAuth road among the
// seats, so the Gemini start + callback below are live again,
// rebuilt on the same machinery the admin Gemini flow uses
// (provider-oauth-config.mjs, oauth-connection-contract.mjs,
// provider-connection-repository.mjs, provider-oauth-readiness.mjs).
// "Sign in with ChatGPT" stays retired (partner-gated, not
// self-serve for a hosted product) and the Grok device-code flow
// stays retired (first-party OAuth only); their paths keep the 410
// fence so no shadow connect road stays reachable.
//
// The flow: GET start (owner/admin actor, tenant from the verified
// actor only) → readiness + config checks → a durable OAuth
// transaction is recorded → 302 to Google with PKCE, state and
// verifier carried in HttpOnly cookies scoped to this flow's path.
// GET callback → state must match the cookie → the transaction is
// claimed → the code is exchanged (PKCE, public client) → the token
// bundle is stored by the encrypted vault adapter under
// vault://tenant/<tenant>/gemini/oauth and the provider_connections
// row is written with auth_mode 'oauth_subscription' → 302 back to
// the app with the outcome. This route never returns secret material.
import { Pool } from 'pg';
import { createCloudOAuthAuthorization } from './oauth-connection-contract.mjs';
import { createGeminiOAuthPkce, geminiCredentialReference, resolveGeminiUserOAuthConfig } from './provider-oauth-config.mjs';
import { readGeminiOAuthReadiness } from './provider-oauth-readiness.mjs';
import { createProviderConnectionRepository } from './provider-connection-repository.mjs';
import { createEncryptedVaultAdapterFromEnv } from './database-encrypted-vault-adapter.mjs';

export const USER_GEMINI_OAUTH_START = '/api/provider-oauth/gemini/start';
export const USER_GEMINI_OAUTH_CALLBACK = '/api/provider-oauth/gemini/callback';
export const USER_OPENAI_OAUTH_START = '/api/provider-oauth/openai/start';
export const USER_OPENAI_OAUTH_CALLBACK = '/api/provider-oauth/openai/callback';
export const USER_GROK_OAUTH_START = '/api/provider-oauth/grok/start';
export const USER_GROK_OAUTH_POLL = '/api/provider-oauth/grok/poll';

const RETIRED_PATHS = new Set([
  USER_OPENAI_OAUTH_START,
  USER_OPENAI_OAUTH_CALLBACK,
  USER_GROK_OAUTH_START,
  USER_GROK_OAUTH_POLL,
]);

const STATE_COOKIE = 'helmion_gemini_user_oauth_state';
const VERIFIER_COOKIE = 'helmion_gemini_user_oauth_verifier';
const COOKIE_PATH = '/api/provider-oauth/gemini';
const APP_LANDING = '/app/';

// Own lazy pool, same env var and ssl rule as credential-connect.mjs
// (live-admin.mjs owns the primary pool and cannot pass it through
// the frozen hook).
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503, code: 'GEMINI_OAUTH_UNAVAILABLE' });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

function requestOrigin(request, env) {
  const configured = String(env.HELMION_APP_ORIGIN ?? '').trim();
  if (configured) {
    try { return new URL(configured).origin; } catch { return null; }
  }
  const protocol = String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim().toLowerCase() || 'http';
  try { return new URL(`${protocol}://${request.headers.host ?? 'localhost'}`).origin; } catch { return null; }
}

function oauthCookie(name, value, maxAgeSeconds = 600) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  return parts.join('; ');
}

function cookieValue(request, name) {
  const header = String(request.headers?.cookie ?? '');
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function statusFor(error, fallback) {
  if (error?.status === 403) return 403;
  if (error?.status === 400 || error instanceof TypeError) return 400;
  if (error?.status === 503) return 503;
  return fallback;
}

export function createUserOAuthHandler({ env = process.env, pool = null, repository = null, vaultAdapter = null, fetchImpl = globalThis.fetch } = {}) {
  function deps() {
    const thePool = pool ?? getPool();
    const theVault = vaultAdapter ?? createEncryptedVaultAdapterFromEnv({ pool: thePool, env });
    const theRepository = repository ?? createProviderConnectionRepository(thePool, { fetchImpl, vaultAdapter: theVault ?? undefined });
    return { pool: thePool, vaultAdapter: theVault, repository: theRepository };
  }

  return async function handleUserOAuthRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError }) {
    const pathname = requestUrl?.pathname;
    if (RETIRED_PATHS.has(pathname)) {
      send(response, 410, JSON.stringify({ error: 'provider_oauth_retired', code: 'PROVIDER_OAUTH_RETIRED' }));
      return true;
    }
    if (pathname !== USER_GEMINI_OAUTH_START && pathname !== USER_GEMINI_OAUTH_CALLBACK) return false;
    if (typeof activeTenantActor !== 'function') {
      // The router always passes the verified-actor function; without
      // it there is no tenant to bind the flow to, so the road fails
      // closed rather than guessing.
      send(response, 503, JSON.stringify({ valid: false, code: 'GEMINI_OAUTH_UNAVAILABLE' }));
      return true;
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ valid: false, code: 'GEMINI_OAUTH_METHOD_NOT_ALLOWED' }));
      return true;
    }

    if (pathname === USER_GEMINI_OAUTH_START) {
      try {
        const actor = await activeTenantActor(request);
        if (!['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('Provider OAuth requires owner or admin membership'), { status: 403, code: 'PROVIDER_OAUTH_MEMBERSHIP_REQUIRED' });
        const config = resolveGeminiUserOAuthConfig(env, requestOrigin(request, env));
        if (!config.configured) throw Object.assign(new Error('Gemini OAuth client registration is not configured'), { status: 503, code: config.code });
        const { pool: thePool, vaultAdapter: theVault, repository: theRepository } = deps();
        const readiness = await readGeminiOAuthReadiness({ pool: thePool, config, vaultAdapter: theVault });
        if (!readiness.ready) throw Object.assign(new Error('Gemini OAuth deployment is not ready'), { status: 503, code: readiness.code });
        const pkce = createGeminiOAuthPkce();
        const authorization = createCloudOAuthAuthorization({ tenant_id: actor.tenantId, actor_role: actor.role, provider_id: 'gemini', client_id: config.clientId, state: pkce.state, code_challenge: pkce.codeChallenge, code_challenge_method: pkce.codeChallengeMethod, redirect_uri: config.redirectUri, scopes: config.scopes });
        if (!authorization.valid) throw Object.assign(new Error('Gemini OAuth authorization contract rejected configuration'), { status: 503, code: 'GEMINI_OAUTH_CONFIGURATION_INVALID' });
        await theRepository.createOAuthTransaction(actor, { providerId: 'gemini', state: pkce.state, clientId: config.clientId, redirectUri: config.redirectUri, codeChallenge: pkce.codeChallenge, credentialReference: geminiCredentialReference(actor.tenantId) });
        send(response, 302, '', 'text/plain; charset=utf-8', { location: authorization.result.authorization_url, 'set-cookie': [oauthCookie(STATE_COOKIE, pkce.state), oauthCookie(VERIFIER_COOKIE, pkce.codeVerifier)] });
      } catch (error) {
        if (TenantAuthorizationError && error instanceof TenantAuthorizationError) {
          send(response, error.status ?? 403, JSON.stringify({ valid: false, code: error.code ?? 'TENANT_AUTHORIZATION_FAILED' }));
          return true;
        }
        const status = statusFor(error, 503);
        send(response, status, JSON.stringify({ valid: false, code: error?.code ?? (status === 403 ? 'PROVIDER_OAUTH_MEMBERSHIP_REQUIRED' : status === 503 ? 'GEMINI_OAUTH_UNAVAILABLE' : 'GEMINI_OAUTH_INPUT_INVALID') }));
      }
      return true;
    }

    // Callback.
    const clearCookies = [oauthCookie(STATE_COOKIE, '', 0), oauthCookie(VERIFIER_COOKIE, '', 0)];
    let callbackActor = null;
    let claimedTransaction = null;
    try {
      const actor = await activeTenantActor(request);
      callbackActor = actor;
      if (!['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('Provider OAuth requires owner or admin membership'), { status: 403, code: 'PROVIDER_OAUTH_MEMBERSHIP_REQUIRED' });
      const state = requestUrl.searchParams.get('state') ?? '';
      const code = requestUrl.searchParams.get('code') ?? '';
      if (!state || !code || state !== cookieValue(request, STATE_COOKIE)) throw Object.assign(new Error('Gemini OAuth callback state is invalid'), { status: 400, code: 'GEMINI_OAUTH_CALLBACK_STATE_INVALID' });
      const { repository: theRepository } = deps();
      const claimed = await theRepository.claimOAuthTransaction(actor, { providerId: 'gemini', state });
      if (!claimed.durable) throw Object.assign(new Error('Gemini OAuth transaction is not pending'), { status: 400, code: claimed.code });
      claimedTransaction = claimed.transaction;
      const verifier = cookieValue(request, VERIFIER_COOKIE);
      if (!verifier) throw Object.assign(new Error('Gemini OAuth verifier is missing'), { status: 400, code: 'GEMINI_OAUTH_VERIFIER_MISSING' });
      const result = await theRepository.exchangeOAuth(actor, { providerId: claimed.transaction.providerId, clientId: claimed.transaction.clientId, code, codeVerifier: verifier, codeChallenge: claimed.transaction.codeChallenge, redirectUri: claimed.transaction.redirectUri, credentialReference: claimed.transaction.credentialReference });
      await theRepository.finishOAuthTransaction(actor, { transactionId: claimed.transaction.id, status: result.durable ? 'completed' : 'failed', errorCode: result.durable ? null : result.exchange?.status ?? 'OAUTH_EXCHANGE_FAILED' });
      const outcome = result.durable ? 'connected' : 'error';
      send(response, 302, '', 'text/plain; charset=utf-8', { location: `${APP_LANDING}?provider_oauth=${outcome}`, 'set-cookie': clearCookies });
    } catch (error) {
      if (callbackActor && claimedTransaction?.id) {
        try {
          const { repository: theRepository } = deps();
          await theRepository.finishOAuthTransaction(callbackActor, { transactionId: claimedTransaction.id, status: 'failed', errorCode: error?.code ?? 'GEMINI_OAUTH_CALLBACK_FAILED' });
        } catch { /* preserve the original bounded callback error */ }
      }
      if (TenantAuthorizationError && error instanceof TenantAuthorizationError) {
        send(response, error.status ?? 403, JSON.stringify({ valid: false, code: error.code ?? 'TENANT_AUTHORIZATION_FAILED' }), 'application/json; charset=utf-8', { 'set-cookie': clearCookies });
        return true;
      }
      const status = statusFor(error, 503);
      send(response, status, JSON.stringify({ valid: false, code: error?.code ?? (status === 403 ? 'PROVIDER_OAUTH_MEMBERSHIP_REQUIRED' : status === 400 ? 'GEMINI_OAUTH_CALLBACK_INVALID' : 'GEMINI_OAUTH_UNAVAILABLE') }), 'application/json; charset=utf-8', { 'set-cookie': clearCookies });
    }
    return true;
  };
}

export const handleUserOAuthRoute = createUserOAuthHandler();

// The roads read the Integrations page paints from: GET
// /api/admin/envoy/credential/oauth-roads answers which OAuth roads
// this deployment is configured for, so the Gemini card offers
// "Connect with Google" only when the start route behind it would
// actually run (a client is registered) — never a dead button. The
// answer carries no secret material: configuration presence only.
// Any verified member may read it, like the other card-state reads.
export const USER_OAUTH_ROADS_PATH = '/api/admin/envoy/credential/oauth-roads';

export function createUserOAuthRoadsHandler({ env = process.env } = {}) {
  return async function handleUserOAuthRoadsRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError }) {
    if (!requestUrl || requestUrl.pathname !== USER_OAUTH_ROADS_PATH) return false;
    if (typeof activeTenantActor !== 'function') {
      send(response, 503, JSON.stringify({ valid: false, code: 'GEMINI_OAUTH_UNAVAILABLE' }));
      return true;
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    try {
      await activeTenantActor(request);
      const config = resolveGeminiUserOAuthConfig(env, requestOrigin(request, env));
      send(response, 200, JSON.stringify({ valid: true, oauth: { gemini: config.configured === true } }));
    } catch (error) {
      if (TenantAuthorizationError && error instanceof TenantAuthorizationError) {
        send(response, error.status ?? 403, JSON.stringify({ valid: false, code: error.code ?? 'TENANT_AUTHORIZATION_FAILED' }));
        return true;
      }
      const status = statusFor(error, 503);
      send(response, status, JSON.stringify({ valid: false, code: error?.code ?? 'GEMINI_OAUTH_UNAVAILABLE' }));
    }
    return true;
  };
}

export const handleUserOAuthRoadsRoute = createUserOAuthRoadsHandler();

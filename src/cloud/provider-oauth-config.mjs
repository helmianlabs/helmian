import { createHash, randomBytes } from 'node:crypto';
import { GEMINI_SCOPES, getCloudProviderOAuthAuthority } from './provider-oauth-authority.mjs';

const CLIENT_ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const STATE = /^[A-Za-z0-9_-]{32,128}$/u;

export const GEMINI_OAUTH_CALLBACK_PATH = '/api/admin/provider-oauth/gemini/callback';
export const GEMINI_OAUTH_USER_CALLBACK_PATH = '/api/provider-oauth/gemini/callback';

function resolveGeminiOAuthConfigForCallback(env, requestOrigin, callbackPath, redirectUriOverride) {
  const clientId = String(env.HELMION_GEMINI_OAUTH_CLIENT_ID ?? '').trim();
  if (!CLIENT_ID.test(clientId)) return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED' });
  let origin;
  try { origin = new URL(String(requestOrigin)).origin; } catch { return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_ORIGIN_INVALID' }); }
  const redirectUri = String(redirectUriOverride ?? `${origin}${callbackPath}`).trim();
  let redirect;
  try { redirect = new URL(redirectUri); } catch { return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_REDIRECT_INVALID' }); }
  if (redirect.protocol !== 'https:' || redirect.origin !== origin || redirect.pathname !== callbackPath || redirect.search || redirect.hash || redirect.username || redirect.password) return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_REDIRECT_INVALID' });
  const authority = getCloudProviderOAuthAuthority('gemini');
  return Object.freeze({ configured: true, clientId, redirectUri: redirect.toString(), scopes: GEMINI_SCOPES, authorizationEndpoint: authority.authorization_endpoint, tokenEndpoint: authority.token_endpoint });
}

// Admin flow: Google returns to the admin callback, which completes the
// server-side vault storage. Its redirect override stays HELMION_GEMINI_OAUTH_REDIRECT_URI.
export function resolveGeminiOAuthConfig(env = process.env, requestOrigin) {
  return resolveGeminiOAuthConfigForCallback(env, requestOrigin, GEMINI_OAUTH_CALLBACK_PATH, env.HELMION_GEMINI_OAUTH_REDIRECT_URI);
}

// User flow: Google must return to the user callback (the admin callback
// requires an admin actor, an admin state cookie, and a DB transaction the
// user flow never creates). The user flow has its own redirect override,
// HELMION_GEMINI_USER_OAUTH_REDIRECT_URI, held to the same strict validation
// against its own callback path.
export function resolveGeminiUserOAuthConfig(env = process.env, requestOrigin) {
  return resolveGeminiOAuthConfigForCallback(env, requestOrigin, GEMINI_OAUTH_USER_CALLBACK_PATH, env.HELMION_GEMINI_USER_OAUTH_REDIRECT_URI);
}

export function createGeminiOAuthPkce() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  return Object.freeze({ state, codeVerifier, codeChallenge, codeChallengeMethod: 'S256' });
}

export function hashOAuthState(state) {
  if (!STATE.test(String(state))) throw new TypeError('OAuth state is invalid');
  return createHash('sha256').update(String(state)).digest('hex');
}

export function geminiCredentialReference(tenantId) {
  const value = String(tenantId ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new TypeError('tenant id is invalid');
  return `vault://tenant/${value}/gemini/oauth`;
}

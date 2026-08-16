import { createHash, randomBytes } from 'node:crypto';
import { GEMINI_SCOPES, getCloudProviderOAuthAuthority } from './provider-oauth-authority.mjs';

const CLIENT_ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const STATE = /^[A-Za-z0-9_-]{32,128}$/u;

export const GEMINI_OAUTH_CALLBACK_PATH = '/api/admin/provider-oauth/gemini/callback';

export function resolveGeminiOAuthConfig(env = process.env, requestOrigin) {
  const clientId = String(env.HELMION_GEMINI_OAUTH_CLIENT_ID ?? '').trim();
  if (!CLIENT_ID.test(clientId)) return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED' });
  let origin;
  try { origin = new URL(String(requestOrigin)).origin; } catch { return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_ORIGIN_INVALID' }); }
  const redirectUri = String(env.HELMION_GEMINI_OAUTH_REDIRECT_URI ?? `${origin}${GEMINI_OAUTH_CALLBACK_PATH}`).trim();
  let redirect;
  try { redirect = new URL(redirectUri); } catch { return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_REDIRECT_INVALID' }); }
  if (redirect.protocol !== 'https:' || redirect.origin !== origin || redirect.pathname !== GEMINI_OAUTH_CALLBACK_PATH || redirect.search || redirect.hash || redirect.username || redirect.password) return Object.freeze({ configured: false, code: 'GEMINI_OAUTH_REDIRECT_INVALID' });
  const authority = getCloudProviderOAuthAuthority('gemini');
  return Object.freeze({ configured: true, clientId, redirectUri: redirect.toString(), scopes: GEMINI_SCOPES, authorizationEndpoint: authority.authorization_endpoint, tokenEndpoint: authority.token_endpoint });
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

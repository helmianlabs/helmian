import { verifyCloudPkce } from './oauth-connection-contract.mjs';
import { createUnavailableEncryptedVaultAdapter } from './encrypted-vault-adapter.mjs';
import { getCloudProviderOAuthAuthority, isSupportedCloudOAuthProvider } from './provider-oauth-authority.mjs';

const CLIENT_ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const CODE = /^[\x21-\x7e]{1,4096}$/u;
const VAULT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

function cleanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('OAuth exchange input');
  const allowed = ['tenantId', 'providerId', 'clientId', 'code', 'codeVerifier', 'codeChallenge', 'redirectUri', 'credentialReference'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('OAuth exchange input contains an unsupported field');
  if (!input.tenantId || !CLIENT_ID.test(String(input.clientId)) || !CODE.test(String(input.code)) || !CODE.test(String(input.codeVerifier)) || !CODE.test(String(input.codeChallenge)) || !VAULT_REFERENCE.test(String(input.credentialReference))) throw new TypeError('OAuth exchange input is invalid');
  const redirect = new URL(String(input.redirectUri));
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new TypeError('OAuth redirect is invalid');
  return { ...input, tenantId: String(input.tenantId), providerId: String(input.providerId), clientId: String(input.clientId), code: String(input.code), codeVerifier: String(input.codeVerifier), codeChallenge: String(input.codeChallenge), redirectUri: redirect.toString(), credentialReference: String(input.credentialReference) };
}

async function jsonResponse(response) {
  try { return await response.json(); } catch { return {}; }
}

function tokenPayload(payload) {
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : null;
  const expiresIn = Number(payload?.expires_in);
  if (!accessToken || (payload?.refresh_token != null && !refreshToken)) throw new Error('provider token response is missing a valid access token');
  return { accessToken, refreshToken, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null, scope: typeof payload?.scope === 'string' ? payload.scope : null, tokenType: typeof payload?.token_type === 'string' ? payload.token_type : 'Bearer' };
}

export async function exchangeCloudOAuthCode(input, { fetchImpl = globalThis.fetch, vaultAdapter = createUnavailableEncryptedVaultAdapter() } = {}) {
  const request = cleanInput(input);
  const authority = getCloudProviderOAuthAuthority(request.providerId);
  if (!authority) throw new Error('unknown cloud OAuth provider');
  if (!isSupportedCloudOAuthProvider(request.providerId)) return Object.freeze({ valid: false, status: authority.status, providerId: request.providerId, tokenExchange: 'blocked', tokenStorage: 'not_attempted', blocker: authority.blocker });
  if (typeof fetchImpl !== 'function') throw new TypeError('OAuth fetch implementation is required');
  if (!verifyCloudPkce({ code_verifier: request.codeVerifier, code_challenge: request.codeChallenge }).valid) return Object.freeze({ valid: false, status: 'pkce_invalid', providerId: request.providerId, tokenExchange: 'not_attempted', tokenStorage: 'not_attempted' });

  const response = await fetchImpl(authority.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ code: request.code, client_id: request.clientId, redirect_uri: request.redirectUri, grant_type: 'authorization_code', code_verifier: request.codeVerifier }).toString(),
  });
  const payload = await jsonResponse(response);
  if (!response.ok) return Object.freeze({ valid: false, status: 'token_exchange_failed', providerId: request.providerId, tokenExchange: 'failed', tokenStorage: 'not_attempted', httpStatus: response.status, providerError: typeof payload?.error === 'string' ? payload.error : 'provider_error' });

  const token = tokenPayload(payload);
  if (typeof vaultAdapter?.storeOAuthTokens !== 'function') throw new TypeError('encrypted vault adapter must expose storeOAuthTokens');
  const stored = await vaultAdapter.storeOAuthTokens({ tenantId: request.tenantId, providerId: request.providerId, credentialReference: request.credentialReference, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresIn: token.expiresIn, scope: token.scope, tokenType: token.tokenType });
  return Object.freeze({ valid: stored?.accepted === true, status: stored?.accepted === true ? 'token_stored' : 'token_storage_unavailable', providerId: request.providerId, tokenExchange: 'completed', tokenStorage: stored?.status ?? 'unknown', credentialReference: request.credentialReference, providerInvocation: 'not_performed', tools: 'not_granted' });
}

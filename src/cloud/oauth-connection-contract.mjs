import { createHash } from 'node:crypto';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';
import { buildCloudOAuthAuthorizationUrl, CLOUD_PROVIDER_OAUTH_AUTHORITIES, getCloudProviderOAuthAuthority } from './provider-oauth-authority.mjs';

const ADMIN = new Set(['owner', 'admin']);
const AUTH_MODES = Object.freeze(['api_key', 'oauth_subscription']);
const STATE = /^[A-Za-z0-9_-]{32,128}$/;
const PKCE = /^[A-Za-z0-9~._-]{43,128}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SENSITIVE = /(api.?key|token|secret|credential|password|private.?key|client_secret|code_verifier)/i;

export const CLOUD_PROVIDER_CONNECTIONS = Object.freeze([
  Object.freeze({ provider_id: 'openai_codex', label: 'Claude/Codex-ChatGPT', api_key: 'accepted_as_vault_reference', oauth_subscription: 'requires_verified_provider_flow', adapter: 'not_configured' }),
  Object.freeze({ provider_id: 'claude', label: 'Claude', api_key: 'accepted_as_vault_reference', oauth_subscription: 'requires_verified_provider_flow', adapter: 'not_configured' }),
  Object.freeze({ provider_id: 'gemini', label: 'Gemini/Antigravity', api_key: 'accepted_as_vault_reference', oauth_subscription: 'documented_google_oauth', adapter: 'not_configured' }),
  Object.freeze({ provider_id: 'grok', label: 'Grok', api_key: 'accepted_as_vault_reference', oauth_subscription: 'first_party_oauth_only', adapter: 'not_configured' }),
]);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validScope(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 12
    && value.every((item) => typeof item === 'string' && /^[a-zA-Z0-9:._/-]{1,96}$/.test(item));
}

function reject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input');
  for (const key of Object.keys(input)) if (key !== 'credential_reference' && SENSITIVE.test(key)) throw new TypeError('sensitive');
}

export function listCloudProviderConnectionReadiness(input) {
  try {
    reject(input);
    const tenant_id = normalizeTenantId(input.tenant_id);
    const actor_role = normalizeActorRole(input.actor_role);
    if (!ADMIN.has(actor_role) || Object.keys(input).some((key) => !['tenant_id', 'actor_role'].includes(key))) throw new TypeError('scope');
    return freeze({ valid: true, result: {
      format: 'helmion.cloud-provider-readiness.v1', tenant_id, actor_role,
      providers: CLOUD_PROVIDER_CONNECTIONS.map((provider) => freeze({
        ...provider, status: 'provider_registration_required', desktop_subscription_reusable: false,
        oauth_authority: getCloudProviderOAuthAuthority(provider.provider_id)?.status ?? 'unknown',
        cloud_connection: 'not_configured', credential_storage: 'external_encrypted_vault_required',
        tenant_isolation: 'tenant_context_and_rls_required', invocation: 'not_performed', tools: 'not_granted',
      })),
    } });
  } catch { return freeze({ valid: false, code: 'CLOUD_PROVIDER_READINESS_INVALID' }); }
}

export function createCloudProviderConnectionIntent(input) {
  try {
    reject(input);
    const allowed = ['tenant_id', 'actor_role', 'provider_id', 'auth_mode', 'credential_reference', 'state', 'code_challenge', 'code_challenge_method'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('input');
    const tenant_id = normalizeTenantId(input.tenant_id);
    const actor_role = normalizeActorRole(input.actor_role);
    const provider = CLOUD_PROVIDER_CONNECTIONS.find((item) => item.provider_id === input.provider_id);
    if (!ADMIN.has(actor_role) || !provider || !AUTH_MODES.includes(input.auth_mode) || !REF.test(String(input.credential_reference))) throw new TypeError('input');
    if (input.auth_mode === 'oauth_subscription' && (!STATE.test(String(input.state)) || !PKCE.test(String(input.code_challenge)) || input.code_challenge_method !== 'S256')) throw new TypeError('oauth');
    return freeze({ valid: true, result: {
      format: 'helmion.cloud-provider-connection-intent.v1', tenant_id, actor_role,
      provider_id: provider.provider_id, auth_mode: input.auth_mode, credential_reference: input.credential_reference,
      credential_storage: 'external_encrypted_vault_required', tenant_isolation: 'tenant_context_and_rls_required',
      adapter: provider.adapter, status: 'pending_external_vault_and_adapter', tools: 'not_granted',
      invocation: 'not_performed', audit: 'durable_intent_receipt_required_before_activation',
    } });
  } catch { return freeze({ valid: false, code: 'CLOUD_PROVIDER_CONNECTION_INVALID' }); }
}

export function createCloudOAuthAuthorization(input) {
  try {
    reject(input);
    const allowed = ['tenant_id', 'actor_role', 'provider_id', 'client_id', 'state', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'scopes'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('input');
    const tenant_id = normalizeTenantId(input.tenant_id);
    const actor_role = normalizeActorRole(input.actor_role);
    const authority = getCloudProviderOAuthAuthority(input.provider_id);
    if (!ADMIN.has(actor_role) || !CLOUD_PROVIDER_CONNECTIONS.some((item) => item.provider_id === input.provider_id) || !authority || !STATE.test(String(input.state)) || !PKCE.test(String(input.code_challenge)) || input.code_challenge_method !== 'S256' || !validScope(input.scopes)) throw new TypeError('input');
    const redirect = new URL(input.redirect_uri);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new TypeError('redirect');
    const scopes = [...new Set(input.scopes)].sort();
    if (authority.token_endpoint && (!input.client_id || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(String(input.client_id)) || scopes.some((scope) => !authority.scopes.includes(scope)))) throw new TypeError('provider oauth registration');
    const authorization_url = authority.authorization_endpoint
      ? buildCloudOAuthAuthorizationUrl({ authority, clientId: String(input.client_id), redirectUri: redirect.toString(), state: input.state, codeChallenge: input.code_challenge, scopes })
      : null;
    return freeze({ valid: true, result: {
      format: 'helmion.cloud-oauth-authorization.v1', tenant_id, actor_role, provider_id: input.provider_id,
      state: input.state, code_challenge: input.code_challenge, code_challenge_method: 'S256', redirect_uri: redirect.toString(),
      scopes: freeze(scopes), oauth_authority: authority.status, status: authority.token_endpoint ? 'authorization_ready' : 'provider_oauth_blocked',
      provider_endpoint: authority.authorization_endpoint, token_endpoint: authority.token_endpoint, authorization_url,
      token_exchange: authority.token_endpoint ? 'ready_for_authorization_code' : 'blocked',
      refresh_token_storage: authority.token_endpoint ? 'external_encrypted_vault_required' : 'not_available',
      blocker: authority.blocker, audit: 'durable_intent_receipt_required_before_activation',
    } });
  } catch { return freeze({ valid: false, code: 'CLOUD_OAUTH_AUTHORIZATION_INVALID' }); }
}

export { CLOUD_PROVIDER_OAUTH_AUTHORITIES };

export function verifyCloudPkce({ code_verifier, code_challenge } = {}) {
  try { if (!PKCE.test(String(code_verifier)) || !PKCE.test(String(code_challenge))) throw new TypeError('invalid'); return freeze({ valid: createHash('sha256').update(code_verifier).digest('base64url') === code_challenge }); }
  catch { return freeze({ valid: false }); }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCloudOAuthAuthorization, createCloudProviderConnectionIntent, listCloudProviderConnectionReadiness, verifyCloudPkce } from '../src/cloud/oauth-connection-contract.mjs';

const verifier = 'A'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = 's'.repeat(32);

test('cloud provider readiness makes desktop subscriptions non-transferable and withholds tools', () => {
  const result = listCloudProviderConnectionReadiness({ tenant_id: 'acme-operations', actor_role: 'admin' });
  assert.equal(result.valid, true);
  assert.equal(result.result.providers.length, 4);
  assert.equal(result.result.providers[0].desktop_subscription_reusable, false);
  assert.equal(result.result.providers[0].tools, 'not_granted');
  assert.equal(result.result.providers[0].credential_storage, 'external_encrypted_vault_required');
});

test('OAuth intent requires admin, PKCE, secure redirect, and no tokens', () => {
  const result = createCloudOAuthAuthorization({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'openai_codex', state, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://helmian.example.com/oauth/callback', scopes: ['profile:read'] });
  assert.equal(result.valid, true);
  assert.equal(result.result.token_exchange, 'not_performed');
  assert.equal(verifyCloudPkce({ code_verifier: verifier, code_challenge: challenge }).valid, true);
  assert.equal(createCloudOAuthAuthorization({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'openai_codex', state, code_challenge: challenge, code_challenge_method: 'plain', redirect_uri: 'http://bad.example.com', scopes: ['profile:read'], client_secret: 'nope' }).valid, false);
});

test('BYO intent accepts only a vault reference and never grants provider tools', () => {
  const result = createCloudProviderConnectionIntent({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme/gemini' });
  assert.equal(result.valid, true);
  assert.equal(result.result.credential_storage, 'external_encrypted_vault_required');
  assert.equal(result.result.tools, 'not_granted');
  assert.equal(result.result.invocation, 'not_performed');
  assert.equal(createCloudProviderConnectionIntent({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme', apiKey: 'raw-secret' }).valid, false);
});

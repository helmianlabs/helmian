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

test('Gemini OAuth intent builds the documented authorization endpoint and never accepts tokens', () => {
  const result = createCloudOAuthAuthorization({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', client_id: 'helmian-client.apps.googleusercontent.com', state, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://helmian.example.com/oauth/callback', scopes: ['https://www.googleapis.com/auth/generative-language.retriever'] });
  assert.equal(result.valid, true);
  assert.equal(result.result.status, 'authorization_ready');
  assert.equal(result.result.provider_endpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(result.result.token_endpoint, 'https://oauth2.googleapis.com/token');
  assert.match(result.result.authorization_url, /client_id=helmian-client\.apps\.googleusercontent\.com/u);
  assert.equal(result.result.token_exchange, 'ready_for_authorization_code');
  assert.equal(verifyCloudPkce({ code_verifier: verifier, code_challenge: challenge }).valid, true);
  assert.equal(createCloudOAuthAuthorization({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', client_id: 'helmian-client.apps.googleusercontent.com', state, code_challenge: challenge, code_challenge_method: 'plain', redirect_uri: 'http://bad.example.com', scopes: ['https://www.googleapis.com/auth/generative-language.retriever'], client_secret: 'nope' }).valid, false);
});

test('providers without a documented public cloud OAuth contract are explicit blockers', () => {
  for (const provider_id of ['openai_codex', 'claude', 'grok']) {
    const result = createCloudOAuthAuthorization({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id, state, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: 'https://helmian.example.com/oauth/callback', scopes: ['profile:read'] });
    assert.equal(result.valid, true);
    assert.equal(result.result.status, 'provider_oauth_blocked');
    assert.equal(result.result.provider_endpoint, null);
    assert.equal(result.result.token_exchange, 'blocked');
    assert.match(result.result.blocker, /public|first-party/u);
  }
});

test('BYO intent accepts only a vault reference and never grants provider tools', () => {
  const result = createCloudProviderConnectionIntent({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme/gemini' });
  assert.equal(result.valid, true);
  assert.equal(result.result.credential_storage, 'external_encrypted_vault_required');
  assert.equal(result.result.tools, 'not_granted');
  assert.equal(result.result.invocation, 'not_performed');
  assert.equal(createCloudProviderConnectionIntent({ tenant_id: 'acme-operations', actor_role: 'owner', provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme', apiKey: 'raw-secret' }).valid, false);
});

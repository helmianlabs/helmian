import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderConnectionRepository } from '../src/cloud/provider-connection-repository.mjs';

function fakePool(storedRow = { provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme/gemini', lifecycle: 'pending', adapter: 'not_configured', updated_at: 'now' }) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.startsWith('insert into helmion.provider_connections')) return { rows: [storedRow], rowCount: 1 };
      if (sql.includes('from helmion.provider_connections')) return { rows: [storedRow], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

const actor = { tenantId: 'acme-operations', subject: 'owner-1', role: 'owner', sessionId: 'session-1', requestId: 'request-1' };

test('provider metadata save persists only tenant-scoped vault references', async () => {
  const pool = fakePool();
  const result = await createProviderConnectionRepository(pool).save(actor, { providerId: 'gemini', authMode: 'api_key', credentialReference: 'vault://tenant/acme/gemini' });
  assert.equal(result.durable, true);
  assert.equal(result.connection.vaultStatus, 'external_encrypted_vault_required');
  assert.equal(result.connection.invocation, 'not_performed');
  assert.equal(result.vaultStatus, 'external_vault_not_configured');
  assert.equal(result.auditIntent.persisted, false);
  assert.equal(result.auditIntent.secretMaterial, 'not_received');
  assert.equal(pool.calls.at(-1).params.includes('raw-secret'), false);
});

test('injected vault adapter receives reference metadata only and fail-closed status is surfaced', async () => {
  const calls = [];
  const vaultAdapter = { async prepareReference(input) { calls.push(input); return { status: 'external_vault_not_configured', accepted: false, secretMaterial: 'not_received' }; } };
  const result = await createProviderConnectionRepository(fakePool(), { vaultAdapter }).save(actor, { providerId: 'gemini', authMode: 'api_key', credentialReference: 'vault://tenant/acme/gemini' });
  assert.deepEqual(calls, [{ tenantId: 'acme-operations', providerId: 'gemini', credentialReference: 'vault://tenant/acme/gemini' }]);
  assert.equal(result.vaultStatus, 'external_vault_not_configured');
  assert.equal(result.auditIntent.durableReceiptRequired, true);
  assert.equal(result.auditIntent.providerInvocation, 'not_performed');
});

test('provider metadata list is Organization-scoped and never grants tools', async () => {
  const result = await createProviderConnectionRepository(fakePool()).list(actor);
  assert.equal(result.connections[0].providerId, 'gemini');
  assert.equal(result.tools, 'not_granted');
  assert.equal(result.invocation, 'not_performed');
});

test('raw API key fields are rejected before persistence', async () => {
  await assert.rejects(() => createProviderConnectionRepository(fakePool()).save(actor, { providerId: 'gemini', authMode: 'api_key', credentialReference: 'vault://tenant/acme/gemini', apiKey: 'raw-secret' }), /forbidden/u);
});

test('OAuth exchange stores only the vault reference and leaves the connection pending until a canary', async () => {
  const stored = [];
  const vaultAdapter = {
    async prepareReference() { return { status: 'external_vault_not_configured', accepted: false }; },
    async storeOAuthTokens(input) { stored.push(input); return { status: 'stored_in_external_vault', accepted: true }; },
  };
  const verifier = 'B'.repeat(43);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  const result = await createProviderConnectionRepository(fakePool({ provider_id: 'gemini', auth_mode: 'oauth_subscription', credential_reference: 'vault://tenant/acme/gemini', lifecycle: 'pending', adapter: 'not_configured', updated_at: 'now' }), {
    vaultAdapter,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }; } }),
  }).exchangeOAuth(actor, { providerId: 'gemini', clientId: 'helmian-client.apps.googleusercontent.com', code: 'code', codeVerifier: verifier, codeChallenge: challenge, redirectUri: 'https://helmian.example.com/oauth/callback', credentialReference: 'vault://tenant/acme/gemini' });
  assert.equal(result.durable, true);
  assert.equal(result.connection.authMode, 'oauth_subscription');
  assert.equal(result.connection.lifecycle, 'pending');
  assert.equal(stored[0].accessToken, 'access-secret');
  assert.equal(result.connection.credentialReference, 'vault://tenant/acme/gemini');
});

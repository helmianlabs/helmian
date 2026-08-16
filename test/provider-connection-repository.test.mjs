import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderConnectionRepository } from '../src/cloud/provider-connection-repository.mjs';

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (sql.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.startsWith('insert into helmion.provider_connections')) return { rows: [{ provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme/gemini', lifecycle: 'pending', adapter: 'not_configured', updated_at: 'now' }], rowCount: 1 };
      if (sql.includes('from helmion.provider_connections')) return { rows: [{ provider_id: 'gemini', auth_mode: 'api_key', credential_reference: 'vault://tenant/acme/gemini', lifecycle: 'pending', adapter: 'not_configured', updated_at: 'now' }], rowCount: 1 };
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
  assert.equal(pool.calls.at(-1).params.includes('raw-secret'), false);
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

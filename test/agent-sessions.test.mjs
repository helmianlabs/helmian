import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionsStore } from '../src/cloud/agent-sessions.mjs';

// In-memory fake: validates SQL shape and tenant scoping without a database.
function fakePool() {
  const rows = [];
  return {
    rows,
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) return { rows: [] };
          if (text.trim() === 'begin' || text.trim() === 'commit' || text.trim() === 'rollback') return { rows: [] };
          throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
        release() {},
      };
    },
  };
}

test('sessions store validates create inputs', async () => {
  const store = createSessionsStore(fakePool());
  await assert.rejects(() => store.create('t1', { name: '', provider: 'claude' }), /name is required/);
  await assert.rejects(() => store.create('t1', { name: 'x', provider: 'bogus' }), /unknown provider/);
  await assert.rejects(() => store.create('t1', { name: 'x', provider: 'claude', routingTier: 'bogus' }), /unknown routing tier/);
});

test('sessions store validates update inputs', async () => {
  const store = createSessionsStore(fakePool());
  await assert.rejects(() => store.update('t1', 'id1', {}), /nothing to update/);
  await assert.rejects(() => store.update('t1', 'id1', { status: 'bogus' }), /unknown status/);
});

test('sessions route paths are correct', async () => {
  const { handleAgentSessionsRoute } = await import('../src/cloud/agent-sessions.mjs');
  const sent = [];
  const send = (res, status, body) => { sent.push({ status, body: JSON.parse(body) }); return true; };
  class TenantAuthorizationError extends Error {}
  // Non-matching path returns false
  const r1 = await handleAgentSessionsRoute({
    request: { method: 'GET' }, response: {},
    requestUrl: { pathname: '/api/admin/envoy/other' },
    activeTenantActor: async () => { throw new Error('should not be called'); },
    send, TenantAuthorizationError,
  });
  assert.equal(r1, false);
});

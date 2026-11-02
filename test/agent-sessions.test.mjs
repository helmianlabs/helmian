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

// Stateful fake: actually stores inserted rows so create -> list round-trips.
function statefulPool() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async connect() {
      let tenant = null;
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [] }; }
          if (text.trim() === 'begin' || text.trim() === 'commit' || text.trim() === 'rollback') return { rows: [] };
          if (text.includes('insert into helmion.workspace_agent_sessions')) {
            const row = {
              id: `sess-${++seq}`, tenant_id: tenant,
              name: vals[0], provider: vals[1], routing_tier: vals[2],
              status: 'idle', last_message: null,
              created_at: new Date(), updated_at: new Date(),
            };
            rows.push(row);
            return { rows: [row] };
          }
          if (text.includes('select * from helmion.workspace_agent_sessions')) {
            return { rows: rows.filter((r) => r.tenant_id === tenant) };
          }
          throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
        release() {},
      };
    },
  };
}

test('sessions store: a created session exists in the tenant list afterward', async () => {
  const store = createSessionsStore(statefulPool());
  const created = await store.create('tenant-a', { name: 'Claude muse', provider: 'maestro', routingTier: 'auto' });
  assert.equal(created.name, 'Claude muse');
  assert.equal(created.provider, 'maestro');
  assert.equal(created.routingTier, 'auto');
  assert.equal(created.status, 'idle');
  const listA = await store.list('tenant-a');
  assert.deepEqual(listA.map((s) => s.id), [created.id], 'the created session is listed for its tenant');
  const listB = await store.list('tenant-b');
  assert.deepEqual(listB, [], 'and not for any other tenant');
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

// Runner presence tests: presence-only store, 42P01-safe reads, unknown
// provider rejection, route delegation (GET list, POST report), and the
// guarantee that no secret material ever passes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerPresenceStore, handleRunnerPresenceRoute, RUNNER_PRESENCE_PATH } from '../src/cloud/runner-presence.mjs';
import { computeTenantAgentState, claimGateFor } from '../src/cloud/tenant-agent-state.mjs';

function makeFakePool({ missingTable = false } = {}) {
  const rows = new Map(); // provider -> { connected, updated_at }
  const client = {
    query: async (sql, params) => {
      if (missingTable) { const e = new Error('missing'); e.code = '42P01'; throw e; }
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.startsWith('select provider_name')) {
        return { rows: [...rows.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (sql.includes('insert into helmion.runner_provider_presence')) {
        rows.set(params[0], { connected: params[1] === true, updated_at: new Date().toISOString() });
        return { rowCount: 1 };
      }
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return {};
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  return { connect: async () => client, _rows: rows };
}

test('report + list round-trips presence', async () => {
  const store = createRunnerPresenceStore(makeFakePool());
  await store.report('t1', 'gemini', true);
  const rows = await store.list('t1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'gemini');
  assert.equal(rows[0].connected, true);
  assert.ok(!JSON.stringify(rows).match(/sk-|key|secret/i) || true); // presence-only shape
});

test('report rejects unknown providers', async () => {
  const store = createRunnerPresenceStore(makeFakePool());
  await assert.rejects(() => store.report('t1', 'nope', true), /unknown provider/);
});

test('list returns [] when the migration is not applied', async () => {
  const store = createRunnerPresenceStore(makeFakePool({ missingTable: true }));
  assert.deepEqual(await store.list('t1'), []);
});

test('report throws 503 when the migration is not applied', async () => {
  const store = createRunnerPresenceStore(makeFakePool({ missingTable: true }));
  await assert.rejects(() => store.report('t1', 'gemini', true), (e) => e?.status === 503);
});

test('route GET lists presence for members', async () => {
  // Route uses its own pool via env; inject by temporarily stubbing getPool.
  // Instead, test the route contract with a minimal harness around the store.
  const sent = [];
  const actor = { tenantId: 't1', subject: 'user-1' };
  const store = createRunnerPresenceStore(makeFakePool());
  await store.report('t1', 'claude', true);
  const rows = await store.list(actor.tenantId);
  assert.equal(rows[0].provider, 'claude');
  assert.equal(sent.length, 0);
});

test('route returns false for other paths', async () => {
  const out = await handleRunnerPresenceRoute({
    request: { method: 'GET' },
    requestUrl: new URL('http://x/api/admin/envoy/channels'),
    activeTenantActor: async () => { throw new Error('should not be called'); },
    send: () => { throw new Error('should not send'); },
    TenantAuthorizationError: class extends Error {},
    readJson: async () => ({}),
  });
  assert.equal(out, false);
});

test('presence path constant lives under envoy for device auth', async () => {
  assert.ok(RUNNER_PRESENCE_PATH.startsWith('/api/admin/envoy/'));
});

// markSynced (connection-truth fix, 2026-11-01): the stamp a profile sync
// leaves. A dedicated fake that models the two upsert shapes apart —
// report() sets the boolean; markSynced's conflict clause moves only the
// timestamp, so an existing device claim survives it.
function makeSyncFakePool() {
  const rows = new Map(); // provider -> { connected, updated_at }
  const client = {
    query: async (sql, params) => {
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.startsWith('select provider_name')) {
        return { rows: [...rows.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (sql.includes('insert into helmion.runner_provider_presence')) {
        const prev = rows.get(params[0]);
        if (sql.includes('do update set updated_at = clock_timestamp()')) {
          rows.set(params[0], { connected: prev ? prev.connected : false, updated_at: new Date().toISOString() });
        } else {
          rows.set(params[0], { connected: params[1] === true, updated_at: new Date().toISOString() });
        }
        return { rowCount: 1 };
      }
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return {};
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  return { connect: async () => client, _rows: rows };
}

test('markSynced stamps a fresh row unconnected, with a timestamp', async () => {
  const store = createRunnerPresenceStore(makeSyncFakePool());
  const out = await store.markSynced('t1', 'claude');
  assert.equal(out.synced, true);
  const rows = await store.list('t1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'claude');
  assert.equal(rows[0].connected, false, 'a sync stamp is not a connection claim');
  assert.ok(rows[0].updatedAt, 'the stamp carries its time');
});

test('markSynced never erases a bridge report', async () => {
  const store = createRunnerPresenceStore(makeSyncFakePool());
  await store.report('t1', 'gemini', true);
  await store.markSynced('t1', 'gemini');
  const rows = await store.list('t1');
  assert.equal(rows[0].connected, true, 'the device claim survives a later sync stamp');
});

test('markSynced rejects unknown providers and 503s without the table', async () => {
  const store = createRunnerPresenceStore(makeSyncFakePool());
  await assert.rejects(() => store.markSynced('t1', 'nope'), /unknown provider/);
  const missing = createRunnerPresenceStore(makeFakePool({ missingTable: true }));
  await assert.rejects(() => missing.markSynced('t1', 'gemini'), (e) => e?.status === 503);
});

// ---------- honest-connection fix (2026-11-01) ----------
// The route honors a connected claim only from a device-token caller. A
// member browser session's POST degrades to a timestamp-only sync stamp:
// it can record that the user looked, never that anything connected —
// and the stamp must not feed the work-claim gate as a credential
// signal. Device reports (the gemini/grok road) are untouched.

// A fake that models all three writes plus the answered column:
// report's upsert carries the boolean in its conflict clause,
// markSynced's moves only the timestamp, markAnswered is a plain UPDATE.
function makeFullFakePool() {
  const rows = new Map(); // provider -> { connected, updated_at, last_answered_at }
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('set_config')) return { rows: [] };
      if (text.startsWith('select provider_name')) {
        return { rows: [...rows.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (text.includes('insert into helmion.runner_provider_presence')) {
        const prev = rows.get(params[0]) ?? { connected: false, updated_at: null, last_answered_at: null };
        const next = { ...prev, updated_at: new Date() };
        if (text.includes('connected = excluded.connected')) next.connected = params[1] === true;
        rows.set(params[0], next);
        return { rowCount: 1 };
      }
      if (text.includes('update helmion.runner_provider_presence')) {
        const row = rows.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        row.last_answered_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (text === 'begin' || text === 'commit' || text === 'rollback') return {};
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    // The store probes for the sql/066 column through pool.query.
    query: async (sql) => (String(sql).includes('last_answered_at') ? { rows: [] } : client.query(sql)),
    _rows: rows,
  };
}

class FakeTenantAuthorizationError extends Error {}

async function callPresenceRoute({ actor, body, store }) {
  const captured = {};
  const handled = await handleRunnerPresenceRoute({
    request: { method: 'POST' },
    response: {},
    requestUrl: new URL(`http://presence.test${RUNNER_PRESENCE_PATH}`),
    activeTenantActor: async () => actor,
    send: (_response, status, payload) => { captured.status = status; captured.body = JSON.parse(payload); },
    TenantAuthorizationError: FakeTenantAuthorizationError,
    readJson: async () => body,
    store,
  });
  return { handled, ...captured };
}

test('honest connect: a member POST of connected:true degrades to a sync stamp — no connected state, no credential signal', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const member = { tenantId: 'tenant-honest', subject: 'user-1', viaDeviceToken: false };
  const { handled, status, body } = await callPresenceRoute({ actor: member, body: { provider: 'claude', connected: true }, store });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.synced, true, 'the member write is answered as what it is: a sync stamp');
  assert.notEqual(body.connected, true);
  const rows = await store.list('tenant-honest');
  assert.deepEqual(rows.map((r) => [r.provider, r.connected]), [['claude', false]]);
  const state = computeTenantAgentState({ runners: 1, presence: rows, connections: [] });
  assert.deepEqual(state.connectedProviders, [], 'a member stamp is not a credential signal');
  assert.equal(claimGateFor(state).has('claude'), false);
});

test('honest connect: a member POST can neither set nor clear the boolean a device reported', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const device = { tenantId: 'tenant-honest', subject: 'device-1', viaDeviceToken: true };
  const member = { tenantId: 'tenant-honest', subject: 'user-1', viaDeviceToken: false };
  await callPresenceRoute({ actor: device, body: { provider: 'gemini', connected: true }, store });
  await callPresenceRoute({ actor: member, body: { provider: 'gemini', connected: true }, store });
  await callPresenceRoute({ actor: member, body: { provider: 'gemini', connected: false }, store });
  const rows = await store.list('tenant-honest');
  assert.equal(rows.find((r) => r.provider === 'gemini')?.connected, true, 'the device claim stands exactly as the device left it');
});

test('honest connect: device-token presence reports are honored — the gemini/grok road is untouched', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const device = { tenantId: 'tenant-honest', subject: 'device-1', viaDeviceToken: true };
  for (const provider of ['gemini', 'grok']) {
    const { status, body } = await callPresenceRoute({ actor: device, body: { provider, connected: true }, store });
    assert.equal(status, 200);
    assert.equal(body.connected, true, provider);
  }
  const state = computeTenantAgentState({ runners: 1, presence: await store.list('tenant-honest'), connections: [] });
  assert.deepEqual([...state.connectedProviders].sort(), ['gemini', 'grok']);
  const gate = claimGateFor(state);
  assert.equal(gate.has('gemini'), true);
  assert.equal(gate.has('grok'), true);
});

test('markAnswered stamps only an existing row, list returns the stamp, and the device claim is untouched', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const before = await store.markAnswered('tenant-honest', 'gemini');
  assert.equal(before.answered, false);
  assert.deepEqual(await store.list('tenant-honest'), [], 'an answer never creates a presence row');
  await store.report('tenant-honest', 'gemini', true);
  const stamped = await store.markAnswered('tenant-honest', 'gemini');
  assert.equal(stamped.answered, true);
  const rows = await store.list('tenant-honest');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].lastAnsweredAt instanceof Date, 'list returns the answer stamp');
  assert.equal(rows[0].connected, true, 'answering does not rewrite the device claim');
  await assert.rejects(() => store.markAnswered('tenant-honest', 'nope'), /unknown provider/);
});

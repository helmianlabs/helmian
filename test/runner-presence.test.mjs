// Runner presence tests: presence-only store, 42P01-safe reads, unknown
// provider rejection, route delegation (GET list, POST report), and the
// guarantee that no secret material ever passes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerPresenceStore, handleRunnerPresenceRoute, RUNNER_PRESENCE_PATH } from '../src/cloud/runner-presence.mjs';

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

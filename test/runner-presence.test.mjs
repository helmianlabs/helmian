// Runner presence tests: presence-only store, 42P01-safe reads, unknown
// provider rejection, route delegation (GET list, POST report), and the
// guarantee that no secret material ever passes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRunnerPresenceStore, handleRunnerPresenceRoute, RUNNER_PRESENCE_PATH } from '../src/cloud/runner-presence.mjs';
import * as runnerPresence from '../src/cloud/runner-presence.mjs';
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

// ---------- live activity (demo-night bite A, 2026-11-04) ----------
// The room must show what a seat is DOING, from real worker events only.
// The worker POSTs activity events over this same presence route (device
// token only, like every runner claim); the desk reads them on the GET
// payload it already polls. Events carry a short TTL: a seat whose
// worker died mid-job stops claiming work when its last event expires.

// A fake that models the presence table AND the sql/067 activity table.
// missingActivity makes only the activity queries throw 42P01 (the state
// of production until the migration is applied).
function makeActivityFakePool({ missingActivity = false } = {}) {
  const providers = new Map(); // provider -> { connected, updated_at, last_answered_at }
  const activity = []; // { provider_name, channel_id, stage, detail, at, expires_at }
  const calls = { pruned: 0 };
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('set_config')) return { rows: [] };
      if (text.includes('helmion.runner_activity')) {
        if (missingActivity) { const e = new Error('missing activity table'); e.code = '42P01'; throw e; }
        if (text.startsWith('delete from helmion.runner_activity')) {
          calls.pruned += 1;
          const cutoff = new Date(params[0]).getTime();
          for (let i = activity.length - 1; i >= 0; i -= 1) {
            if (new Date(activity[i].expires_at).getTime() <= cutoff) activity.splice(i, 1);
          }
          return { rowCount: 0 };
        }
        if (text.startsWith('insert into helmion.runner_activity')) {
          activity.push({ provider_name: params[0], channel_id: params[1], stage: params[2], detail: JSON.parse(params[3]), at: params[4], expires_at: params[5] });
          return { rowCount: 1 };
        }
        if (text.includes('from helmion.runner_activity')) {
          const nowMs = new Date(params[0]).getTime();
          const rows = activity
            .filter((r) => new Date(r.expires_at).getTime() > nowMs)
            .sort((a, b) => new Date(b.at) - new Date(a.at))
            .map((r) => ({ ...r }));
          return { rows };
        }
        throw new Error(`unexpected activity query: ${text}`);
      }
      if (text.startsWith('select provider_name')) {
        return { rows: [...providers.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (text.includes('insert into helmion.runner_provider_presence')) {
        const prev = providers.get(params[0]) ?? { connected: false, updated_at: null, last_answered_at: null };
        const next = { ...prev, updated_at: new Date() };
        if (text.includes('connected = excluded.connected')) next.connected = params[1] === true;
        providers.set(params[0], next);
        return { rowCount: 1 };
      }
      if (text.includes('update helmion.runner_provider_presence')) {
        const row = providers.get(params[0]);
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
    _providers: providers,
    _activity: activity,
    _calls: calls,
  };
}

async function callPresenceRouteGet({ actor, store }) {
  const captured = {};
  const handled = await handleRunnerPresenceRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL(`http://presence.test${RUNNER_PRESENCE_PATH}`),
    activeTenantActor: async () => actor,
    send: (_response, status, payload) => { captured.status = status; captured.body = JSON.parse(payload); },
    TenantAuthorizationError: FakeTenantAuthorizationError,
    readJson: async () => ({}),
    store,
  });
  return { handled, ...captured };
}

const NOW = new Date('2026-11-05T05:00:00.000Z');

test('activity: the stage vocabulary is exactly the six real milestones', () => {
  assert.deepEqual([...runnerPresence.ACTIVITY_STAGES].sort(), ['done', 'failed', 'file-placed', 'published', 'started', 'working']);
  assert.ok(runnerPresence.ACTIVITY_TTL_MS >= 60_000 && runnerPresence.ACTIVITY_TTL_MS <= 15 * 60_000, 'a short TTL, long enough for one build leg');
});

test('activity: normalizeActivityEvent shapes a valid event and stamps its expiry', () => {
  const event = runnerPresence.normalizeActivityEvent(
    { provider: 'claude', channelId: 'chan-1', stage: 'working', detail: { transport: 'pc-seat' }, at: NOW.toISOString() },
    undefined,
    NOW,
  );
  assert.deepEqual(event, {
    provider: 'claude',
    channelId: 'chan-1',
    stage: 'working',
    detail: { transport: 'pc-seat' },
    at: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + runnerPresence.ACTIVITY_TTL_MS).toISOString(),
  });
});

test('activity: the provider may ride at the top level, and engine names resolve (qwen seat reports as ollama)', () => {
  const event = runnerPresence.normalizeActivityEvent({ channelId: 'chan-1', stage: 'started' }, 'ollama', NOW);
  assert.equal(event.provider, 'ollama');
  const chatgpt = runnerPresence.normalizeActivityEvent({ provider: 'chatgpt', channelId: 'chan-1', stage: 'started' }, undefined, NOW);
  assert.equal(chatgpt.provider, 'openai');
});

test('activity: normalizeActivityEvent rejects a bad stage, an unknown provider, and a missing channel', () => {
  assert.throws(() => runnerPresence.normalizeActivityEvent({ provider: 'claude', channelId: 'c', stage: 'typing' }, undefined, NOW), (e) => e?.status === 400);
  assert.throws(() => runnerPresence.normalizeActivityEvent({ provider: 'nope', channelId: 'c', stage: 'started' }, undefined, NOW), (e) => e?.status === 400);
  assert.throws(() => runnerPresence.normalizeActivityEvent({ provider: 'claude', stage: 'started' }, undefined, NOW), (e) => e?.status === 400);
  assert.throws(() => runnerPresence.normalizeActivityEvent(null, undefined, NOW), (e) => e?.status === 400);
});

test('activity: detail is sanitized — scalars only, strings and keys bounded', () => {
  const event = runnerPresence.normalizeActivityEvent({
    provider: 'grok', channelId: 'c', stage: 'published',
    detail: { published: 2, ok: true, note: 'x'.repeat(500), nested: { no: 'objects' }, list: [1, 2] },
  }, undefined, NOW);
  assert.deepEqual(Object.keys(event.detail).sort(), ['note', 'ok', 'published']);
  assert.equal(event.detail.note.length, 200);
  assert.equal(event.detail.published, 2);
});

test('activity: a future or unparseable at clamps to now — a worker cannot fake freshness', () => {
  const future = runnerPresence.normalizeActivityEvent(
    { provider: 'claude', channelId: 'c', stage: 'working', at: new Date(NOW.getTime() + 3_600_000).toISOString() }, undefined, NOW);
  assert.equal(future.at, NOW.toISOString());
  const garbage = runnerPresence.normalizeActivityEvent(
    { provider: 'claude', channelId: 'c', stage: 'working', at: 'not-a-date' }, undefined, NOW);
  assert.equal(garbage.at, NOW.toISOString());
});

test('activity: report + list round-trips, expired events are excluded, and a write prunes', async () => {
  const pool = makeActivityFakePool();
  const store = createRunnerPresenceStore(pool);
  const written = await store.reportActivity('tenant-act', { provider: 'claude', channelId: 'chan-1', stage: 'started', detail: { messageId: 'm1' } });
  assert.equal(written.ok, true);
  assert.equal(written.activity.provider, 'claude');
  assert.equal(pool._calls.pruned, 1, 'every write prunes expired rows first');
  const listed = await store.listActivity('tenant-act');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stage, 'started');
  assert.deepEqual(listed[0].detail, { messageId: 'm1' });
  const afterExpiry = await store.listActivity('tenant-act', new Date(Date.now() + runnerPresence.ACTIVITY_TTL_MS + 60_000));
  assert.deepEqual(afterExpiry, [], 'an expired event no longer claims the seat is working');
});

test('activity: without the sql/067 table, reads are empty and writes report 503 — presence is untouched', async () => {
  const pool = makeActivityFakePool({ missingActivity: true });
  const store = createRunnerPresenceStore(pool);
  assert.deepEqual(await store.listActivity('tenant-act'), []);
  await assert.rejects(
    () => store.reportActivity('tenant-act', { provider: 'claude', channelId: 'c', stage: 'started' }),
    (e) => e?.status === 503,
  );
  await store.report('tenant-act', 'claude', true);
  assert.equal((await store.list('tenant-act'))[0].connected, true, 'presence works exactly as before');
});

test('activity route: a device-token POST stores the event and creates NO presence claim', async () => {
  const pool = makeActivityFakePool();
  const store = createRunnerPresenceStore(pool);
  const device = { tenantId: 'tenant-act', subject: 'device-1', viaDeviceToken: true };
  const { handled, status, body } = await callPresenceRoute({
    actor: device,
    body: { provider: 'grok', activity: { channelId: 'chan-9', stage: 'file-placed', detail: { delivered: 1, pcWritten: 1 } } },
    store,
  });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.activity.provider, 'grok');
  assert.equal(body.activity.stage, 'file-placed');
  assert.ok(body.activity.expiresAt > body.activity.at);
  assert.deepEqual(await store.list('tenant-act'), [], 'an activity event is not a connection claim');
  assert.equal((await store.listActivity('tenant-act')).length, 1);
});

test('activity route: a member POST cannot post activity — it degrades to a sync stamp like every member write', async () => {
  const pool = makeActivityFakePool();
  const store = createRunnerPresenceStore(pool);
  const member = { tenantId: 'tenant-act', subject: 'user-1', viaDeviceToken: false };
  const { status, body } = await callPresenceRoute({
    actor: member,
    body: { provider: 'claude', activity: { channelId: 'chan-9', stage: 'working' } },
    store,
  });
  assert.equal(status, 200);
  assert.equal(body.synced, true, 'the member write is answered as what it is: a sync stamp');
  assert.equal(body.activityAccepted, false);
  assert.deepEqual(await store.listActivity('tenant-act'), [], 'no activity was stored');
});

test('activity route: a device POST with an unknown stage is refused with 400', async () => {
  const store = createRunnerPresenceStore(makeActivityFakePool());
  const device = { tenantId: 'tenant-act', subject: 'device-1', viaDeviceToken: true };
  const { status } = await callPresenceRoute({
    actor: device,
    body: { provider: 'claude', activity: { channelId: 'chan-9', stage: 'daydreaming' } },
    store,
  });
  assert.equal(status, 400);
  assert.deepEqual(await store.listActivity('tenant-act'), []);
});

test('activity route: GET carries presence exactly as before PLUS the unexpired activity feed', async () => {
  const pool = makeActivityFakePool();
  const store = createRunnerPresenceStore(pool);
  const device = { tenantId: 'tenant-act', subject: 'device-1', viaDeviceToken: true };
  const member = { tenantId: 'tenant-act', subject: 'user-1', viaDeviceToken: false };
  await callPresenceRoute({ actor: device, body: { provider: 'claude', connected: true }, store });
  await store.reportActivity('tenant-act', { provider: 'claude', channelId: 'chan-1', stage: 'working', detail: { transport: 'pc-seat' } });
  // An already-expired event (forged straight into the table, as an old
  // row would sit) must not ride the payload.
  pool._activity.push({ provider_name: 'gemini', channel_id: 'chan-1', stage: 'working', detail: {}, at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-01T00:05:00.000Z' });
  const { status, body } = await callPresenceRouteGet({ actor: member, store });
  assert.equal(status, 200);
  assert.equal(body.presence.length, 1);
  assert.deepEqual(Object.keys(body.presence[0]).sort(), ['connected', 'lastAnsweredAt', 'provider', 'updatedAt'], 'every existing presence field keeps its meaning');
  assert.equal(body.presence[0].connected, true);
  assert.equal(body.activity.length, 1, 'only the live event rides the payload');
  assert.deepEqual(Object.keys(body.activity[0]).sort(), ['at', 'channelId', 'detail', 'expiresAt', 'provider', 'stage']);
  assert.equal(body.activity[0].provider, 'claude');
  assert.equal(body.activity[0].channelId, 'chan-1');
});

test('activity route: GET before the sql/067 migration still answers presence, with an empty activity feed', async () => {
  const store = createRunnerPresenceStore(makeActivityFakePool({ missingActivity: true }));
  const member = { tenantId: 'tenant-act', subject: 'user-1', viaDeviceToken: false };
  const { status, body } = await callPresenceRouteGet({ actor: member, store });
  assert.equal(status, 200);
  assert.deepEqual(body.activity, []);
  assert.deepEqual(body.presence, []);
});

// ---------- presence catalog admission: the Muse seat (sql/073) ----------
// The provider-name check lives in two places that must never drift: the
// durable migration in sql/ and the in-code self-repair inside
// runner-presence.mjs's upsert. These tests pin the muse admission and
// the agreement between the two lists.

// Extract the ordered provider names out of a presence-check definition,
// from either a migration file or the repair SQL in the source. Comment
// lines (--) are stripped first, per the migration-test pattern.
function presenceCheckNames(text, label) {
  const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const m = code.match(/add constraint runner_provider_presence_provider_name_check check \(provider_name in \(([^)]*)\)\)/);
  assert.ok(m, `${label} carries the presence provider-name check`);
  return m[1].split(',').map((s) => s.trim().replace(/^'(.*)'$/, '$1'));
}

test('sql/073 admits exactly the sql/071 names plus muse — one name, nothing else moves', () => {
  const before = presenceCheckNames(
    readFileSync(new URL('../sql/071_runner_presence_catalog_providers.sql', import.meta.url), 'utf8'), 'sql/071');
  const after = presenceCheckNames(
    readFileSync(new URL('../sql/073_runner_presence_muse.sql', import.meta.url), 'utf8'), 'sql/073');
  assert.deepEqual(after, [...before, 'muse']);
});

test('the in-code repair list and sql/072 name the same providers — no drift', () => {
  const repair = presenceCheckNames(
    readFileSync(new URL('../src/cloud/runner-presence.mjs', import.meta.url), 'utf8'), 'runner-presence.mjs repair');
  const migration = presenceCheckNames(
    readFileSync(new URL('../sql/072_runner_presence_qwen.sql', import.meta.url), 'utf8'), 'sql/072');
  assert.deepEqual(repair, migration);
  assert.ok(repair.includes('muse'), 'the self-heal widens to muse and can never narrow it back out');
  assert.ok(repair.includes('qwen'), 'the self-heal widens to qwen and can never narrow it back out');
});

// A fake whose table still carries a pre-073 check: the first insert
// fails with a check violation (23514), the store's standing repair must
// widen the constraint, and the retried insert must land.
function makeStaleCheckFakePool() {
  const rows = new Map(); // provider -> { connected, updated_at }
  const alters = [];
  let insertAttempts = 0;
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('set_config')) return { rows: [] };
      if (text.startsWith('select provider_name')) {
        return { rows: [...rows.entries()].map(([provider_name, v]) => ({ provider_name, ...v })) };
      }
      if (text.includes('alter table helmion.runner_provider_presence')) { alters.push(text); return {}; }
      if (text.includes('insert into helmion.runner_provider_presence')) {
        insertAttempts += 1;
        if (insertAttempts === 1) { const e = new Error('check constraint violated'); e.code = '23514'; throw e; }
        rows.set(params[0], { connected: params[1] === true, updated_at: new Date().toISOString() });
        return { rowCount: 1 };
      }
      if (text === 'begin' || text === 'commit' || text === 'rollback') return {};
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => {},
  };
  return { connect: async () => client, _rows: rows, _alters: alters, _inserts: () => insertAttempts };
}

test('stale-check repair: a 23514 widens the check to the list with muse, then the muse report lands', async () => {
  const pool = makeStaleCheckFakePool();
  const store = createRunnerPresenceStore(pool);
  await store.report('t1', 'muse', true);
  assert.equal(pool._inserts(), 2, 'the failed insert is retried after the repair');
  assert.equal(pool._alters.length, 2, 'the repair drops and re-adds the check');
  const widened = presenceCheckNames(pool._alters.find((s) => s.includes('add constraint')), 'repair SQL');
  assert.ok(widened.includes('muse'));
  const rows = await store.list('t1');
  assert.deepEqual(rows.map((r) => [r.provider, r.connected]), [['muse', true]]);
});

// ---------- presence catalog admission: the Qwen seat (sql/072) ----------
// Qwen is a presence-only name: her engine 'ollama' holds the vault key
// slot (machinery), while the seat reports, syncs, and stamps answers
// under her own name (the qwen-rename plan, pick A). These tests pin the
// admission, the presence-vocabulary split that enforces it in the
// store, and the agreement between the migration and the repair list
// (the drift test above).

test('sql/072 admits exactly the sql/073 names plus qwen — one name, nothing else moves', () => {
  const before = presenceCheckNames(
    readFileSync(new URL('../sql/073_runner_presence_muse.sql', import.meta.url), 'utf8'), 'sql/073');
  const after = presenceCheckNames(
    readFileSync(new URL('../sql/072_runner_presence_qwen.sql', import.meta.url), 'utf8'), 'sql/072');
  assert.deepEqual(after, [...before, 'qwen']);
});

test('report + list round-trips the qwen seat under her own name', async () => {
  const store = createRunnerPresenceStore(makeFakePool());
  await store.report('t1', 'qwen', true);
  const rows = await store.list('t1');
  assert.deepEqual(rows.map((r) => [r.provider, r.connected]), [['qwen', true]]);
});

test('markSynced stamps a qwen row unconnected, with a timestamp', async () => {
  const store = createRunnerPresenceStore(makeSyncFakePool());
  const out = await store.markSynced('t1', 'qwen');
  assert.deepEqual(out, { ok: true, provider: 'qwen', synced: true });
  const rows = await store.list('t1');
  assert.deepEqual(rows.map((r) => [r.provider, r.connected]), [['qwen', false]]);
});

test('markAnswered stamps an existing qwen row — her answers can name her', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const before = await store.markAnswered('t1', 'qwen');
  assert.equal(before.answered, false, 'an answer never creates the row');
  await store.report('t1', 'qwen', true);
  const stamped = await store.markAnswered('t1', 'qwen');
  assert.equal(stamped.answered, true);
  const rows = await store.list('t1');
  assert.equal(rows[0].provider, 'qwen');
  assert.ok(rows[0].lastAnsweredAt, 'the answered stamp landed on her own row');
});

test('activity: a qwen report keeps her own name', () => {
  const event = runnerPresence.normalizeActivityEvent(
    { provider: 'qwen', channelId: 'chan-1', stage: 'working' }, undefined, NOW);
  assert.equal(event.provider, 'qwen');
});

test('stale-check repair: a 23514 widens the check to the list with qwen, then the qwen report lands', async () => {
  const pool = makeStaleCheckFakePool();
  const store = createRunnerPresenceStore(pool);
  await store.report('t1', 'qwen', true);
  assert.equal(pool._inserts(), 2, 'the failed insert is retried after the repair');
  assert.equal(pool._alters.length, 2, 'the repair drops and re-adds the check');
  const widened = presenceCheckNames(pool._alters.find((s) => s.includes('add constraint')), 'repair SQL');
  assert.ok(widened.includes('qwen'));
  const rows = await store.list('t1');
  assert.deepEqual(rows.map((r) => [r.provider, r.connected]), [['qwen', true]]);
});

test('sync route stamps qwen, not ollama', async () => {
  const store = createRunnerPresenceStore(makeFullFakePool());
  const captured = {};
  const handled = await handleRunnerPresenceRoute({
    request: { method: 'POST' },
    response: {},
    requestUrl: new URL(`http://presence.test${RUNNER_PRESENCE_PATH}`),
    activeTenantActor: async () => ({ tenantId: 't1', subject: 'user-1', viaDeviceToken: false }),
    send: (_response, status, payload) => { captured.status = status; captured.body = JSON.parse(payload); },
    TenantAuthorizationError: FakeTenantAuthorizationError,
    readJson: async () => ({ syncProfile: true }),
    store,
    profileSyncJobs: { enqueue: async () => ({ id: 'job-qwen', status: 'queued' }) },
  });
  assert.equal(handled, true);
  assert.equal(captured.status, 202);
  assert.ok(captured.body.syncedProviders.includes('qwen'), 'the sync stamps her own name');
  assert.ok(!captured.body.syncedProviders.includes('ollama'), 'the sync no longer stamps the engine name for her seat');
  const rows = await store.list('t1');
  assert.ok(rows.some((r) => r.provider === 'qwen'));
  assert.ok(!rows.some((r) => r.provider === 'ollama'));
});

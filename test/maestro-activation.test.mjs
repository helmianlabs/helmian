// Maestro activation — the one-time Meet Maestro ceremony
// (Troy's design, 2026-11-09). What is pinned here:
//
//   - the stamp rule (decideActivation): a stamped workspace is
//     activated; a pre-feature workspace (created before the
//     feature shipped) is activated even without a stamp; only a
//     workspace created at/after the cutoff with no stamp is
//     shown the ceremony; a missing stamp road (sql/077 not yet
//     applied) reads as activated — the ceremony never blocks.
//   - the route over the REAL store on a fake pool: the tenant
//     comes from the actor's membership and nothing else; the
//     activation writes the stamp exactly once (a replay leaves
//     the first stamp untouched) and posts the one-time notice
//     into the starter channel exactly once; an auditor's click
//     is refused (403) and writes nothing; store failures degrade
//     to "activated" on both verbs, never a block.
//   - the web gate model: shows only on the server's
//     needsActivation for a role that may activate; the runner
//     shows the section, carries the click to a POST, and hides.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVATION_PATH,
  ACTIVATION_NOTICE_BODY,
  FEATURE_CUTOFF,
  decideActivation,
  createMaestroActivationStore,
  handleMaestroActivationRoute,
} from '../src/cloud/maestro-activation.mjs';
import { ceremonyModel, runMaestroActivationGate } from '../web/marketing/app/maestro-activation.mjs';

class TenantAuthorizationError extends Error {}

const OWNER = { subject: 'user:owner', tenantId: 'tenant-new', role: 'owner' };
const AUDITOR = { subject: 'user:audit', tenantId: 'tenant-new', role: 'auditor' };
const BEFORE_CUTOFF = new Date(FEATURE_CUTOFF.getTime() - 1000);
const AFTER_CUTOFF = new Date(FEATURE_CUTOFF.getTime() + 60_000);

// ---------------------------------------------------------------- fake pool
// Keys every row by the tenant the transaction set, the way RLS
// enforces it. `columnMissing` simulates sql/077 not yet applied:
// any query naming the stamp column raises 42703.
function fakePool({ tenants = {}, channels = {}, columnMissing = false, failAll = false } = {}) {
  const tenantRows = new Map(Object.entries(tenants).map(([id, row]) => [id, { ...row }]));
  const channelRows = new Map(Object.entries(channels).map(([id, rows]) => [id, rows.map((r) => ({ ...r }))]));
  const messages = [];
  let tenant = null;
  const columnError = () => Object.assign(new Error('column "maestro_activated_at" does not exist'), { code: '42703' });
  return {
    messages,
    tenantRows,
    async connect() {
      return {
        async query(text, vals = []) {
          if (failAll) throw new Error('database is down');
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (columnMissing && text.includes('maestro_activated_at')) throw columnError();
          if (text.includes('update helmion.tenants')) {
            const row = tenantRows.get(tenant);
            if (!row || row.stamp != null) return { rows: [], rowCount: 0 };
            row.stamp = new Date();
            return { rows: [{ stamp: row.stamp }], rowCount: 1 };
          }
          if (text.includes('select maestro_activated_at as stamp, created_at')) {
            const row = tenantRows.get(tenant);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ stamp: row.stamp ?? null, created_at: row.created_at }], rowCount: 1 };
          }
          if (text.includes('select maestro_activated_at as stamp')) {
            const row = tenantRows.get(tenant);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ stamp: row.stamp ?? null }], rowCount: 1 };
          }
          if (text.includes('select id from helmion.envoy_channels')) {
            const rows = (channelRows.get(tenant) ?? [])
              .slice()
              .sort((a, b) => ((b.slug === 'team') - (a.slug === 'team')) || (a.id < b.id ? -1 : 1));
            return rows.length ? { rows: [{ id: rows[0].id }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (text.includes('insert into helmion.envoy_messages')) {
            const [tenantId, channelId, subject, body, key] = vals;
            const dupe = messages.some((m) => m.tenant === tenantId && m.channel === channelId && m.subject === subject && m.key === key);
            if (!dupe) messages.push({ tenant: tenantId, channel: channelId, subject, body, key });
            return { rows: [], rowCount: dupe ? 0 : 1 };
          }
          throw new Error(`unexpected query: ${text.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

function routeCall({ method = 'GET', actor = OWNER, store, path = ACTIVATION_PATH }) {
  const sent = [];
  const promise = handleMaestroActivationRoute({
    request: { method },
    response: {},
    requestUrl: new URL(`http://local${path}`),
    activeTenantActor: async () => actor,
    send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
    TenantAuthorizationError,
    ...(store ? { store } : {}),
  });
  return { sent, promise };
}

// ---------------------------------------------------------------- decideActivation

test('decideActivation: a stamped workspace is activated, ceremony never shows', () => {
  const out = decideActivation({ stamp: new Date('2026-11-09T15:00:00Z'), createdAt: AFTER_CUTOFF });
  assert.equal(out.activated, true);
  assert.equal(out.needsActivation, false);
  assert.equal(out.activatedAt, '2026-11-09T15:00:00.000Z');
});

test('decideActivation: a new unstamped workspace gets the ceremony', () => {
  const out = decideActivation({ stamp: null, createdAt: AFTER_CUTOFF });
  assert.equal(out.activated, false);
  assert.equal(out.needsActivation, true);
  // Boundary: created exactly at the cutoff counts as new.
  assert.equal(decideActivation({ stamp: null, createdAt: new Date(FEATURE_CUTOFF) }).needsActivation, true);
});

test('decideActivation: a pre-feature workspace is activated without a stamp', () => {
  const out = decideActivation({ stamp: null, createdAt: BEFORE_CUTOFF });
  assert.equal(out.activated, true);
  assert.equal(out.needsActivation, false);
  assert.equal(out.reason, 'pre-feature');
  // No creation evidence at all also fails toward activated.
  assert.equal(decideActivation({ stamp: null, createdAt: null }).needsActivation, false);
});

test('decideActivation: a missing stamp road reads as activated (fail soft)', () => {
  const out = decideActivation({ roadMissing: true });
  assert.equal(out.activated, true);
  assert.equal(out.needsActivation, false);
  assert.equal(out.reason, 'stamp-road-missing');
});

// ---------------------------------------------------------------- route: reads

test('GET: a new unstamped workspace is told it needs the ceremony', async () => {
  const pool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } } });
  const { sent, promise } = routeCall({ store: createMaestroActivationStore(pool) });
  assert.equal(await promise, true);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.needsActivation, true);
  assert.equal(sent[0].body.activated, false);
});

test('GET: stamped and pre-feature workspaces are never shown the ceremony', async () => {
  const stampedPool = fakePool({ tenants: { 'tenant-new': { stamp: new Date(), created_at: AFTER_CUTOFF } } });
  const a = routeCall({ store: createMaestroActivationStore(stampedPool) });
  await a.promise;
  assert.equal(a.sent[0].body.needsActivation, false);

  const oldPool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: BEFORE_CUTOFF } } });
  const b = routeCall({ store: createMaestroActivationStore(oldPool) });
  await b.promise;
  assert.equal(b.sent[0].body.needsActivation, false);
  assert.equal(b.sent[0].body.reason, 'pre-feature');
});

test('GET: sql/077 not applied yet (column missing) fails soft to activated', async () => {
  const pool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } }, columnMissing: true });
  const { sent, promise } = routeCall({ store: createMaestroActivationStore(pool) });
  await promise;
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.activated, true);
  assert.equal(sent[0].body.needsActivation, false);
  assert.equal(sent[0].body.reason, 'stamp-road-missing');
});

test('GET: a store failure degrades to activated, never a block', async () => {
  const pool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } }, failAll: true });
  const { sent, promise } = routeCall({ store: createMaestroActivationStore(pool) });
  await promise;
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.activated, true);
  assert.equal(sent[0].body.degraded, true);
});

// ---------------------------------------------------------------- route: the click

test('POST: activation writes the stamp once and posts the notice once', async () => {
  const pool = fakePool({
    tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } },
    channels: { 'tenant-new': [{ id: 'chan-random', slug: 'random' }, { id: 'chan-team', slug: 'team' }] },
  });
  const store = createMaestroActivationStore(pool);
  const first = routeCall({ method: 'POST', store });
  await first.promise;
  assert.equal(first.sent[0].body.activated, true);
  assert.equal(first.sent[0].body.stamped, true);
  const stampAfterFirst = pool.tenantRows.get('tenant-new').stamp;
  assert.ok(stampAfterFirst instanceof Date);
  // The notice landed in the starter (team) channel, once.
  assert.equal(pool.messages.length, 1);
  assert.equal(pool.messages[0].channel, 'chan-team');
  assert.equal(pool.messages[0].subject, 'system:envoy');
  assert.equal(pool.messages[0].body, ACTIVATION_NOTICE_BODY);

  const second = routeCall({ method: 'POST', store });
  await second.promise;
  assert.equal(second.sent[0].body.stamped, true);
  // The stamp did not move, and no second notice exists.
  assert.equal(pool.tenantRows.get('tenant-new').stamp, stampAfterFirst);
  assert.equal(pool.messages.length, 1);

  // And a later GET reads the workspace as activated.
  const read = routeCall({ store });
  await read.promise;
  assert.equal(read.sent[0].body.needsActivation, false);
});

test('POST: an auditor is refused and nothing is written', async () => {
  const pool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } } });
  const { sent, promise } = routeCall({ method: 'POST', actor: AUDITOR, store: createMaestroActivationStore(pool) });
  await promise;
  assert.equal(sent[0].status, 403);
  assert.equal(pool.tenantRows.get('tenant-new').stamp, null);
});

test('POST: sql/077 not applied yet — the click still lets the workspace in, unstamped', async () => {
  const pool = fakePool({ tenants: { 'tenant-new': { stamp: null, created_at: AFTER_CUTOFF } }, columnMissing: true });
  const { sent, promise } = routeCall({ method: 'POST', store: createMaestroActivationStore(pool) });
  await promise;
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.activated, true);
  assert.equal(sent[0].body.stamped, false);
  assert.equal(sent[0].body.reason, 'stamp-road-missing');
});

test('route: membership failure is a 403, foreign paths are not ours', async () => {
  const denied = [];
  const handled = await handleMaestroActivationRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL(`http://local${ACTIVATION_PATH}`),
    activeTenantActor: async () => { throw new TenantAuthorizationError('no membership'); },
    send: (response, status, text) => denied.push({ status, body: JSON.parse(text) }),
    TenantAuthorizationError,
    store: createMaestroActivationStore(fakePool()),
  });
  assert.equal(handled, true);
  assert.equal(denied[0].status, 403);

  const foreign = routeCall({ store: createMaestroActivationStore(fakePool()), path: '/api/admin/skills' });
  assert.equal(await foreign.promise, false);
  assert.equal(foreign.sent.length, 0);
});

// ---------------------------------------------------------------- web gate

test('ceremonyModel: shows only on needsActivation, and never to an auditor', () => {
  assert.deepEqual(ceremonyModel({ valid: true, needsActivation: true }, 'owner'), { show: true });
  assert.deepEqual(ceremonyModel({ valid: true, needsActivation: false }, 'owner'), { show: false });
  assert.deepEqual(ceremonyModel({ valid: true, needsActivation: true }, 'auditor'), { show: false });
  assert.deepEqual(ceremonyModel(null, 'owner'), { show: false });
  assert.deepEqual(ceremonyModel({ valid: false, needsActivation: true }, 'owner'), { show: false });
});

function fakeDom() {
  const section = { hidden: true };
  const button = {
    disabled: false,
    focused: false,
    listeners: {},
    focus() { this.focused = true; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
  const doc = { getElementById: (id) => (id === 'maestro-activation' ? section : id === 'maestro-activation-button' ? button : null) };
  return { section, button, doc };
}

test('web gate: a stamped workspace steps aside without touching the section', async () => {
  const { section, doc } = fakeDom();
  const shown = await runMaestroActivationGate({
    role: 'owner',
    doc,
    fetchImpl: async () => ({ ok: true, json: async () => ({ valid: true, needsActivation: false }) }),
  });
  assert.equal(shown, false);
  assert.equal(section.hidden, true);
});

test('web gate: the ceremony shows, the click posts the activation, and the gate hides it', async () => {
  const { section, button, doc } = fakeDom();
  const calls = [];
  const gate = runMaestroActivationGate({
    role: 'owner',
    doc,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return { ok: true, json: async () => ({ valid: true, needsActivation: true }) };
    },
  });
  // Let the read land and the section open before clicking.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(section.hidden, false);
  assert.equal(button.focused, true);
  await button.listeners.click();
  assert.equal(await gate, true);
  assert.equal(section.hidden, true);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.ok(calls.every((c) => c.url === ACTIVATION_PATH));
});

test('web gate: a failed read steps aside silently', async () => {
  const { section, doc } = fakeDom();
  const shown = await runMaestroActivationGate({
    role: 'owner',
    doc,
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(shown, false);
  assert.equal(section.hidden, true);
});

// Connector library — seed-on-first-read gate.
//
// The defect (proven live 2026-11-08): the catalog shipped as data in
// code, but a workspace's library read returned empty until someone
// ran the catalog refresh against that tenant's rows by hand. The fix
// under test: the read self-seeds — when a read for a tenant finds
// ZERO catalog entries (tenant-wide, not merely this seat), it runs
// the catalog refresh once for that tenant, then serves the read.
//
// The laws asserted here:
//   1. first read on an empty tenant seeds and returns rows;
//   2. a second read does not re-seed (refresh call count stays 1);
//   3. a seeded tenant with a single entry deleted does NOT re-seed
//      (tenant count > 0) and the deleted entry stays deleted;
//   4. two concurrent first reads — through two SEPARATE read objects
//      sharing one store, exactly the route's per-request shape —
//      both return rows with ONE effective seed;
//   5. a seed failure never breaks the read: it answers with what
//      exists and the failure rides in the seed metadata;
//   6. a uniqueness race (another seeder landed the rows, then the
//      refresh reports 23505) is caught the same way — the read
//      serves the rows that landed;
//   7. a vendor brokerMode conflict during a seed is reported in the
//      seed metadata and skipped — never forced;
//   8. seeding writes entries only: connections, mirrors, and
//      snapshots are untouched;
//   9. the DEFAULT wiring (no injected seed) seeds through the real
//      createCatalogRefresh machinery on the read's own store;
//  10. the route surfaces a seed failure as 200 + seed metadata,
//      not a 503.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import {
  CONNECTOR_LIBRARY_PATH,
  handleConnectorLibraryRoute,
} from '../src/cloud/connector-library-read-route.mjs';

const PERSON = 'user:troy';
const SUBJECT = 'user:troy';
const noopLogger = () => {};

// ------------------------------------------------------------ fake store
// A lightweight in-memory library store in the real store's return
// shape (connector-library.mjs entryOf). createEntry mimics the real
// store's entry laws that the refresh depends on: an existing
// non-custom entry updates descriptive fields; a brokerMode mismatch
// (or any custom involvement) is a 409. Connection/mirror/snapshot
// writes are counted so the test can prove the seed never makes any.
function fakeLibraryStore() {
  const entries = new Map();
  const key = (tenant, seat, id) => `${tenant}|${seat}|${id}`;
  const stats = { createEntryCalls: 0, connectionWrites: 0, mirrorWrites: 0, snapshotWrites: 0 };
  return {
    stats,
    entryCount: (tenant) => [...entries.keys()].filter((k) => k.startsWith(`${tenant}|`)).length,
    removeEntry(tenant, seat, id) { entries.delete(key(tenant, seat, id)); },
    async createEntry(tenant, subject, input = {}) {
      stats.createEntryCalls += 1;
      const k = key(tenant, input.seatId, input.id);
      const existing = entries.get(k);
      if (existing) {
        if (existing.kind === 'custom' || input.kind === 'custom') {
          throw Object.assign(new Error('a custom connector is never edited in place'), { status: 409 });
        }
        if (existing.brokerMode !== input.brokerMode) {
          throw Object.assign(new Error('brokerMode is set at creation and never changes'), { status: 409 });
        }
        Object.assign(existing, { ...input });
        return { ...existing };
      }
      const row = {
        clientIdentity: null, scopesSummary: null, category: null,
        mcpEndpointUrl: null, vendorConnectorRef: null, state: 'available',
        ...input,
      };
      entries.set(k, row);
      return { ...row };
    },
    async listEntries(tenant, seat) {
      return [...entries.values()]
        .filter((e) => key(tenant, e.seatId, e.id).startsWith(`${tenant}|`) && e.seatId === seat
          && entries.get(key(tenant, e.seatId, e.id)) === e)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async listConnections() { return []; },
    async listMirrors() { return []; },
  };
}

// A seed spy that runs the REAL refresh machinery against the fake
// store and counts whole-tenant seed runs.
function seedSpy(store, { delayMs = 0 } = {}) {
  const refresh = createCatalogRefresh({ libraryStore: store, subject: SUBJECT });
  const spy = {
    calls: 0,
    async run(tenantId) {
      spy.calls += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return refresh.refreshAll(tenantId);
    },
  };
  return spy;
}

function makeRead(store, extra = {}) {
  return createSeatLibraryRead({ libraryStore: store, seedLogger: noopLogger, ...extra });
}

// ------------------------------------------------------------------ laws

test('1+2+8 — first read on an empty tenant seeds and returns rows; second read does not re-seed; seed touches entries only', async () => {
  const tenant = 'tenant-seed-basic';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  const first = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1, 'exactly one seed run');
  assert.equal(first.seed.attempted, true);
  assert.equal(first.seed.seeded, true);
  assert.deepEqual(first.seed.conflicts, []);
  assert.equal(first.rows.length, catalogEntriesForSeat('claude').length, 'the seeded catalog reads back');
  assert.ok(first.rows.every((r) => r.name && r.oneLiner && r.state), 'rows are real library rows');
  assert.equal(store.entryCount(tenant), 68, 'the whole catalog landed (all seats), not just the read seat — 68 since bite M2 added Idiolect to the Claude set');

  const createCallsAfterSeed = store.stats.createEntryCalls;
  const second = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1, 'second read does not re-seed');
  assert.equal(second.seed.attempted, false);
  assert.equal(second.rows.length, first.rows.length);
  assert.equal(store.stats.createEntryCalls, createCallsAfterSeed, 'second read performs no entry writes at all');

  // The seed wrote entries and nothing else.
  assert.deepEqual(await store.listConnections(tenant, { personId: PERSON, seatId: 'claude' }), []);
  assert.deepEqual(await store.listMirrors(tenant, { personId: PERSON, seatId: 'claude' }), []);
  assert.equal(store.stats.connectionWrites + store.stats.mirrorWrites + store.stats.snapshotWrites, 0);
});

test('9 — default wiring seeds through the real refresh machinery on the read’s own store', async () => {
  const tenant = 'tenant-seed-default';
  const store = fakeLibraryStore();
  const read = makeRead(store); // no seedCatalog, no catalogRefresh injected

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'grok' });
  assert.equal(view.seed.seeded, true);
  assert.equal(view.rows.length, catalogEntriesForSeat('grok').length);
  assert.equal(store.entryCount(tenant), 68);
});

test('3 — a seeded tenant with a single entry deleted does NOT re-seed, and the entry stays deleted', async () => {
  const tenant = 'tenant-seed-deleted-one';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1);
  store.removeEntry(tenant, 'claude', 'notion');

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1, 'tenant count > 0 → no full re-seed');
  assert.equal(view.seed.attempted, false);
  assert.equal(view.rows.some((r) => r.entryId === 'notion'), false, 'the deleted entry is not resurrected by a read');
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length - 1);
});

test('5b — a tenant holding entries for OTHER seats only does not seed on an empty seat’s read', async () => {
  const tenant = 'tenant-seed-partial';
  const store = fakeLibraryStore();
  // Hand-place one seat's entries (the partly-seeded state): grok only.
  for (const def of catalogEntriesForSeat('grok')) await store.createEntry(tenant, SUBJECT, def);
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 0, 'tenant count > 0 → the read does not seed');
  assert.equal(view.seed.attempted, false);
  assert.deepEqual(view.rows, [], 'the empty seat reads honestly empty');
});

test('4 — two concurrent first reads (separate read objects, one store) both return rows with ONE effective seed', async () => {
  const tenant = 'tenant-seed-concurrent';
  const store = fakeLibraryStore();
  const spy = seedSpy(store, { delayMs: 25 });
  // The route builds a fresh read object per request; two concurrent
  // requests are two read objects over the same store.
  const readA = makeRead(store, { seedCatalog: spy.run });
  const readB = makeRead(store, { seedCatalog: spy.run });

  const [a, b] = await Promise.all([
    readA.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' }),
    readB.readSeatLibrary(tenant, { personId: PERSON, seatId: 'gemini' }),
  ]);
  assert.equal(spy.calls, 1, 'one effective seed for both reads');
  assert.equal(a.rows.length, catalogEntriesForSeat('claude').length);
  assert.equal(b.rows.length, catalogEntriesForSeat('gemini').length);
  assert.equal(a.seed.seeded, true);
  assert.equal(b.seed.seeded, true);
});

test('5 — a seed failure never breaks the read: it answers empty with the failure in the seed metadata', async () => {
  const tenant = 'tenant-seed-failure';
  const store = fakeLibraryStore();
  let calls = 0;
  const read = makeRead(store, {
    seedCatalog: async () => { calls += 1; throw Object.assign(new Error('refresh exploded'), { status: 503 }); },
  });

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(calls, 1);
  assert.deepEqual(view.rows, []);
  assert.equal(view.connectedCount, 0);
  assert.equal(view.seed.attempted, true);
  assert.equal(view.seed.seeded, false);
  assert.equal(view.seed.error.message, 'refresh exploded');
  assert.equal(view.seed.error.status, 503);
});

test('6 — a uniqueness race is caught and continued: rows another seeder landed are served', async () => {
  const tenant = 'tenant-seed-race';
  const store = fakeLibraryStore();
  const refresh = createCatalogRefresh({ libraryStore: store, subject: SUBJECT });
  const read = makeRead(store, {
    seedCatalog: async (tenantId) => {
      // Another process seeded first; this process's refresh then
      // reports the collision instead of the summary.
      await refresh.refreshAll(tenantId);
      throw Object.assign(new Error('duplicate key value violates unique constraint "connector_entries_pkey"'), { code: '23505' });
    },
  });

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(view.seed.seeded, false, 'this process did not complete the seed');
  assert.equal(view.seed.error.code, '23505');
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length, 'the read serves the rows that landed');
});

test('7 — a vendor brokerMode conflict during a seed is reported and skipped, never forced', async () => {
  const tenant = 'tenant-seed-conflict';
  const store = fakeLibraryStore();
  const refresh = createCatalogRefresh({ libraryStore: store, subject: SUBJECT });
  const read = makeRead(store, {
    seedCatalog: async (tenantId) => {
      // Mid-seed, a conflicting gmail entry lands (helmian pipe where
      // the catalog says vendor). The refresh must skip it, not flip it.
      const def = catalogEntryById('claude', 'gmail');
      await store.createEntry(tenantId, SUBJECT, {
        ...def, brokerMode: 'helmian', vendorConnectorRef: undefined,
        mcpEndpointUrl: 'https://gmail.example.com/mcp',
      });
      return refresh.refreshAll(tenantId);
    },
  });

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(view.seed.seeded, true);
  assert.equal(view.seed.conflicts.length, 1);
  assert.equal(view.seed.conflicts[0].entryId, 'gmail');
  const gmail = view.rows.find((r) => r.entryId === 'gmail');
  assert.equal(gmail.brokerMode, 'helmian', 'the stored pipe survives — the conflict was skipped, not forced');
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length, 'every other entry still seeded');
});

// ------------------------------------------------------------------ route

class TenantAuthorizationError extends Error {}

test('10 — the route surfaces a seed failure as 200 + seed metadata, not a 503', async () => {
  const tenant = 'tenant-seed-route';
  const store = fakeLibraryStore();
  const read = makeRead(store, {
    seedCatalog: async () => { throw new Error('refresh exploded'); },
  });
  const sent = [];
  const handled = await handleConnectorLibraryRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL(`${CONNECTOR_LIBRARY_PATH}?seat=claude`, 'http://local'),
    activeTenantActor: async () => ({ subject: PERSON, tenantId: tenant, role: 'owner' }),
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    read,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.valid, true);
  assert.deepEqual(sent[0].body.rows, []);
  assert.equal(sent[0].body.seed.attempted, true);
  assert.equal(sent[0].body.seed.seeded, false);
  assert.equal(sent[0].body.seed.error.message, 'refresh exploded');
});

test('route on an unseeded tenant: the seats read seeds once and lists the seats', async () => {
  const tenant = 'tenant-seed-route-seats';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });
  const sent = [];
  const handled = await handleConnectorLibraryRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL('/api/admin/connector-library/seats', 'http://local'),
    activeTenantActor: async () => ({ subject: PERSON, tenantId: tenant, role: 'owner' }),
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    read,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 200);
  assert.equal(spy.calls, 1, 'fourteen seat reads, one seed');
  assert.equal(sent[0].body.seats.length, LIVE_SEATS.length);
  assert.equal(sent[0].body.seed.seeded, true);
});

// Connector library — seed-on-first-read gate + heal-on-read.
//
// The defect (proven live 2026-11-08): the catalog shipped as data in
// code, but a workspace's library read returned empty until someone
// ran the catalog refresh against that tenant's rows by hand. The fix
// under test: the read self-seeds — when a read for a tenant finds
// ZERO catalog entries (tenant-wide, not merely this seat), it runs
// the catalog refresh once for that tenant, then serves the read.
//
// The second defect (M2 live walk, 2026-11-09): the catalog gained an
// entry in code (Idiolect), but populated tenants never refresh — the
// seed gate fires only for empty tenants — so the new entry never
// landed in any live store and its starter actions never reached the
// menu. The durable fix under test: the read also self-heals for
// catalog ADDITIONS — a seat that already holds catalog entries but
// lacks ids the code catalog holds runs the same one-flight refresh,
// then re-lists.
//
// The laws asserted here:
//   1. first read on an empty tenant seeds and returns rows;
//   2. a second read does not re-seed (refresh call count stays 1);
//   3. a catalog entry deleted from a POPULATED seat is restored by
//      that seat's next read — resurrection-on-read for
//      operator-curated catalog entries is the deliberate, accepted
//      trade-off (FIX-C; the refresh only ever adds/updates, and
//      'disabled-by-owner' is the durable opt-out a refresh
//      preserves). A custom entry is never touched by the heal;
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
//      not a 503;
//  11. heal: a populated seat missing one catalog entry — the read
//      runs the refresh once and returns the entry WITH its catalog
//      starter actions joined; a further read does not refresh again;
//  12. a populated, CURRENT tenant performs zero writes on read —
//      the module header's read-only promise survives the heal.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
  catalogStarterActions,
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
  assert.equal(store.entryCount(tenant), 134, 'the whole catalog landed (all seats), not just the read seat — 134 since the Salesforce bite added Salesforce brokered on each of claude, chatgpt, grok; 131 since the Box bite added Box brokered on each of claude, chatgpt, grok; 128 since the Microsoft bite added OneDrive, Outlook, Microsoft Teams and SharePoint brokered on each of claude, chatgpt, grok; 116 since the fixed-tail bite added Canva and Dropbox brokered on each of claude, chatgpt, grok; 110 since the DCR long-tail bite added Meltwater, S&P Global, Idiolect and Gamma brokered on each of claude, chatgpt, grok; 98 since the Google family bite added Gmail, Google Calendar and Google Drive brokered on each of claude, chatgpt, grok; 89 since Bite R2 added the team-work family to Source 4 (Slack, Asana, HubSpot brokered on each of claude, chatgpt, grok) and the Figma mirror on claude and chatgpt; 78 since Source 4 (the vendor-published Vercel server, Helmian-brokered) added 1 entry on each of claude, chatgpt, grok; 75 since Source 3 (the MCP Registry imports) stocked 21 more across the seats; 54 after the Scribe cut removed the native Scribe entry from all 14 seats (was 68)');

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
  assert.equal(store.entryCount(tenant), 134); // 54 + the 21 Source 3 registry imports + the 3 Source 4 brokered Vercel entries + Bite R2's 9 brokered team-work entries and 2 Figma mirrors + the Google family bite's 9 brokered entries + the DCR long-tail bite's 12 brokered entries + the fixed-tail bite's 6 brokered entries + the Microsoft bite's 12 brokered entries + the Box bite's 3 brokered entries + the Salesforce bite's 3 brokered entries
});

test('3 — a catalog entry deleted from a populated seat is restored by that seat’s next read (resurrection-on-read, the accepted trade-off); a custom entry is untouched', async () => {
  const tenant = 'tenant-seed-deleted-one';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1);
  // A person's own custom entry in the same seat — the heal's refresh
  // writes catalog/native entries only and must not touch it.
  await store.createEntry(tenant, SUBJECT, {
    seatId: 'claude', id: 'my-custom', kind: 'custom', name: 'My Custom',
    oneLiner: 'A connector the person added', iconRef: 'icon:custom',
    vendorName: 'Custom', trustLabel: 'custom', category: null,
    brokerMode: 'helmian', mcpEndpointUrl: 'https://custom.example.com/mcp',
    authMode: 'none', addedBy: PERSON,
  });
  store.removeEntry(tenant, 'claude', 'notion');

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 2, 'the missing catalog id triggers exactly one heal refresh');
  assert.equal(view.seed.attempted, true);
  assert.equal(view.seed.seeded, true);
  assert.equal(view.rows.some((r) => r.entryId === 'notion'), true,
    'the deleted catalog entry returns — resurrection-on-read is the accepted behaviour for operator-curated entries');
  const custom = view.rows.find((r) => r.entryId === 'my-custom');
  assert.ok(custom, 'the custom entry is still listed');
  assert.equal(custom.name, 'My Custom', 'the custom entry is unchanged by the refresh');
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length + 1, 'the full catalog plus the custom');
});

test('11 — heal: a populated seat missing one catalog entry refreshes once and returns it WITH its starter actions joined', async () => {
  const tenant = 'tenant-heal-missing-one';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1);
  // The M2 defect state: the tenant is fully seeded from the
  // pre-Idiolect catalog, so the store lacks the entry the code
  // catalog gained.
  store.removeEntry(tenant, 'claude', 'idiolect');

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 2, 'one heal refresh for the missing catalog id');
  assert.equal(view.seed.attempted, true);
  assert.equal(view.seed.seeded, true);
  const idiolect = view.rows.find((r) => r.entryId === 'idiolect');
  assert.ok(idiolect, 'the missing entry is in the returned rows');
  assert.deepEqual(idiolect.starterActions, catalogStarterActions('claude', 'idiolect'),
    'the starter actions ride the healed row — the join the menu renders from');
  assert.equal(idiolect.starterActions.length, 3);
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length);

  const again = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 2, 'a healed, current seat does not refresh again');
  assert.equal(again.seed.attempted, false);
});

test('12 — a populated, current tenant performs zero writes on read (the read-only promise survives the heal)', async () => {
  const tenant = 'tenant-heal-current';
  const store = fakeLibraryStore();
  const spy = seedSpy(store);
  const read = makeRead(store, { seedCatalog: spy.run });

  await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude' });
  assert.equal(spy.calls, 1);
  const createCallsAfterSeed = store.stats.createEntryCalls;

  for (const seatId of ['claude', 'grok', 'gemini']) {
    const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId });
    assert.equal(view.seed.attempted, false, `seat ${seatId}: no seed, no heal`);
    assert.equal(view.rows.length, catalogEntriesForSeat(seatId).length);
  }
  assert.equal(spy.calls, 1, 'no further refresh runs');
  assert.equal(store.stats.createEntryCalls, createCallsAfterSeed, 'zero entry writes across all three reads');
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

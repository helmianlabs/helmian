// Connector library READ performance laws (2026-11-09 perf bite).
// The live walks that forced this bite: after the catalog grew
// 54 → 75, the Connectors tab took ~20s to show a seat's cards and
// ~35s to open — measured in the bite's harness (real stores over a
// counting stub pool) as three compounding costs:
//   · the heal's refresh rewrote EVERY catalog entry (75 writes,
//     each its own transaction) when only the delta had changed;
//   · the /seats route produced two counts per seat by running the
//     full per-seat library read fourteen times sequentially
//     (308 queries on a converged library), joins included;
//   · the Manage surface re-asked for the seats on every refresh,
//     so every seat switch paid that fan-out again (pinned in the
//     view's test file, web/marketing/test/connector-manage.test.mjs).
// The pins below hold the fixes to their numbers:
//   (a) a current library performs ZERO entry writes on any read;
//   (b) a catalog delta triggers exactly the delta — the missing
//       and the drifted entries, nothing else;
//   (c) the Level 1 counts read returns the same counts the row
//       reads return, with the tenant-level joins resolved once.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LIVE_SEATS, catalogEntriesForSeat } from '../src/cloud/connector-catalog.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { handleConnectorLibraryRoute } from '../src/cloud/connector-library-read-route.mjs';

const TENANT = 'tenant-read-perf';
const PERSON = 'user:troy';
const SUBJECT = 'user:troy';
const ACTOR = { subject: PERSON, tenantId: TENANT, role: 'owner', sessionId: 's', requestId: 'r' };
const noopLogger = () => {};

// An in-memory library store in the real store's return shapes,
// with the refresh's laws the delta test depends on (an existing
// non-custom entry updates; a brokerMode mismatch or any custom
// involvement is a 409). Entry writes are counted and named.
function fakeLibraryStore() {
  const entries = new Map();
  const connections = new Map();
  const mirrors = new Map();
  const key = (...parts) => parts.join('|');
  const stats = { createEntryCalls: 0, createdIds: [], listEntriesForTenantCalls: 0 };
  return {
    stats,
    putEntry(def) {
      entries.set(key(def.seatId, def.id), {
        clientIdentity: null, scopesSummary: null, category: null,
        mcpEndpointUrl: null, vendorConnectorRef: null, state: 'available',
        ...def,
      });
    },
    putConnection({ personId = PERSON, seatId, entryId, state = 'connected' }) {
      connections.set(key(personId, seatId, entryId), { personId, seatId, entryId, state, accountIdentity: 'someone', posture: 'ask', lastUsedAt: null });
    },
    putMirror({ personId = PERSON, seatId, entryId, reportedState }) {
      mirrors.set(key(personId, seatId, entryId), { personId, seatId, entryId, reportedState, reportedAccountIdentity: null, reportedAt: null });
    },
    driftEntry(seatId, id, fields) {
      const row = entries.get(key(seatId, id));
      Object.assign(row, fields);
    },
    entry(seatId, id) { return entries.get(key(seatId, id)); },
    async createEntry(tenant, subject, input = {}) {
      stats.createEntryCalls += 1;
      stats.createdIds.push(`${input.seatId}/${input.id}`);
      const k = key(input.seatId, input.id);
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
      return [...entries.values()].filter((e) => e.seatId === seat).map((e) => ({ ...e })).sort((a, b) => a.id.localeCompare(b.id));
    },
    async listConnections(tenant, { personId, seatId }) {
      return [...connections.values()].filter((c) => c.personId === personId && c.seatId === seatId).map((c) => ({ ...c }));
    },
    async listMirrors(tenant, { personId, seatId }) {
      return [...mirrors.values()].filter((m) => m.personId === personId && m.seatId === seatId).map((m) => ({ ...m }));
    },
    async listEntriesForTenant() {
      stats.listEntriesForTenantCalls += 1;
      return [...entries.values()].map((e) => ({ seatId: e.seatId, id: e.id, kind: e.kind, brokerMode: e.brokerMode, state: e.state }));
    },
    async listConnectionsForTenant(tenant, { personId }) {
      return [...connections.values()].filter((c) => c.personId === personId).map((c) => ({ seatId: c.seatId, entryId: c.entryId, state: c.state }));
    },
    async listMirrorsForTenant(tenant, { personId }) {
      return [...mirrors.values()].filter((m) => m.personId === personId).map((m) => ({ seatId: m.seatId, entryId: m.entryId, reportedState: m.reportedState }));
    },
  };
}

function seedWholeCatalog(store, { except = [] } = {}) {
  for (const seatId of LIVE_SEATS) {
    for (const def of catalogEntriesForSeat(seatId)) {
      if (except.includes(`${seatId}/${def.id}`)) continue;
      store.putEntry(def);
    }
  }
}

// ------------------------------------------------------------ (a) no writes
test('(a) a current library performs zero entry writes on row reads and counts reads alike', async () => {
  const store = fakeLibraryStore();
  seedWholeCatalog(store);
  const read = createSeatLibraryRead({ libraryStore: store, seedLogger: noopLogger });

  await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', actor: ACTOR });
  await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', actor: ACTOR });
  const counts1 = await read.readSeatCounts(TENANT, { personId: PERSON, actor: ACTOR });
  const counts2 = await read.readSeatCounts(TENANT, { personId: PERSON, actor: ACTOR });

  assert.equal(store.stats.createEntryCalls, 0, 'no read of a current library writes an entry');
  assert.equal(counts1.seats.length, LIVE_SEATS.length);
  assert.deepEqual(counts2.seats, counts1.seats, 'repeat counts reads agree');
  assert.equal(counts1.seed.attempted, false, 'a current library neither seeds nor heals');
  assert.ok(store.stats.listEntriesForTenantCalls >= 2, 'the counts read lists the tenant once per call, not once per seat');
});

// ------------------------------------------------------------ (b) exact delta
test('(b) a catalog delta triggers exactly the delta: the missing entry and the drifted entry, nothing else', async () => {
  const store = fakeLibraryStore();
  seedWholeCatalog(store, { except: ['claude/registry-weather'] });
  store.driftEntry('grok', 'gmail', { oneLiner: 'AN OLD LINE THE CATALOG NO LONGER SAYS' });
  const read = createSeatLibraryRead({ libraryStore: store, seedLogger: noopLogger });

  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', actor: ACTOR });
  assert.equal(view.seed.attempted, true, 'the missing catalog id triggers the heal');
  assert.equal(view.seed.seeded, true);
  assert.deepEqual(store.stats.createdIds, ['claude/registry-weather', 'grok/gmail'],
    'the refresh writes the missing entry and the drifted entry — and no others');
  assert.equal(store.entry('grok', 'gmail').oneLiner,
    catalogEntriesForSeat('grok').find((d) => d.id === 'gmail').oneLiner,
    'the drifted entry now says what the catalog says');
  assert.ok(view.rows.some((r) => r.entryId === 'registry-weather'), 'the healed row reads back');

  const callsAfterHeal = store.stats.createEntryCalls;
  await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', actor: ACTOR });
  assert.equal(store.stats.createEntryCalls, callsAfterHeal, 'a healed library is current — the next read writes nothing');
});

// ------------------------------------------------------------ (c) counts parity
test('(c) the counts read agrees with the row reads, joins resolved once, gate cap included', async () => {
  const store = fakeLibraryStore();
  seedWholeCatalog(store);
  // One of each connected flavour: a Helmian connection (grok's
  // catalog GitHub), a vendor mirror report (claude's Gmail), the
  // native GitHub via the channel repo link (every seat — the fake
  // envoy store below reports one linked channel), and a custom
  // entry whose connection says connected but whose gate has NOT
  // passed (no gate row) — capped at not-connected by both reads.
  store.putConnection({ seatId: 'grok', entryId: 'github' });
  store.putMirror({ seatId: 'claude', entryId: 'gmail', reportedState: 'connected' });
  store.putEntry({
    seatId: 'claude', id: 'my-custom', kind: 'custom', name: 'My Custom',
    oneLiner: 'Added by the person', iconRef: 'icon:custom', vendorName: 'Custom',
    trustLabel: 'custom', category: null, brokerMode: 'helmian',
    mcpEndpointUrl: 'https://custom.example.com/mcp', authMode: 'none', addedBy: PERSON,
  });
  store.putConnection({ seatId: 'claude', entryId: 'my-custom' });

  const joinCalls = { toolList: 0, channels: 0 };
  const toolConnectionsStore = {
    async list() {
      joinCalls.toolList += 1;
      return [{ serviceId: 'github', scopeKind: 'workspace', scopeId: 'workspace', state: 'verified', lastVerifiedAt: new Date(), accountLabel: 'helmianlabs' }];
    },
    async get() { return null; }, // no gate row anywhere: no custom gate has passed
  };
  const envoyStore = {
    async listChannels() {
      joinCalls.channels += 1;
      return { channels: [{ id: '1', slug: 'team', title: 'Team', github: { repo: 'helmianlabs/helmian', linkedAt: null } }] };
    },
  };
  const read = createSeatLibraryRead({ libraryStore: store, toolConnectionsStore, envoyStore, seedLogger: noopLogger });

  const counts = await read.readSeatCounts(TENANT, { personId: PERSON, actor: ACTOR });
  assert.equal(joinCalls.toolList, 1, 'the tool-connections surface resolves once for the whole counts read');
  assert.equal(joinCalls.channels, 1, 'the channel repo links resolve once for the whole counts read');

  for (const seatId of LIVE_SEATS) {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId, actor: ACTOR });
    const counted = counts.seats.find((s) => s.seatId === seatId);
    assert.ok(counted, `${seatId}: present in the counts`);
    assert.equal(counted.entryCount, view.rows.length, `${seatId}: entryCount matches the row read`);
    assert.equal(counted.connectedCount, view.connectedCount, `${seatId}: connectedCount matches the row read`);
  }
  const claude = counts.seats.find((s) => s.seatId === 'claude');
  assert.equal(claude.connectedCount, 2, 'claude: the mirrored Gmail + the repo-linked GitHub; the ungated custom does not count');
});

// ------------------------------------------------------------ route shape
test('route: the seats branch uses the counts read with the actor’s identity, and surfaces a seed attempt', async () => {
  class TenantAuthorizationError extends Error {}
  const calls = [];
  const read = {
    async readSeatCounts(tenantId, opts) {
      calls.push({ tenantId, ...opts });
      return {
        seats: [{ seatId: 'claude', entryCount: 17, connectedCount: 1 }],
        seed: { attempted: true, seeded: true, conflicts: [] },
      };
    },
  };
  const sent = [];
  const handled = await handleConnectorLibraryRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL('/api/admin/connector-library/seats', 'http://local'),
    activeTenantActor: async () => ({ subject: PERSON, tenantId: TENANT, role: 'owner' }),
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    read,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 200);
  assert.deepEqual(sent[0].body.seats, [{ seatId: 'claude', entryCount: 17, connectedCount: 1 }]);
  assert.equal(sent[0].body.seed.seeded, true);
  assert.equal(calls.length, 1, 'one counts read behind the route, not one read per seat');
  assert.equal(calls[0].tenantId, TENANT);
  assert.equal(calls[0].personId, PERSON, 'the person is the actor’s subject, never a request field');
});

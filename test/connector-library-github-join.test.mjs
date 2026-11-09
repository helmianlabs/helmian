// Connector library — native GitHub repo-link join gate.
//
// The defect (proven against production data 2026-11-08):
// helmion.tool_connections holds NO github row for the owner's
// workspace — the GitHub connection the room lives by is the
// PER-CHANNEL REPO LINK (channel config github.repo; #Team →
// helmianlabs/helmian). Bite 2's read joined the native GitHub
// entry's state from tool-connections only, so the live panel read
// "GitHub (by Helmian) — Not connected" in every seat while the
// channel header and rail both said linked.
//
// The fix under test: the helmian-github entry's state ALSO joins
// the workspace's per-channel repo links, read through the envoy
// store's channels-list-with-config read (the read the rail's
// channel list is built from). The laws asserted here:
//   1. a channel-linked tenant reads the native GitHub entry
//      CONNECTED in every seat, toggleable like any connected
//      helmian entry, with stateDetail naming the repo and channel;
//   2. several linked channels are counted ("+N more channels");
//      several repos are all named;
//   3. no link and no tool row → not connected, as before;
//   4. a tool-connections verified row alone still reads connected
//      (the bite-2 road is untouched);
//   5. both sources → connected, the repo named as the source;
//   6. a link outranks a failed or stale tool row — a link is live
//      config, not a probe receipt, so no freshness window applies;
//   7. tenant isolation: the join is keyed to the actor's tenant —
//      another tenant's links never surface, and a read with no
//      actor gets no link join at all;
//   8. helmian-scribe keeps its honest unjoined state;
//   9. the route threads the actor into the read, so the join fires
//      on the live road.

import test from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntriesForSeat, createCatalogRefresh } from '../src/cloud/connector-catalog.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import {
  CONNECTOR_LIBRARY_PATH,
  handleConnectorLibraryRoute,
} from '../src/cloud/connector-library-read-route.mjs';

const PERSON = 'user:troy';
const SUBJECT = 'user:troy';
const NOW = Date.parse('2026-11-08T17:00:00.000Z');
const noopLogger = () => {};

// ------------------------------------------------------------ fake stores
// The library store: the seed gate's lightweight fake — entries via
// the real catalog refresh, no connections or mirrors.
function fakeLibraryStore() {
  const entries = new Map();
  const key = (tenant, seat, id) => `${tenant}|${seat}|${id}`;
  return {
    async createEntry(tenant, subject, input = {}) {
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
        .filter((e) => key(tenant, e.seatId, e.id).startsWith(`${tenant}|`) && e.seatId === seat)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async listConnections() { return []; },
    async listMirrors() { return []; },
  };
}

// The tool-connections store: rows in the real store's list() shape
// (the shape toolConnectionSurfaceStatus reads).
function fakeToolConnectionsStore(rowsByTenant = new Map()) {
  return {
    async list(tenantId) {
      return (rowsByTenant.get(tenantId) ?? []).map((r) => ({ ...r }));
    },
  };
}

const verifiedGithubRow = (over = {}) => ({
  serviceId: 'github', scopeKind: 'workspace', scopeId: 'workspace',
  state: 'verified', lastVerifiedAt: new Date(NOW - 60_000),
  lastToolsCount: 26, lastError: null, accountLabel: 'helmianlabs',
  ...over,
});

// The envoy store: channels in attachChannelLinks' output shape —
// the parsed config's links ride on the channel (github null when
// the channel links no repo). Keyed by tenant: listChannels answers
// for the ACTOR's tenant only, exactly as the real store's
// membership-checked read does.
function fakeEnvoyStore(channelsByTenant = new Map()) {
  return {
    async listChannels(actor) {
      return { channels: (channelsByTenant.get(actor.tenantId) ?? []).map((c) => ({ ...c })) };
    },
  };
}

const channel = (id, title, github) => ({
  id, slug: title.toLowerCase().replace(/\s+/g, '-'), title, kind: 'channel',
  discord: null, slack: null, github, avatar: null,
});
const repoLink = (repo) => ({ repo, events: ['push', 'pull_request', 'issues'], linkedAt: '2026-11-04T03:07:00.000Z' });

const actorFor = (tenantId) => ({ tenantId, subject: PERSON, role: 'owner' });

async function makeWorld({ toolRows = new Map(), channels = new Map() } = {}) {
  const libraryStore = fakeLibraryStore();
  const refresh = createCatalogRefresh({ libraryStore, subject: SUBJECT });
  const read = createSeatLibraryRead({
    libraryStore,
    toolConnectionsStore: fakeToolConnectionsStore(toolRows),
    envoyStore: fakeEnvoyStore(channels),
    seedLogger: noopLogger,
  });
  return { libraryStore, refresh, read };
}

const githubRow = (view) => view.rows.find((r) => r.entryId === 'helmian-github');
// The panel's one toggle law (connector-panel.mjs): only a Connected
// row on a pipe Helmian holds can be armed for a message.
const toggleable = (row) => row.state === 'connected' && row.brokerMode === 'helmian';

// ------------------------------------------------------------------ laws

test('1 — a channel-linked tenant reads GitHub connected in every seat, toggleable, the repo named', async () => {
  const tenant = 'tenant-linked';
  const channels = new Map([[tenant, [
    channel('c-team', 'Team', repoLink('helmianlabs/helmian')),
    channel('c-quiet', 'Quiet Corner', null),
  ]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  for (const seatId of ['claude', 'grok', 'gemini']) {
    const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId, now: NOW, actor: actorFor(tenant) });
    const gh = githubRow(view);
    assert.equal(gh.state, 'connected', `${seatId}: the link reads connected`);
    assert.equal(toggleable(gh), true, `${seatId}: connected + helmian pipe = toggleable`);
    assert.equal(gh.accountIdentity, 'helmianlabs/helmian');
    assert.equal(gh.stateDetail.source, 'channel-repo-links');
    assert.equal(gh.stateDetail.repo, 'helmianlabs/helmian');
    assert.equal(gh.stateDetail.summary, 'helmianlabs/helmian via #Team');
    assert.equal(gh.stateDetail.viaChannel, '#Team');
    assert.equal(gh.stateDetail.channelCount, 1);
    assert.deepEqual(gh.stateDetail.channels, [{ channel: '#Team', repo: 'helmianlabs/helmian' }]);
    assert.equal(view.rows[0].entryId, 'helmian-github', `${seatId}: connected rows sort first`);
    assert.ok(view.connectedCount >= 1);
  }
});

test('2 — several linked channels are counted: "+2 more channels"', async () => {
  const tenant = 'tenant-many-channels';
  const channels = new Map([[tenant, [
    channel('c-team', 'Team', repoLink('helmianlabs/helmian')),
    channel('c-dev', 'Dev', repoLink('helmianlabs/helmian')),
    channel('c-ops', 'Ops', repoLink('helmianlabs/helmian')),
  ]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const gh = githubRow(view);
  assert.equal(gh.state, 'connected');
  assert.equal(gh.stateDetail.channelCount, 3);
  assert.equal(gh.stateDetail.summary, 'helmianlabs/helmian via #Dev +2 more channels');
  assert.deepEqual(gh.stateDetail.channels.map((c) => c.channel), ['#Dev', '#Ops', '#Team']);
  assert.deepEqual(gh.stateDetail.repos, ['helmianlabs/helmian']);
});

test('2b — several repos are all named; the headline is the first channel by name', async () => {
  const tenant = 'tenant-many-repos';
  const channels = new Map([[tenant, [
    channel('c-zeta', 'Zeta', repoLink('acme/zeta-repo')),
    channel('c-alpha', 'Alpha', repoLink('acme/alpha-repo')),
  ]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const gh = githubRow(view);
  assert.equal(gh.state, 'connected');
  assert.equal(gh.stateDetail.repo, 'acme/alpha-repo');
  assert.deepEqual(gh.stateDetail.repos, ['acme/alpha-repo', 'acme/zeta-repo']);
  assert.equal(gh.stateDetail.summary, 'acme/alpha-repo via #Alpha +1 more channel');
});

test('3 — no link and no tool row: not connected, exactly as before', async () => {
  const tenant = 'tenant-bare';
  const channels = new Map([[tenant, [channel('c-team', 'Team', null)]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const gh = githubRow(view);
  assert.equal(gh.state, 'not-connected');
  assert.equal(toggleable(gh), false);
  assert.equal(gh.stateDetail.source, 'tool-connections');
  assert.equal(gh.stateDetail.toolStatus, 'none');
});

test('4 — a verified tool-connections row alone still reads connected (the bite-2 road)', async () => {
  const tenant = 'tenant-tool-only';
  const toolRows = new Map([[tenant, [verifiedGithubRow()]]]);
  const { refresh, read } = await makeWorld({ toolRows });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const gh = githubRow(view);
  assert.equal(gh.state, 'connected');
  assert.equal(gh.accountIdentity, 'helmianlabs', 'the receipt’s account label, as bite 2 ruled it');
  assert.equal(gh.stateDetail.source, 'tool-connections');
  assert.equal(gh.stateDetail.toolStatus, 'connected');
});

test('5 — both sources: connected, the repo named as the source, the receipt recorded under it', async () => {
  const tenant = 'tenant-both';
  const toolRows = new Map([[tenant, [verifiedGithubRow()]]]);
  const channels = new Map([[tenant, [channel('c-team', 'Team', repoLink('helmianlabs/helmian'))]]]);
  const { refresh, read } = await makeWorld({ toolRows, channels });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const gh = githubRow(view);
  assert.equal(gh.state, 'connected');
  assert.equal(gh.stateDetail.source, 'channel-repo-links');
  assert.equal(gh.stateDetail.repo, 'helmianlabs/helmian');
  assert.equal(gh.stateDetail.summary, 'helmianlabs/helmian via #Team');
  assert.equal(gh.stateDetail.toolStatus, 'connected', 'the agreeing receipt is recorded, not hidden');
  assert.equal(gh.stateDetail.toolAccountLabel, 'helmianlabs');
});

test('6 — a link outranks a failed or stale tool row: no freshness window applies to a link', async () => {
  const tenant = 'tenant-link-beats-probe';
  const channels = new Map([[tenant, [channel('c-team', 'Team', repoLink('helmianlabs/helmian'))]]]);

  const failed = new Map([[tenant, [verifiedGithubRow({ state: 'failed', lastVerifiedAt: null, lastError: 'probe timed out' })]]]);
  const worldA = await makeWorld({ toolRows: failed, channels });
  await worldA.refresh.refreshAll(tenant);
  const viewA = await worldA.read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  assert.equal(githubRow(viewA).state, 'connected', 'a failed probe cannot unplug the link the room is using');
  assert.equal(githubRow(viewA).stateDetail.source, 'channel-repo-links');

  const stale = new Map([[tenant, [verifiedGithubRow({ lastVerifiedAt: new Date(NOW - 72 * 60 * 60 * 1000) })]]]);
  const worldB = await makeWorld({ toolRows: stale, channels });
  await worldB.refresh.refreshAll(tenant);
  const viewB = await worldB.read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  assert.equal(githubRow(viewB).state, 'connected', 'a link never goes stale — it is config, not a receipt');
});

test('7 — tenant isolation: another tenant’s links never surface; a read with no actor gets no link join', async () => {
  const tenantA = 'tenant-isolated-a';
  const tenantB = 'tenant-isolated-b';
  const channels = new Map([
    [tenantA, [channel('c-a', 'Team', null)]],
    [tenantB, [channel('c-b', 'Team', repoLink('other/tenant-repo'))]],
  ]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenantA);
  await refresh.refreshAll(tenantB);

  const viewA = await read.readSeatLibrary(tenantA, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenantA) });
  assert.equal(githubRow(viewA).state, 'not-connected', 'tenant B’s link does not leak into tenant A');

  const viewB = await read.readSeatLibrary(tenantB, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenantB) });
  assert.equal(githubRow(viewB).state, 'connected');
  assert.equal(githubRow(viewB).stateDetail.repo, 'other/tenant-repo');

  // The join is membership-keyed: without an actor there is no
  // channel read, so even the linked tenant reads tool-connections
  // only — the read never guesses at links it could not read.
  const noActor = await read.readSeatLibrary(tenantB, { personId: PERSON, seatId: 'claude', now: NOW });
  assert.equal(githubRow(noActor).state, 'not-connected');
  assert.equal(githubRow(noActor).stateDetail.source, 'tool-connections');
});

test('8 — helmian-scribe keeps its honest unjoined state while GitHub connects', async () => {
  const tenant = 'tenant-scribe-untouched';
  const channels = new Map([[tenant, [channel('c-team', 'Team', repoLink('helmianlabs/helmian'))]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  const view = await read.readSeatLibrary(tenant, { personId: PERSON, seatId: 'claude', now: NOW, actor: actorFor(tenant) });
  const scribe = view.rows.find((r) => r.entryId === 'helmian-scribe');
  assert.equal(scribe.state, 'not-connected');
  assert.equal(scribe.stateDetail.source, 'helmian-service');
  assert.equal(view.rows.length, catalogEntriesForSeat('claude').length, 'the seat’s full library still reads');
});

// ------------------------------------------------------------------ route

class TenantAuthorizationError extends Error {}

test('9 — the route threads the actor into the read: the join fires on the live road', async () => {
  const tenant = 'tenant-route-join';
  const channels = new Map([[tenant, [channel('c-team', 'Team', repoLink('helmianlabs/helmian'))]]]);
  const { refresh, read } = await makeWorld({ channels });
  await refresh.refreshAll(tenant);

  const sent = [];
  const handled = await handleConnectorLibraryRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL(`${CONNECTOR_LIBRARY_PATH}?seat=claude`, 'http://local'),
    activeTenantActor: async () => actorFor(tenant),
    send: (response, status, body) => { sent.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    read,
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 200);
  const gh = sent[0].body.rows.find((r) => r.entryId === 'helmian-github');
  assert.equal(gh.state, 'connected');
  assert.equal(gh.stateDetail.summary, 'helmianlabs/helmian via #Team');
  assert.equal(sent[0].body.connectedCount, 1);

  // Level 1 (seats) carries the joined count too.
  const sentSeats = [];
  const handledSeats = await handleConnectorLibraryRoute({
    request: { method: 'GET' },
    response: {},
    requestUrl: new URL('/api/admin/connector-library/seats', 'http://local'),
    activeTenantActor: async () => actorFor(tenant),
    send: (response, status, body) => { sentSeats.push({ status, body: JSON.parse(body) }); },
    TenantAuthorizationError,
    read,
  });
  assert.equal(handledSeats, true);
  const claudeSeat = sentSeats[0].body.seats.find((s) => s.seatId === 'claude');
  assert.equal(claudeSeat.connectedCount, 1, 'the Level 1 count includes the repo-link join');
});

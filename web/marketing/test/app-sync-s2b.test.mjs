import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as workspace from '../app/envoy-workspace.js';
import { loadToolAccess } from '../app/connector-tool-access.mjs';

// Sync S2b (panel half) — connections are the person's workspace
// SET (sync S1, server side): connect on one agent and every
// agent's read shows it. This file pins the panel's half of that
// truth:
// 1. FRESHNESS — a connector write made through one agent's panel
//    invalidates the cached libraries of the person's OTHER agents
//    too, so the next loadSeatLibrary for another agent re-reads
//    inside the 60-second window the cache used to hide behind.
//    The write sites themselves are pinned by source, the loader
//    behaviour by the real loader over a counting fake read (the
//    plus-menu fix-D pattern).
// 2. WORDING — the panel no longer frames a connection as one
//    agent's: the Connect and key-form titles carry the workspace
//    truth, the empty-connectors note and the Tool access face
//    drop their seat framings, and the strings that were already
//    true stay (provenance, and the per-seat ENTRY library a
//    custom entry is created in / removed from — entries are
//    stocked per seat; connections are the set).
// 3. TOOL-ACCESS CACHE ITEM (S1's list) — the verdict is SOUND:
//    the legacy Manage module S1 named does not exist in this
//    tree, and the panel's Tool access face holds no per-seat
//    cache: its model module caches nothing and the face
//    re-reads the tool-access read every time it opens.
// New exports are reached through the namespace import, so on the
// base these tests fail one by one by name rather than taking the
// whole file down at import.

const libRow = (seatId, entryId, name, over = {}) => ({
  entryId, seatId, name,
  oneLiner: `The ${name} line`,
  vendorLabel: 'Vendor',
  trustLabel: 'Helmian-brokered',
  state: 'not-connected',
  stateDetail: null,
  accountIdentity: null,
  brokerMode: 'helmian',
  kind: 'native',
  ...over,
});

test('sync S2b freshness: a write through seat A\u2019s panel makes seat B\u2019s next library load re-read, inside the staleness window', async () => {
  // The fake server read: one workspace set behind both seats.
  // `setConnected` flips what EVERY seat's read answers — that is
  // the set behaviour S1 lands server-side; this test proves the
  // panel's session cache stops hiding it across seats.
  let setConnected = false;
  const reads = { seats: 0, claude: 0, gemini: 0 };
  const api = async (path) => {
    if (path === '/api/admin/connector-library/seats') {
      reads.seats += 1;
      return { seats: [{ seatId: 'claude' }, { seatId: 'gemini' }] };
    }
    if (path.startsWith('/api/admin/connector-library?seat=')) {
      const seatId = path.split('seat=')[1];
      reads[seatId] += 1;
      const row = libRow(seatId, 'registry-weather', 'Weather', setConnected ? { state: 'connected' } : {});
      return { connectedCount: setConnected ? 1 : 0, rows: [row] };
    }
    throw new Error(`unexpected read: ${path}`);
  };
  workspace.resetLibrarySession({ api });
  const t0 = 1_000_000;
  const aFirst = await workspace.loadSeatLibrary('claude', t0);
  const bFirst = await workspace.loadSeatLibrary('gemini', t0);
  assert.equal(aFirst.rows[0].state, 'not-connected');
  assert.equal(bFirst.rows[0].state, 'not-connected');
  assert.equal(reads.gemini, 1);
  // Inside the window, seat B's cache stands (the pre-S2b truth too).
  const bCached = await workspace.loadSeatLibrary('gemini', t0 + 30_000);
  assert.equal(reads.gemini, 1, 'inside the window the cache stands — no re-read');
  assert.equal(bCached.rows[0].state, 'not-connected');
  // A connector write lands through seat A's panel; the server set
  // now reads connected. The panel marks the write the way every
  // write site in envoy-workspace.js does (pinned by source below).
  setConnected = true;
  assert.equal(typeof workspace.invalidateAllSeatLibraries, 'function', 'the workspace exports the all-seats invalidation');
  workspace.invalidateAllSeatLibraries(t0 + 40_000);
  // Seat B's next load — still inside its 60-second window — MUST
  // re-read and show the set as it now is.
  const bFresh = await workspace.loadSeatLibrary('gemini', t0 + 50_000);
  assert.equal(reads.gemini, 2, 'seat B re-read after seat A\u2019s write, window notwithstanding');
  assert.equal(bFresh.rows[0].state, 'connected', 'seat B shows the connection seat A made');
  assert.ok(reads.seats >= 2, 'the Level 1 facts (the connected counts) re-read too — they ride the same set');
  // Seat B's fresh copy then stands inside its own window again:
  // the invalidation is a re-read trigger, not a cache ban.
  const bAgain = await workspace.loadSeatLibrary('gemini', t0 + 55_000);
  assert.equal(reads.gemini, 2, 'the copy fetched after the write stands inside its window');
  assert.equal(bAgain.rows[0].state, 'connected');
  // And the acted-on seat re-reads as well.
  const aFresh = await workspace.loadSeatLibrary('claude', t0 + 50_000);
  assert.equal(reads.claude, 2, 'the acted-on seat re-reads after its own write');
  assert.equal(aFresh.rows[0].state, 'connected');
});

test('sync S2b freshness wiring: every panel connector write site invalidates ALL seats, and no per-seat-only invalidation remains', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const slice = (from, to) => js.slice(js.indexOf(from), js.indexOf(to));
  const sites = [
    ['connect (startPanelConnect)', slice('async function startPanelConnect', '// The key form (panel-native home bite 2)')],
    ['key store / replace (saveKeyForm)', slice('async function saveKeyForm', 'async function disconnectKeyForm')],
    ['key disconnect (disconnectKeyForm)', slice('async function disconnectKeyForm', 'function keyFormNode')],
    ['posture write (saveToolAccessPosture)', slice('async function saveToolAccessPosture', 'async function saveToolAccessTool')],
    ['tool-enable write (saveToolAccessTool)', slice('async function saveToolAccessTool', 'function toolAccessNode')],
    ['custom create (saveCustomForm)', slice('async function saveCustomForm', 'function customFormNode')],
    ['custom remove (removeCustomEntry)', slice('async function removeCustomEntry', 'function customRemoveNode')],
  ];
  for (const [name, body] of sites) {
    assert.ok(body.includes('invalidateAllSeatLibraries()'), `${name} invalidates every seat\u2019s cached library on success`);
  }
  for (const gone of ['ws.libraryFetchedAt[row.seatId] = 0', 'ws.libraryFetchedAt[result.model.seatId] = 0', 'ws.libraryFetchedAt[cf.seatId] = 0']) {
    assert.ok(!js.includes(gone), `the per-seat-only invalidation ${gone} is gone — the all-seats one replaced it`);
  }
  const stale = slice('export const LIBRARY_STALE_MS', 'export async function loadSeatLibrary');
  assert.ok(stale.includes('libraryWriteAt'), 'the staleness check itself refuses a copy fetched before the last in-session write');
});

test('sync S2b wording: connect and key titles carry the workspace truth, and the seat-framed strings are gone', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(js.includes('Connect ${row.name} for your workspace — every agent shares it'), 'the Connect title says the connection is the workspace\u2019s');
  assert.ok(js.includes('Store the key and connect ${model.name} for your workspace — every agent shares it'), 'the key-form title says the same');
  assert.ok(!js.includes('Connect ${row.name} for ${seatName'), 'the old Connect title (for one agent) is gone');
  assert.ok(!js.includes('connect ${model.name} for ${seatName'), 'the old key title (for one agent) is gone');
  assert.ok(js.includes('Set when this connection\\u2019s tools ask before they run'), 'the Tool access face speaks of the connection, not this seat');
  assert.ok(!js.includes('this seat\\u2019s connected tools'), 'the old Tool access seat framing is gone');
  assert.ok(js.includes("'Loading connectors...'"), 'the Tool access loading line names no seat');
  assert.ok(js.includes("'No connectors can be set here yet.'"), 'the Tool access empty line names no seat');
  assert.ok(!js.includes('No connectors for ${seatName'), 'no Tool access line frames connectors as one agent\u2019s');
  // The model-level note (plusMenuLevel2Model) carries the new copy.
  const empty = workspace.plusMenuLevel2Model({
    seatId: 'claude',
    library: { seatId: 'claude', connectedCount: 0, rows: [] },
    conversationId: 'c1',
  });
  const notes = [];
  const walk = (rows) => { for (const r of rows ?? []) { if (r.kind === 'note') notes.push(r.text); if (r.rows) walk(r.rows); } };
  walk(empty.rows);
  assert.ok(notes.includes('No connectors are connected yet.'), 'the empty Connectors note drops the seat framing');
  assert.ok(!notes.some((t) => t.includes('for Claude')), 'no note frames connected state as one agent\u2019s');
});

test('sync S2b wording: the strings that were already true stay — provenance and the per-seat entry library', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  // Provenance is not a false claim: a mirror connection lives in
  // the seat's own vendor product, and its row still says so.
  assert.ok(js.includes('is managed in ${row.mirror.managedIn}, not in Helmian'), 'the mirror row still names where its connection is managed');
  assert.ok(js.includes("open Helmian's Agents page for ${seatName(row.seatId)}'s account"), 'the mirror row still names the seat\u2019s own vendor account');
  // Entry stocking is per seat (S1): a custom entry is created in,
  // and removed from, the seat's library it stands in — those
  // words stay, in the workspace and in the faces' models.
  assert.ok(js.includes("was added to ${seatName(result.created.seatId ?? cf.seatId)}'s library"), 'the custom-create toast still names the seat\u2019s library the entry joined');
  assert.ok(js.includes("was removed from ${seatName(seatId)}'s library"), 'the custom-remove toast still names the seat\u2019s library the entry left');
  const customForm = await readFile(new URL('../app/connector-custom-form.mjs', import.meta.url), 'utf8');
  assert.ok(customForm.includes('added to this seat\\u2019s library'), 'the custom form intro still names the seat\u2019s library — an entry truth, not a connection claim');
  // Account identity is provenance too: "Connected as <account>"
  // names the account the set is connected as, on every seat.
  const panel = await readFile(new URL('../app/connector-panel.mjs', import.meta.url), 'utf8');
  assert.ok(panel.includes('Connected as ${row.accountIdentity}'), 'the connected state line still names the account');
});

test('sync S2b tool-access item: SOUND — no legacy Manage module, no per-seat cache, the face re-reads on open', async () => {
  // The module S1 named (web/marketing/app/connector-manage.mjs,
  // with its per-(seat, entry) Map and its localStorage seat
  // memory) does not exist in this tree — the Manage surface was
  // deleted and never re-mounted here.
  await assert.rejects(readFile(new URL('../app/connector-manage.mjs', import.meta.url), 'utf8'), 'the legacy Manage module is absent from this tree');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('connector-manage'), 'the workspace never imports a Manage module');
  assert.ok(!js.includes('MANAGE_SEAT_MEMORY'), 'no Manage seat memory survives in the workspace');
  // The panel face's model module caches nothing: its read
  // function calls the road every time it is invoked, and a
  // changed server answer is what the second call returns.
  let posture = 'ask';
  let calls = 0;
  const api = async () => { calls += 1; return { seatId: 'claude', entryId: 'helmian-github', connected: true, posture, tools: [], snapshotHash: 'h1' }; };
  const first = await loadToolAccess({ api, seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(first.posture, 'ask');
  posture = 'all';
  const second = await loadToolAccess({ api, seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(calls, 2, 'the tool-access read runs on every load — nothing is served from a cache');
  assert.equal(second.posture, 'all', 'the second load shows the server\u2019s current state, not a cached copy');
  // And the workspace's open path goes through that read every
  // time the face opens (openToolAccess → refreshToolAccess →
  // loadToolAccess), with the held state a single open face's
  // model — keyed to no seat/entry map.
  const open = js.slice(js.indexOf('async function openToolAccess'), js.indexOf('function toolAccessNode'));
  assert.ok(open.includes('refreshToolAccess'), 'opening the face refreshes it');
  assert.ok(open.includes('loadToolAccess('), 'the refresh runs the tool-access read');
  assert.ok(js.includes('toolAccess: { open: false, seatId: null, entryId: null, model: null'), 'the held tool-access state is one open face, not a per-seat cache');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  TOOL_ACCESS_POSTURES,
  applyToolAccessWrite,
  loadToolAccess,
  pickToolAccessEntry,
  postureWriteBody,
  toolAccessEntries,
  toolAccessModel,
  toolAccessReadUrl,
  toolEnableWriteBody,
  writeToolAccessPosture,
  writeToolAccessTool,
} from '../app/connector-tool-access.mjs';
import { level2Model } from '../app/connector-panel.mjs';
import { plusMenuLevel2Model } from '../app/envoy-workspace.js';

// Panel-native home bite 1 (2026-11-10): the Tool access face in the
// channel connector panel — the per-connection posture picker and
// the per-tool switches over the connection's frozen snapshot. The
// face's model is connector-tool-access.mjs (pure); the panel
// composition is the real plusMenuLevel2Model over a real Level 2
// model; the writes are proven against stubbed roads shaped exactly
// like the real server contracts:
//   GET  /api/admin/connector-library/tool-access?seat=&entry=
//        → { valid, seatId, entryId, connected, posture, tools[],
//            snapshotTakenAt, snapshotHash }
//   POST /api/admin/connector-library/posture
//        { seatId, entryId, posture } → { status:'posture-set', connection }
//   POST /api/admin/connector-library/tool-enable
//        { seatId, entryId, toolEnableMap } → { status:'tool-map-set', connection }
// (src/cloud/connector-library-read-route.mjs's productionToolAccess
// and connector-library-write-route.mjs's posture/tool-enable
// actions; the store refuses tools the frozen snapshot does not
// name and merges partial maps — connector-library.mjs.)

// ---- fixtures: library reads in the Level 2 model's input shape ----
const libRow = (seatId, entryId, name, over = {}) => ({
  entryId, seatId, name,
  oneLiner: `The ${name} line`,
  vendorLabel: 'Vendor',
  trustLabel: 'verified',
  state: 'not-connected',
  stateDetail: null,
  accountIdentity: null,
  brokerMode: 'helmian',
  kind: 'catalog',
  ...over,
});
const library = (seatId, rows) => ({
  seatId,
  connectedCount: rows.filter((r) => r.state === 'connected').length,
  rows,
});
const CLAUDE_LIB = library('claude', [
  libRow('claude', 'helmian-github', 'GitHub', { state: 'connected', accountIdentity: 'troy' }),
  libRow('claude', 'helmian-vercel', 'Vercel', {}),
  libRow('claude', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', kind: 'oauth-app' }),
  libRow('claude', 'helmian-slack', 'Slack', { state: 'needs-reconnect' }),
]);
const flat = (model) => model.rows.flatMap(function walk(r) {
  return r.kind === 'submenu' ? [{ kind: 'submenu', label: r.label }, ...r.rows.flatMap(walk)] : [r];
});
const toolAccessRow = (model) => flat(model).find((r) => r.kind === 'action' && r.action === 'tool-access');

// The tool-access READ answer, shaped like productionToolAccess.
const READ = {
  valid: true, seatId: 'claude', entryId: 'helmian-github',
  connected: true, posture: 'ask',
  tools: [
    { name: 'list_repos', description: 'List repositories', annotation: 'read', effectiveAnnotation: 'read', enabled: true },
    { name: 'create_issue', description: 'Open an issue', annotation: 'write', effectiveAnnotation: 'write', enabled: false },
    { name: 'mystery_tool', description: '', annotation: 'undeclared', effectiveAnnotation: 'write', enabled: true },
  ],
  snapshotTakenAt: '2026-11-10T00:00:00.000Z', snapshotHash: 'abc123',
};
// The connection record the write roads answer with (connectionOf's
// shape in connector-library.mjs — the fields this face reads).
const connection = (over = {}) => ({
  id: 'conn-1', personId: 'person-1', seatId: 'claude', entryId: 'helmian-github',
  accountIdentity: 'troy', grantedScopes: [], posture: 'ask', toolEnableMap: {},
  toolSnapshotRef: 'snap-1', state: 'connected', ...over,
});

test('postures: exactly the server values, in server order, each with plain words', () => {
  assert.deepEqual(TOOL_ACCESS_POSTURES.map((p) => p.value), ['ask', 'read', 'low-risk', 'all'],
    'the picker offers CONNECTOR_POSTURES and nothing else (connector-library.mjs)');
  for (const p of TOOL_ACCESS_POSTURES) {
    assert.ok(p.label && p.detail, `${p.value} carries a plain label and a plain explanation`);
    assert.doesNotMatch(`${p.label} ${p.detail}`, /posture|snapshot|broker/i, 'no internal program words in the picker copy');
  }
});

test('entries: connected Helmian entries open the face; the rest say Connect first; mirrors never appear', () => {
  const entries = toolAccessEntries(level2Model(CLAUDE_LIB, {}, 'channel:c1'));
  assert.deepEqual(entries.map((e) => [e.entryId, e.connected, e.blockedNote]), [
    ['helmian-github', true, null],
    ['helmian-vercel', false, 'Connect first'],
    ['helmian-slack', false, 'Reconnect first'],
  ], 'connected first, then the rest in the read\u2019s own order, each with its plain blocker');
  assert.ok(!entries.some((e) => e.entryId === 'gmail'), 'a vendor mirror carries no posture or tool switches — it is not in this face at all');
  assert.equal(pickToolAccessEntry(entries, null)?.entryId, 'helmian-github', 'the face opens on the first connected entry');
});

test('entries: a pick that names an unconnected entry falls back to the first connected one', () => {
  const entries = toolAccessEntries(level2Model(CLAUDE_LIB, {}, 'channel:c1'));
  assert.equal(pickToolAccessEntry(entries, 'helmian-vercel')?.entryId, 'helmian-github',
    'an unconnected pick can never open a face with dead controls');
  assert.equal(pickToolAccessEntry(entries, 'helmian-github')?.entryId, 'helmian-github');
  assert.equal(pickToolAccessEntry([], null), null);
  assert.equal(pickToolAccessEntry(toolAccessEntries(level2Model(library('claude', [libRow('claude', 'helmian-vercel', 'Vercel', {})]), {}, 'c')), null), null,
    'a seat with nothing connected picks nothing');
});

test('composed menu: the Tool access row carries the face in the panel — entries, pick, open state', () => {
  const closed = toolAccessRow(plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'channel:c1' }));
  assert.ok(closed, 'Claude\u2019s Connectors submenu still carries the Tool access row');
  assert.equal(closed.open, false);
  assert.equal(closed.selectedEntryId, 'helmian-github');
  assert.deepEqual(closed.entries.map((e) => e.entryId), ['helmian-github', 'helmian-vercel', 'helmian-slack']);
  const open = toolAccessRow(plusMenuLevel2Model({
    seatId: 'claude', library: CLAUDE_LIB, conversationId: 'channel:c1',
    toolAccess: { open: true, seatId: 'claude', entryId: 'helmian-github' },
  }));
  assert.equal(open.open, true, 'the workspace\u2019s open state rides into the composed row');
  const otherSeat = toolAccessRow(plusMenuLevel2Model({
    seatId: 'claude', library: CLAUDE_LIB, conversationId: 'channel:c1',
    toolAccess: { open: true, seatId: 'grok', entryId: 'helmian-github' },
  }));
  assert.equal(otherSeat.open, false, 'one seat\u2019s open face never opens another seat\u2019s');
  const loading = toolAccessRow(plusMenuLevel2Model({ seatId: 'claude', library: null, conversationId: 'channel:c1' }));
  assert.equal(loading.libraryState, 'loading');
  assert.deepEqual(loading.entries, [], 'no library read, no invented entries');
});

test('read model: the face state is the read\u2019s state — posture, frozen tools, on/off', () => {
  const model = toolAccessModel(READ, { seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(model.connected, true);
  assert.equal(model.connectFirst, false);
  assert.equal(model.posture, 'ask');
  assert.deepEqual(model.options.map((o) => [o.value, o.selected]), [['ask', true], ['read', false], ['low-risk', false], ['all', false]]);
  assert.deepEqual(model.tools.map((t) => [t.name, t.kind, t.kindLabel, t.enabled]), [
    ['list_repos', 'read', 'Reads only', true],
    ['create_issue', 'write', 'Can change things', false],
    ['mystery_tool', 'write', 'Can change things', true],
  ], 'an undeclared tool reads as a tool that can change things — the server\u2019s own effective rule');
  assert.equal(model.hasSnapshot, true);
  assert.equal(model.snapshotHash, 'abc123');
});

test('read model: a disconnected answer is Connect first with no controls to draw', () => {
  const model = toolAccessModel(
    { valid: true, seatId: 'claude', entryId: 'helmian-vercel', connected: false, posture: null, tools: [], snapshotTakenAt: null, snapshotHash: null },
    { seatId: 'claude', entryId: 'helmian-vercel' },
  );
  assert.equal(model.connectFirst, true);
  assert.equal(model.posture, null);
  assert.deepEqual(model.tools, []);
  assert.ok(model.options.every((o) => !o.selected), 'no posture is shown chosen for a connection that does not exist');
});

test('read model: gaps stay gaps — no snapshot, unknown posture, malformed tools are never filled in', () => {
  const model = toolAccessModel({ connected: true, posture: 'sideways', tools: [{ description: 'no name' }, null, { name: 'ok_tool' }] }, { seatId: 'claude', entryId: 'x' });
  assert.equal(model.postureKnown, false);
  assert.ok(model.options.every((o) => !o.selected), 'an unknown posture selects nothing');
  assert.deepEqual(model.tools.map((t) => t.name), ['ok_tool'], 'a tool with no name is dropped, never invented');
  assert.equal(model.tools[0].enabled, true, 'a tool the read does not switch off is on (the read\u2019s own rule)');
  assert.equal(model.hasSnapshot, false);
});

test('wire shapes: the read URL and both write bodies are exactly the server contracts', () => {
  assert.equal(toolAccessReadUrl({ seatId: 'claude', entryId: 'helmian-github' }),
    '/api/admin/connector-library/tool-access?seat=claude&entry=helmian-github');
  assert.equal(toolAccessReadUrl({ seatId: 'claude' }), null);
  assert.deepEqual(postureWriteBody({ seatId: 'claude', entryId: 'helmian-github', posture: 'low-risk' }),
    { seatId: 'claude', entryId: 'helmian-github', posture: 'low-risk' });
  assert.equal(postureWriteBody({ seatId: 'claude', entryId: 'helmian-github', posture: 'sideways' }), null,
    'a posture the server does not hold is refused client-side, never sent');
  assert.deepEqual(toolEnableWriteBody({ seatId: 'claude', entryId: 'helmian-github', toolName: 'create_issue', enabled: true }),
    { seatId: 'claude', entryId: 'helmian-github', toolEnableMap: { create_issue: true } },
    'one flip sends the one-entry partial map the store merges');
  assert.equal(toolEnableWriteBody({ seatId: 'claude', entryId: 'helmian-github', toolName: 'not_in_snapshot', enabled: true, knownTools: [{ name: 'list_repos' }] }), null,
    'a tool outside the face\u2019s frozen snapshot is never sent — the store would refuse it');
});

test('write folding: the face after a write is the write\u2019s own returned connection, not the flip', () => {
  const model = toolAccessModel(READ, { seatId: 'claude', entryId: 'helmian-github' });
  const after = applyToolAccessWrite(model, connection({ posture: 'read', toolEnableMap: { create_issue: true } }));
  assert.equal(after.posture, 'read');
  assert.deepEqual(after.options.map((o) => [o.value, o.selected]), [['ask', false], ['read', true], ['low-risk', false], ['all', false]]);
  assert.equal(after.tools.find((t) => t.name === 'create_issue').enabled, true, 'the stored map says on');
  assert.equal(after.tools.find((t) => t.name === 'list_repos').enabled, true, 'a tool absent from the stored map is on');
  const unproven = applyToolAccessWrite(model, null);
  assert.equal(unproven, model, 'a write answer with no connection record changes nothing the face can prove');
});

test('round trip: open the face, change the posture, flip a tool — the writes carry the exact contract payloads', async () => {
  const calls = [];
  // Stubbed roads shaped like the real ones: the read answers the
  // per-entry snapshot; the writes answer the full connection
  // record the store stored (posture applied; the tool map merged
  // over the stored one, exactly like setToolEnableMap).
  let stored = connection({ posture: 'ask', toolEnableMap: { create_issue: false } });
  const api = async (url) => { calls.push(['GET', url]); return READ; };
  const post = async (path, body) => {
    calls.push(['POST', path, body]);
    if (path === '/api/admin/connector-library/posture') {
      stored = connection({ ...stored, posture: body.posture });
      return { status: 'posture-set', connection: stored };
    }
    if (path === '/api/admin/connector-library/tool-enable') {
      stored = connection({ ...stored, toolEnableMap: { ...stored.toolEnableMap, ...body.toolEnableMap } });
      return { status: 'tool-map-set', connection: stored };
    }
    throw new Error(`unexpected road ${path}`);
  };

  let model = await loadToolAccess({ api, seatId: 'claude', entryId: 'helmian-github' });
  assert.deepEqual(calls[0], ['GET', '/api/admin/connector-library/tool-access?seat=claude&entry=helmian-github'],
    'opening the face reads the tool-access read for the picked entry — no cached invention');
  assert.equal(model.posture, 'ask');
  assert.equal(model.tools.find((t) => t.name === 'create_issue').enabled, false);

  model = await writeToolAccessPosture({ post, model, posture: 'low-risk' });
  assert.deepEqual(calls[1], ['POST', '/api/admin/connector-library/posture', { seatId: 'claude', entryId: 'helmian-github', posture: 'low-risk' }],
    'the posture pick posts exactly { seatId, entryId, posture } to the posture road');
  assert.equal(model.posture, 'low-risk', 'the face now shows the posture the server stored');

  model = await writeToolAccessTool({ post, model, toolName: 'create_issue', enabled: true });
  assert.deepEqual(calls[2], ['POST', '/api/admin/connector-library/tool-enable', { seatId: 'claude', entryId: 'helmian-github', toolEnableMap: { create_issue: true } }],
    'the tool flip posts exactly { seatId, entryId, toolEnableMap } to the tool-enable road');
  assert.equal(model.tools.find((t) => t.name === 'create_issue').enabled, true, 'the switch now shows the server\u2019s stored state');
  assert.equal(model.posture, 'low-risk', 'a tool write never touches the posture');

  const refused = await writeToolAccessTool({ post, model, toolName: 'not_in_snapshot', enabled: true });
  assert.equal(refused, null, 'flipping a tool the snapshot does not hold sends nothing');
  assert.equal(calls.length, 3, 'no extra road was called');
});

test('face wiring: the panel renders the face in place and never funnels Tool access to the Agents tab', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const needle of [
    'function toolAccessNode',
    'function openToolAccess',
    "loadToolAccess({ api: (url) => ws.ctx.api(url)",
    'writeToolAccessPosture({ post:',
    'writeToolAccessTool({ post:',
    "if (row.action === 'tool-access') return toolAccessNode(which, row);",
    'Connect first — tool access belongs to a connection',
    'entry.blockedNote',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  const node = js.slice(js.indexOf('function toolAccessNode'), js.indexOf('function plusMenuRowNode'));
  assert.ok(!node.includes('openManageForSeat'), 'the Tool access face never leaves the panel for the Agents tab');
  assert.ok(!js.includes("title: 'Open this seat\u2019s account page in Helmian', onclick: () => openManageForSeat(which) },\n          h('span', {}, row.label)"), 'the old funnel row is gone');
  const menu = await readFile(new URL('../app/connector-menu.mjs', import.meta.url), 'utf8');
  assert.ok(menu.includes("action('Tool access', 'tool-access')"), 'the menu definition still carries the one Tool access row');
});

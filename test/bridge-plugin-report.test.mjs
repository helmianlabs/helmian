// Bridge plugin reports (M3 G7) — the cloud half of the plugins pipe.
//
// The pins, over the repo-pattern fake pool (the bridge_plugin_reports
// table keyed by the tenant the transaction set, the way RLS enforces
// it) and the real surfaces' models:
//
//   - a device-token POST of a bridge `commands` payload stores the
//     report with the bridge's `root` paths ABSENT from the stored
//     bytes — the drop happens at ingest, and warning strings are
//     counted, never carried (they can name PC file paths);
//   - the tenant is the credential's: a body naming another tenant
//     does not move the report;
//   - a member's POST writes nothing (the presence degrade rule);
//   - a second report replaces the first whole, age reset;
//   - the plugins read then prefers the stored report over the local
//     list and carries the report's age as `bridgeReport`; with no
//     report the read is the local list, unchanged, no age field;
//   - the stale rule (shared by the console picker and the workspace
//     plus menu) fires only past 24 hours, and an empty list behind
//     a stale report is not "no plugins are installed";
//   - before sql/089 lands, the store answers "no report" on reads
//     and reports unavailable on writes, like its neighbours.
//
// The store is proven against the fake pool only: the .pg-gated
// suites are not part of this bite's set, and no live Postgres was
// used. The production bridgeList wiring (productionDeps) is not
// injectable, so the read test wires the dep exactly the way
// productionDeps and live-admin's lister do — report helper over
// the store, local list as the fallback constant.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_PLUGIN_REPORT_PATH,
  createBridgePluginReportStore,
  bridgeReportPluginList,
  bridgePluginReportRow,
  shapeBridgePluginReport,
  handleBridgePluginReportRoute,
} from '../src/cloud/bridge-plugin-report.mjs';
import { handlePluginLibraryRoute, PLUGINS_PATH } from '../src/cloud/plugin-library-route.mjs';
import { installedPluginRow } from '../src/cloud/installed-plugins.mjs';
import { PLUGINS_REPORT_STALE_MS, pickerModel, pluginsReportStaleNote } from '../web/marketing/app/composer-picker.mjs';
import { plusMenuLevel2Model } from '../web/marketing/app/envoy-workspace.js';

class TenantAuthorizationError extends Error {}

const DEVICE = { subject: 'device:pc-bridge', tenantId: 'tenant-a', role: 'admin', viaDeviceToken: true };
const MEMBER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const DAY = 24 * 60 * 60 * 1000;

// A bridge `commands` event's plugins half, in the bridge's own
// shape (src/agent/bridge.mjs): roots and path-carrying warnings
// included, exactly as the sender hop will post it.
const COMMANDS_PLUGINS = [
  {
    name: 'notes-tools',
    root: 'C:\\Users\\troyh\\helmian\\plugins\\notes-tools',
    version: '1.2.0',
    commands: true,
    approvedMcpServers: ['notes-server'],
    refusedMcpServers: [{ name: 'rogue-server', reason: 'not on the approved list' }],
    warnings: ['could not read C:\\Users\\troyh\\helmian\\plugins\\notes-tools\\extra.json'],
  },
  {
    name: 'plain-one',
    root: '/home/troy/helmian/plugins/plain-one',
    commands: false,
    approvedMcpServers: [],
    refusedMcpServers: [],
    warnings: [],
  },
];

// ------------------------------------------------------------- fake pool
// helmion.bridge_plugin_reports, keyed by the tenant the transaction
// set. The raw jsonb string is kept beside the parsed value so the
// roots-absent pin reads the stored BYTES, not a re-serialization.
function fakeReportPool({ missing = false } = {}) {
  const rows = new Map();
  let tenant = null;
  return {
    rows,
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (missing) throw Object.assign(new Error('relation "helmion.bridge_plugin_reports" does not exist'), { code: '42P01' });
          if (text.includes('insert into helmion.bridge_plugin_reports')) {
            rows.set(tenant, { reported_at: new Date(vals[0]), rawJson: vals[1], plugins: JSON.parse(vals[1]) });
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('from helmion.bridge_plugin_reports')) {
            const row = rows.get(tenant);
            return { rows: row ? [{ reported_at: row.reported_at, plugins: row.plugins }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`unexpected query: ${text}`);
        },
        release() {},
      };
    },
  };
}

function ingestHarness({ actor = DEVICE, store } = {}) {
  const sent = [];
  return {
    sent,
    async run(path = BRIDGE_PLUGIN_REPORT_PATH, { method = 'POST', body = undefined } = {}) {
      const handled = await handleBridgePluginReportRoute({
        request: { method },
        response: {},
        requestUrl: new URL(path, 'http://local'),
        activeTenantActor: async () => actor,
        send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
        TenantAuthorizationError,
        readJson: async () => body ?? {},
        store,
      });
      return handled;
    },
  };
}

// The plugins read with its bridge dep wired the way productionDeps
// (plugin-library-route.mjs) and live-admin's lister wire it: the
// report helper over the store, the local list as fallback.
function readHarness({ actor = MEMBER, store } = {}) {
  const sent = [];
  const localList = {
    plugins: [installedPluginRow({ name: 'local-only' })],
    unavailable: [],
  };
  const bridgeList = async (tenantId) => {
    const fromReport = await bridgeReportPluginList(store, tenantId).catch(() => null);
    return fromReport ?? localList;
  };
  return {
    sent,
    async run() {
      return handlePluginLibraryRoute({
        request: { method: 'GET' },
        response: {},
        requestUrl: new URL(PLUGINS_PATH, 'http://local'),
        activeTenantActor: async () => actor,
        send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
        TenantAuthorizationError,
        readJson: async () => ({}),
        plugins: { listPlugins: async () => [] },
        skills: {},
        entryExists: () => false,
        entryStates: async () => new Map(),
        bridgeList,
        shelf: [],
      });
    },
  };
}

test('ingest: a device-token POST stores the report with roots and paths ABSENT from the stored bytes', async () => {
  const pool = fakeReportPool();
  const store = createBridgePluginReportStore(pool);
  const h = ingestHarness({ store });
  const handled = await h.run(BRIDGE_PLUGIN_REPORT_PATH, { body: { type: 'commands', workspace: 'C:\\Users\\troyh\\helmian', plugins: COMMANDS_PLUGINS } });
  assert.equal(handled, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.valid, true);
  assert.equal(h.sent[0].body.ok, true);
  assert.equal(h.sent[0].body.pluginCount, 2);

  const stored = pool.rows.get('tenant-a');
  assert.ok(stored, 'the report landed under the credential tenant');
  // The stored bytes: no root field, no PC path fragment, no
  // warning string — the drop is at the door, not the renderer.
  assert.ok(!stored.rawJson.includes('root'), 'no root key in the stored bytes');
  assert.ok(!stored.rawJson.includes('C:'), 'no drive path in the stored bytes');
  assert.ok(!stored.rawJson.includes('extra.json'), 'no warning text (it named a file) in the stored bytes');
  assert.ok(!stored.rawJson.includes('/home/troy'), 'no home path in the stored bytes');
  assert.deepEqual(stored.plugins, [
    {
      name: 'notes-tools',
      version: '1.2.0',
      commands: true,
      approvedMcpServers: ['notes-server'],
      refusedMcpServers: [{ name: 'rogue-server', reason: 'not on the approved list' }],
      warningCount: 1,
    },
    {
      name: 'plain-one',
      commands: false,
      approvedMcpServers: [],
      refusedMcpServers: [],
      warningCount: 0,
    },
  ]);
});

test('ingest: the tenant comes from the credential — a body naming another tenant does not move the report', async () => {
  const pool = fakeReportPool();
  const store = createBridgePluginReportStore(pool);
  const h = ingestHarness({ store });
  await h.run(BRIDGE_PLUGIN_REPORT_PATH, { body: { tenantId: 'tenant-b', tenant: 'tenant-b', plugins: COMMANDS_PLUGINS } });
  assert.equal(h.sent[0].status, 200);
  assert.equal(await store.latest('tenant-b'), null, 'nothing landed under the body-named tenant');
  const mine = await store.latest('tenant-a');
  assert.ok(mine, 'the report landed under the credential tenant');
  assert.equal(mine.plugins.length, 2);
});

test('ingest: a member POST writes nothing and answers reportAccepted: false', async () => {
  const pool = fakeReportPool();
  const store = createBridgePluginReportStore(pool);
  const h = ingestHarness({ actor: MEMBER, store });
  await h.run(BRIDGE_PLUGIN_REPORT_PATH, { body: { plugins: COMMANDS_PLUGINS } });
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body, { valid: true, reportAccepted: false });
  assert.equal(pool.rows.size, 0, 'a member session cannot attest to a bridge: nothing stored');
});

test('ingest: a device POST without a plugins array is refused with 400', async () => {
  const store = createBridgePluginReportStore(fakeReportPool());
  const h = ingestHarness({ store });
  await h.run(BRIDGE_PLUGIN_REPORT_PATH, { body: { type: 'commands' } });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.valid, false);
});

test('store: a second report replaces the first whole and the age resets', async () => {
  const store = createBridgePluginReportStore(fakeReportPool());
  const t0 = new Date('2026-11-13T10:00:00.000Z');
  await store.report('tenant-a', [{ name: 'first-one', commands: false }], t0);
  const t1 = new Date(t0.getTime() + 60 * 60 * 1000);
  await store.report('tenant-a', [{ name: 'second-one', commands: true }], t1);
  const latest = await store.latest('tenant-a', new Date(t1.getTime() + 5 * 60 * 1000));
  assert.deepEqual(latest.plugins.map((p) => p.name), ['second-one'], 'the newer report stands alone');
  assert.equal(latest.reportedAt, t1.toISOString());
  assert.equal(latest.ageMs, 5 * 60 * 1000, 'the age runs from the newest report, not the first');
});

test('store: before sql/089 lands, reads answer no report and writes report unavailable', async () => {
  const store = createBridgePluginReportStore(fakeReportPool({ missing: true }));
  assert.equal(await store.latest('tenant-a'), null);
  await assert.rejects(() => store.report('tenant-a', []), (error) => error.status === 503);
  assert.equal(await bridgeReportPluginList(store, 'tenant-a'), null, 'the read preference falls back clean');
});

test('shaping: unusable names drop, non-string versions drop, warnings are counted, duplicates keep the first', () => {
  const shaped = shapeBridgePluginReport([
    { name: 'Bad Name!', commands: true },
    { name: 'kept', version: 42, warnings: ['one', 'two'] },
    { name: 'kept', version: '9.9.9' },
    { name: 'also-kept', version: ' 2.0 ' },
    'not an object',
  ]);
  assert.deepEqual(shaped.map((e) => e.name), ['kept', 'also-kept']);
  assert.equal('version' in shaped[0], false, 'a non-string version never rides');
  assert.equal(shaped[0].warningCount, 2);
  assert.equal('warnings' in shaped[0], false, 'the warning strings themselves never ride');
  assert.equal(shaped[1].version, '2.0');
  const row = bridgePluginReportRow(shaped[0]);
  assert.equal(row.name, 'kept');
  assert.equal(row.commands, false);
});

test('read: with a stored report the plugins read serves the report rows and carries the age', async () => {
  const store = createBridgePluginReportStore(fakeReportPool());
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await store.report('tenant-a', COMMANDS_PLUGINS, twoHoursAgo);
  const h = readHarness({ store });
  await h.run();
  assert.equal(h.sent[0].status, 200);
  const body = h.sent[0].body;
  const names = body.plugins.map((p) => p.name);
  assert.ok(names.includes('notes-tools'), 'the report supplies the list');
  assert.ok(!names.includes('local-only'), 'the local list does not ride when a report exists');
  const notes = body.plugins.find((p) => p.name === 'notes-tools');
  assert.equal(notes.brings, 'Brings 1 approved tool server — their tools join the turn; adds its commands as skills; 1 declared server was refused by the install ledger and stays off.', 'report rows speak the one row vocabulary — installedPluginRow’s own line, verbatim');
  assert.equal(notes.commands, true);
  assert.ok(body.bridgeReport, 'the age rides');
  assert.equal(body.bridgeReport.reportedAt, twoHoursAgo.toISOString());
  assert.ok(body.bridgeReport.ageMs > 1.9 * 60 * 60 * 1000 && body.bridgeReport.ageMs < 2.1 * 60 * 60 * 1000, `age ≈ 2h (got ${body.bridgeReport.ageMs})`);
});

test('read: with no report the plugins read is the local list, unchanged, no age field', async () => {
  const store = createBridgePluginReportStore(fakeReportPool());
  const h = readHarness({ store });
  await h.run();
  assert.equal(h.sent[0].status, 200);
  const body = h.sent[0].body;
  assert.deepEqual(body.plugins.map((p) => p.name), ['local-only']);
  assert.equal('bridgeReport' in body, false, 'no report → no age field, the answer is byte-identical in shape to today');
});

test('stale rule: fires only past 24 hours', () => {
  assert.equal(pluginsReportStaleNote(null), null);
  assert.equal(pluginsReportStaleNote(undefined), null);
  assert.equal(pluginsReportStaleNote(0), null);
  assert.equal(pluginsReportStaleNote(PLUGINS_REPORT_STALE_MS), null, 'exactly a day is not yet stale');
  assert.match(pluginsReportStaleNote(PLUGINS_REPORT_STALE_MS + 1), /over a day old/);
  assert.match(pluginsReportStaleNote(2 * DAY), /last report/);
});

test('stale rule: the console picker group note carries it when the report is old, and only then', () => {
  const base = { plugins: [{ name: 'calc', brings: 'Adds its commands as skills.', tools: false, commands: true }], unavailable: [] };
  const fresh = pickerModel({ plugins: { ...base, bridgeReport: { reportedAt: 'x', ageMs: 60 * 1000 } } });
  assert.ok(!fresh.groups.find((g) => g.id === 'plugins').note.includes('over a day old'));
  const stale = pickerModel({ plugins: { ...base, bridgeReport: { reportedAt: 'x', ageMs: DAY + 1 } } });
  assert.ok(stale.groups.find((g) => g.id === 'plugins').note.includes('over a day old'));
  const none = pickerModel({ plugins: base });
  assert.ok(!none.groups.find((g) => g.id === 'plugins').note.includes('over a day old'), 'no report → no stale note');
});

const EMPTY_LIB = { seatId: 'claude', connectedCount: 0, rows: [] };
const flatRows = (model) => model.rows.flatMap(function walk(r) {
  return r.kind === 'submenu' ? [{ kind: 'submenu', label: r.label }, ...r.rows.flatMap(walk)] : [r];
});
const noteTexts = (model) => flatRows(model).filter((r) => r.kind === 'note').map((r) => r.text);

test('stale rule: the workspace plus menu shows the note past a day, and an empty stale report is not "none installed"', () => {
  const staleEmpty = plusMenuLevel2Model({ seatId: 'claude', library: EMPTY_LIB, conversationId: 'c1', skills: [], plugins: [], pluginsReportAgeMs: DAY + 1000, projects: [] });
  const staleNotes = noteTexts(staleEmpty);
  assert.ok(staleNotes.some((t) => t.includes('over a day old')), 'the stale note stands over an empty last report');
  assert.ok(!staleNotes.includes('No plugins are installed.'), 'the empty note does not stand over a report');

  const freshEmpty = plusMenuLevel2Model({ seatId: 'claude', library: EMPTY_LIB, conversationId: 'c1', skills: [], plugins: [], projects: [] });
  const freshNotes = noteTexts(freshEmpty);
  assert.ok(freshNotes.includes('No plugins are installed.'), 'no report age → the plain empty note, unchanged');
  assert.ok(!freshNotes.some((t) => t.includes('over a day old')));

  const staleList = plusMenuLevel2Model({ seatId: 'claude', library: EMPTY_LIB, conversationId: 'c1', skills: [], plugins: [{ name: 'notes-tools', brings: 'Notes reads' }], pluginsReportAgeMs: DAY + 1000, projects: [] });
  assert.ok(flatRows(staleList).some((r) => r.kind === 'plugin' && r.name === 'notes-tools'), 'the rows still list');
  assert.ok(noteTexts(staleList).some((t) => t.includes('over a day old')), 'and the stale note rides beside them');
});

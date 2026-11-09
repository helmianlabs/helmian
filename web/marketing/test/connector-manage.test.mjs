// The Manage surface (mirror M1): the pure row-controls model and
// the static wiring that lands every seat panel's "Manage
// connectors" row on THIS surface at that seat's tab.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { rowControls, seatName, toolAccessRows, pluginsListModel, pluginsUnavailableLine, MIRROR_LINE, MANAGE_SEAT_STORAGE_KEY, NO_SNAPSHOT_LINE, NO_PLUGINS_LINE, TOOL_ANNOTATION_LABELS } from '../app/connector-manage.mjs';

const manage = await readFile(new URL('../app/connector-manage.mjs', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');

test('rowControls: mirror rows are view-only with the one plain line', () => {
  const ctl = rowControls({ brokerMode: 'vendor', state: 'connected' }, { role: 'owner' });
  assert.equal(ctl.mode, 'mirror');
  assert.equal(ctl.note, MIRROR_LINE);
  assert.match(MIRROR_LINE, /connecting it there does not connect it here/);
});

test('rowControls: a connected Helmian row carries posture, disconnect; owner acts are role-gated', () => {
  const row = { brokerMode: 'helmian', state: 'connected', kind: 'custom', accountIdentity: 'Work key', stateDetail: { posture: 'read' } };
  const owner = rowControls(row, { role: 'owner' });
  assert.equal(owner.mode, 'connected');
  assert.equal(owner.posture, 'read');
  assert.equal(owner.canDisconnect, true);
  assert.equal(owner.canDisable, true);
  assert.equal(owner.canRemove, true);
  const member = rowControls(row, { role: 'member' });
  assert.equal(member.canDisconnect, true);
  assert.equal(member.canDisable, false);
  assert.equal(member.canRemove, false);
  const catalog = rowControls({ ...row, kind: 'catalog' }, { role: 'owner' });
  assert.equal(catalog.canRemove, false, 'only custom entries are removable');
});

test('rowControls: not-connected offers Connect; disabled offers owner re-enable only', () => {
  assert.equal(rowControls({ brokerMode: 'helmian', state: 'not-connected' }).mode, 'connect');
  assert.equal(rowControls({ brokerMode: 'helmian', state: 'needs-reconnect' }).reconnect, true);
  const off = rowControls({ brokerMode: 'helmian', state: 'disabled-by-owner' }, { role: 'admin' });
  assert.equal(off.mode, 'disabled');
  assert.equal(off.canEnable, true);
  assert.equal(rowControls({ brokerMode: 'helmian', state: 'disabled-by-owner' }, { role: 'member' }).canEnable, false);
});

test('seat names come from the library seat list', () => {
  assert.equal(seatName('chatgpt'), 'ChatGPT');
  assert.equal(seatName('claude'), 'Claude');
});

test('wiring: the surface mounts in the Integrations view and app.js loads it', () => {
  assert.match(html, /id="connector-manage"/);
  assert.match(appJs, /import\('\.\/connector-manage\.mjs'\)/);
  assert.match(appJs, /mountConnectorManage\(manageBox/);
  assert.ok(appJs.includes("'/app/connector-manage.mjs'"), 'the deploy watch list carries the new module');
});

test('wiring: the surface reads the existing reads and writes through the M1 routes', () => {
  for (const path of [
    '/api/admin/connector-library/seats',
    '/api/admin/connector-library?seat=',
    '/api/admin/connector-library/connect',
    '/api/admin/connector-library/connect/header',
    '/api/admin/connector-library/disconnect',
    '/api/admin/connector-library/posture',
    '/api/admin/connector-library/entry-state',
    '/api/admin/connector-library/entries',
    '/api/admin/connector-library/entries/remove',
    '/api/admin/connector-library/tool-access?seat=',
    '/api/admin/connector-library/tool-enable',
    '/api/admin/skills',
    '/api/admin/plugins',
  ]) assert.ok(manage.includes(path), path);
});

test('rowControls: a connected Helmian row carries Tool access; a mirror row never does (bite M2)', () => {
  const row = { brokerMode: 'helmian', state: 'connected', kind: 'catalog', stateDetail: { posture: 'ask' } };
  assert.equal(rowControls(row, { role: 'member' }).canToolAccess, true);
  const mirror = rowControls({ brokerMode: 'vendor', state: 'connected' }, { role: 'owner' });
  assert.equal(mirror.mode, 'mirror');
  assert.equal(mirror.canToolAccess, undefined, 'vendor tools are never shown on Helmian\u2019s face');
  assert.equal(rowControls({ brokerMode: 'helmian', state: 'not-connected' }).canToolAccess, undefined);
});

test('toolAccessRows: posture in words, per-tool annotations labelled, enabled defaults on', () => {
  const view = toolAccessRows({
    connected: true,
    posture: 'read',
    snapshotHash: 'abc123',
    snapshotTakenAt: '2026-11-09T10:00:00.000Z',
    tools: [
      { name: 'search', description: 'Search mail', annotation: 'read', enabled: true },
      { name: 'send', description: 'Send mail', annotation: 'write', enabled: false },
      { name: 'mystery', description: '', annotation: 'undeclared' },
      { name: '', description: 'nameless rows are dropped' },
      { description: 'no name at all' },
    ],
  });
  assert.equal(view.connected, true);
  assert.equal(view.posture, 'read');
  assert.equal(view.postureLine, 'Reading is fine; ask before changes');
  assert.equal(view.hasSnapshot, true);
  assert.equal(view.snapshotTakenAt, '2026-11-09T10:00:00.000Z');
  assert.deepEqual(view.tools.map((t) => [t.name, t.annotationLabel, t.enabled]), [
    ['search', 'Reads', true],
    ['send', 'Changes things', false],
    ['mystery', 'Undeclared — treated as changes', true],
  ]);
  assert.equal(TOOL_ANNOTATION_LABELS.undeclared, 'Undeclared — treated as changes');
});

test('toolAccessRows: no snapshot is an honest state, not an empty tool list', () => {
  const view = toolAccessRows({ connected: true, posture: 'ask', tools: [], snapshotTakenAt: null, snapshotHash: null });
  assert.equal(view.hasSnapshot, false);
  assert.deepEqual(view.tools, []);
  assert.match(NO_SNAPSHOT_LINE, /No tool list has been frozen/);
  const empty = toolAccessRows(null);
  assert.equal(empty.connected, false);
  assert.equal(empty.posture, null);
  assert.equal(empty.hasSnapshot, false);
});

test('pluginsListModel: plugins that failed to load are named, never read as none installed (fix B)', () => {
  // (a) Zero loaded + failures behind the read: the count line, and
  // no empty line — "none installed" would be a lie here.
  const onlyFailed = pluginsListModel({ plugins: [], unavailable: [{ name: 'a', error: 'x' }, { name: 'b', error: 'y' }] });
  assert.equal(onlyFailed.unavailableCount, 2);
  assert.equal(onlyFailed.unavailableLine, '2 plugins could not be loaded.');
  assert.equal(onlyFailed.emptyLine, null);
  assert.deepEqual(onlyFailed.plugins, []);
  // (b) Truly empty: the empty line only, no count line.
  const trulyEmpty = pluginsListModel({ plugins: [], unavailable: [] });
  assert.equal(trulyEmpty.emptyLine, 'No plugins are installed.');
  assert.equal(trulyEmpty.emptyLine, NO_PLUGINS_LINE);
  assert.equal(trulyEmpty.unavailableLine, null);
  assert.equal(pluginsListModel(null).emptyLine, NO_PLUGINS_LINE, 'a missing body reads as a clean empty');
  assert.equal(pluginsListModel({}).unavailableLine, null, 'a missing unavailable list is no failures, not an error');
  // (c) Loaded plugins AND a failure: both survive the model.
  const mixed = pluginsListModel({ plugins: [{ name: 'scribe-tools' }], unavailable: [{ name: 'c', error: 'z' }] });
  assert.equal(mixed.plugins.length, 1);
  assert.equal(mixed.unavailableLine, '1 plugin could not be loaded.');
  assert.equal(mixed.emptyLine, null);
  // The line builder itself: singular, plural, and silence at zero.
  assert.equal(pluginsUnavailableLine(0), null);
  assert.equal(pluginsUnavailableLine(1), '1 plugin could not be loaded.');
  assert.equal(pluginsUnavailableLine(3), '3 plugins could not be loaded.');
});

test('wiring: the Plugins tab renders the plugins model, and neither surface claims the old shelf (fix B)', () => {
  assert.match(manage, /const model = pluginsListModel\(body\);/);
  assert.match(manage, /if \(model\.unavailableLine\) frag\.append/);
  assert.ok(!manage.includes('No plugins are installed in this workspace.'), 'the Manage empty note no longer names a shelf the read never reaches');
  assert.ok(!workspace.includes('No plugins are installed on the PC bridge.'), 'the menu empty note no longer names the PC bridge');
  assert.match(workspace, /ws\.plugins\.unavailable = Array\.isArray\(body\?\.unavailable\)/, 'the menu loader keeps the unavailable list on the plugins state');
  assert.match(workspace, /pluginsUnavailable: ws\.plugins\.loaded \? ws\.plugins\.unavailable : \[\]/, 'the menu model receives the unavailable list');
});

test('wiring: the surface paints a loading state first — empty states wait for the first reads', () => {
  // The 2026-11-09 exercise: first landings showed a false empty
  // state with no seat tabs until a detour away and back. The
  // surface now paints "Loading connectors…" synchronously and only
  // renders real content (empty states included) once `loaded`.
  assert.match(manage, /Loading connectors…/);
  assert.match(manage, /loaded: false/);
  assert.match(manage, /if \(!state\.loaded\) root\.replaceChildren\(note, loadingLine\(\)\)/);
  assert.match(manage, /state\.loaded = true/);
  assert.ok(manage.indexOf('Loading connectors…') < manage.indexOf('async function refresh'), 'the loading line is painted at construction, before any read');
});

test('wiring: loadIntegrations holds the "Nothing connected yet" hint down with a loading line', () => {
  assert.match(appJs, /Loading integrations…/);
  const fnStart = appJs.indexOf('async function loadIntegrations');
  assert.ok(fnStart >= 0);
  assert.ok(appJs.indexOf('Loading integrations…', fnStart) < appJs.indexOf('Promise.allSettled', fnStart), 'the placeholder lands before the integrations reads start');
});

test('wiring: the composer Manage row leaves the seat marker for this surface', () => {
  assert.equal(MANAGE_SEAT_STORAGE_KEY, 'helmian.manageSeat');
  assert.match(workspace, /sessionStorage\.setItem\('helmian\.manageSeat', ws\.libraryPanel\.seatId\)/);
  assert.match(manage, /sessionStorage\.getItem\(MANAGE_SEAT_STORAGE_KEY\)/);
});

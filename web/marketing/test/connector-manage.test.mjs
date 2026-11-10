// The Manage surface (mirror M1): the pure row-controls model and
// the static wiring that lands every seat panel's "Manage
// connectors" row on THIS surface at that seat's tab.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { rowControls, seatName, toolAccessRows, pluginsListModel, pluginsUnavailableLine, renderConnectorManage, MIRROR_NOTE, mirrorGroupTitle, planConnectorRows, openKeyFor, MANAGE_SEAT_STORAGE_KEY, MANAGE_TAB_STORAGE_KEY, MANAGE_SEAT_MEMORY_KEY, NO_SNAPSHOT_LINE, NO_PLUGINS_LINE, PLUGIN_CATALOG_TITLE, NO_SHELF_LINE, TOOL_ANNOTATION_LABELS } from '../app/connector-manage.mjs';

const manage = await readFile(new URL('../app/connector-manage.mjs', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');

test('rowControls: mirror rows are view-only and carry NO per-row note (simplify pass)', () => {
  const ctl = rowControls({ brokerMode: 'vendor', state: 'connected' }, { role: 'owner' });
  assert.equal(ctl.mode, 'mirror');
  assert.equal(ctl.note, undefined, 'the mirror note is the group\u2019s, said once per seat — never a per-row field');
});

test('planConnectorRows: duplicate names collapse to the brokered row; leftover mirrors group with the note once', () => {
  const brokeredGithub = { entryId: 'github', name: 'GitHub', brokerMode: 'helmian', state: 'connected' };
  const mirrorGithub = { entryId: 'vendor-github', name: 'GitHub', brokerMode: 'vendor', state: 'connected' };
  const atlassian = { entryId: 'vendor-atlassian', name: 'Atlassian', brokerMode: 'vendor', state: 'not-connected' };
  const gmail = { entryId: 'vendor-gmail', name: 'Gmail', brokerMode: 'vendor', state: 'not-connected' };
  const plan = planConnectorRows([brokeredGithub, atlassian, mirrorGithub, gmail], 'Claude');
  assert.deepEqual(plan.primary, [brokeredGithub], 'one primary row for the name GitHub: the brokered entry');
  assert.deepEqual(plan.mirrors, [atlassian, gmail], 'the GitHub mirror is gone; mirrors with no brokered namesake remain, in read order');
  assert.equal(plan.mirrorTitle, 'On Claude\u2019s own side');
  assert.equal(plan.mirrorTitle, mirrorGroupTitle('Claude'));
  assert.equal(plan.mirrorNote, MIRROR_NOTE, 'one note string for the whole seat, however many mirror rows stand under it');
  assert.match(MIRROR_NOTE, /connecting them there does not connect them here/);
  // Name matching is trimmed and case-insensitive, and read order does not matter.
  const flipped = planConnectorRows([
    { entryId: 'm1', name: ' github ', brokerMode: 'vendor', state: 'connected' },
    { entryId: 'b1', name: 'GitHub', brokerMode: 'helmian', state: 'connected' },
  ], 'Claude');
  assert.deepEqual(flipped.primary.map((r) => r.entryId), ['b1']);
  assert.deepEqual(flipped.mirrors, []);
  assert.equal(flipped.mirrorNote, null, 'no leftover mirrors, no group, no note');
  // A seat with no mirrors at all plans no group.
  const plain = planConnectorRows([brokeredGithub], 'Claude');
  assert.deepEqual(plain.mirrors, []);
  assert.equal(plain.mirrorTitle, null);
  assert.equal(plain.mirrorNote, null);
  assert.deepEqual(planConnectorRows(null).primary, [], 'a missing read plans empty, not a crash');
});

test('wiring: the disclaimer sentence renders at most once per seat — the group head, never a card', () => {
  assert.ok(!manage.includes('This connector lives in the vendor'), 'the old per-card paragraph is gone from the module');
  assert.equal(manage.split('does not connect them here').length - 1, 1, 'the note\u2019s words exist exactly once in the module: inside MIRROR_NOTE');
  assert.match(manage, /wrap\.append\(el\('p', 'cm-mirror-note muted sm', plan\.mirrorNote\)\)/, 'the one render of the note is the mirror group\u2019s head');
  assert.ok(!manage.includes('ctl.note'), 'no row renders a note of its own');
  assert.match(manage, /const plan = planConnectorRows\(state\.rows, seatName\(state\.seat\)\)/, 'the tab renders the plan, not the raw read');
  assert.match(manage, /if \(plan\.mirrors\.length\) frag\.append\(mirrorGroup\(plan\)\)/, 'the group renders only when leftover mirrors exist');
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
  // The import specifier carries the shell stamp (?v=…, 2026-11-09
  // speed fix); the wiring law is the import itself.
  assert.match(appJs, /import\('\.\/connector-manage\.mjs(\?v=[0-9a-f]{16})?'\)/);
  assert.match(appJs, /mountConnectorManage\(manageBox/);
  // The watch law, restated for the stamp (2026-11-09): DEPLOY_WATCH
  // no longer lists files — it watches the document alone, and the
  // document names the shell stamp this module feeds, so a change to
  // the module still moves the one watched ETag.
  assert.match(appJs, /DEPLOY_WATCH = \['\/app'\]/, 'the deploy watch watches the document alone');
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

test('wiring: the Manage road opens Integrations on the Connectors tab, not the remembered one', () => {
  // Menu side: openManageForSeat names the landing tab beside the seat marker.
  assert.equal(MANAGE_TAB_STORAGE_KEY, 'helmian.manageTab');
  const fnStart = workspace.indexOf('function openManageForSeat');
  assert.ok(fnStart >= 0);
  assert.match(workspace.slice(fnStart, fnStart + 600), /sessionStorage\.setItem\('helmian\.manageTab', 'connectors'\)/);
  // Landing side: loadIntegrations consumes the one-shot marker and
  // selects the named tab (selectIntegrationsTab persists the pick).
  const loadStart = appJs.indexOf('async function loadIntegrations');
  assert.ok(loadStart >= 0);
  const loadSlice = appJs.slice(loadStart, loadStart + 6000);
  assert.match(loadSlice, /sessionStorage\.getItem\('helmian\.manageTab'\)/);
  assert.match(loadSlice, /wantedTab = 'connectors'/);
  assert.match(loadSlice, /selectIntegrationsTab\(wantedTab\)/);
});

test('wiring: the selected seat is remembered the way the tab choice is', () => {
  assert.equal(typeof MANAGE_SEAT_MEMORY_KEY, 'string');
  assert.ok(MANAGE_SEAT_MEMORY_KEY.length > 0);
  assert.match(manage, /localStorage\.setItem\(MANAGE_SEAT_MEMORY_KEY, state\.seat\)/, 'the surface writes the settled seat down');
  assert.match(manage, /localStorage\.getItem\(MANAGE_SEAT_MEMORY_KEY\)/, 'mount falls back to the remembered seat when no fresh marker was left');
});

test('wiring: a seat switch paints the header and loading line before the new seat\u2019s read lands', () => {
  assert.match(manage, /state\.renderedSeat !== state\.seat/, 'refresh notices when the seat changed under it');
  assert.match(manage, /root\.replaceChildren\(note, header\(\), loadingLine\(\)\)/, 'the interim paint replaces the previous seat\u2019s cards at switch time, not when the read returns');
  assert.match(manage, /state\.renderedSeat = state\.seat/, 'the rendered seat is recorded after a successful render');
});

test('planConnectorRows: two primary-shaped entries with one name collapse to the connected one (Grok-shaped)', () => {
  // The 2026-11-09 ~18:00 live walk: Grok's primary list showed TWO
  // GitHub rows — both primary-shaped, so the mirror-only dedupe let
  // both stand. One row per name across ALL entries now.
  const connected = { entryId: 'helmian-github', name: 'GitHub', brokerMode: 'helmian', state: 'connected', oneLiner: 'Work with the repositories this workspace already reaches' };
  const notConnected = { entryId: 'github', name: 'GitHub', brokerMode: 'helmian', state: 'not-connected', oneLiner: 'Review pull requests, issues, and repository activity' };
  const slack = { entryId: 'slack', name: 'Slack', brokerMode: 'helmian', state: 'not-connected' };
  const plan = planConnectorRows([notConnected, slack, connected], 'Grok');
  assert.deepEqual(plan.primary.map((r) => r.entryId), ['helmian-github', 'slack'], 'the connected GitHub stands; the not-connected duplicate renders nowhere');
  assert.deepEqual(plan.mirrors, [], 'a suppressed duplicate does not drop into the mirror group — it is the same connector, not a different one');
  const flipped = planConnectorRows([connected, notConnected], 'Grok');
  assert.deepEqual(flipped.primary, [connected], 'read order does not change the survivor');
});

test('planConnectorRows: one name, one row — Claude-shaped state preference, and state words come from the survivor', () => {
  // Claude-shaped with the states split: brokered connected over a
  // not-connected mirror (the simplify pin covered both connected).
  const brokered = { entryId: 'github', name: 'GitHub', brokerMode: 'helmian', state: 'connected' };
  const mirror = { entryId: 'vendor-github', name: 'GitHub', brokerMode: 'vendor', state: 'not-connected' };
  const plan = planConnectorRows([mirror, brokered], 'Claude');
  assert.deepEqual(plan.primary, [brokered]);
  assert.deepEqual(plan.mirrors, []);
  // A not-connected brokered entry still stands over a connected
  // mirror: the brokered row is the seat's actionable row for the
  // name, and it renders with its OWN state — the suppressed
  // mirror's connected state never lends itself to it.
  const cold = planConnectorRows([
    { entryId: 'vendor-github', name: 'GitHub', brokerMode: 'vendor', state: 'connected' },
    { entryId: 'github', name: 'GitHub', brokerMode: 'helmian', state: 'not-connected' },
  ], 'Claude');
  assert.equal(cold.primary.length, 1, 'one row for the name');
  assert.equal(cold.primary[0].entryId, 'github', 'the brokered entry is the survivor');
  assert.equal(cold.primary[0].state, 'not-connected', 'state words come from the surviving row');
  assert.deepEqual(cold.mirrors, [], 'the connected mirror is the same connector — suppressed, not grouped');
});

test('planConnectorRows: mirror-only duplicate names collapse to one group row', () => {
  const plan = planConnectorRows([
    { entryId: 'v-slack-1', name: 'Slack', brokerMode: 'vendor', state: 'not-connected' },
    { entryId: 'v-slack-2', name: 'Slack', brokerMode: 'vendor', state: 'connected' },
  ], 'Grok');
  assert.deepEqual(plan.primary, []);
  assert.deepEqual(plan.mirrors.map((r) => r.entryId), ['v-slack-2'], 'the connected mirror is the name’s one row in the group');
  assert.equal(plan.mirrorNote, MIRROR_NOTE, 'the group still says its note once');
});

test('openKeyFor: expansion keys are per (seat, entry) — the same entry id on two seats is two keys', () => {
  assert.equal(openKeyFor('claude', 'github'), openKeyFor('claude', 'github'));
  assert.notEqual(openKeyFor('claude', 'github'), openKeyFor('grok', 'github'), 'an entry opened on Claude can never render open on Grok');
  assert.notEqual(openKeyFor('claude', 'github'), openKeyFor('claude', 'slack'));
});

test('wiring: expansion state is seat-scoped and resets on a seat change', () => {
  assert.match(manage, /openKeyFor\(state\.seat, row\.entryId\)/, 'the row’s key is built from the CURRENT seat and the row’s entry');
  assert.match(manage, /state\.open\.has\(openKey\)/, 'the row reads its expansion by that seat-scoped key');
  const refreshStart = manage.indexOf('async function refresh()');
  assert.ok(refreshStart >= 0);
  const refreshBody = manage.slice(refreshStart, refreshStart + 2200);
  const clearAt = refreshBody.indexOf('state.open.clear()');
  assert.ok(clearAt >= 0, 'refresh clears the open set');
  assert.ok(clearAt < refreshBody.indexOf('root.replaceChildren(note, header(), loadingLine())'), 'the clear lands with the seat-change interim paint, before the incoming seat renders');
  assert.match(refreshBody, /seatChanged/, 'the reset rides the seat-change detection, not every refresh — a same-seat refresh keeps its open rows');
});

test('wiring: a Manage-road landing paints the Manage box’s loading line before the integrations reads', () => {
  // The mount happens at the END of loadIntegrations; without this
  // paint the box showed the remembered seat's rows for a beat.
  const loadStart = appJs.indexOf('async function loadIntegrations');
  assert.ok(loadStart >= 0);
  const paintAt = appJs.indexOf("mb.replaceChildren(el('p', 'cm-loading muted sm', 'Loading connectors…'))", loadStart);
  assert.ok(paintAt > loadStart, 'the landing paint exists in loadIntegrations');
  assert.ok(paintAt < appJs.indexOf('Promise.allSettled', loadStart), 'it lands before the integrations reads start');
  assert.ok(paintAt < appJs.indexOf('mountConnectorManage(manageBox', loadStart), 'and before the surface mounts at the end of the function');
  const peekBlock = appJs.slice(loadStart, paintAt);
  assert.match(peekBlock, /sessionStorage\.getItem\('helmian\.manageSeat'\)/, 'the paint is conditioned on the fresh seat marker');
  assert.ok(!peekBlock.includes("removeItem('helmian.manageSeat')"), 'the marker is only peeked — mountConnectorManage still consumes it');
});

test('landing: show() clears the Manage box to the loading line before the integrations loader runs', () => {
  // The perf bite (2026-11-09 ~18:19): arriving at Integrations from
  // another seat's Manage row still showed the PREVIOUS seat's rows
  // as the first visible content — the box is persistent DOM and the
  // surface only re-mounts at the end of loadIntegrations, so the
  // old rows stood until the mount landed. The navigation handler
  // clears the box synchronously, before any loader is invoked.
  const showStart = appJs.indexOf('function show(view)');
  assert.ok(showStart > 0);
  const showBody = appJs.slice(showStart, appJs.indexOf('loaders[panelView]', showStart));
  const clearAt = showBody.indexOf("view === 'integrations'");
  const paintAt = showBody.indexOf("mb.replaceChildren(el('p', 'cm-loading muted sm', 'Loading connectors…'))");
  assert.ok(clearAt > 0 && paintAt > clearAt,
    'show() clears #connector-manage to the loading line when the integrations view is shown, before the loader runs');
});

test('the seat list is fetched once per surface, not once per refresh (remove marks it stale)', () => {
  const loadSeatsAt = manage.indexOf('async function loadSeats()');
  assert.ok(loadSeatsAt > 0);
  const loadSeatsBody = manage.slice(loadSeatsAt, manage.indexOf('\n  }', loadSeatsAt));
  const guardAt = loadSeatsBody.indexOf('state.seatsLoaded && !state.seatsStale');
  const fetchAt = loadSeatsBody.indexOf("api('/api/admin/connector-library/seats')");
  assert.ok(guardAt > 0 && fetchAt > guardAt,
    'loadSeats answers from the cached list unless it was never loaded or was marked stale');
  const removeAt = manage.indexOf("'/api/admin/connector-library/entries/remove'");
  assert.ok(removeAt > 0 && manage.indexOf('state.seatsStale = true', removeAt) > removeAt,
    'the Remove handler marks the cached seat list stale — the one write that can change seat membership');
});

test('wiring: the rows read fires beside the seats read — and the header still paints before the list renders', () => {
  // Speed fix 1 (2026-11-09): the two reads used to run serially —
  // seats awaited alone, then rows — and every mount paid both
  // legs end to end. The rows read now STARTS before the seats
  // read is awaited; the early header paint and the
  // render-after-paint law are unchanged.
  const refreshStart = manage.indexOf('async function refresh()');
  assert.ok(refreshStart >= 0);
  const refreshBody = manage.slice(refreshStart, refreshStart + 3400);
  assert.match(refreshBody, /if \(\(!state\.loaded \|\| seatChanged\) && myRefresh === refreshSeq\)/, 'the early header paint is scoped to mounts and seat changes, not every refresh — and since the P2 fix, to the newest pass only');
  const flightAt = refreshBody.indexOf('startRowsFlight()');
  const seatsAt = refreshBody.indexOf('await loadSeats()');
  assert.ok(flightAt >= 0 && seatsAt > flightAt, 'the rows read is started before the seats read is awaited — the two fly together');
  const paintAt = refreshBody.indexOf('root.replaceChildren(note, header(), loadingLine())', seatsAt);
  assert.ok(paintAt > seatsAt, 'once the seats are known, header + loading paint');
  assert.ok(refreshBody.indexOf('await connectorsTab()') > paintAt, 'and the tab body renders only after that paint — the remembered seat’s list can never be a mount’s first render');
});

// ------------------------------------------------------- parallel reads
// (speed fix 1, 2026-11-09): the seats read and the per-seat rows
// read are independent and each costs ~1 s; refresh() used to
// await them one after the other. These tests drive the real
// surface (the FakeEl harness stands below, with the plugin
// section) against deferred promises, so "in flight" is proven,
// not inferred from source shape.

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flushMicrotasks = () => new Promise((r) => setImmediate(r));
const manageRow = (entryId, name, over = {}) => ({
  entryId, name, brokerMode: 'helmian', state: 'connected', oneLiner: `The ${name} line`, ...over,
});

test('parallel reads: on mount the seats and rows reads are both in flight before either resolves', async () => {
  const calls = [];
  const seatsD = deferred(); const rowsD = deferred();
  const api = (path) => {
    calls.push(path);
    if (path === '/api/admin/connector-library/seats') return seatsD.promise;
    if (path.startsWith('/api/admin/connector-library?seat=')) return rowsD.promise;
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude' });
  const done = surface.refresh();
  assert.deepEqual(calls, [
    '/api/admin/connector-library?seat=claude',
    '/api/admin/connector-library/seats',
  ], 'both reads are in flight before either resolves — the rows read no longer waits on the seats read');
  rowsD.resolve({ rows: [manageRow('helmian-github', 'GitHub')] });
  await flushMicrotasks();
  assert.equal(surface.state.loaded, false, 'the surface still waits for the seats read before it renders');
  seatsD.resolve({ seats: [{ seatId: 'claude' }, { seatId: 'chatgpt' }] });
  await done;
  assert.equal(surface.state.loaded, true);
  assert.ok(box.textContent.includes('GitHub'), 'the rows that flew beside the seats read are the ones that render');
});

test('parallel reads: a seat switch and a post-action refresh fire only the per-seat read', async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/admin/connector-library/seats') return { seats: [{ seatId: 'claude' }, { seatId: 'chatgpt' }] };
    if (path.startsWith('/api/admin/connector-library?')) {
      const seat = new URLSearchParams(path.split('?')[1]).get('seat');
      return { rows: [manageRow(`gh-${seat}`, `GitHub ${seat}`)] };
    }
    throw new Error(`unexpected api call: ${path}`);
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude' });
  await surface.refresh();
  const seatsCalls = () => calls.filter((p) => p.endsWith('/seats')).length;
  const rowsCalls = () => calls.filter((p) => p.includes('connector-library?seat=')).length;
  assert.equal(seatsCalls(), 1, 'the mount reads the seats list once');
  assert.equal(rowsCalls(), 1);
  // A post-action refresh (every write handler ends in one): the
  // seats list is NOT re-read — only the current seat's library.
  await surface.refresh();
  assert.equal(seatsCalls(), 1, 'a post-action refresh does not re-read the seats list');
  assert.equal(rowsCalls(), 2, 'it re-reads only the current seat’s library');
  // A seat switch, through the surface's own seat tab.
  const tab = buttonsNamed(box, 'ChatGPT')[0];
  assert.ok(tab, 'the seat tab renders');
  await tab.click();
  assert.equal(surface.state.seat, 'chatgpt');
  assert.equal(seatsCalls(), 1, 'a seat switch does not re-read the seats list');
  assert.equal(rowsCalls(), 3, 'the switch fires exactly the new seat’s read');
  assert.ok(box.textContent.includes('GitHub chatgpt'), 'the new seat’s rows render');
});

test('parallel reads: a stale seat marker re-reads for the settled seat, and the early read’s late answer is discarded', async () => {
  const rowsBySeat = new Map();
  const api = (path) => {
    if (path === '/api/admin/connector-library/seats') return Promise.resolve({ seats: [{ seatId: 'claude' }] });
    if (path.startsWith('/api/admin/connector-library?')) {
      const seat = new URLSearchParams(path.split('?')[1]).get('seat');
      const d = deferred(); rowsBySeat.set(seat, d); return d.promise;
    }
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'ghost' });
  const done = surface.refresh();
  await flushMicrotasks();
  assert.deepEqual([...rowsBySeat.keys()], ['ghost', 'claude'], 'the early read flew for the marker’s seat; the settled seat got its own');
  rowsBySeat.get('claude').resolve({ rows: [manageRow('gh-claude', 'Claude GitHub')] });
  await done;
  assert.ok(box.textContent.includes('Claude GitHub'), 'the settled seat’s rows render');
  rowsBySeat.get('ghost').resolve({ rows: [manageRow('gh-ghost', 'Ghost GitHub')] });
  await flushMicrotasks();
  assert.deepEqual(surface.state.rows.map((r) => r.entryId), ['gh-claude'], 'a superseded read’s late answer never paints over the settled seat');
});

test('preload: app.js warms the Integrations modules at idle once the workspace mounts (speed fix 2)', () => {
  const warmStart = appJs.indexOf('function scheduleIntegrationsPreload()');
  assert.ok(warmStart >= 0, 'the preload scheduler exists');
  const warmBody = appJs.slice(warmStart, appJs.indexOf('async function loadIntegrations', warmStart));
  assert.match(warmBody, /integrationsMod \?\?= await import\('\.\/integrations-view\.mjs\?v=[0-9a-f]{16}'\)/, 'the warm-up fills the same module var the real open reads');
  assert.match(warmBody, /connectorManageMod \?\?= await import\('\.\/connector-manage\.mjs\?v=[0-9a-f]{16}'\)/, 'and the Manage surface’s module var');
  assert.equal((warmBody.match(/catch \{\}/g) ?? []).length, 2, 'a failed warm-up is swallowed per module — the vars stay null and the real open retries normally');
  assert.match(warmBody, /requestIdleCallback/, 'the warm-up is scheduled for idle time');
  assert.match(warmBody, /setTimeout/, 'with a timer fallback where idle callbacks do not exist');
  assert.match(warmBody, /integrationsPreloadScheduled/, 'it schedules once, not once per mount');
  const desktopStart = appJs.indexOf('async function loadDesktop()');
  assert.ok(desktopStart >= 0);
  const desktopBody = appJs.slice(desktopStart, appJs.indexOf('function wireRail()', desktopStart));
  assert.ok(desktopBody.indexOf('scheduleIntegrationsPreload();') > desktopBody.indexOf('mountWorkspace({'), 'the scheduling call lands after the workspace mounts');
});

// ------------------------------------------------------- plugin catalog
// (plugin-catalog bite, 2026-11-09): the Plugins tab's catalog half —
// the shelf the plugins read now carries, joined against the
// installed rows, with Install/Uninstall on the tab itself.

const SHELF_PAYLOAD = [
  {
    name: 'weather', version: '1.0.0',
    description: 'US weather from the National Weather Service: forecasts, alerts, and current conditions, answered the plain way.',
    entries: [{ entryId: 'registry-weather', name: 'Weather' }],
    skills: [{ id: 'reading-a-forecast', name: 'reading-a-forecast', description: 'Turn National Weather Service tool output into a plain forecast answer: alerts first, then today, then the week.' }],
  },
  {
    name: 'github-review', version: '1.0.0',
    description: 'Pull request reviews over the workspace’s GitHub connection: the diff read first, the tests the PR names checked, and what was not checked named.',
    entries: [{ entryId: 'helmian-github', name: 'GitHub' }],
    skills: [{ id: 'reviewing-a-pull-request', name: 'reviewing-a-pull-request', description: 'Review a pull request from its diff: read what changed, check the tests the PR names, summarize in plain words, and name what was not checked.' }],
  },
];

test('pluginsListModel: the shelf normalizes into the catalog and joins installed state by name', () => {
  const joined = pluginsListModel({
    plugins: [{ name: 'weather', source: 'helmian-plugin' }],
    unavailable: [],
    shelf: SHELF_PAYLOAD,
  });
  assert.equal(joined.catalog.length, 2);
  const weather = joined.catalog[0];
  assert.equal(weather.name, 'weather');
  assert.equal(weather.version, '1.0.0');
  assert.equal(weather.installed, true, 'a helmian-plugin row of the same name is the bundle’s install');
  assert.deepEqual(weather.entries, [{ entryId: 'registry-weather', name: 'Weather' }]);
  assert.deepEqual(weather.skills.map((s) => [s.id, s.name]), [['reading-a-forecast', 'reading-a-forecast']]);
  assert.equal(weather.brings, 'Brings the Weather tools, plus the reading-a-forecast skill.', 'the brings line names the bundle’s own entries and skills, with no state words');
  assert.equal(joined.catalog[1].installed, false);
  // A bridge row of the same name is NOT the bundle's install, and
  // neither is a row with no source at all.
  assert.equal(pluginsListModel({ plugins: [{ name: 'weather', source: 'bridge' }], shelf: SHELF_PAYLOAD }).catalog[0].installed, false);
  assert.equal(pluginsListModel({ plugins: [{ name: 'weather' }], shelf: SHELF_PAYLOAD }).catalog[0].installed, false);
  // A read without the shelf field (an older deployment) plans an
  // empty catalog, not a crash.
  assert.deepEqual(pluginsListModel({ plugins: [] }).catalog, []);
  assert.deepEqual(pluginsListModel(null).catalog, []);
});

// ---- minimal DOM for the tab render (only what the surface touches)
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.value = '';
    this._listeners = {};
    const classes = new Set();
    this.classList = {
      toggle: (cls, force) => { if (force) classes.add(cls); else classes.delete(cls); },
      contains: (cls) => classes.has(cls),
    };
  }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = [...kids]; }
  setAttribute() {}
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  async click() { for (const fn of this._listeners.click ?? []) await fn(); }
}
const fakeEl = (tag, cls, text) => { const n = new FakeEl(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
function* walkEls(node) { yield node; for (const c of node.children) yield* walkEls(c); }
const findEls = (root, pred) => [...walkEls(root)].filter(pred);
const buttonsNamed = (root, label) => findEls(root, (n) => n.tagName === 'BUTTON' && n.textContent === label);

// A fake server behind the surface's api(): the seats read, the
// plugins read (built from a mutable install set, the way the real
// route joins records), and the two plugin write routes, recorded.
function pluginsSurface({ shelf = SHELF_PAYLOAD, bridgeRows = [], pluginsError = null } = {}) {
  const calls = [];
  const installed = new Map();
  const api = async (path, opts) => {
    if (path === '/api/admin/connector-library/seats') return { seats: [{ seatId: 'claude' }] };
    if (path === '/api/admin/plugins' && !opts) {
      if (pluginsError) throw pluginsError;
      return { valid: true, plugins: [...installed.values(), ...bridgeRows], unavailable: [], shelf };
    }
    if (path === '/api/admin/plugins/install' || path === '/api/admin/plugins/uninstall') {
      const body = JSON.parse(opts?.body ?? '{}');
      calls.push({ path, method: opts?.method, body });
      if (path.endsWith('/install')) {
        installed.set(body.name, { name: body.name, version: '1.0.0', source: 'helmian-plugin', description: 'The installed row.', brings: 'Brings the Weather tools — not connected yet.' });
      } else installed.delete(body.name);
      return { valid: true };
    }
    throw new Error(`unexpected api call: ${path}`);
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude' });
  return {
    box, calls,
    async openPlugins() { surface.state.tab = 'plugins'; await surface.refresh(); },
  };
}

test('plugins tab: the catalog renders from the read’s shelf, and Install fires the exact request, then the row flips', async () => {
  const h = pluginsSurface();
  await h.openPlugins();
  let text = h.box.textContent;
  assert.ok(text.includes(PLUGIN_CATALOG_TITLE), 'the catalog section renders on the tab');
  assert.ok(text.includes('weather'));
  assert.ok(text.includes('US weather from the National Weather Service'), 'the bundle’s own description renders');
  assert.ok(text.includes('Brings the Weather tools, plus the reading-a-forecast skill.'), 'the brings line renders from the shelf row');
  assert.ok(text.includes(NO_PLUGINS_LINE), 'the installed list keeps its honest empty line above the catalog');
  assert.equal(buttonsNamed(h.box, 'Install').length, 2, 'both shelf bundles offer Install');
  assert.equal(buttonsNamed(h.box, 'Uninstall').length, 0);

  await buttonsNamed(h.box, 'Install')[0].click();
  assert.deepEqual(h.calls, [{ path: '/api/admin/plugins/install', method: 'POST', body: { name: 'weather' } }],
    'Install posts exactly { name } to the existing install route — nothing invented');

  // The landed write refreshed the read: weather stands in the
  // installed list, its catalog row flipped to Installed, and the
  // remaining Install is github-review's.
  text = h.box.textContent;
  assert.ok(!text.includes(NO_PLUGINS_LINE), 'the installed list is no longer empty');
  assert.ok(text.includes('Installed'), 'the catalog row shows its installed state');
  assert.equal(buttonsNamed(h.box, 'Install').length, 1);
  assert.ok(buttonsNamed(h.box, 'Uninstall').length >= 1, 'the flipped row offers Uninstall');

  const uninstalls = buttonsNamed(h.box, 'Uninstall');
  await uninstalls[uninstalls.length - 1].click();
  assert.deepEqual(h.calls[1], { path: '/api/admin/plugins/uninstall', method: 'POST', body: { name: 'weather' } },
    'Uninstall posts exactly { name } to the existing uninstall route');
  assert.equal(buttonsNamed(h.box, 'Install').length, 2, 'after the refresh the row flipped back to Install');
});

test('plugins tab: a bridge plugin gets NO cloud uninstall button', async () => {
  const h = pluginsSurface({ bridgeRows: [{ name: 'bridge-one', version: '2.0.0', brings: 'Brings bridge tools.' }] });
  await h.openPlugins();
  assert.ok(h.box.textContent.includes('bridge-one'), 'the bridge row renders in the installed list');
  assert.equal(buttonsNamed(h.box, 'Uninstall').length, 0, 'the bridge’s plugins are the bridge’s to remove — no cloud Uninstall anywhere');
  assert.equal(buttonsNamed(h.box, 'Install').length, 2, 'the catalog still offers both bundles');
});

test('plugins tab: a failed plugins read shows the honest error and no catalog buttons', async () => {
  const h = pluginsSurface({ pluginsError: new Error('Plugins did not load.') });
  await h.openPlugins();
  assert.ok(h.box.textContent.includes('Plugins did not load.'), 'the read’s failure words stand on the tab');
  assert.equal(buttonsNamed(h.box, 'Install').length, 0);
  assert.equal(buttonsNamed(h.box, 'Uninstall').length, 0);
});

test('plugins tab: an empty shelf says so instead of leaving a blank tab', async () => {
  const h = pluginsSurface({ shelf: [] });
  await h.openPlugins();
  assert.ok(h.box.textContent.includes(PLUGIN_CATALOG_TITLE));
  assert.ok(h.box.textContent.includes(NO_SHELF_LINE), 'the catalog section names its own emptiness');
  assert.equal(buttonsNamed(h.box, 'Install').length, 0);
});

test('wiring: the Plugins tab’s catalog rides the existing plugin routes in their exact shape', () => {
  assert.ok(manage.includes("call('/api/admin/plugins/install', { name: row.name })"), 'catalog Install goes through call() with exactly { name }');
  assert.ok(manage.includes("call('/api/admin/plugins/uninstall', { name: row.name })"), 'catalog Uninstall, same shape');
  assert.ok(manage.includes("call('/api/admin/plugins/uninstall', { name: p.name })"), 'the installed row’s Uninstall, same shape');
  assert.match(manage, /frag\.append\(pluginCatalogSection\(model\)\)/, 'the tab appends the catalog under the installed list');
  assert.match(manage, /p\.source === 'helmian-plugin'/, 'the installed row’s Uninstall is gated on the cloud source');
});

// ------------------------------------------------------- refresh order
// (P2 fix, 2026-11-09): refresh() passes paint in START order, never
// in finish order. The fresh-signup walk installed a plugin and
// watched "…is installed." land over "No plugins are installed." —
// an earlier pass whose read was issued before the install POST
// finished AFTER the post-install pass and repainted its stale
// read. These tests drive two overlapping passes against deferred
// reads and resolve them out of order: the late stale pass must
// never paint.

test('refresh order: a stale plugins pass finishing last never repaints over the post-install refresh (P2)', async () => {
  const pluginReads = [];
  const api = (path, opts) => {
    if (path === '/api/admin/connector-library/seats') return Promise.resolve({ seats: [{ seatId: 'claude' }] });
    if (path === '/api/admin/plugins' && !opts) { const d = deferred(); pluginReads.push(d); return d.promise; }
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude' });
  surface.state.tab = 'plugins';
  const stale = surface.refresh();
  const fresh = surface.refresh();
  await flushMicrotasks();
  assert.equal(pluginReads.length, 2, 'both passes issued their plugins read');
  pluginReads[1].resolve({ valid: true, plugins: [{ name: 'weather', version: '1.0.0', source: 'helmian-plugin', description: 'The installed row.' }], unavailable: [], shelf: SHELF_PAYLOAD });
  await fresh;
  assert.ok(box.textContent.includes('weather'), 'the newer pass painted the installed plugin');
  pluginReads[0].resolve({ valid: true, plugins: [], unavailable: [], shelf: SHELF_PAYLOAD });
  await stale;
  await flushMicrotasks();
  assert.ok(!box.textContent.includes(NO_PLUGINS_LINE), 'the stale pass never repainted the empty list over the installed one');
  assert.ok(box.textContent.includes('weather'), 'the installed plugin still stands');
  assert.ok(buttonsNamed(box, 'Uninstall').length >= 1, 'and its Uninstall action with it');
});

test('refresh order: switching tabs, the earlier tab’s late pass never repaints over the new tab (P2)', async () => {
  const pluginReads = [];
  const api = (path, opts) => {
    if (path === '/api/admin/connector-library/seats') return Promise.resolve({ seats: [{ seatId: 'claude' }] });
    if (path === '/api/admin/plugins' && !opts) { const d = deferred(); pluginReads.push(d); return d.promise; }
    if (path === '/api/admin/skills') return Promise.resolve({ skills: [{ name: 'reading-a-forecast', description: 'Turns forecasts plain.' }] });
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude' });
  surface.state.tab = 'plugins';
  const stale = surface.refresh();
  await flushMicrotasks();
  assert.equal(pluginReads.length, 1, 'the plugins pass is in flight');
  surface.state.tab = 'skills';
  await surface.refresh();
  assert.ok(box.textContent.includes('reading-a-forecast'), 'the skills tab painted');
  pluginReads[0].resolve({ valid: true, plugins: [], unavailable: [], shelf: SHELF_PAYLOAD });
  await stale;
  await flushMicrotasks();
  assert.ok(box.textContent.includes('reading-a-forecast'), 'the late plugins pass did not repaint over the skills tab');
  assert.ok(!box.textContent.includes(PLUGIN_CATALOG_TITLE), 'no plugins catalog over the skills tab');
});

// ------------------------------------------------------- first-load
// retry (2026-11-10): the owner walk's Connectors tab sat on a red
// CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED line after ONE failed
// library load — the surface painted the failure as terminal and
// nothing re-read until a full view re-entry. A first load that
// has never landed now retries a bounded number of times before
// the failure is allowed to paint.

test('first-load retry: a seats read that fails twice then answers loads the surface, and no error ever paints', async () => {
  let seatsCalls = 0;
  const api = async (path) => {
    if (path === '/api/admin/connector-library/seats') {
      seatsCalls += 1;
      if (seatsCalls < 3) throw Object.assign(new Error('CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED'), { status: 403 });
      return { seats: [{ seatId: 'claude' }] };
    }
    if (path.startsWith('/api/admin/connector-library?seat=')) return { rows: [manageRow('helmian-github', 'GitHub')] };
    throw new Error(`unexpected api call: ${path}`);
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude', loadRetryDelays: [0, 0] });
  await surface.refresh();
  assert.equal(seatsCalls, 3, 'the failed first load was retried twice before anything painted');
  assert.equal(surface.state.loaded, true);
  assert.ok(box.textContent.includes('GitHub'), 'the recovered load renders its rows');
  assert.ok(!box.textContent.includes('CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED'), 'the transient error never painted');
  assert.ok(!box.textContent.includes('did not load'), 'the terminal line never painted');
});

test('first-load retry: a read that keeps failing paints the terminal error only after the retries are spent', async () => {
  let seatsCalls = 0;
  const api = async (path) => {
    if (path === '/api/admin/connector-library/seats') { seatsCalls += 1; throw Object.assign(new Error('CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED'), { status: 403 }); }
    if (path.startsWith('/api/admin/connector-library?seat=')) return { rows: [] };
    throw new Error(`unexpected api call: ${path}`);
  };
  const box = fakeEl('div');
  const surface = renderConnectorManage(box, { api, el: fakeEl, role: 'owner', initialSeat: 'claude', loadRetryDelays: [0, 0] });
  await surface.refresh();
  assert.equal(seatsCalls, 3, 'one first attempt plus two bounded retries, then it stops');
  assert.equal(surface.state.loaded, false);
  assert.ok(box.textContent.includes('The connector library did not load'), 'the terminal line paints once the retries are spent');
  assert.ok(box.textContent.includes('CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED'), 'and the server\u2019s error words are the ones reported');
});

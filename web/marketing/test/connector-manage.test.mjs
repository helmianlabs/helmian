// The Manage surface (mirror M1): the pure row-controls model and
// the static wiring that lands every seat panel's "Manage
// connectors" row on THIS surface at that seat's tab.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { rowControls, seatName, toolAccessRows, pluginsListModel, pluginsUnavailableLine, MIRROR_NOTE, mirrorGroupTitle, planConnectorRows, openKeyFor, MANAGE_SEAT_STORAGE_KEY, MANAGE_TAB_STORAGE_KEY, MANAGE_SEAT_MEMORY_KEY, NO_SNAPSHOT_LINE, NO_PLUGINS_LINE, TOOL_ANNOTATION_LABELS } from '../app/connector-manage.mjs';

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

test('wiring: mount and seat-change renders paint the header with the loading line before the rows read', () => {
  const refreshStart = manage.indexOf('async function refresh()');
  assert.ok(refreshStart >= 0);
  const refreshBody = manage.slice(refreshStart, refreshStart + 2600);
  assert.match(refreshBody, /if \(!state\.loaded \|\| seatChanged\)/, 'the early header paint is scoped to mounts and seat changes, not every refresh');
  const seatsAt = refreshBody.indexOf('await loadSeats()');
  const paintAt = refreshBody.indexOf('root.replaceChildren(note, header(), loadingLine())', seatsAt);
  const rowsAt = refreshBody.indexOf('await loadRows()', seatsAt);
  assert.ok(seatsAt >= 0 && paintAt > seatsAt, 'once the seats are known, header + loading paint');
  assert.ok(rowsAt > paintAt, 'before the rows read — the remembered seat’s list can never be a mount’s first render');
});

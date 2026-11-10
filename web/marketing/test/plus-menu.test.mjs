import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LIBRARY_STALE_MS, loadSeatLibrary, plusMenuLevel2Model, preloadLibrarySession, resetLibrarySession } from '../app/envoy-workspace.js';
import { armedConnectorPairs, armedStateFromConfig, connectorsForTurn, level1Model, toggleConnector } from '../app/connector-panel.mjs';
import { MENU_SEAT_IDS, collectCatalogEntryIds, dedupePanelConnectorRows, menuForSeat } from '../app/connector-menu.mjs';

// Bite 3R-b — the "+" MENU FACE (Troy, 2026-11-08): the old bite-3
// panel opened full-width across the composer; Troy's order is a
// small popup — press +, pick your agent, then THAT agent's own menu
// in the vendor's own words and order. These tests pin the face's
// contract the way the repo pins its faces: the pure composition
// (connector-menu.mjs definitions × connector-panel.mjs row state)
// by value, and the DOM half (width, anchoring, close behaviour) by
// source, the same split the desk tests use. Live rendering and the
// measured on-screen width are the post-push gate, not claimed here.

// ---- fixtures: library reads in the Level 2 model's input shape ----
const libRow = (seatId, entryId, name, over = {}) => ({
  entryId, seatId, name,
  oneLiner: `The ${name} line`,
  vendorLabel: 'Vendor',
  trustLabel: 'Helmian-brokered',
  state: 'available',
  stateDetail: null,
  accountIdentity: null,
  brokerMode: 'helmian',
  kind: 'native',
  ...over,
});
const library = (seatId, rows) => ({
  seatId,
  connectedCount: rows.filter((r) => r.state === 'connected').length,
  rows,
});
// Every descriptor of a composed menu, submenus flattened open, in
// render order.
const flat = (model) => model.rows.flatMap(function walk(r) {
  return r.kind === 'submenu' ? [{ kind: 'submenu', label: r.label }, ...r.rows.flatMap(walk)] : [r];
});
const brief = (model) => flat(model).map((r) => r.kind === 'toggle' || r.kind === 'mirror' || r.kind === 'row' || r.kind === 'connect'
  ? `${r.kind}:${r.row.entryId}${r.kind === 'toggle' ? (r.row.on ? '=on' : '=off') : ''}${r.kind === 'connect' && r.row.reconnect ? '=reconnect' : ''}`
  : r.kind === 'note' ? `note:${r.text}`
    : r.kind === 'manage' ? `manage:${r.label}:${r.target}:${r.url ?? 'none'}`
      : r.kind === 'action' ? `action:${r.label}:${r.action}`
        : r.kind === 'starter' ? `starter:${r.label}`
          : r.kind === 'prompt' ? `prompt:${r.prompt.title ?? r.prompt.name}`
            : r.kind === 'skill' ? `skill:${r.name}${r.on ? '=on' : '=off'}`
              : r.kind === 'plugin' ? `plugin:${r.name}${r.on ? '=on' : '=off'}`
                : r.kind === 'project' ? `project:${r.name}${r.active ? '=active' : ''}`
                  : `${r.kind}:${r.label ?? ''}`);
const findRow = (model, entryId) => flat(model).find((r) => r.row?.entryId === entryId);

const CLAUDE_LIB = library('claude', [
  libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
  libRow('claude', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  libRow('claude', 'slack', 'Slack', { brokerMode: 'vendor', kind: 'oauth-app' }),
]);

test('plus menu: the popup class carries the narrow fixed width, anchored to the composer', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  const rule = css.match(/\.ew-picker\.ew-plus-menu \{([^}]*)\}/);
  assert.ok(rule, 'envoy.css carries the .ew-picker.ew-plus-menu rule');
  assert.match(rule[1], /position:\s*absolute/, 'the menu is a popup, not an in-flow block');
  const width = Number(rule[1].match(/width:\s*(\d+)px/)?.[1]);
  assert.ok(width >= 320 && width <= 380, `the popup width is a small fixed width (got ${width}px)`);
  assert.match(css, /\.ew-composer \{ position:relative; \}/, 'the composer is the positioning context');
});

test('plus menu Level 1: every seat the seats read returns, name and connected count, nothing else', () => {
  // The seats read returns one entry per roster seat (server order =
  // the catalog's seat order); the model preserves it whole.
  const seatsRead = MENU_SEAT_IDS.map((seatId) => ({ seatId, connectedCount: seatId === 'claude' ? 2 : 0, entryCount: 3 }));
  const model = level1Model(seatsRead);
  assert.deepEqual(model.rows.map((r) => r.seatId), MENU_SEAT_IDS, 'all 14 seats, in the shipped roster order');
  assert.equal(model.rows.find((r) => r.seatId === 'claude').connectedCount, 2);
  assert.equal(model.rows.find((r) => r.seatId === 'muse').connectedCount, 0, 'a seat with nothing connected counts zero, never an invented number');
  for (const row of model.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['connectedCount', 'entryCount', 'name', 'provider', 'seatId'], 'Level 1 rows carry the pick and the count — nothing else');
  }
});

test('plus menu Level 2 — Claude: attach, screenshot, project, GitHub, Skills, Connectors, Plugins, Web search, Manage, in his words and order', () => {
  const model = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add files or photos',
    'screenshot:Take a screenshot',
    'submenu:Add to project',
    'note:Loading projects...',
    'action:Add from GitHub:github-file',
    'submenu:Skills',
    'note:Loading skills...',
    'submenu:Connectors',
    'toggle:helmian-github=off',
    'mirror:gmail',
    'mirror:slack',
    'action:Tool access:tool-access',
    'submenu:Plugins',
    'note:Loading plugins...',
    'capability:Web search',
    'manage:Manage connectors:integrations:none',
  ]);
  const gmail = findRow(model, 'gmail');
  assert.equal(gmail.row.mirror.managedIn, 'Claude', 'the mirror row names where the vendor manages it');
  assert.equal(gmail.row.toggleable, false);
});

test('plus menu Level 2 — Claude (bite M2): the Connectors badge is the needs-reconnect roll-up over the seat read', () => {
  const lib = library('claude', [
    libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
    libRow('claude', 'gmail', 'Gmail', { state: 'needs-reconnect', brokerMode: 'vendor', kind: 'oauth-app' }),
    libRow('claude', 'slack', 'Slack', { state: 'needs-reconnect', brokerMode: 'vendor', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, conversationId: 'c1' });
  const connectors = model.rows.find((r) => r.kind === 'submenu' && r.label === 'Connectors');
  assert.equal(connectors.badge, 2, 'two needs-reconnect rows roll up to ⚠ 2, wherever they sit in the library');
  const healthy = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1' });
  assert.equal(healthy.rows.find((r) => r.kind === 'submenu' && r.label === 'Connectors').badge, undefined, 'a healthy library wears no badge');
});

test('plus menu Level 2 — Claude (bite A2): connector rows seed NO drafts — no starter rows, no prompt rows, armed or not', async () => {
  // The M2 face rendered catalog starter actions and arm-time MCP
  // prompts under a connector, each seeding the composer with a
  // draft. The standing toggle list (Amendment 1 §2.3) replaces
  // that behaviour: a connector row is a switch and nothing else.
  const lib = library('claude', [
    libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
    libRow('claude', 'idiolect', 'Idiolect', {
      state: 'connected', brokerMode: 'vendor', kind: 'oauth-app',
      starterActions: [{ label: 'Write an email in my style', prompt: 'Write an email in my style' }],
    }),
  ]);
  const toggles = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  for (const model of [
    plusMenuLevel2Model({ seatId: 'claude', library: lib, toggles, conversationId: 'c1' }),
    plusMenuLevel2Model({ seatId: 'claude', library: lib, conversationId: 'c1' }),
  ]) {
    const lines = brief(model);
    assert.ok(!lines.some((l) => l.startsWith('starter:')), 'no catalog starter row under any connector');
    assert.ok(!lines.some((l) => l.startsWith('prompt:')), 'no MCP prompt row under any connector');
    assert.ok(!flat(model).some((r) => r.kind === 'starter' || r.kind === 'prompt'), 'the descriptors themselves are gone');
  }
  // The renderer carries no draft-seeding road at all any more.
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('seedComposerDraft'), 'the draft seeder is deleted from the workspace');
  assert.ok(!js.includes('ensureConnectorPrompts'), 'the arm-time prompt fetch is deleted with the rows it fed');
  assert.ok(!js.includes('/api/admin/connector-library/prompts'), 'the menu no longer calls the prompts list road');
});

test('plus menu Level 2 — the Connectors list offers a Connect action for not-connected Helmian rows (owner order, 2026-11-10)', () => {
  // Supersedes bite A2's connected-only toggle list. The owner's
  // order: every not-connected connector gets a working Connect
  // button right on this panel, wired to the same library
  // connect-start the Connectors tab's Manage panel uses. A toggle
  // is still offered ONLY for a connected row — never a switch that
  // cannot work — and the empty note stands only over a list with
  // nothing in it at all.
  const notConnected = library('claude', [
    libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'not-connected' }),
    libRow('claude', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'claude', library: notConnected, conversationId: 'c1' });
  const connectors = model.rows.find((r) => r.kind === 'submenu' && r.label === 'Connectors');
  assert.ok(connectors, 'the Connectors submenu still composes');
  assert.ok(!connectors.rows.some((r) => r.kind === 'toggle'), 'no toggle is offered for a connector that is not connected');
  const connect = connectors.rows.find((r) => r.kind === 'connect');
  assert.ok(connect, 'a Connect action is offered for the not-connected Helmian row');
  assert.equal(connect.row.entryId, 'helmian-github');
  assert.equal(connect.row.connectable, true);
  assert.equal(connect.row.reconnect, false);
  assert.ok(!connectors.rows.some((r) => r.kind === 'note' && r.text === 'No connectors are connected for Claude yet.'), 'the empty note does not stand over a row that offers Connect');
  // Needs-reconnect is not connected: no switch — the connect
  // action again, marked as the reconnect it is.
  const needsReconnect = library('claude', [
    libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'needs-reconnect' }),
  ]);
  const model2 = plusMenuLevel2Model({ seatId: 'claude', library: needsReconnect, conversationId: 'c1' });
  const connectors2 = model2.rows.find((r) => r.kind === 'submenu' && r.label === 'Connectors');
  assert.ok(!connectors2.rows.some((r) => r.kind === 'toggle'), 'a needs-reconnect connector is not offered as a switch');
  const reconnect = connectors2.rows.find((r) => r.kind === 'connect');
  assert.ok(reconnect, 'a needs-reconnect connector offers the connect action');
  assert.equal(reconnect.row.reconnect, true, 'and the row marks it a reconnect');
  // A library with nothing in it still says so in one note.
  const empty = plusMenuLevel2Model({ seatId: 'claude', library: library('claude', []), conversationId: 'c1' });
  const connectors3 = empty.rows.find((r) => r.kind === 'submenu' && r.label === 'Connectors');
  assert.ok(connectors3.rows.some((r) => r.kind === 'note' && r.text === 'No connectors are connected for Claude yet.'), 'the empty list says so in one note');
});

test('plus menu dedupe: the brokered GitHub stands in Claude’s panel and the mirror namesake drops', () => {
  // The 2026-11-09 live walk's shape, in the read's own words:
  // Helmian's GitHub (connected) and Claude's own GitHub (not
  // connected) both named "GitHub" in one Connectors list.
  const lib = library('claude', [
    libRow('claude', 'helmian-github', 'GitHub', { state: 'connected', oneLiner: 'Work with the repositories this workspace already reaches' }),
    libRow('claude', 'github', 'GitHub', { brokerMode: 'vendor', kind: 'oauth-app', oneLiner: 'Review pull requests, issues, and repository activity' }),
    libRow('claude', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, conversationId: 'c1' });
  const githubs = flat(model).filter((r) => r.row?.name === 'GitHub');
  assert.equal(githubs.length, 1, 'one GitHub row in the panel, not two');
  assert.equal(githubs[0].row.entryId, 'helmian-github', 'the survivor is Helmian’s brokered row');
  assert.equal(githubs[0].kind, 'toggle', 'standing as the connected switch');
  assert.equal(githubs[0].row.oneLiner, 'Work with the repositories this workspace already reaches', 'the survivor keeps its own words');
  // With Helmian's GitHub NOT connected, the brokered row stands
  // in the list carrying its Connect action (owner order,
  // 2026-11-10) — so the mirror namesake drops, the same
  // one-name-one-row outcome the Connectors tab already rules.
  // (The earlier cold case expected the mirror to stand because a
  // not-connected brokered row was not offered in the list at all;
  // that was bite A2's law, superseded by the owner's order.)
  const cold = library('claude', [
    libRow('claude', 'helmian-github', 'GitHub', { state: 'not-connected', oneLiner: 'Work with the repositories this workspace already reaches' }),
    libRow('claude', 'github', 'GitHub', { brokerMode: 'vendor', kind: 'oauth-app', oneLiner: 'Review pull requests, issues, and repository activity' }),
  ]);
  const coldModel = plusMenuLevel2Model({ seatId: 'claude', library: cold, conversationId: 'c1' });
  const coldGithubs = flat(coldModel).filter((r) => r.row?.name === 'GitHub');
  assert.equal(coldGithubs.length, 1, 'still one GitHub row');
  assert.equal(coldGithubs[0].row.entryId, 'helmian-github', 'the brokered row stands for the name');
  assert.equal(coldGithubs[0].kind, 'connect', 'standing as the Connect action the panel now offers');
});

test('dedupePanelConnectorRows: tiers, order, and hands-off for non-connector rows', () => {
  const toggle = (entryId, name, over = {}) => ({ kind: 'toggle', row: { entryId, name, brokerMode: 'helmian', state: 'connected', ...over } });
  const mirror = (entryId, name, over = {}) => ({ kind: 'mirror', row: { entryId, name, brokerMode: 'vendor', state: 'not-connected', ...over } });
  const rows = [
    { kind: 'label', label: 'Connectors' },
    toggle('helmian-github', 'GitHub'),
    mirror('github', 'GitHub'),
    mirror('v-slack-1', 'Slack'),
    mirror('v-slack-2', 'Slack', { state: 'connected' }),
    { kind: 'note', text: 'On for the whole account — name it in a message to use it.' },
  ];
  const out = dedupePanelConnectorRows(rows);
  assert.deepEqual(out.map((r) => r.row?.entryId ?? r.kind), ['label', 'helmian-github', 'v-slack-2', 'note'],
    'brokered beats mirror, a connected mirror beats a not-connected one, and labels and notes pass through in place');
  const untouched = [toggle('a', 'A'), mirror('b', 'B')];
  assert.equal(dedupePanelConnectorRows(untouched), untouched, 'a list with no duplicate names comes back as itself');
  assert.deepEqual(dedupePanelConnectorRows(null), [], 'a missing list plans an empty one, not a crash');
});

test('standing armed set: the config bridges round-trip (bite A2)', () => {
  // Hydration: the channel config's flat pair list folds under the
  // channel's scope; malformed pairs drop, duplicates collapse.
  const state = armedStateFromConfig({ armedConnectors: [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'Bad Seat', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'helmian-github' },
    'junk',
  ] }, 'channel:c1');
  assert.deepEqual(connectorsForTurn(state, 'channel:c1'), [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'grok', entryId: 'helmian-github' },
  ], 'the hydrated set carries exactly the stored pairs');
  assert.deepEqual(connectorsForTurn(state, 'channel:c2'), [], 'another channel\u2019s scope stays empty');
  // Extraction: the write road carries the same flat shape back.
  const flipped = toggleConnector(state, 'channel:c1', 'grok', 'helmian-github');
  assert.deepEqual(armedConnectorPairs(flipped, 'channel:c1'), [
    { seatId: 'claude', entryId: 'helmian-github' },
  ], 'a flip off is what the next persist would store');
  // Absent config hydrates to nothing armed.
  assert.deepEqual(armedStateFromConfig(null, 'channel:c1'), {});
  assert.deepEqual(armedStateFromConfig({}, 'channel:c1'), {});
});

test('standing armed set: flips persist through the channel-config road (bite A2, source pins)', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(js.includes("action: 'set-armed-connectors'"), 'the persist posts the channel-config action');
  assert.ok(js.includes('armedStateFromConfig'), 'the config load hydrates the toggle store');
  assert.ok(!js.includes('clearConversationToggles'), 'a send no longer clears the standing set');
});

test('plus menu Level 2 — Claude (bite M2): Skills binds the workspace library, Plugins the bridge list, Projects the registry', () => {
  const skills = [
    { id: 'helm', name: 'Helm', description: 'Steer the fleet', scope: 'blanket', seatIds: [], state: 'available' },
    { id: 'claude-only', name: 'Claude craft', description: '', scope: 'seats', seatIds: ['claude'], state: 'available' },
    { id: 'grok-only', name: 'Grok craft', description: '', scope: 'seats', seatIds: ['grok'], state: 'available' },
    { id: 'retired', name: 'Retired', description: '', scope: 'blanket', seatIds: [], state: 'disabled-by-owner' },
  ];
  const skillAttach = [{ skillId: 'helm', seatId: 'claude' }];
  const plugins = [{ name: 'notes-tools', brings: 'Notes reads' }, { name: 'forge-tools', brings: 'Forge reads' }];
  const attachments = [{ kind: 'plugin', name: 'forge-tools' }];
  const projects = [{ key: 'helmian', name: 'Helmian' }, { key: 'forge', name: 'Forge' }];
  const model = plusMenuLevel2Model({
    seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1',
    skills, skillAttach, plugins, attachments, projects, activeProjectKey: 'forge',
  });
  const lines = brief(model);
  assert.ok(lines.includes('skill:Helm=on'), 'a blanket skill armed for this seat shows on');
  assert.ok(lines.includes('skill:Claude craft=off'), 'a seat-scoped skill for this seat shows, off until armed');
  assert.ok(!lines.some((l) => l.includes('Grok craft')), 'a skill scoped to another seat never shows here');
  const retired = flat(model).find((r) => r.kind === 'skill' && r.skillId === 'retired');
  assert.equal(retired.disabled, true, 'an owner-disabled skill shows as turned off, never armable');
  assert.ok(lines.includes('plugin:notes-tools=off'));
  assert.ok(lines.includes('plugin:forge-tools=on'), 'the attached plugin shows on');
  // The plugins read provides no tool count today (a `tools`
  // boolean + a brings line only), so the row carries none — and
  // when a read ever provides one, it passes through untouched.
  assert.equal(flat(model).find((r) => r.kind === 'plugin' && r.name === 'notes-tools').toolCount, null, 'no count is invented from a read that carries none');
  const counted = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', skills: [], plugins: [{ name: 'notes-tools', brings: 'Notes reads', toolCount: 3 }], projects: [] });
  assert.equal(flat(counted).find((r) => r.kind === 'plugin').toolCount, 3, 'a count the read does provide rides the row');
  assert.ok(lines.includes('project:Helmian'));
  assert.ok(lines.includes('project:Forge=active'), 'the active project is marked');
  // Loaded-empty is a specific honest note, never "Nothing here yet".
  const empty = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', skills: [], plugins: [], projects: [] });
  const emptyLines = brief(empty);
  assert.ok(emptyLines.includes("note:No skills on Claude's shelf yet."));
  assert.ok(emptyLines.includes('note:No plugins are installed.'));
  assert.ok(emptyLines.includes('note:No projects in this workspace yet.'));
  assert.ok(!emptyLines.includes('note:Nothing here yet.'), 'no feed group falls back to the eternal empty note');
});

test('plus menu Level 2 — plugins that failed to load are named, never read as none installed (fix B)', () => {
  const failed = [{ name: 'broken-one', error: 'boom' }, { name: 'broken-two', error: 'bang' }];
  // (a) Zero loaded + failures behind the read: the count line
  // renders and the bare empty note does not stand — not alone, not
  // at all: "none installed" would be a lie here.
  const onlyFailed = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', skills: [], plugins: [], pluginsUnavailable: failed, projects: [] });
  const failedLines = brief(onlyFailed);
  assert.ok(failedLines.includes('note:2 plugins could not be loaded.'));
  assert.ok(!failedLines.includes('note:No plugins are installed.'), 'the empty note never stands over a failed load');
  // (b) Truly empty: the empty note only, no count line.
  const trulyEmpty = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', skills: [], plugins: [], pluginsUnavailable: [], projects: [] });
  const emptyLines = brief(trulyEmpty);
  assert.ok(emptyLines.includes('note:No plugins are installed.'));
  assert.ok(!emptyLines.some((l) => l.includes('could not be loaded')), 'no failure line over a clean empty read');
  // (c) Loaded plugins AND failures: the list and the count line
  // both render.
  const mixed = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', skills: [], plugins: [{ name: 'notes-tools', brings: 'Notes reads' }], pluginsUnavailable: [failed[0]], projects: [] });
  const mixedLines = brief(mixed);
  assert.ok(mixedLines.includes('plugin:notes-tools=off'), 'the loaded plugin still lists');
  assert.ok(mixedLines.includes('note:1 plugin could not be loaded.'), 'the singular count line renders beside it');
  assert.ok(!mixedLines.includes('note:No plugins are installed.'));
});

test('plus menu Level 2 — Claude web search reflects the per-message flag', () => {
  const on = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1', webSearchOn: true });
  assert.equal(flat(on).find((r) => r.kind === 'capability').on, true);
  const off = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1' });
  assert.equal(flat(off).find((r) => r.kind === 'capability').on, false, 'default off, like every per-message arm');
});

test('plus menu Level 2 — ChatGPT: no web-search row (the attachments layer cannot honour it there, REPORT §6)', () => {
  const lib = library('chatgpt', [
    libRow('chatgpt', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
    libRow('chatgpt', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'chatgpt', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add photos & files',
    'submenu:More',
    'toggle:helmian-github=off',
    'mirror:gmail',
    'manage:Manage connectors:integrations:none',
  ]);
  assert.ok(!flat(model).some((r) => r.kind === 'capability'), 'no capability row is rendered for ChatGPT at all');
});

test('plus menu Level 2 — Grok: account-level rows are state rows, with the account note', () => {
  const lib = library('grok', [
    libRow('grok', 'github', 'GitHub', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'helmianlabs', kind: 'oauth-app' }),
    libRow('grok', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
    libRow('grok', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'grok', library: lib, conversationId: 'c1' });
  const stateRow = flat(model).find((r) => r.row?.entryId === 'gmail' && r.rowShape === 'state');
  assert.ok(stateRow, 'Grok\'s Gmail renders as an account-level state row');
  assert.equal(stateRow.kind, 'mirror');
  assert.ok(brief(model).includes('note:On for the whole account — name it in a message to use it.'), 'the state group carries the honest account note');
  // Bite A2: Grok's GitHub is bound in the live group but is
  // vendor-brokered there — the standing toggle list offers only
  // rows Helmian can arm, so it no longer appears in the menu at
  // all (it is not a switch, and the toggle list carries no state
  // rows; its state lives on the Manage surface).
  assert.equal(findRow(model, 'github'), undefined, 'a vendor-brokered row bound in the live group is not offered in the toggle list');
  assert.equal(findRow(model, 'helmian-github').kind, 'toggle', 'the Helmian-brokered row still toggles');
});

test('plus menu Level 2 — Gemini: Connected Apps mirror first, then the live Helmian group', () => {
  const lib = library('gemini', [
    libRow('gemini', 'google-calendar', 'Google Calendar', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
    libRow('gemini', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'gemini', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add photos & files',
    'submenu:Connected Apps',
    'mirror:google-calendar',
    'note:On for the whole account — name it in a message to use it.',
    'label:Connectors',
    'toggle:helmian-github=off',
    'manage:Manage connectors:integrations:none',
  ]);
});

test('plus menu Level 2 — Groq: the beta note rides its live group', () => {
  const lib = library('groq', [libRow('groq', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const model = plusMenuLevel2Model({ seatId: 'groq', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add files',
    'label:Connectors',
    'note:Beta — Groq remote MCP',
    'toggle:helmian-github=off',
    'manage:Manage connectors:integrations:none',
  ]);
});

test('plus menu Level 2 — Mistral: empty groups are honest notes; the Agents mirror is deleted (bite M2); the footer is Helmian\'s manage road like every seat', () => {
  const lib = library('mistral', [libRow('mistral', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const model = plusMenuLevel2Model({ seatId: 'mistral', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add files',
    'submenu:Tools',
    'toggle:helmian-github=off',
    'note:Nothing here yet.',
    'manage:Manage connectors:integrations:none',
  ]);
});

test('plus menu: no seat\'s Level 2 carries a vendor manage row — the only manage row is Helmian\'s Integrations road (Troy\'s ruling, 2026-11-08)', () => {
  for (const seatId of MENU_SEAT_IDS) {
    const model = plusMenuLevel2Model({ seatId, library: library(seatId, []), conversationId: 'c1' });
    assert.ok(model, `${seatId} composes`);
    const manages = flat(model).filter((r) => r.kind === 'manage');
    assert.equal(manages.length, 1, seatId);
    assert.deepEqual(manages[0], { kind: 'manage', label: 'Manage connectors', target: 'integrations' }, seatId);
    assert.equal(flat(model).at(-1).kind, 'manage', `${seatId}: the manage row still closes the menu`);
  }
});

test('plus menu face: no vendor eject renders — no mirror manage anchor, no vendor manage branch, no dead placeholder row', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('ew-lib-manage'), 'the per-row vendor manage anchor is gone from the renderer');
  assert.ok(!js.includes("row.target === 'vendor'"), 'the footer has no vendor branch');
  assert.ok(!js.includes('Not available yet'), 'no dead manage placeholder row remains');
  assert.match(js, /data-view="integrations"/, 'the Integrations nav road is still the footer action');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('.ew-lib-manage'), 'the removed anchor\'s style rule is gone too');
});

test('plus menu: cross-seat toggle isolation — arming Claude\'s GitHub arms nothing for Grok, and nothing in another channel', () => {
  // The scope keys are channel ids (conversationIdFor names the
  // open channel): the standing set is per (seat, channel).
  const t1 = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  const claude = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, toggles: t1, conversationId: 'c1' });
  assert.equal(findRow(claude, 'helmian-github').row.on, true, 'the armed row shows on in its own seat and channel');
  const grokLib = library('grok', [libRow('grok', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const grok = plusMenuLevel2Model({ seatId: 'grok', library: grokLib, toggles: t1, conversationId: 'c1' });
  assert.equal(findRow(grok, 'helmian-github').row.on, false, 'the same entry under another seat stays off');
  const elsewhere = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, toggles: t1, conversationId: 'c2' });
  assert.equal(findRow(elsewhere, 'helmian-github').row.on, false, 'another channel stays off');
  assert.deepEqual(connectorsForTurn(t1, 'c1'), [{ seatId: 'claude', entryId: 'helmian-github' }], 'the ask-path vehicle carries exactly the armed pair');
  assert.deepEqual(connectorsForTurn(t1, 'c2'), []);
});

test('plus menu: no mirror row, on any seat, ever composes as a toggle', () => {
  // Every entry id any seat's menu can reference, fed two ways: once
  // as vendor-brokered read rows, once as Helmian-brokered ones. The
  // catalog (inside connector-panel.mjs) decides which rows are
  // mirrors; the face must honour that either way.
  for (const brokerMode of ['vendor', 'helmian']) {
    for (const seatId of MENU_SEAT_IDS) {
      const ids = [...new Set(collectCatalogEntryIds(menuForSeat(seatId)))];
      const rows = ids.map((id) => libRow(seatId, id, id, {
        state: 'connected', brokerMode, accountIdentity: 'troy@example.com', kind: 'oauth-app',
      }));
      const model = plusMenuLevel2Model({ seatId, library: library(seatId, rows), conversationId: 'c1' });
      assert.ok(model, `${seatId} composes`);
      for (const d of flat(model)) {
        if (!d.row) continue;
        if (d.row.mirror) {
          assert.equal(d.kind, 'mirror', `${seatId}/${d.row.entryId} (${brokerMode} read): a vendor-brokered row is a mirror, never a toggle`);
          assert.equal(d.row.toggleable, false, `${seatId}/${d.row.entryId}: mirror rows are not toggleable`);
        }
        if (d.kind === 'toggle') assert.equal(d.row.mirror, null, `${seatId}/${d.row.entryId}: a toggle is never a mirror`);
      }
    }
  }
});

test('plus menu: a loading or failed library still renders the seat\'s own rows — attach first, manage last, notes between', () => {
  const loading = plusMenuLevel2Model({ seatId: 'claude', library: null });
  const kinds = brief(loading);
  assert.equal(kinds[0], 'attach:Add files or photos');
  assert.ok(kinds.includes('note:Loading Claude\'s library...'));
  assert.equal(kinds.at(-1), 'manage:Manage connectors:integrations:none');
  assert.ok(!flat(loading).some((r) => r.kind === 'toggle'), 'no toggle is offered before its state is read');
  const errored = plusMenuLevel2Model({ seatId: 'claude', library: { seatId: 'claude', connectedCount: 0, rows: [], error: true } });
  assert.ok(brief(errored).includes('note:This library could not be loaded.'));
  assert.equal(plusMenuLevel2Model({ seatId: 'no-such-seat', library: null }), null, 'an unknown seat composes nothing');
});

test('plus menu face wiring: popup class on the room picker only, outside-press close, closing never writes the draft', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /classList\.add\('ew-plus-menu'\)/, 'the room picker gains the popup class at wire time');
  assert.match(js, /document\.addEventListener\('pointerdown'/, 'an outside press closes the menu');
  const close = js.slice(js.indexOf('function closePicker()'), js.indexOf('async function togglePicker'));
  assert.doesNotMatch(close, /maestro-input|attach\[|webSearch\[/, 'closePicker hides the panel only — the draft, attachments and toggles are untouched');
  const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(appJs, /ew-plus-menu/, 'the session console keeps its own panel — its send carries no connector toggles (named seam)');
  assert.match(appJs, /renderConsolePicker/, 'the console picker still renders');
});

test('plus menu: the old full-width panel is gone from the face — no code path renders it', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const gone of ['Add to this message', 'CONNECTOR LIBRARY', 'renderLibrarySection', 'loadPickerData', 'currentPickerModel', "g.id ===", 'ew-picker-input', 'pickerModel']) {
    assert.ok(!js.includes(gone), `envoy-workspace.js no longer contains ${gone}`);
  }
});

test('seat library loader (fix D): a row added mid-session appears on the next open past the staleness window — no page reload', async () => {
  // The real loader, driven end to end against a fake read whose
  // second response adds a row (the Idiolect shape: created in the
  // store while the page session was already open).
  let libraryReads = 0;
  let grown = false;
  const api = async (path) => {
    if (path === '/api/admin/connector-library/seats') return { seats: [{ seatId: 'claude' }] };
    if (path.startsWith('/api/admin/connector-library?seat=')) {
      libraryReads += 1;
      const rows = [libRow('claude', 'gmail', 'Gmail', { state: 'connected' })];
      if (grown) rows.push(libRow('claude', 'idiolect', 'Idiolect', { brokerMode: 'vendor', kind: 'catalog' }));
      return { connectedCount: 1, rows };
    }
    throw new Error(`unexpected read: ${path}`);
  };
  resetLibrarySession({ api });
  const t0 = 1_000_000;
  const first = await loadSeatLibrary('claude', t0);
  assert.deepEqual(first.rows.map((r) => r.entryId), ['gmail'], 'the first read serves what the store holds');
  assert.equal(libraryReads, 1);
  grown = true;
  const cached = await loadSeatLibrary('claude', t0 + 30_000);
  assert.equal(libraryReads, 1, 'inside the window the cache stands — no re-read');
  assert.deepEqual(cached.rows.map((r) => r.entryId), ['gmail']);
  const fresh = await loadSeatLibrary('claude', t0 + LIBRARY_STALE_MS + 1);
  assert.equal(libraryReads, 2, 'past the window the next open re-reads');
  assert.deepEqual(fresh.rows.map((r) => r.entryId), ['gmail', 'idiolect'], 'the row added mid-session appears without a page reload');
});

test('arm-time prompts are gone with the draft rows they fed (bite A2)', async () => {
  // The fix-D prompt-listing machinery (ensureConnectorPrompts and
  // its PROMPTS_NOT_HELD outcome) existed only to render prompt
  // rows under an armed connector. Those rows are deleted (the
  // no-drafts test above), so the machinery is deleted too — the
  // server-side prompts route itself is untouched and other
  // surfaces may still use it.
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('connectorPrompts'), 'no prompts cache remains in the workspace state');
});

test('mount preload (speed fix): the menu libraries are warm before first open — no fetch-on-open on the warm path', async () => {
  // The real loaders, driven end to end against a counting fake
  // read. Before the fix the seats read fired only when the menu
  // first opened (envoy-workspace.js renderPlusMenuLevel1 was the
  // first caller) and the open painted "Loading libraries…" while it
  // ran. The preload fires the same loaders at workspace mount.
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/admin/connector-library/seats') return { seats: [{ seatId: 'claude' }, { seatId: 'grok' }] };
    if (path.startsWith('/api/admin/connector-library?seat=')) {
      const seatId = path.split('seat=')[1];
      return { connectedCount: 1, rows: [libRow(seatId, 'gmail', 'Gmail', { state: 'connected' })] };
    }
    if (path === '/api/admin/plugins') return { plugins: [], unavailable: [] };
    if (path === '/api/admin/skills') return { skills: [] };
    throw new Error(`unexpected read: ${path}`);
  };
  resetLibrarySession({ api });
  preloadLibrarySession();
  // The preload is background work: let its chain settle (seats
  // facts, then one library per seat, plus the plugins and skills
  // reads that fire alongside).
  for (let i = 0; i < 50 && calls.length < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.includes('/api/admin/connector-library/seats'), 'the seats facts were read at preload time, not at first open');
  assert.ok(calls.includes('/api/admin/plugins'), 'the plugins list was read at preload time');
  assert.ok(calls.includes('/api/admin/skills'), 'the skills list was read at preload time');
  assert.deepEqual(
    calls.filter((p) => p.startsWith('/api/admin/connector-library?seat=')).sort(),
    ['/api/admin/connector-library?seat=claude', '/api/admin/connector-library?seat=grok'],
    'each seat library was prefetched exactly once, in the background',
  );
  const warmed = calls.length;
  // The warm path: opening a seat's menu now reads from the session
  // cache — the loader the open path calls makes no new read.
  const library = await loadSeatLibrary('claude', Date.now());
  assert.deepEqual(library.rows.map((r) => r.entryId), ['gmail'], 'the open serves the preloaded library');
  assert.equal(calls.length, warmed, 'no fetch-on-open once the preload has landed');
  // And the preload itself is once-per-session: a remount does not
  // re-fire any of it (the caches and their staleness windows rule).
  preloadLibrarySession();
  assert.equal(calls.length, warmed, 'a second preload call fires nothing');
});

test('plus menu Level 2 — the panel carries the seat’s WHOLE library: rows no menu binds still render (owner order, 2026-11-10)', () => {
  // The menu definitions bind the shipped catalog. A person's own
  // entries — and any row a catalog gains before a menu binds it —
  // are in the library read but bound nowhere, and before this fix
  // they never rendered: the panel showed a subset and called it
  // the library. Now unbound Helmian-brokered rows join the
  // Connectors list and unbound vendor rows join the mirror group,
  // each exactly once.
  const lib = library('claude', [
    libRow('claude', 'helmian-github', 'GitHub', { state: 'connected' }),
    libRow('claude', 'registry-atlassian', 'Atlassian', { state: 'disabled-by-owner' }),
    libRow('claude', 'my-own-server', 'My Server', { state: 'not-connected', kind: 'custom' }),
    libRow('claude', 'local-tool', 'Local Tool', { state: 'not-connected', kind: 'mcp-local' }),
    libRow('claude', 'unbound-mirror', 'Unbound Mirror', { state: 'not-connected', brokerMode: 'vendor', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, conversationId: 'c1' });
  const mine = findRow(model, 'my-own-server');
  assert.ok(mine, 'an unbound row renders');
  assert.equal(mine.kind, 'connect', 'an unbound not-connected Helmian row stands with its Connect action');
  const local = findRow(model, 'local-tool');
  assert.equal(local.kind, 'row', 'a local-only entry stands as an honest state row');
  assert.equal(local.row.connectable, false, 'with no Connect action — it has no connect-start to offer');
  const mirror = findRow(model, 'unbound-mirror');
  assert.equal(mirror.kind, 'mirror', 'an unbound vendor row stands with the mirrors');
  const atlassian = findRow(model, 'registry-atlassian');
  assert.equal(atlassian.kind, 'row', 'an owner-disabled row stands as a state row, not a Connect button');
  assert.equal(atlassian.row.connectable, false, 're-enabling it is the owner’s Manage act, not a panel Connect');
  for (const id of ['my-own-server', 'local-tool', 'unbound-mirror', 'registry-atlassian']) {
    assert.equal(flat(model).filter((r) => r.row?.entryId === id).length, 1, `${id} renders exactly once`);
  }
});

test('plus menu Level 2 — Grok, the owner’s screenshot shape: mirrors carry no Connect, brokered rows carry theirs (2026-11-10)', () => {
  // The owner's own screen: Grok's Connectors panel listed Gmail,
  // SharePoint and the rest as "Not connected" with no action
  // anywhere. Those rows are Grok-side mirrors — the library write
  // route refuses vendor entries, so no Helmian-side Connect exists
  // for them; they stand as mirrors (their row opens Helmian's own
  // library at this seat — see the face pin below). The brokered
  // rows DO get the button, and a brokered row stands for its name.
  const lib = library('grok', [
    libRow('grok', 'helmian-github', 'GitHub', { state: 'connected' }),
    libRow('grok', 'github', 'GitHub', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'helmianlabs', kind: 'oauth-app' }),
    libRow('grok', 'gmail', 'Gmail', { brokerMode: 'vendor', kind: 'oauth-app' }),
    libRow('grok', 'sharepoint', 'SharePoint', { brokerMode: 'vendor', kind: 'oauth-app' }),
    libRow('grok', 'registry-notion', 'Notion', { state: 'not-connected' }),
    libRow('grok', 'notion', 'Notion', { brokerMode: 'vendor', kind: 'oauth-app' }),
    libRow('grok', 'registry-weather', 'Weather', { state: 'not-connected' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'grok', library: lib, conversationId: 'c1' });
  for (const id of ['gmail', 'sharepoint']) {
    const row = findRow(model, id);
    assert.equal(row.kind, 'mirror', `${id} stands as a mirror`);
    assert.equal(row.row.connectable, false, `${id} carries no Connect action — none exists on Helmian’s side for a vendor entry`);
  }
  const notion = findRow(model, 'registry-notion');
  assert.equal(notion.kind, 'connect', 'the brokered Notion stands with its Connect action');
  assert.equal(flat(model).filter((r) => r.row?.name === 'Notion').length, 1, 'and the vendor namesake drops — one Notion row in the panel');
  assert.equal(findRow(model, 'registry-weather').kind, 'connect', 'Weather offers Connect from this panel — the road the Connectors tab proved end to end');
  assert.equal(findRow(model, 'github'), undefined, 'the vendor GitHub bound in the live group is still not offered there');
  assert.equal(findRow(model, 'helmian-github').kind, 'toggle', 'the connected brokered GitHub still toggles');
});

test('plus menu Level 2 — the card’s switch is the connection: on when connected, off only when off for everyone (owner order, 2026-11-10)', () => {
  // The owner's screenshot, second time: GitHub and Weather read
  // "Connected as …" with their switches OFF, because the switch
  // drew the channel's armed set. The switch now draws the
  // connection itself, and these values are its contract. The
  // armed set (row.on) keeps its own meaning — the chips and the
  // wire — and plays no part here.
  const lib = library('grok', [
    libRow('grok', 'helmian-github', 'GitHub', { state: 'connected', accountIdentity: 'helmianlabs/helmian' }),
    libRow('grok', 'registry-weather', 'Weather', { state: 'connected', accountIdentity: 'No sign-in' }),
    libRow('grok', 'registry-notion', 'Notion', { state: 'not-connected' }),
    libRow('grok', 'registry-linear', 'Linear', { state: 'needs-reconnect' }),
    libRow('grok', 'helmian-vercel', 'Vercel', { state: 'disabled-by-owner' }),
    libRow('grok', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  ]);
  // An unarmed channel: nothing in the toggle store at all — the
  // state the owner's screenshot was taken in.
  const model = plusMenuLevel2Model({ seatId: 'grok', library: lib, conversationId: 'c1' });
  for (const id of ['helmian-github', 'registry-weather']) {
    const row = findRow(model, id).row;
    assert.equal(row.on, false, `${id}: nothing is armed in this channel`);
    assert.equal(row.connectionSwitch, true, `${id}: a connected Helmian card carries the connection switch`);
    assert.equal(row.connectionOn, true, `${id}: connected reads ON, armed or not`);
  }
  // An armed channel: arming moves row.on and nothing about the
  // switch — the two facts no longer share a slot.
  const armed = plusMenuLevel2Model({ seatId: 'grok', library: lib, toggles: toggleConnector({}, 'c1', 'grok', 'helmian-github'), conversationId: 'c1' });
  assert.equal(findRow(armed, 'helmian-github').row.on, true, 'the armed set still tracks its own fact');
  assert.equal(findRow(armed, 'helmian-github').row.connectionOn, true, 'and the switch is still simply the connection');
  // Not connected and needs-reconnect carry no switch — the
  // Connect action stands there instead (the earlier order).
  for (const id of ['registry-notion', 'registry-linear']) {
    assert.equal(findRow(model, id).row.connectionSwitch, false, `${id}: no switch where there is no connection to switch`);
  }
  // Off for everyone: the switch stands, OFF, with its reason as
  // the state line — and the row still composes as a state row,
  // not a Connect and not a toggle.
  const off = findRow(model, 'helmian-vercel');
  assert.equal(off.kind, 'row', 'an owner-disabled row still composes as a state row');
  assert.equal(off.row.connectionSwitch, true, 'but it carries the connection switch');
  assert.equal(off.row.connectionOn, false, 'standing OFF');
  assert.equal(off.row.stateLabel, 'Turned off by your workspace owner', 'with its reason as the state line');
  // A mirror never carries the switch: its connection lives in
  // the seat's own product, not in Helmian.
  assert.equal(findRow(model, 'gmail').row.connectionSwitch, false, 'a vendor mirror carries no connection switch');
});

test('plus menu face: the switch and its word share one source, and the panel Connect posts Manage’s road (owner report, 2026-11-10)', async () => {
  // The owner's second screenshot: GitHub read "Connected as
  // helmianlabs/helmian" while its switch rendered OFF — the
  // trailing word borrowed the connection's state label while the
  // switch drew the channel's armed state. Two sources, one slot.
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes("row.on ? 'On' : row.stateLabel"), 'the word beside the switch never borrows the connection’s state label');
  // The pin below replaces the same morning's earlier one
  // ("row.on ? 'On' : 'Off'") under the owner's second order of
  // 2026-11-10: separating the words was not enough — the switch
  // itself changed source, from the channel's armed set to the
  // connection. A connected card now stands ON with the word
  // "On" drawn from the connection state, and the row renderer
  // no longer reads the armed set (row.on) at all; the flip runs
  // the disconnect, not an arm.
  assert.ok(!js.includes("row.on ? 'On' : 'Off'"), 'the word beside the switch no longer comes from the armed set');
  assert.ok(js.includes("h('span', { class: 'ew-picker-state on' }, 'On')"), 'a connected card stands ON, word "On", from the connection');
  const rowNode = js.slice(js.indexOf('function libraryRowNode'), js.indexOf('async function startPanelConnect'));
  assert.ok(!rowNode.includes('toggleConnector'), 'the card’s flip no longer arms or disarms in the channel — the standing set’s store is not the switch any more');
  assert.ok(!rowNode.includes('persistArmedConnectors'), 'the card’s flip never persists an armed set');
  assert.ok(rowNode.includes('startPanelDisconnect'), 'the connected card’s flip runs the panel disconnect');
  assert.ok(rowNode.includes('row.connectionSwitch'), 'the off-for-everyone card renders through the connection-switch branch, switch OFF with its reason line');
  const flip = js.slice(js.indexOf('async function startPanelDisconnect'), js.indexOf('// The Level 2 model'));
  assert.ok(flip.includes("'/api/admin/connector-library/disconnect'"), 'the flip posts the same disconnect route Manage’s Disconnect posts');
  assert.ok(flip.includes('{ seatId: row.seatId, entryId: row.entryId }'), 'with the seat and the entry — the per-agent disconnect, no new road');
  assert.ok(flip.includes('is disconnected and its stored sign-in was revoked.'), 'the custody words are Manage’s own, shared by both faces');
  assert.ok(js.includes('ew-lib-state'), 'the connection state stands as its own line in the row’s text block');
  assert.ok(js.includes('ew-lib-connect'), 'the Connect control renders as a real button on the row');
  assert.ok(js.includes("'/api/admin/connector-library/connect'"), 'the panel Connect posts the same connect-start the Manage panel uses');
  assert.ok(js.includes("out?.status === 'authorize'"), 'the panel hands the person the authorize door the start returns');
  assert.ok(js.includes('not in Helmian — open Helmian'), 'a mirror row states plainly that its connection is not Helmian’s to make, and its one action opens Helmian’s library at this seat');
});

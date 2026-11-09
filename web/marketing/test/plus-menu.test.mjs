import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LIBRARY_STALE_MS, connectorPromptsState, ensureConnectorPrompts, loadSeatLibrary, plusMenuLevel2Model, resetLibrarySession } from '../app/envoy-workspace.js';
import { connectorsForTurn, level1Model, toggleConnector } from '../app/connector-panel.mjs';
import { MENU_SEAT_IDS, collectCatalogEntryIds, menuForSeat } from '../app/connector-menu.mjs';

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
const brief = (model) => flat(model).map((r) => r.kind === 'toggle' || r.kind === 'mirror' || r.kind === 'row'
  ? `${r.kind}:${r.row.entryId}${r.kind === 'toggle' ? (r.row.on ? '=on' : '=off') : ''}`
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

test('plus menu Level 2 — Claude (bite M2): catalog starter actions ride under their connector; MCP prompts ride under an ARMED toggle only', () => {
  const lib = library('claude', [
    libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
    libRow('claude', 'idiolect', 'Idiolect', {
      state: 'connected', brokerMode: 'vendor', kind: 'oauth-app',
      starterActions: [{ label: 'Write an email in my style', prompt: 'Write an email in my style' }],
    }),
  ]);
  const toggles = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  const promptsByEntry = { 'helmian-github': { status: 'ok', prompts: [{ name: 'daily-note', title: 'Daily note', arguments: [] }] } };
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, toggles, conversationId: 'c1', promptsByEntry });
  const lines = brief(model);
  const githubAt = lines.indexOf('toggle:helmian-github=on');
  assert.equal(lines[githubAt + 1], 'prompt:Daily note', 'the armed server\u2019s starter prompt follows its toggle');
  const idiolectAt = lines.indexOf('mirror:idiolect');
  assert.equal(lines[idiolectAt + 1], 'starter:Write an email in my style', 'the catalog starter action follows its connector row');
  // Disarmed: the same prompts input renders nothing — prompts are
  // listed at arm time, never before.
  const disarmed = plusMenuLevel2Model({ seatId: 'claude', library: lib, conversationId: 'c1', promptsByEntry });
  assert.ok(!brief(disarmed).some((l) => l.startsWith('prompt:')), 'no prompt row under a disarmed toggle');
  // A failed listing is one honest note, not a silent gap.
  const failed = plusMenuLevel2Model({ seatId: 'claude', library: lib, toggles, conversationId: 'c1', promptsByEntry: { 'helmian-github': { status: 'error', prompts: [] } } });
  assert.ok(brief(failed).includes("note:Helmian GitHub's starters could not be listed."));
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
  assert.equal(findRow(model, 'github').kind, 'mirror', 'GitHub sits in Grok\'s live group but is vendor-brokered there — it renders as a mirror, never a toggle');
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

test('plus menu: cross-seat toggle isolation — arming Claude\'s GitHub arms nothing for Grok, and nothing in another conversation', () => {
  const t1 = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  const claude = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, toggles: t1, conversationId: 'c1' });
  assert.equal(findRow(claude, 'helmian-github').row.on, true, 'the armed row shows on in its own seat and conversation');
  const grokLib = library('grok', [libRow('grok', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const grok = plusMenuLevel2Model({ seatId: 'grok', library: grokLib, toggles: t1, conversationId: 'c1' });
  assert.equal(findRow(grok, 'helmian-github').row.on, false, 'the same entry under another seat stays off');
  const elsewhere = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, toggles: t1, conversationId: 'c2' });
  assert.equal(findRow(elsewhere, 'helmian-github').row.on, false, 'another conversation stays off');
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

test('arm-time prompts (fix D): a PROMPTS_NOT_HELD refusal is the silent unsupported outcome — no failure note', async () => {
  // The route's by-design refusal for an entry Helmian holds no
  // token for (the tokenless native GitHub entry): there are no
  // starters to list, so arming it must not paint a failure.
  const refusal = Object.assign(new Error('PROMPTS_NOT_HELD'), { status: 409, body: { code: 'PROMPTS_NOT_HELD', error: 'Helmian does not hold a sign-in token for this connector, so its starter prompts cannot be listed here yet' } });
  resetLibrarySession({ post: async () => { throw refusal; } });
  ensureConnectorPrompts('claude', 'helmian-github');
  await new Promise((resolve) => setImmediate(resolve));
  const state = connectorPromptsState('claude', 'helmian-github');
  assert.equal(state?.status, 'unsupported', 'the by-design refusal lands on the silent outcome');
  const lib = library('claude', [libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const toggles = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, toggles, conversationId: 'c1', promptsByEntry: { 'helmian-github': state } });
  assert.ok(!brief(model).some((l) => l.includes('could not be listed')), 'no failure note under the armed row');
});

test('arm-time prompts (fix D): any other listing failure still renders the failure note', async () => {
  const refusal = Object.assign(new Error('NOT_CONNECTED'), { status: 409, body: { code: 'NOT_CONNECTED', error: 'connect this connector first — its starters are listed for the person connected to it' } });
  resetLibrarySession({ post: async () => { throw refusal; } });
  ensureConnectorPrompts('claude', 'helmian-github');
  await new Promise((resolve) => setImmediate(resolve));
  const state = connectorPromptsState('claude', 'helmian-github');
  assert.equal(state?.status, 'error', 'a real failure keeps the error state');
  const lib = library('claude', [libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const toggles = toggleConnector({}, 'c1', 'claude', 'helmian-github');
  const model = plusMenuLevel2Model({ seatId: 'claude', library: lib, toggles, conversationId: 'c1', promptsByEntry: { 'helmian-github': state } });
  assert.ok(brief(model).includes("note:Helmian GitHub's starters could not be listed."), 'the honest note stands for a real failure');
});

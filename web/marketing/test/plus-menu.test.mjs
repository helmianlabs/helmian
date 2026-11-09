import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { plusMenuLevel2Model } from '../app/envoy-workspace.js';
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
      : `${r.kind}:${r.label ?? ''}`);
const findRow = (model, entryId) => flat(model).find((r) => r.row?.entryId === entryId);

const CLAUDE_LIB = library('claude', [
  libRow('claude', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
  libRow('claude', 'helmian-scribe', 'Helmian Scribe', { state: 'connected' }),
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

test('plus menu Level 2 — Claude: attach, Skills, Connectors, Plugins, Web search, Manage, in his words and order', () => {
  const model = plusMenuLevel2Model({ seatId: 'claude', library: CLAUDE_LIB, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add files or photos',
    'submenu:Skills',
    'note:Nothing here yet.',
    'note:Nothing here yet.',
    'submenu:Connectors',
    'toggle:helmian-github=off',
    'toggle:helmian-scribe=off',
    'mirror:gmail',
    'mirror:slack',
    'submenu:Plugins',
    'note:Nothing here yet.',
    'capability:Web search',
    'manage:Manage connectors:integrations:none',
  ]);
  const gmail = findRow(model, 'gmail');
  assert.equal(gmail.row.mirror.managedIn, 'Claude', 'the mirror row names where the vendor manages it');
  assert.equal(gmail.row.toggleable, false);
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
    libRow('chatgpt', 'helmian-scribe', 'Helmian Scribe'),
    libRow('chatgpt', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
  ]);
  const model = plusMenuLevel2Model({ seatId: 'chatgpt', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add photos & files',
    'submenu:More',
    'toggle:helmian-github=off',
    'row:helmian-scribe',
    'mirror:gmail',
    'manage:Manage in ChatGPT:vendor:https://chatgpt.com/plugins',
  ]);
  assert.ok(!flat(model).some((r) => r.kind === 'capability'), 'no capability row is rendered for ChatGPT at all');
});

test('plus menu Level 2 — Grok: account-level rows are state rows, with the account note', () => {
  const lib = library('grok', [
    libRow('grok', 'github', 'GitHub', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'helmianlabs', kind: 'oauth-app' }),
    libRow('grok', 'gmail', 'Gmail', { state: 'connected', brokerMode: 'vendor', accountIdentity: 'troy@example.com', kind: 'oauth-app' }),
    libRow('grok', 'helmian-github', 'Helmian GitHub', { state: 'connected' }),
    libRow('grok', 'helmian-scribe', 'Helmian Scribe'),
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
    'manage:Manage in Gemini:vendor:https://gemini.google.com',
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

test('plus menu Level 2 — Mistral: empty groups are honest notes; the manage row carries no invented address', () => {
  const lib = library('mistral', [libRow('mistral', 'helmian-github', 'Helmian GitHub', { state: 'connected' })]);
  const model = plusMenuLevel2Model({ seatId: 'mistral', library: lib, conversationId: 'c1' });
  assert.deepEqual(brief(model), [
    'attach:Add files',
    'submenu:Tools',
    'toggle:helmian-github=off',
    'note:Nothing here yet.',
    'label:Agents',
    'note:Nothing here yet.',
    'manage:Manage in Mistral:vendor:none',
  ]);
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

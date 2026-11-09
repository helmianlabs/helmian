// Connector library — REPORT §3/§4/§6, build bite 3R-a gate pieces
// that staging can prove without the live room:
//
//   (1) for every one of the 14 library seats, the menu definition
//       emits exactly REPORT §3's Level 2 items, in the vendor's own
//       words and order (the projection below IS §3 written as data —
//       a vendor rename or reorder must fail here, never drift);
//   (2) every connector a definition names resolves to an entry in
//       the shipped catalog for that seat, every catalog entry of
//       the seat is bound exactly once across its menu, live toggle
//       groups bind only brokerMode:'helmian' entries and mirror
//       groups only brokerMode:'vendor' entries (the §1.5/§6 pipe
//       law, in data);
//   (3) mirror groups carry NO toggle affordance anywhere in their
//       structure — no toggle/armed/posture/connect-shaped key at
//       any depth, not a flagged-off field (REPORT §6, structural);
//   (4) Grok/Gemini connector rows are account-level STATE rows,
//       distinct in shape from Claude/ChatGPT/Mistral's mirror rows
//       and from every live toggle group (REPORT §5.1);
//   (5) capability discipline: the only capability row in the whole
//       model is Claude's Web search — the one capability with a
//       real per-seat road in the room's turn path (REPORT §6);
//   (6) the module is pure (no DOM, no fetch, one relative import)
//       and the definitions are frozen.
//
// The live half of the gate (the rendered menu in the real room,
// served bytes byte-compared) belongs to bite 3R-b — see the bite
// report's UNVERIFIED list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MENU_DEFINITIONS,
  MENU_ITEM_TYPES,
  MENU_SEAT_IDS,
  collectCatalogEntryIds,
  menuForSeat,
  walkMenuItems,
} from '../web/marketing/app/connector-menu.mjs';
import { LIBRARY_SEATS } from '../web/marketing/app/connector-panel.mjs';
import { catalogEntriesForSeat, catalogEntryById } from '../src/cloud/connector-catalog.mjs';

// ------------------------------------------------------------ shape
// One line per item, depth-first: type, the item's own words, and
// its binding. This projection is the comparison shape for test (1).

function project(items) {
  const out = [];
  for (const { item } of walkMenuItems(items)) {
    if (item.type === 'attach') out.push(`attach:${item.label}`);
    else if (item.type === 'capability') out.push(`capability:${item.label}:${item.capability}`);
    else if (item.type === 'submenu') out.push(`submenu:${item.label}`);
    else if (item.type === 'manage-link') out.push(`manage:${item.label}:${item.target}`);
    else if (item.type === 'live-toggle-group') {
      const bind = item.entryIds ? item.entryIds.join(',') : `feed:${item.feed}`;
      const flags = [item.note ? `note:${item.note}` : null, item.requiresToolCapableModel ? 'requiresToolCapableModel' : null].filter(Boolean);
      out.push(`live:${item.label ?? '-'}:${bind}${flags.length ? `:${flags.join(':')}` : ''}`);
    } else if (item.type === 'mirror-group') {
      const bind = item.entryIds ? item.entryIds.join(',') : `feed:${item.feed}`;
      out.push(`mirror:${item.label ?? '-'}:${item.managedIn}:${item.rowShape}:${bind}`);
    } else out.push(`UNKNOWN:${item.type}`);
  }
  return out;
}

const NATIVES = 'helmian-github,helmian-scribe';
const PLAIN_LIST = [`attach:Add files`, `live:Connectors:${NATIVES}`, 'manage:Manage connectors:integrations'];

const EXPECTED = {
  claude: [
    'attach:Add files or photos',
    'submenu:Skills',
    'live:-:feed:seat-skills-api',
    'mirror:-:Claude:mirror:feed:seat-skills-vendor',
    'submenu:Connectors',
    `live:-:${NATIVES}`,
    'mirror:-:Claude:mirror:gmail,google-calendar,google-drive,github,slack,notion,linear,stripe,atlassian,canva',
    'submenu:Plugins',
    'mirror:-:Claude:mirror:feed:vendor-plugins',
    'capability:Web search:web-search',
    'manage:Manage connectors:integrations',
  ],
  chatgpt: [
    'attach:Add photos & files',
    'submenu:More',
    `live:-:${NATIVES}`,
    'mirror:-:ChatGPT:mirror:gmail,google-calendar,google-drive,slack,notion,github,canva,dropbox',
    'manage:Manage in ChatGPT:vendor',
  ],
  grok: [
    'attach:Files',
    'submenu:Connectors',
    `live:-:github,${NATIVES}`,
    'mirror:-:Grok:state:gmail,google-calendar,google-drive,onedrive,outlook,microsoft-teams,sharepoint,salesforce,box,canva,gamma,linear,meltwater,notion,sp-global,vercel',
    'manage:Manage in Grok:vendor',
  ],
  gemini: [
    'attach:Add photos & files',
    'submenu:Connected Apps',
    'mirror:-:Gemini:state:gmail,google-drive,google-calendar',
    `live:Connectors:${NATIVES}`,
    'manage:Manage in Gemini:vendor',
  ],
  mistral: [
    'attach:Add files',
    'submenu:Tools',
    `live:-:${NATIVES}`,
    'mirror:-:Mistral:mirror:',
    'mirror:Agents:Mistral:mirror:feed:vendor-agents',
    'manage:Manage in Mistral:vendor',
  ],
  groq: ['attach:Add files', `live:Connectors:${NATIVES}:note:Beta — Groq remote MCP`, 'manage:Manage connectors:integrations'],
  nvidia: PLAIN_LIST,
  openrouter: ['attach:Add files', `live:Connectors:${NATIVES}:requiresToolCapableModel`, 'manage:Manage connectors:integrations'],
  cloudflare: ['attach:Add files', `live:Connectors:cloudflare-docs,${NATIVES}`, 'manage:Manage connectors:integrations'],
  qwen: PLAIN_LIST,
  muse: PLAIN_LIST,
  maestro: PLAIN_LIST,
  helm: PLAIN_LIST,
  owner: PLAIN_LIST,
};

// ------------------------------------------------------------- roster

test('roster: a definition for every library seat, in the fleet order, and no others', () => {
  assert.deepEqual(MENU_SEAT_IDS, LIBRARY_SEATS.map((s) => s.seatId));
  assert.deepEqual(Object.keys(MENU_DEFINITIONS), [...MENU_SEAT_IDS]);
  for (const seatId of MENU_SEAT_IDS) assert.ok(Array.isArray(menuForSeat(seatId)), seatId);
  assert.equal(menuForSeat('no-such-seat'), null);
  assert.equal(menuForSeat(null), null);
});

// --------------------------------------------------- (1) §3 verbatim

test('§3 shape: every seat emits exactly its REPORT §3 items, in words and order', () => {
  for (const seatId of MENU_SEAT_IDS) {
    assert.deepEqual(project(menuForSeat(seatId)), EXPECTED[seatId], seatId);
  }
});

test('item types: only the six menu types appear, anywhere', () => {
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      assert.ok(MENU_ITEM_TYPES.includes(item.type), `${seatId}: ${item.type}`);
    }
  }
});

test('skeleton: attach leads and exactly one manage footer closes every seat', () => {
  for (const seatId of MENU_SEAT_IDS) {
    const def = menuForSeat(seatId);
    assert.equal(def[0].type, 'attach', seatId);
    assert.equal(def[def.length - 1].type, 'manage-link', seatId);
    const flat = [...walkMenuItems(def)].map(({ item }) => item.type);
    assert.equal(flat.filter((t) => t === 'attach').length, 1, seatId);
    assert.equal(flat.filter((t) => t === 'manage-link').length, 1, seatId);
  }
});

// ------------------------------------------- (2) catalog binding law

test('catalog: every named connector resolves, and every catalog entry is bound exactly once', () => {
  for (const seatId of MENU_SEAT_IDS) {
    const bound = collectCatalogEntryIds(menuForSeat(seatId));
    // No duplicates: a connector lives in exactly one group.
    assert.equal(new Set(bound).size, bound.length, `${seatId}: duplicate binding`);
    // Every bound id resolves against the shipped catalog.
    for (const entryId of bound) {
      assert.ok(catalogEntryById(seatId, entryId), `${seatId}: ${entryId} has no catalog entry`);
    }
    // Full coverage: the menu accounts for the seat's whole library —
    // nothing the catalog holds is silently dropped from the shape.
    const catalogIds = catalogEntriesForSeat(seatId).map((e) => e.id);
    assert.deepEqual([...bound].sort(), [...catalogIds].sort(), seatId);
  }
});

test('pipe law: live groups bind only Helmian-brokered entries, mirror groups only vendor-brokered', () => {
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      if (!Array.isArray(item.entryIds)) continue;
      for (const entryId of item.entryIds) {
        const entry = catalogEntryById(seatId, entryId);
        if (item.type === 'live-toggle-group') assert.equal(entry.brokerMode, 'helmian', `${seatId}/${entryId}`);
        if (item.type === 'mirror-group') assert.equal(entry.brokerMode, 'vendor', `${seatId}/${entryId}`);
      }
    }
  }
});

// ------------------------------------- (3) mirror structure, no fake

test('never-fake: mirror groups carry no toggle-shaped field at any depth', () => {
  const banned = /toggle|armed|posture|connect|reconnect|disconnect/i;
  const scan = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      assert.ok(!banned.test(key), `${path}: key "${key}"`);
      scan(node[key], `${path}.${key}`);
    }
  };
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      if (item.type !== 'mirror-group') continue;
      scan(item, `${seatId}.mirror`);
      // The whole field set, exactly: nothing extra can hide here.
      assert.deepEqual(
        Object.keys(item).sort(),
        ['label', 'managedIn', 'rowShape', 'type', ...(item.entryIds ? ['entryIds'] : ['feed'])].sort(),
        `${seatId}: mirror field set`,
      );
    }
  }
});

test('never-blur: live toggle groups carry no mirror fields', () => {
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      if (item.type !== 'live-toggle-group') continue;
      assert.equal('managedIn' in item, false, seatId);
      assert.equal('rowShape' in item, false, seatId);
    }
  }
});

// ------------------------------------------------- (4) row-shape law

test('row shapes: Grok and Gemini mirrors are account-level state rows; the rest are mirror rows', () => {
  const shapes = new Map();
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      if (item.type !== 'mirror-group') continue;
      if (!shapes.has(seatId)) shapes.set(seatId, new Set());
      shapes.get(seatId).add(item.rowShape);
    }
  }
  assert.deepEqual([...(shapes.get('grok') ?? [])], ['state']);
  assert.deepEqual([...(shapes.get('gemini') ?? [])], ['state']);
  assert.deepEqual([...(shapes.get('claude') ?? [])], ['mirror']);
  assert.deepEqual([...(shapes.get('chatgpt') ?? [])], ['mirror']);
  assert.deepEqual([...(shapes.get('mistral') ?? [])], ['mirror']);
  // Seats with no vendor-brokered surface have no mirror group at all.
  for (const seatId of ['groq', 'nvidia', 'openrouter', 'cloudflare', 'qwen', 'muse', 'maestro', 'helm', 'owner']) {
    assert.equal(shapes.has(seatId), false, seatId);
  }
});

// -------------------------------------------- (5) capability honesty

test('capabilities: the only capability row in the model is Claude\'s Web search', () => {
  const found = [];
  for (const seatId of MENU_SEAT_IDS) {
    for (const { item } of walkMenuItems(menuForSeat(seatId))) {
      if (item.type === 'capability') found.push({ seatId, label: item.label, capability: item.capability });
    }
  }
  assert.deepEqual(found, [{ seatId: 'claude', label: 'Web search', capability: 'web-search' }]);
});

// ------------------------------------------------------- (6) purity

test('frozen: definitions are frozen to the leaves', () => {
  assert.ok(Object.isFrozen(MENU_DEFINITIONS));
  for (const seatId of MENU_SEAT_IDS) {
    const def = menuForSeat(seatId);
    assert.ok(Object.isFrozen(def), seatId);
    for (const { item } of walkMenuItems(def)) {
      assert.ok(Object.isFrozen(item), `${seatId}: ${item.type}`);
      if (Array.isArray(item.entryIds)) assert.ok(Object.isFrozen(item.entryIds), seatId);
      if (Array.isArray(item.items)) assert.ok(Object.isFrozen(item.items), seatId);
    }
  }
});

test('purity: no DOM, no fetch, exactly one import (the panel roster)', () => {
  const source = readFileSync(new URL('../web/marketing/app/connector-menu.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(source), 'fetch');
  assert.ok(!/\bdocument\b/.test(source), 'document');
  assert.ok(!/\bwindow\b/.test(source), 'window');
  assert.ok(!/\blocalStorage\b/.test(source), 'localStorage');
  const imports = source.split('\n').filter((line) => line.startsWith('import '));
  assert.deepEqual(imports, ["import { LIBRARY_SEATS } from './connector-panel.mjs';"]);
});

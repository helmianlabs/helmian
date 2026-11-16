// The in-panel Manage view (Troy's order, 2026-11-15): a seat's
// "Manage connectors" — and every connector row's own Manage —
// opens that connector's management for that seat INSIDE the
// panel (state, arm switch, tool access, disconnect), instead of
// navigating away to the Integrations page. These pins follow the
// app-sync source-shape pattern: the workspace source carries the
// view, its roads, and its entry points, and the menu data names
// the panel as the manage target.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('manage view: the workspace renders the seat\u2019s management inside the panel', async () => {
  const js = await read('../app/envoy-workspace.js');
  for (const needle of [
    'function openConnectorManage',
    'function closeConnectorManage',
    'function renderConnectorManage',
    'function manageBlockNodes',
    'function disconnectPanelConnector',
    "post('/api/admin/connector-library/disconnect'",
    'manageModel(library, ws.connectorToggles, conversationIdFor(which))',
    'ws.connectorManage',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  // The Level 2 render hands the panel to the manage view while
  // it is open for the seat on screen.
  assert.ok(js.includes('if (ws.connectorManage.seatId === seatId) return renderConnectorManage(which, library);'),
    'renderPlusMenuLevel2 stands the manage view in for the seat\u2019s menu');
  // The manage block carries the four acts: the arm switch (the
  // same toggle + persist road the rows use), Connect (the same
  // panel connect road), tool access (the existing face), and
  // disconnect behind a confirm step.
  const block = js.slice(js.indexOf('function manageBlockNodes'), js.indexOf('async function disconnectPanelConnector'));
  assert.ok(block.includes('toggleConnector(ws.connectorToggles, conversationIdFor(which), row.seatId, row.entryId)'), 'the arm switch flips the channel toggle store');
  assert.ok(block.includes('void persistArmedConnectors()'), 'the arm flip persists like the rows\u2019 flips');
  assert.ok(block.includes('void startPanelConnect(which, row)'), 'Connect rides the panel connect road');
  assert.ok(block.includes('toolAccessNode(which,'), 'tool access renders the existing face in the block');
  assert.ok(block.includes('cm.confirmEntryId === row.entryId'), 'disconnect asks for a confirm step first');
  assert.ok(block.includes('row.isMirror'), 'a mirror\u2019s block is ruled separately — state and the account-page road only');
});

test('manage view: every entry point opens it in place — the footer, the mirror rows, the brokered rows', async () => {
  const js = await read('../app/envoy-workspace.js');
  // The menu footer.
  assert.ok(js.includes("class: 'ew-picker-row ew-plus-manage', onclick: () => openConnectorManage(which, ws.libraryPanel.seatId)"),
    'the Manage footer opens the in-panel manage view');
  // A mirror row.
  assert.ok(js.includes("onclick: () => openConnectorManage(which, row.seatId, row.entryId) }, libraryIconTile(row), text"),
    'mirror rows open the manage view expanded to their entry');
  // A connected row's Manage action under its switch.
  assert.ok(js.includes('function manageRowAction'), 'connected rows carry the Manage action row');
  // The one remaining Agents-tab road is the mirror block's
  // account-page button — a deliberate pick inside the block, not
  // the Manage act itself.
  const block = js.slice(js.indexOf('function manageBlockNodes'), js.indexOf('async function disconnectPanelConnector'));
  assert.ok(block.includes('onclick: () => openManageForSeat(which)'), 'the mirror block carries the account-page road');
  const footer = js.slice(js.indexOf("case 'manage':"), js.indexOf("case 'manage':") + 1200);
  assert.ok(!footer.includes('openManageForSeat'), 'the footer no longer navigates to the Agents tab');
});

test('manage view: the menu data names the panel as the manage target on every seat', async () => {
  const menu = await read('../app/connector-menu.mjs');
  assert.ok(menu.includes("manageLink({ label: 'Manage connectors', target: 'panel' })"), 'the manage footer targets the panel');
  assert.ok(!menu.includes("target: 'integrations'"), 'no seat\u2019s manage footer targets the Integrations page');
  const panel = await read('../app/connector-panel.mjs');
  assert.ok(panel.includes('export function manageModel'), 'the manage model lives with the panel models');
});

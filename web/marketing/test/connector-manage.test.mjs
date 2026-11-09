// The Manage surface (mirror M1): the pure row-controls model and
// the static wiring that lands every seat panel's "Manage
// connectors" row on THIS surface at that seat's tab.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { rowControls, seatName, MIRROR_LINE, MANAGE_SEAT_STORAGE_KEY } from '../app/connector-manage.mjs';

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
    '/api/admin/skills',
    '/api/admin/plugins',
  ]) assert.ok(manage.includes(path), path);
});

test('wiring: the composer Manage row leaves the seat marker for this surface', () => {
  assert.equal(MANAGE_SEAT_STORAGE_KEY, 'helmian.manageSeat');
  assert.match(workspace, /sessionStorage\.setItem\('helmian\.manageSeat', ws\.libraryPanel\.seatId\)/);
  assert.match(manage, /sessionStorage\.getItem\(MANAGE_SEAT_STORAGE_KEY\)/);
});

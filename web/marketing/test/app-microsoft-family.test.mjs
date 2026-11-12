import assert from 'node:assert/strict';
import test from 'node:test';
import { level2Model, stateLabelFor } from '../app/connector-panel.mjs';

// The Microsoft family on the panel (Troy's ruling, 2026-11-10):
// OneDrive, Outlook, Microsoft Teams and SharePoint keep their
// separate rows, and underneath they are ONE Microsoft
// connection. The library read projects the family's connection
// onto every member row and marks the siblings with a
// sharedConnection detail (the family, and the member the
// connection was recorded under). The panel's law here: the row
// model carries that marking through untouched, and the state
// label SAYS the connection is shared — four rows must never
// each read as their own connection.

const readRow = (over = {}) => ({
  seatId: 'claude', entryId: 'helmian-outlook', name: 'Outlook',
  oneLiner: 'Read and search your Outlook mail and calendar', vendorLabel: 'Connector by Microsoft',
  trustLabel: 'verified', iconRef: 'icon:outlook', kind: 'catalog',
  brokerMode: 'helmian', authMode: 'oauth', state: 'connected',
  accountIdentity: 'Microsoft account',
  stateDetail: { posture: 'ask', lastUsedAt: null, sharedConnection: { family: 'microsoft', recordedUnderEntryId: 'helmian-onedrive' } },
  starterActions: [], ...over,
});

test('panel: a sibling row carries the shared marking and its label says the connection is shared', () => {
  const level2 = level2Model({ seatId: 'claude', rows: [readRow()] }, {}, 'channel:c1');
  assert.equal(level2.connected.length, 1);
  const row = level2.connected[0];
  assert.deepEqual(row.sharedConnection, { family: 'microsoft', recordedUnderEntryId: 'helmian-onedrive' });
  assert.equal(row.stateLabel, 'Connected as Microsoft account — the shared Microsoft connection');
  assert.equal(row.toggleable, true, 'a connected family row arms like any connected row — the set resolves the one connection');
});

test('panel: the recorded-under member reads plain connected; an unshared row is untouched', () => {
  const own = level2Model({ seatId: 'claude', rows: [readRow({ entryId: 'helmian-onedrive', name: 'OneDrive', stateDetail: { posture: 'ask', lastUsedAt: null } })] }, {}, 'channel:c1');
  assert.equal(own.connected[0].sharedConnection, null);
  assert.equal(own.connected[0].stateLabel, 'Connected as Microsoft account');

  const plain = level2Model({ seatId: 'claude', rows: [readRow({ entryId: 'helmian-gmail', name: 'Gmail', stateDetail: { posture: 'ask', lastUsedAt: null } })] }, {}, 'channel:c1');
  assert.equal(plain.connected[0].sharedConnection, null);
  assert.equal(plain.connected[0].stateLabel, 'Connected as Microsoft account');
});

test('panel: stateLabelFor words the shared truth for needs-reconnect too, and never for not-connected', () => {
  assert.equal(
    stateLabelFor({ state: 'needs-reconnect', stateDetail: { sharedConnection: { family: 'microsoft', recordedUnderEntryId: 'helmian-onedrive' } } }),
    'Needs reconnect — the shared Microsoft connection',
  );
  assert.equal(
    stateLabelFor({ state: 'not-connected', stateDetail: { sharedConnection: { family: 'microsoft', recordedUnderEntryId: 'helmian-onedrive' } } }),
    'Not connected',
    'a not-connected row claims no connection, shared or otherwise',
  );
});

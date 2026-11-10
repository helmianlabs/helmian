import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  CUSTOM_REMOVE_PATH,
  NOT_CUSTOM_MESSAGE,
  NOT_FOUND_MESSAGE,
  OWNER_REFUSAL_MESSAGE,
  applyCustomRemove,
  customRemoveModel,
  isCustomEntryRow,
  removeCustomBody,
  submitCustomRemove,
} from '../app/connector-custom-remove.mjs';

// Panel-native home bite 4 (2026-11-10): a custom entry's removal
// control in the channel connector panel — the row gains a Remove
// control, the confirmation states in plain words that this
// deletes the entry itself (not a disconnect) and that a
// connection under it is deleted with it, the submit posts the
// removal road's exact payload, and the entry's absence afterwards
// comes from the panel's library re-read, never a local deletion.
// The model's contracts are the real server ones:
//   POST /api/admin/connector-library/entries/remove
//        { seatId, entryId }
//        → 200 { status:'removed', entry } (owner/admin)
//        refusals: a non-owner/admin caller 403 with the
//        workspace-level words; an unknown entry 404 with the
//        not-found words; a non-custom entry 400 with the
//        only-custom words. The store removes the entry and
//        everything under it — connections, mirrors, and their
//        snapshots cascade (sql/074) — and runs no credential
//        revoke: that is the disconnect road's shape, not this
//        one's, and no copy here claims it.

const OWNER_REFUSAL = 'this is a workspace-level change — it takes the workspace owner or an admin';
const NOT_CUSTOM_REFUSAL = 'only custom entries are removed from here — catalog and Helmian entries are turned off with entry-state instead';
const NOT_FOUND_REFUSAL = 'connector entry not found in this seat\u2019s library';

const customRow = (over = {}) => ({
  seatId: 'grok', entryId: 'custom-weather-tools', name: 'Weather Tools',
  kind: 'custom', brokerMode: 'helmian', mirror: null, ...over,
});
const freshModel = () => customRemoveModel(customRow());
const removedEntry = (over = {}) => ({
  seatId: 'grok', id: 'custom-weather-tools', kind: 'custom', name: 'Weather Tools',
  oneLiner: 'Weather lookups', vendorName: 'Custom', trustLabel: 'custom', category: null,
  brokerMode: 'helmian', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header',
  state: 'available', ...over,
});

test('eligibility: only a custom entry\u2019s row carries the removal control — catalog, native, local and mirror rows never do', () => {
  assert.equal(isCustomEntryRow(customRow()), true, 'a Helmian-brokered custom row is the one removable row');
  assert.equal(isCustomEntryRow(customRow({ kind: 'catalog' })), false, 'catalog entries are turned off with entry-state, never removed from here');
  assert.equal(isCustomEntryRow(customRow({ kind: 'helmian-native' })), false, 'Helmian entries are turned off with entry-state, never removed from here');
  assert.equal(isCustomEntryRow(customRow({ kind: 'mcp-local' })), false, 'a local install is not a custom entry and the road refuses it');
  assert.equal(isCustomEntryRow(customRow({ brokerMode: 'vendor', mirror: { managedIn: 'Grok', manageUrl: null } })), false,
    'a mirror row never carries the control — its state lives in the vendor\u2019s own product');
  assert.equal(isCustomEntryRow(customRow({ mirror: { managedIn: 'Grok', manageUrl: null } })), false,
    'any row carrying a mirror note is refused, whatever its kind field says');
  assert.equal(isCustomEntryRow(null), false);
  assert.equal(isCustomEntryRow({}), false);

  assert.ok(freshModel(), 'the custom row builds its model');
  for (const over of [{ kind: 'catalog' }, { kind: 'helmian-native' }, { kind: 'mcp-local' }, { brokerMode: 'vendor' }, { mirror: { managedIn: 'Grok', manageUrl: null } }]) {
    assert.equal(customRemoveModel(customRow(over)), null, `no model, so no control, for ${JSON.stringify(over)}`);
  }
  assert.equal(customRemoveModel({}), null, 'no seat, entry or name, no control — nothing invented');
  assert.equal(customRemoveModel(), null);
});

test('the confirmation copy says what removal is, in plain words — the road\u2019s own truth and no more', () => {
  const model = freshModel();
  assert.equal(model.button.label, 'Remove');
  assert.equal(model.keepLabel, 'Keep it');
  assert.equal(model.confirmLabel, 'Remove for good');
  assert.match(model.confirmLine, /^Remove Weather Tools for good\?/, 'the confirmation names the entry it removes');
  assert.match(model.confirmLine, /deletes the custom connector itself/, 'removal deletes the entry itself');
  assert.match(model.confirmLine, /it is not a disconnect/, 'removal is not disconnect — disconnect leaves the entry standing');
  assert.match(model.confirmLine, /If anyone is connected to it, their connection is deleted with it/,
    'the store removes the entry and everything under it — a live connection goes with it, and the copy says so');
  assert.match(model.confirmLine, /added again/, 'a removed entry returns only by being added again — remove-and-re-add is the road\u2019s own shape');
  assert.ok(!/revok/i.test(model.confirmLine),
    'the copy never claims a stored sign-in was revoked — this road runs no credential revoke; revoking is the disconnect road\u2019s shape');
  assert.ok(!/disconnect/i.test(model.button.label), 'the control itself is never labelled as a disconnect');
});

test('the road\u2019s refusal words are pinned against the server files', async () => {
  const route = await readFile(new URL('../../../src/cloud/connector-library-write-route.mjs', import.meta.url), 'utf8');
  const store = await readFile(new URL('../../../src/cloud/connector-library.mjs', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../../../sql/074_connector_library.sql', import.meta.url), 'utf8');
  assert.equal(OWNER_REFUSAL_MESSAGE, OWNER_REFUSAL);
  assert.ok(route.includes(OWNER_REFUSAL), 'the owner/admin words are the write route\u2019s ownerAct refusal');
  assert.ok(route.includes("if (action === 'entries/remove')"), 'the removal action stands in the write route');
  assert.ok(route.includes(NOT_CUSTOM_MESSAGE), 'the only-custom words are the removal action\u2019s own refusal');
  assert.ok(route.includes(NOT_FOUND_MESSAGE.replace('\u2019', '\\u2019')), 'the not-found words are the removal action\u2019s own refusal (the route file writes its apostrophe as an escape)');
  assert.ok(store.includes('Remove an entry and everything under it (connections, mirrors, and'), 'the store\u2019s own words name what removal takes with it');
  assert.ok(sql.includes('on delete cascade'), 'the connections and mirrors under an entry cascade on its delete (sql/074)');
  const removeAction = route.slice(route.indexOf("if (action === 'entries/remove')"), route.indexOf("sendJson(404, { error: 'unknown connector library write action' })"));
  assert.ok(removeAction.includes('ownerAct()'), 'the removal action is owner/admin gated');
  assert.ok(removeAction.includes("entry.kind !== 'custom'"), 'the removal action refuses any kind but custom');
  assert.ok(!/revoke/i.test(removeAction), 'the removal action runs no credential revoke — disconnect\u2019s revoke is not this road\u2019s');
});

test('wire shape: the remove body is exactly the server contract', () => {
  assert.deepEqual(
    removeCustomBody({ seatId: 'grok', entryId: 'custom-weather-tools' }),
    { seatId: 'grok', entryId: 'custom-weather-tools' },
    'the seat and the entry, nothing else',
  );
  const body = removeCustomBody({ seatId: 'grok', entryId: 'custom-weather-tools' });
  for (const key of ['tenantId', 'personId', 'subject', 'apiKey', 'token', 'secret', 'name', 'kind']) {
    assert.ok(!(key in body), `no ${key} rides the remove body — authority comes from the membership and credential values never ride this road`);
  }
  assert.equal(removeCustomBody({ seatId: 'grok' }), null, 'no entry, no body — refused here, never built');
  assert.equal(removeCustomBody({ entryId: 'custom-weather-tools' }), null, 'no seat, no body');
  assert.equal(removeCustomBody(), null);
});

test('round trip: the submit posts the exact payload and the removed entry is the road\u2019s returned record', async () => {
  const calls = [];
  // Stubbed road shaped exactly like the real one: the entry is
  // deleted from the store, and the answer carries the deleted
  // record.
  const post = async (path, body) => {
    calls.push([path, body]);
    return { status: 'removed', entry: removedEntry() };
  };
  const out = await submitCustomRemove({ post, model: freshModel() });
  assert.equal(out.ok, true);
  assert.equal(out.error, '');
  assert.deepEqual(calls, [[CUSTOM_REMOVE_PATH, { seatId: 'grok', entryId: 'custom-weather-tools' }]],
    'the submit posts exactly { seatId, entryId } to the removal road');
  assert.equal(CUSTOM_REMOVE_PATH, '/api/admin/connector-library/entries/remove');
  assert.equal(out.removed.entryId, 'custom-weather-tools', 'the removed entry id is the road\u2019s returned record\u2019s');
  assert.equal(out.removed.name, 'Weather Tools');
  assert.equal(out.removed.kind, 'custom');
});

test('absence comes from the re-read, not a local deletion: the submit returns no list and mutates nothing', async () => {
  // A panel-shaped local list, as the workspace holds it before
  // the remove. The module is handed no list and returns none:
  // the ONLY road from a successful remove to the entry's
  // absence is the caller re-reading the library.
  const localRows = [customRow(), customRow({ entryId: 'custom-notes', name: 'Notes' })];
  const before = JSON.stringify(localRows);
  const post = async () => ({ status: 'removed', entry: removedEntry() });
  const out = await submitCustomRemove({ post, model: freshModel() });
  assert.equal(out.ok, true);
  assert.ok(!('rows' in out) && !('list' in out) && !('library' in out), 'the result carries no list a caller could paint from');
  assert.equal(JSON.stringify(localRows), before, 'the caller\u2019s local rows are untouched — nothing was deleted locally');
  // The re-read is what removes it: a read that no longer returns
  // the entry (the stubbed store after its delete) is the list
  // the panel paints, and the entry is absent from THAT.
  const storeRows = [customRow({ entryId: 'custom-notes', name: 'Notes' })];
  assert.ok(!storeRows.some((r) => r.entryId === 'custom-weather-tools'), 'the entry is gone because the re-read no longer returns it');
  assert.ok(localRows.some((r) => r.entryId === 'custom-weather-tools'), 'until that re-read, the local list still held it — proof the absence is the re-read\u2019s, not the submit\u2019s');
});

test('refusals: the server\u2019s plain words surface and the entry stays', async () => {
  const throwing = (status, message) => async () => {
    throw Object.assign(new Error(String(status)), { status, body: { valid: false, error: message } });
  };
  const owner = await submitCustomRemove({ post: throwing(403, OWNER_REFUSAL), model: freshModel() });
  assert.equal(owner.ok, false);
  assert.equal(owner.sent, true);
  assert.equal(owner.error, OWNER_REFUSAL, 'a member who is not owner/admin reads the road\u2019s workspace-level words word for word');
  assert.equal(owner.removed, null, 'a refused remove removes nothing here — the entry stays');

  const notCustom = await submitCustomRemove({ post: throwing(400, NOT_CUSTOM_REFUSAL), model: freshModel() });
  assert.equal(notCustom.ok, false);
  assert.equal(notCustom.error, NOT_CUSTOM_REFUSAL, 'the only-custom refusal reaches the person word for word');
  assert.equal(notCustom.removed, null);

  const notFound = await submitCustomRemove({ post: throwing(404, NOT_FOUND_REFUSAL), model: freshModel() });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, NOT_FOUND_REFUSAL);
  assert.equal(notFound.removed, null);

  const odd = await submitCustomRemove({ post: async () => ({ status: 'ok' }), model: freshModel() });
  assert.equal(odd.ok, false, 'an answer that is not the removed answer removes nothing here, however it is worded');
  assert.equal(odd.removed, null);
  assert.equal(applyCustomRemove({ status: 'removed' }), null, 'a removed answer with no entry record folds to nothing');
  assert.equal(applyCustomRemove({ status: 'removed', entry: removedEntry() }).entryId, 'custom-weather-tools');

  const noModel = await submitCustomRemove({ post: async () => { throw new Error('must not be called'); }, model: null });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.sent, false, 'no model, nothing sent');
});

test('panel wiring: the custom row carries the control in the panel, the panel re-reads after a remove, and a refusal stays on the row', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  for (const needle of [
    "from './connector-custom-remove.mjs",
    'customRemoveModel(',
    'submitCustomRemove({',
    'ws.customRemove',
    'function customRemoveNode',
    'function removeCustomEntry',
    'Remove for good',
    'Keep it',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  // The control is built off the row model the panel renders, and
  // only through the model's eligibility: the node is composed
  // inside libraryRowNode, gated on the model being non-null.
  const rowNode = js.slice(js.indexOf('function libraryRowNode'), js.indexOf('// The panel\u2019s Connect button'));
  assert.ok(rowNode.includes('customRemoveModel({'), 'the row node builds the removal model from the row itself');
  assert.ok(rowNode.includes('customRemoveNode(which, row'), 'a custom row\u2019s node carries the removal control under its row');
  assert.ok(rowNode.includes('row.kind') && rowNode.includes('row.brokerMode') && rowNode.includes('row.mirror'),
    'eligibility reads the row\u2019s kind, broker mode and mirror — the three facts the road rules on');
  const removeFn = js.slice(js.indexOf('async function removeCustomEntry'), js.indexOf('function customRemoveNode'));
  assert.ok(removeFn.includes('loadSeatLibrary('), 'after a successful remove the panel re-reads the seat\u2019s library — the entry\u2019s absence is the re-read\u2019s');
  assert.ok(removeFn.includes('cr.error = result.error'), 'a refusal stays on the row as the server\u2019s words, and the entry stays');
  assert.ok(!/\.filter\(/.test(removeFn) && !/delete\s/.test(removeFn),
    'the remove flow deletes nothing locally — no filter, no delete of a cached row');
  const node = js.slice(js.indexOf('function customRemoveNode'), js.indexOf('// ---------- composer "/" menu'));
  assert.ok(node.includes('model.confirmLine'), 'the confirmation renders the model\u2019s plain-words line');
  assert.ok(node.includes('model.confirmLabel') && node.includes('model.keepLabel'), 'the confirmation offers Remove for good and Keep it');
});

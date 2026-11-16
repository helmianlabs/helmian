import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardPaneApprovalsModel, approvalPopupModel } from '../app/app-model.mjs';

// Bite P13: the workspace Guard pane's approvals shelf. Before this bite the
// shelf listed only the Envoy approvals, as bare links that left the
// workspace for the full Approvals view, and the PC (hands) approvals the
// Executive Guard holds never appeared there at all. Troy's order
// (2026-11-15): decision cards carry Approve and Disapprove buttons on the
// card, and deciding happens in an in-place pop-up. These tests pin the two
// pure models the shelf and the pop-up render from, plus the wiring shape
// in app.js and the card styles in envoy.css.

const coraItem = (over = {}) => ({ requestReceiptId: 'r1', requestKind: 'tool.write_file', summary: 'Write a file', createdAt: '2026-11-15T10:00:00Z', canDecide: true, decision: null, ...over });
const pcItem = (over = {}) => ({ approvalId: 'a1', status: 'pending', summary: 'hands write_file', tool: 'write_file', site: null, deviceId: 'hands-mcp', reason: 'destructive-needs-approval', createdAt: '2026-11-15T11:00:00Z', expiresAt: '2026-11-15T23:00:00Z', ...over });

test('the pane model merges both streams, newest first, and counts every waiting item', () => {
  const m = guardPaneApprovalsModel({ cora: [coraItem()], pc: [pcItem()] });
  assert.equal(m.total, 2);
  assert.equal(m.cards.length, 2);
  assert.equal(m.cards[0].kind, 'pc');
  assert.equal(m.cards[1].kind, 'cora');
});

test('decided cora items and non-pending pc items never reach the shelf', () => {
  const m = guardPaneApprovalsModel({ cora: [coraItem({ decision: 'approve' })], pc: [pcItem({ status: 'approved' }), pcItem({ approvalId: 'a2' })] });
  assert.equal(m.total, 1);
  assert.equal(m.cards[0].key, 'pc:a2');
});

test('the shelf caps at four cards while the total still counts the rest', () => {
  const pc = [1, 2, 3, 4, 5, 6].map((n) => pcItem({ approvalId: `a${n}`, createdAt: `2026-11-15T1${n}:00:00Z` }));
  const m = guardPaneApprovalsModel({ pc });
  assert.equal(m.cards.length, 4);
  assert.equal(m.total, 6);
});

test('pc cards always carry their buttons; cora cards carry them only when the item can be decided', () => {
  const m = guardPaneApprovalsModel({ cora: [coraItem({ canDecide: false })], pc: [pcItem()] });
  assert.equal(m.cards.find((c) => c.kind === 'pc').canDecide, true);
  assert.equal(m.cards.find((c) => c.kind === 'cora').canDecide, false);
});

test('empty streams give an empty shelf, so the nothing-waiting line is honest', () => {
  assert.deepEqual(guardPaneApprovalsModel({}), { cards: [], total: 0 });
  assert.deepEqual(guardPaneApprovalsModel({ cora: [], pc: [] }), { cards: [], total: 0 });
});

test('the pop-up model for a pc approval carries the server risk wording and who asked', () => {
  const m = approvalPopupModel({ kind: 'pc', item: pcItem() });
  assert.equal(m.what, 'hands write_file');
  assert.equal(m.who, 'write_file · asked by hands-mcp');
  assert.equal(m.risk, 'destructive-needs-approval');
  assert.equal(m.expiresAt, '2026-11-15T23:00:00Z');
});

test('the pop-up model for a cora approval names the request and the recorded-with-your-name words', () => {
  const m = approvalPopupModel({ kind: 'cora', item: coraItem() });
  assert.equal(m.what, 'Write a file');
  assert.equal(m.who, 'Write file');
  assert.match(m.risk, /recorded with your name/);
  assert.equal(m.expiresAt, null);
});

test('app.js wires the shelf cards and the pop-up to the two decide routes, with no navigation away', async () => {
  const src = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  const shelf = src.slice(src.indexOf('function renderGuardApprovals'), src.indexOf('function openApprovalPopup'));
  assert.match(shelf, /guardPaneApprovalsModel/);
  assert.match(shelf, /'Approve'/);
  assert.match(shelf, /'Disapprove'/);
  assert.doesNotMatch(shelf, /href = '#approvals'/);
  assert.match(src, /function openApprovalPopup/);
  assert.match(src, /'Confirm approve'/);
  assert.match(src, /\/api\/admin\/guard\/pc-approvals\/decide/);
  assert.match(src, /post\('\/api\/admin\/cora\/approvals'/);
  const load = src.slice(src.indexOf('async function loadFeedData'), src.indexOf('async function decide('));
  assert.match(load, /guardQueueReadModel\(pcRes\.status/);
});

test('envoy.css styles the shelf approval cards beside the old link style', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew-approval-card \{/);
  assert.match(css, /\.ew-approval-btns \{/);
});

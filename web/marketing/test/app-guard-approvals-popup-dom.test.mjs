import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardPaneApprovalsModel, approvalPopupModel, formatTime } from '../app/app-model.mjs';

// Bite P13, the driven half: the real shelf renderer and pop-up functions
// extracted from app.js (the app-agent-sessions-dialog pattern), run
// against a minimal DOM. Proves the whole desk path: a pending PC approval
// renders as a card with Approve and Disapprove buttons on it, Approve
// opens the in-place pop-up carrying the server's risk wording, Confirm
// approve posts to the Executive Guard decide route and the pop-up closes;
// a Cora approval's Disapprove decides through the existing decide() on
// its one tap inside the pop-up.

const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.className = ''; this.text = ''; this.style = {}; this.dataset = {}; this.attributes = {}; this.parent = null; this.disabled = false; this.hidden = false; this.type = ''; }
  set textContent(v) { this.text = String(v ?? ''); this.children = []; }
  get textContent() { return this.text; }
  append(...kids) { for (const k of kids) { if (k instanceof El) { k.parent = this; this.children.push(k); } else if (k != null) this.children.push(String(k)); } }
  replaceChildren(...kids) { for (const c of this.children) if (c instanceof El) c.parent = null; this.children = []; this.append(...kids); }
  setAttribute(k, v) { this.attributes[k] = v; }
  remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  focus() { this.focused = true; }
}
function textOf(node) { if (typeof node === 'string') return node; return (node.text || '') + node.children.map(textOf).join(' '); }
function findBtn(node, label) { if (node instanceof El) { if (node.tagName === 'BUTTON' && textOf(node).trim() === label) return node; for (const c of node.children) { const hit = findBtn(c, label); if (hit) return hit; } } return null; }

function buildWorld() {
  const registry = { 'ew-approvals-list': new El('div'), 'ew-approvals-count': new El('span'), 'ew-guard-count': new El('b') };
  const document = { createElement: (t) => new El(t), body: new El('body'), getElementById: (id) => registry[id] ?? null };
  const state = { approvals: [], findings: [] };
  const calls = { fetch: [], decide: [], toast: [] };
  const fetchStub = async (url, init) => { calls.fetch.push({ url, init }); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
  const code = [
    extractFn(js, 'el'),
    extractFn(js, 'renderGuardApprovals'),
    extractFn(js, 'openApprovalPopup'),
    extractFn(js, 'popupDecision'),
    extractFn(js, 'pcDecide'),
    'return { renderGuardApprovals, openApprovalPopup };',
  ].join('\n');
  const factory = new Function('document', 'state', 'guardPcApprovals', 'guardPaneApprovalsModel', 'approvalPopupModel', 'formatTime', 'toast', 'decide', 'loadFeedData', 'loadPcApprovals', 'fetch', code);
  return { registry, document, state, calls, factory, fetchStub };
}

const pcItem = { approvalId: 'a1', status: 'pending', summary: 'hands write_file', tool: 'write_file', site: null, deviceId: 'hands-mcp', reason: 'destructive-needs-approval', createdAt: '2026-11-15T11:00:00Z', expiresAt: '2026-11-15T23:00:00Z' };
const coraItem = { requestReceiptId: 'r1', requestKind: 'tool.write_file', summary: 'Write a file', createdAt: '2026-11-15T10:00:00Z', canDecide: true, decision: null };

test('a pending pc approval renders as a card with both buttons, and Confirm approve posts the decision', async () => {
  const w = buildWorld();
  const api = w.factory(w.document, w.state, [pcItem], guardPaneApprovalsModel, approvalPopupModel, formatTime,
    (m, k) => w.calls.toast.push([m, k]), async () => {}, async () => {}, () => {}, w.fetchStub);
  api.renderGuardApprovals();
  const list = w.registry['ew-approvals-list'];
  assert.equal(list.children.length, 1);
  const card = list.children[0];
  assert.match(textOf(card), /hands write_file/);
  assert.ok(findBtn(card, 'Approve'), 'card carries an Approve button');
  assert.ok(findBtn(card, 'Disapprove'), 'card carries a Disapprove button');
  findBtn(card, 'Approve').onclick();
  const overlay = w.document.body.children[0];
  assert.ok(overlay, 'the pop-up opened in place');
  assert.match(textOf(overlay), /Decide this PC action/);
  assert.match(textOf(overlay), /destructive-needs-approval/);
  assert.match(textOf(overlay), /asked by hands-mcp/);
  await findBtn(overlay, 'Confirm approve').onclick();
  assert.equal(w.calls.fetch.length, 1);
  assert.equal(w.calls.fetch[0].url, '/api/admin/guard/pc-approvals/decide');
  assert.deepEqual(JSON.parse(w.calls.fetch[0].init.body), { approvalId: 'a1', approve: true });
  assert.equal(w.document.body.children.length, 0, 'the pop-up closed after deciding');
});

test('a cora approval disapproves through decide() on the one tap inside the pop-up', async () => {
  const w = buildWorld();
  w.state.approvals = [coraItem];
  const decideStub = async (item, d) => { w.calls.decide.push([item.requestReceiptId, d]); };
  const api = w.factory(w.document, w.state, [], guardPaneApprovalsModel, approvalPopupModel, formatTime,
    () => {}, decideStub, async () => {}, () => {}, w.fetchStub);
  api.renderGuardApprovals();
  const card = w.registry['ew-approvals-list'].children[0];
  findBtn(card, 'Disapprove').onclick();
  const overlay = w.document.body.children[0];
  assert.match(textOf(overlay), /recorded with your name/);
  await findBtn(overlay, 'Disapprove').onclick();
  assert.deepEqual(w.calls.decide, [['r1', 'reject']]);
  assert.equal(w.document.body.children.length, 0);
});

test('an empty queue renders the nothing-waiting line and no cards', () => {
  const w = buildWorld();
  const api = w.factory(w.document, w.state, [], guardPaneApprovalsModel, approvalPopupModel, formatTime,
    () => {}, async () => {}, async () => {}, () => {}, w.fetchStub);
  api.renderGuardApprovals();
  const list = w.registry['ew-approvals-list'];
  assert.equal(list.children.length, 1);
  assert.match(textOf(list), /Nothing waiting for a decision\./);
});

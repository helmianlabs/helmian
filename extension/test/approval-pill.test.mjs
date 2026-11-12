// The "send this as written?" approval box + corner pill (content/ui.js).
// It stays open until the person answers: explicit Allow only; Cancel / Escape
// deny; no auto-dismiss, no outside-click close, no redraw for the same
// question; big, high-contrast, next to the pill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContentScripts } from '../test-support/load-content-script.mjs';
import { createDocument } from '../test-support/mini-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ui() {
  const doc = createDocument([]);
  const sb = await loadContentScripts(['content/ui.js'], { document: doc });
  return { doc, UI: sb.HelmionUI };
}
const btn = (doc, id) => doc.querySelector(`[data-helmion-action="${id}"]`);
const pills = (doc) => doc.querySelectorAll('.helmion-guard-approval-pill');
const key = (doc, k, extra = {}) => doc.dispatch('keydown', { key: k, isTrusted: true, ...extra });

test('opens expanded: the approval box is shown above the pill straight away; the pill only hides/shows it', async () => {
  const { doc, UI } = await ui();
  UI.showApprovalPill({ title: 'Guard: send?', message: 'It contains an email address.', onAllow() {}, onDeny() {} });
  const pill = pills(doc)[0];
  assert.ok(pill);
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  const details = doc.querySelector('.helmion-guard-approval-pill-details');
  assert.equal(details.hidden, false);
  assert.equal(pill.childNodes[0], details, 'the box comes first, so it sits above the pill');
  assert.equal(pill.childNodes[1], btn(doc, 'expand'));
  btn(doc, 'expand').dispatch('click', {});
  assert.equal(details.hidden, true);
  assert.equal(pills(doc).length, 1, 'hiding the box is not an answer');
  btn(doc, 'expand').dispatch('click', {});
  assert.equal(details.hidden, false);
  UI.hideApprovalPill();
});

test('only an explicit Allow allows; Cancel cancels; both close it; answered once', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  btn(doc, 'allow').dispatch('click', {});
  btn(doc, 'allow')?.dispatch('click', {});
  assert.deepEqual(seen, ['allow']);
  assert.equal(pills(doc).length, 0);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  assert.equal(btn(doc, 'deny').textContent, 'Cancel');
  btn(doc, 'deny').dispatch('click', {});
  assert.deepEqual(seen, ['allow', 'cancelled']);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  btn(doc, 'allow').dispatch('click', { isTrusted: false });
  assert.deepEqual(seen, ['allow', 'cancelled'], 'a synthetic (page-script) click does not allow');
  UI.hideApprovalPill();
});

test('STAYS OPEN: no auto-dismiss by default, still open after several seconds', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  const pill = UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  await wait(3500);
  assert.equal(pills(doc).length, 1);
  assert.equal(pills(doc)[0], pill);
  assert.equal(doc.querySelector('.helmion-guard-approval-pill-details').hidden, false);
  assert.deepEqual(seen, [], 'it answered by itself');
  assert.equal(UI.isApprovalPillOpen(), true);
  btn(doc, 'deny').dispatch('click', {});
  assert.deepEqual(seen, ['cancelled']);
  assert.equal(UI.isApprovalPillOpen(), false);
});

test('STAYS OPEN: the same question asked again (re-check) keeps the very same open box', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  const first = UI.showApprovalPill({ key: 'fp1', onAllow: () => seen.push('allow'), onDeny: (w) => seen.push('a:' + w) });
  for (let i = 0; i < 5; i += 1) {
    const again = UI.showApprovalPill({ key: 'fp1', onAllow: () => seen.push('allow2'), onDeny: (w) => seen.push('b:' + w) });
    assert.equal(again, first);
  }
  assert.equal(pills(doc).length, 1);
  assert.deepEqual(seen, []);
  btn(doc, 'allow').dispatch('click', {});
  assert.deepEqual(seen, ['allow'], 'the original Allow handler answered');
});

test('STAYS OPEN: clicks elsewhere on the page, blur and other keys do not close it', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  doc.dispatch('click', { target: doc.body });
  doc.dispatch('mousedown', { target: doc.body });
  doc.dispatch('blur', {});
  key(doc, 'a', { target: doc.body });
  key(doc, 'Enter', { target: doc.body }); // Enter in the chat box is not an answer
  assert.equal(pills(doc).length, 1);
  assert.deepEqual(seen, []);
  UI.hideApprovalPill();
});

test('KEYBOARD: Escape cancels; Enter inside the box allows; synthetic keys do nothing', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  key(doc, 'Escape', { isTrusted: false });
  assert.equal(pills(doc).length, 1);
  key(doc, 'Escape');
  assert.deepEqual(seen, ['cancelled']);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w) });
  key(doc, 'Enter', { target: btn(doc, 'deny') });
  assert.equal(pills(doc).length, 1, 'Enter on Cancel must not allow');
  key(doc, 'Enter', { target: btn(doc, 'allow'), isTrusted: false });
  assert.equal(pills(doc).length, 1);
  key(doc, 'Enter', { target: btn(doc, 'allow') });
  assert.deepEqual(seen, ['cancelled', 'allow']);
});

test('an explicit timeout still means deny, never allow; a different question replaces the old one as a deny', async () => {
  const { UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w), timeoutMs: 30 });
  await wait(80);
  assert.deepEqual(seen, ['timeout']);
  UI.showApprovalPill({ key: 'a', onAllow: () => seen.push('allow'), onDeny: (w) => seen.push('a:' + w) });
  UI.showApprovalPill({ key: 'b', onAllow: () => seen.push('allow'), onDeny: (w) => seen.push('b:' + w) });
  assert.deepEqual(seen, ['timeout', 'a:replaced']);
  UI.hideApprovalPill();
  assert.ok(!seen.includes('allow'));
});

test('WHAT WAS FOUND: the box lists type (count) lines and never a value', async () => {
  const { doc, UI } = await ui();
  UI.showApprovalPill({ items: ['Email address (2)', 'Password or secret (1)'], itemsTitle: 'Found in this message:', onAllow() {}, onDeny() {} });
  const items = doc.querySelectorAll('.helmion-guard-approval-pill-item').map((li) => li.textContent);
  assert.deepEqual(items, ['Email address (2)', 'Password or secret (1)']);
  assert.match(doc.querySelector('.helmion-guard-approval-pill-items-title').textContent, /Found in this message/);
  UI.hideApprovalPill();
});

test('BIG AND CSS-PROOF: 18px+ text, 48px+ buttons, bottom-right next to the pill, all !important', async () => {
  const css = await readFile(path.join(ROOT, 'content', 'guard.css'), 'utf8');
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
      || new RegExp(`${sel.replace(/[.]/g, '\\.')}[^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `no rule for ${sel}`);
    return m[1];
  };
  const box = rule('.helmion-guard-approval-pill');
  assert.match(box, /position:\s*fixed !important/);
  assert.match(box, /right:\s*16px !important/);
  assert.match(box, /bottom:\s*16px !important/);
  assert.match(box, /all:\s*initial !important/);
  assert.match(rule('.helmion-guard-approval-pill-details'), /font:\s*18px/);
  assert.match(rule('.helmion-guard-approval-pill-question'), /font-size:\s*22px/);
  const buttons = rule('.helmion-guard-approval-pill-allow,');
  const px = (prop) => Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(buttons)[1]);
  assert.ok(px('min-height') >= 48 && px('min-width') >= 48, 'buttons smaller than 48px');
  assert.match(buttons, /font:\s*700 20px/);
  for (const decl of buttons.split(';').map((d) => d.trim()).filter(Boolean)) assert.match(decl, /!important$/, decl);
});

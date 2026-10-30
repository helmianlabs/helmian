// 0.6.0 compact allow/deny corner pill (content/ui.js): explicit Allow only; Deny and timeout deny.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScripts } from '../test-support/load-content-script.mjs';
import { createDocument } from '../test-support/mini-dom.mjs';

async function ui() {
  const doc = createDocument([]);
  const sb = await loadContentScripts(['content/ui.js'], { document: doc });
  return { doc, UI: sb.HelmionUI };
}
const btn = (doc, id) => doc.querySelector(`[data-helmion-action="${id}"]`);

test('pill is compact (collapsed), in the corner, and expands for details', async () => {
  const { doc, UI } = await ui();
  UI.showApprovalPill({ title: 'Guard: send?', message: 'It contains an email address.', onAllow() {}, onDeny() {}, timeoutMs: 5000 });
  const pill = doc.querySelector('.helmion-guard-approval-pill');
  assert.ok(pill); assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelector('.helmion-guard-approval-pill-details').hidden, true);
  btn(doc, 'expand').dispatch('click', {});
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.querySelector('.helmion-guard-approval-pill-details').hidden, false);
  UI.hideApprovalPill();
});

test('only an explicit Allow allows; Deny denies; both close the pill; answered once', async () => {
  const { doc, UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w), timeoutMs: 5000 });
  btn(doc, 'allow').dispatch('click', {});
  btn(doc, 'allow')?.dispatch('click', {});
  assert.deepEqual(seen, ['allow']);
  assert.equal(doc.querySelectorAll('.helmion-guard-approval-pill').length, 0);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w), timeoutMs: 5000 });
  btn(doc, 'deny').dispatch('click', {});
  assert.deepEqual(seen, ['allow', 'denied']);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w), timeoutMs: 5000 });
  btn(doc, 'allow').dispatch('click', { isTrusted: false });
  assert.deepEqual(seen, ['allow', 'denied'], 'a synthetic (page-script) click does not allow');
  UI.hideApprovalPill();
});

test('timeout = deny; never auto-allows; a replaced pill is denied', async () => {
  const { UI } = await ui();
  const seen = [];
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push(w), timeoutMs: 30 });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, ['timeout']);
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push('a:' + w), timeoutMs: 5000 });
  UI.showApprovalPill({ onAllow: () => seen.push('allow'), onDeny: (w) => seen.push('b:' + w), timeoutMs: 5000 });
  assert.deepEqual(seen, ['timeout', 'a:replaced']);
  UI.hideApprovalPill();
  assert.ok(!seen.includes('allow'));
});

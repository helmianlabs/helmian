// The Scribe approvals pop-up (0.7.0): client, parser, poll, badge, decide —
// against a stub door that implements the door's real contract
// (test-support/stub-door.mjs, sourced from helmian-door
// app/src/approvals.mjs), plus the real worker wiring for the badge and the
// popup-privilege check. A real decide against the production door is NOT
// exercised here; it is main's fire-time leg and is labelled UNVERIFIED in
// this bite's report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { memoryStorage } from '../background/ledger.js';
import {
  APPROVALS_STATE_KEY,
  badgeTextFor,
  decideApproval,
  fetchApprovalsView,
  getApprovalsState,
  parseApprovalsPage,
  pollApprovals,
  signInToApprovals,
} from '../background/approvals-client.js';
import { jarFetch, startStubDoor } from '../test-support/stub-door.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';

const PASS = 'correct horse battery staple';
const ITEMS = [
  { id: 'appr-1', summary: 'Delete "old-plan.txt" & upload the new one', deviceId: 'hands-mcp', createdAt: Date.now() - 5 * 60 * 1000, expiresAt: Date.now() + 10 * 60 * 1000 },
  { id: 'appr-2', summary: 'Send the weekly report to the team channel', deviceId: 'scribe-door', createdAt: Date.now() - 2 * 60 * 1000, expiresAt: Date.now() + 13 * 60 * 1000 },
];

async function signedIn(extra = {}) {
  const door = await startStubDoor({ passphrase: PASS, pending: structuredClone(ITEMS), ...extra });
  const storage = memoryStorage();
  const fetchImpl = jarFetch();
  const r = await signInToApprovals(storage, PASS, { fetchImpl, doorUrl: door.url });
  assert.equal(r.ok, true, `sign-in failed: ${r.error || ''}`);
  return { door, storage, fetchImpl };
}

test('parser: the door list page becomes items with unescaped text and per-row csrf', async () => {
  const { door, fetchImpl } = await signedIn();
  try {
    const res = await fetchImpl(`${door.url}/approvals`, {});
    const page = parseApprovalsPage(await res.text());
    assert.equal(page.state, 'list');
    assert.equal(page.approvals.length, 2);
    assert.equal(page.approvals[0].id, 'appr-1');
    assert.equal(page.approvals[0].summary, 'Delete "old-plan.txt" & upload the new one');
    assert.match(page.approvals[0].meta, /Device: hands-mcp/);
    assert.match(page.approvals[0].meta, /Asked:/);
    assert.ok(page.approvals[0].csrf.length > 10, 'csrf captured from the row form');
  } finally { await door.close(); }
});

test('parser: login, unavailable and empty pages classify by state', () => {
  const login = parseApprovalsPage('<form method="POST" action="/approvals/login"><input name="passphrase"></form>');
  assert.equal(login.state, 'signed-out');
  assert.equal(login.error, '');
  const wrong = parseApprovalsPage('<p class="error">Incorrect passphrase. Please try again.</p><form method="POST" action="/approvals/login"></form>');
  assert.equal(wrong.state, 'signed-out');
  assert.equal(wrong.error, 'Incorrect passphrase. Please try again.');
  const down = parseApprovalsPage('<p class="error">Approvals are unavailable right now. Please try again.</p><form method="POST" action="/approvals/login"></form>');
  assert.equal(down.state, 'unavailable');
  const empty = parseApprovalsPage('<p class="empty">Nothing is waiting for a decision.</p>');
  assert.equal(empty.state, 'list');
  assert.deepEqual(empty.approvals, []);
});

test('sign-in: a wrong passphrase fails with the door own words and stores nothing', async () => {
  const door = await startStubDoor({ passphrase: PASS, pending: structuredClone(ITEMS) });
  try {
    const storage = memoryStorage();
    const fetchImpl = jarFetch();
    const r = await signInToApprovals(storage, 'not the passphrase', { fetchImpl, doorUrl: door.url });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Incorrect passphrase. Please try again.');
    const s = await getApprovalsState(storage);
    assert.equal(s.session, 'out');
    const v = await fetchApprovalsView(storage, { fetchImpl });
    assert.equal(v.view.session, 'out', 'no session leaked from the failed sign-in');
  } finally { await door.close(); }
});

test('sign-in: the passphrase is never written to storage', async () => {
  const { door, storage } = await signedIn();
  try {
    const everything = JSON.stringify(storage._bag);
    assert.ok(!everything.includes(PASS), 'the passphrase reached storage');
    const s = await getApprovalsState(storage);
    assert.equal(s.session, 'in');
    assert.equal(s.count, 2);
  } finally { await door.close(); }
});

test('poll: signed out means silent — no request leaves the extension', async () => {
  const door = await startStubDoor({ passphrase: PASS, pending: structuredClone(ITEMS) });
  try {
    const storage = memoryStorage();
    const fetchImpl = jarFetch();
    const before = door.hits.length;
    const r = await pollApprovals(storage, { fetchImpl });
    assert.equal(r.skipped, 'signed-out');
    assert.equal(door.hits.length, before, 'a signed-out poll touched the network');
  } finally { await door.close(); }
});

test('poll: a new waiting approval moves the count', async () => {
  const { door, storage, fetchImpl } = await signedIn();
  try {
    door.pending.push({ id: 'appr-3', summary: 'Restart the sync worker', deviceId: 'hands-mcp', createdAt: Date.now(), expiresAt: Date.now() + 900000 });
    const r = await pollApprovals(storage, { fetchImpl, force: true });
    assert.equal(r.count, 3);
    assert.equal(r.view.items[2].summary, 'Restart the sync worker');
  } finally { await door.close(); }
});

test('decide: approve and deny reach the door, the item leaves, the door flash comes back', async () => {
  const { door, storage, fetchImpl } = await signedIn();
  try {
    const a = await decideApproval(storage, 'appr-1', 'approve', { fetchImpl });
    assert.equal(a.ok, true);
    assert.equal(a.flash, 'Approved. The action can now run.');
    assert.deepEqual(door.decisions, [{ id: 'appr-1', approve: true }]);
    assert.equal(a.view.count, 1);
    const d = await decideApproval(storage, 'appr-2', 'deny', { fetchImpl });
    assert.equal(d.ok, true);
    assert.equal(d.flash, 'Denied. The action will not run.');
    assert.deepEqual(door.decisions[1], { id: 'appr-2', approve: false });
    assert.equal(d.view.count, 0);
  } finally { await door.close(); }
});

test('decide: when the door cannot decide, the item stays and one plain line says so', async () => {
  const { door, storage, fetchImpl } = await signedIn();
  try {
    door.guardDown = true;
    const r = await decideApproval(storage, 'appr-1', 'approve', { fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(r.error.length > 0, 'a failure with no line is a silent no-op');
    const s = await getApprovalsState(storage);
    assert.ok(s.items.some((i) => i.id === 'appr-1'), 'the item vanished on a failed decide');
  } finally { await door.close(); }
});

test('unavailable: the Guard being down keeps the last list and the session', async () => {
  const { door, storage, fetchImpl } = await signedIn();
  try {
    door.guardDown = true;
    const r = await fetchApprovalsView(storage, { fetchImpl });
    assert.equal(r.view.state, 'unavailable');
    assert.equal(r.view.session, 'in');
    assert.equal(r.view.count, 2, 'the last known list was hidden by a hiccup');
    assert.match(r.view.lastError, /Approvals are unavailable/);
  } finally { await door.close(); }
});

test('expiry: the door 30-minute session dying flips state to signed-out and zeroes the count', async () => {
  const { door, storage, fetchImpl } = await signedIn();
  try {
    door.timeOffsetMs += 31 * 60 * 1000;
    const r = await pollApprovals(storage, { fetchImpl, force: true });
    assert.equal(r.session, 'out');
    assert.equal(r.count, 0);
    const s = await getApprovalsState(storage);
    assert.equal(s.session, 'out');
    assert.deepEqual(s.items, []);
  } finally { await door.close(); }
});

test('badge text: plain counts, capped, empty at zero', () => {
  assert.equal(badgeTextFor(0), '');
  assert.equal(badgeTextFor(1), '1');
  assert.equal(badgeTextFor(7), '7');
  assert.equal(badgeTextFor(140), '99+');
});

// ─── Worker wiring: the badge and the popup privilege ──────────────────────
await installWorker();
const POPUP = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
const CONTENT = { id: chrome.runtime.id, url: 'https://claude.ai/chat/1', tab: { id: 3, url: 'https://claude.ai/chat/1' } };
function send(message, sender) {
  return new Promise((resolve) => {
    const kept = fake.listeners.map((l) => l(message, sender, resolve)).some((r) => r === true);
    if (!kept) setTimeout(() => resolve(undefined), 0);
  });
}

test('worker: a poll paints the global badge with the waiting count and no tab scope', async () => {
  const { door, fetchImpl } = await (async () => {
    const d = await startStubDoor({ passphrase: PASS, pending: structuredClone(ITEMS) });
    const jar = jarFetch();
    // The browser-jar equivalent of a completed sign-in at the door.
    await jar(`${d.url}/approvals/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ passphrase: PASS }).toString(),
    });
    return { door: d, fetchImpl: jar };
  })();
  try {
    fake.resetStorage();
    fake.badgeCalls.length = 0;
    await chrome.storage.local.set({
      [APPROVALS_STATE_KEY]: { doorUrl: door.url, session: 'in', items: [], count: 0, nextAt: 0, badgeOwned: false },
    });
    const { runApprovalsPoll } = await import('../background/worker.js');
    const r = await runApprovalsPoll({ fetchImpl, force: true });
    assert.equal(r.count, 2);
    const texts = fake.badgeCalls.filter((c) => c.call === 'setBadgeText');
    assert.ok(texts.some((c) => c.text === '2' && !('tabId' in c)), `no global count badge in ${JSON.stringify(texts)}`);
    const colors = fake.badgeCalls.filter((c) => c.call === 'setBadgeBackgroundColor');
    assert.ok(colors.some((c) => c.color === '#c77700'), 'the approvals badge is not amber');
    const titles = fake.badgeCalls.filter((c) => c.call === 'setTitle');
    assert.ok(titles.some((c) => /approval\(s\) waiting/.test(c.title || '')), 'the title does not name the waiting approvals');
  } finally { await door.close(); }
});

test('worker: approvals messages are popup-only', async () => {
  const refused = await send({ type: 'helmion:approvals-view', options: {} }, CONTENT);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /only accepted from the extension popup/);
  const fromPopup = await send({ type: 'helmion:approvals-view', options: {} }, POPUP);
  assert.equal(fromPopup.ok, true);
  assert.ok(fromPopup.view, 'the popup got no view');
});

test('manifest: the name is Helmian, the door host is present, the version moved', async () => {
  const m = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.name, 'Helmian Guard');
  assert.equal(m.action.default_title, 'Helmian Guard');
  assert.equal(m.version, '0.7.0');
  assert.deepEqual(m.host_permissions, ['https://helmian.cloud/*', 'https://connect.helmian.cloud/*']);
  const f = JSON.parse(await readFile(new URL('../manifest.firefox.json', import.meta.url), 'utf8'));
  assert.equal(f.name, 'Helmian Guard');
  assert.equal(f.action.default_title, 'Helmian Guard');
});

test('non-invasive: the approvals change opens nothing, creates no tab, notifies nothing', async () => {
  const client = await readFile(new URL('../background/approvals-client.js', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../background/worker.js', import.meta.url), 'utf8');
  const popupSection = popup.slice(popup.indexOf('Scribe approvals pop-up'), popup.indexOf('Scribe door-knock'));
  const workerSection = worker.slice(worker.indexOf('SCRIBE APPROVALS POP-UP'), worker.indexOf('SCRIBE AUTO-NUDGE'));
  const banned = /windows\s*\.\s*create|tabs\s*\.\s*create|notifications\s*\.\s*create|chrome\s*\.\s*notifications/;
  assert.ok(!banned.test(client), 'the client opens or notifies');
  assert.ok(!banned.test(popupSection), 'the popup section opens or notifies');
  assert.ok(!banned.test(workerSection), 'the worker approvals block opens or notifies');
  assert.ok(!/openPopup/.test(workerSection), 'the worker approvals block pops the popup open itself');
});

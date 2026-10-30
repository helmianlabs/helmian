// Scribe door-knock against a mock of PR #3's GET /mailbox/unread, plus the real worker wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryStorage } from '../background/ledger.js';
import {
  badgeFor, clampPollSeconds, getScribeSettings, inboxView, isAllowedScribeUrl, mailboxName, noticeText, pollScribe,
  readScribeState, scribeOriginPattern, setScribeSettings, unreadUrl, ERROR_BACKOFF_S, NOT_INSTALLED_S,
} from '../background/scribe-client.js';
import { MOCK_SCRIBE_TOKEN, startMockScribe } from '../test-support/mock-scribe.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';

await installWorker();
const POPUP = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
const CONTENT = { id: chrome.runtime.id, url: 'https://claude.ai/chat/1', tab: { id: 3, url: 'https://claude.ai/chat/1' } };
const noJitter = () => 0.5;
function send(message, sender) {
  return new Promise((resolve) => {
    const kept = fake.listeners.map((l) => l(message, sender, resolve)).some((r) => r === true);
    if (!kept) setTimeout(() => resolve(undefined), 0);
  });
}
async function ready(api, extra = {}) {
  const s = memoryStorage();
  await setScribeSettings(s, { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN, mailboxes: 'muse', ...extra });
  return s;
}

test('off by default: no request without opt-in, URL, token and a mailbox', async () => {
  const s = memoryStorage();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('no'); };
  assert.equal((await getScribeSettings(s)).enabled, false);
  assert.equal((await pollScribe(s, { fetchImpl })).skipped, 'not-enabled');
  await setScribeSettings(s, { enabled: true, baseUrl: 'https://scribe.example.com', token: MOCK_SCRIBE_TOKEN });
  assert.equal((await pollScribe(s, { fetchImpl })).skipped, 'not-configured', 'no mailbox chosen');
  assert.equal(calls, 0);
});

test('settings: token stored, never returned; URL rules; mailbox aliases normalised like PR #3', async () => {
  const s = memoryStorage();
  const v = await setScribeSettings(s, { baseUrl: 'https://scribe.example.com/', token: MOCK_SCRIBE_TOKEN, mailboxes: 'grok-bot, Faith and Light News, muse, all, claude-ai' });
  assert.equal(v.hasToken, true);
  assert.doesNotMatch(JSON.stringify(v), /mock-mailbox-status-token/);
  assert.deepEqual(v.mailboxes, ['paul', 'muse', 'claude.ai']);
  await assert.rejects(setScribeSettings(s, { baseUrl: 'http://evil.example.com' }));
  await assert.rejects(setScribeSettings(s, { token: 'short' }));
  assert.equal(isAllowedScribeUrl('http://localhost:8787'), true);
  assert.equal(scribeOriginPattern('https://scribe.example.com:8443/'), 'https://scribe.example.com/*');
  assert.equal(mailboxName('claude'), 'claude', 'contract open question: plain claude stays its own mailbox');
  assert.equal(clampPollSeconds(5), 60); assert.equal(clampPollSeconds(600), 120);
  assert.equal(unreadUrl('https://s.example', 'claude.ai', 7.9, true), 'https://s.example/mailbox/unread?agent=claude.ai&since_id=7&include_legacy=1');
});

test('poll: exact request shape, cursor round-trip, notices only for new', async () => {
  const api = await startMockScribe();
  try {
    api.send({ to: 'muse', from: 'paul', subject: 'One' });
    api.send({ to: 'faith-and-light-news', from: 'grok-bot', subject: 'Two', priority: 'high' });
    const s = await ready(api, { notify: true });
    const now = 1_000_000;
    const r1 = await pollScribe(s, { now, rand: noJitter });
    assert.equal(r1.unread, 2);
    assert.deepEqual(r1.fresh.map((f) => [f.mailbox, f.items.map((i) => i.subject)]), [['muse', ['One', 'Two']]]);
    assert.deepEqual(api.requests[0].query, { agent: 'muse', since_id: '0' });
    assert.equal(api.requests[0].auth, `Bearer ${MOCK_SCRIBE_TOKEN}`);
    assert.equal((await pollScribe(s, { now: now + 10_000, rand: noJitter })).skipped, 'not-due', 'respects poll_after_seconds');
    const r2 = await pollScribe(s, { now: now + 61_000, rand: noJitter });
    assert.equal(api.requests[1].query.since_id, '2');
    assert.equal(r2.unread, 2); assert.equal(r2.fresh.length, 0, 'nothing above the cursor, no notice');
    api.markRead(1, 'muse');
    api.send({ to: 'muse', from: 'troy', subject: 'Three' });
    const r3 = await pollScribe(s, { now: now + 122_000, rand: noJitter });
    assert.equal(r3.unread, 2);
    assert.deepEqual(r3.fresh[0].items.map((i) => i.id), [3]);
    const view = await inboxView(s);
    assert.equal(view.mailboxes[0].recent[0].subject, 'Three');
    assert.doesNotMatch(JSON.stringify(view), /body/);
  } finally { await api.close(); }
});

test('jitter stays within ±15 s of poll_after_seconds', async () => {
  const api = await startMockScribe();
  try {
    for (const [rand, delta] of [[0, -15_000], [1, 15_000]]) {
      const s = await ready(api);
      await pollScribe(s, { now: 0, rand: () => rand });
      assert.equal((await readScribeState(s)).boxes.muse.nextAt, 60_000 + delta);
    }
  } finally { await api.close(); }
});

test('503 courier_not_installed: quiet "not set up yet", 15-minute backoff, no error state', async () => {
  const api = await startMockScribe({ installed: false });
  try {
    const s = await ready(api);
    const r = await pollScribe(s, { now: 0, rand: noJitter });
    assert.equal(r.serverState, 'not-installed');
    const st = await readScribeState(s);
    assert.equal(st.boxes.muse.state, 'not-installed');
    assert.equal(st.boxes.muse.nextAt, NOT_INSTALLED_S * 1000);
    assert.equal(st.boxes.muse.errors, 0, 'not counted as an error');
    for (let t = 60_000; t < NOT_INSTALLED_S * 1000; t += 60_000) await pollScribe(s, { now: t, rand: noJitter });
    assert.equal(api.requests.length, 1, 'no request spam while not installed');
    assert.equal((await inboxView(s)).serverState, 'not-installed');
    api.installed = true;
    api.send({ to: 'muse', from: 'paul', subject: 'Hi' });
    assert.equal((await pollScribe(s, { now: NOT_INSTALLED_S * 1000, rand: noJitter })).unread, 1, 'recovers once 006 runs');
  } finally { await api.close(); }
});

test('401 stops polling ("reconnect Scribe") until a new token is pasted', async () => {
  const api = await startMockScribe({ token: 'a-different-server-token-xyz' });
  try {
    const s = await ready(api);
    assert.equal((await pollScribe(s, { now: 0 })).skipped, 'token-rejected');
    assert.equal((await pollScribe(s, { now: 999_999, force: true })).skipped, 'token-rejected');
    assert.equal(api.requests.length, 1);
    assert.equal((await inboxView(s)).serverState, 'reconnect');
    await setScribeSettings(s, { token: MOCK_SCRIBE_TOKEN });
    assert.equal((await getScribeSettings(s)).tokenRejected, false);
  } finally { await api.close(); }
});

test('404 (feature off) backs off quietly; 400 parks that mailbox only', async () => {
  const api = await startMockScribe();
  try {
    api.token = '';
    const s = await ready(api);
    assert.equal((await pollScribe(s, { now: 0, rand: noJitter })).serverState, 'feature-off');
    assert.equal((await readScribeState(s)).boxes.muse.nextAt, 900_000);
    const fetchImpl = async () => ({ status: 400, json: async () => ({ error: 'bad_request' }), headers: { get: () => null } });
    const s2 = await ready(api);
    await pollScribe(s2, { now: 0, fetchImpl });
    assert.equal((await readScribeState(s2)).boxes.muse.state, 'bad-name');
    assert.equal((await pollScribe(s2, { now: 10 ** 9, fetchImpl })).skipped, 'not-due');
  } finally { await api.close(); }
});

test('500 / network: 60 s retries, then 5 minutes after 3 errors', async () => {
  const api = await startMockScribe();
  try {
    api.forceStatus = 500;
    const s = await ready(api);
    let t = 0;
    for (let i = 1; i <= 3; i += 1) {
      await pollScribe(s, { now: t, rand: noJitter });
      const b = (await readScribeState(s)).boxes.muse;
      assert.equal(b.errors, i);
      assert.equal(b.nextAt - t, (i >= 3 ? ERROR_BACKOFF_S : 60) * 1000);
      t = b.nextAt;
    }
    const s2 = memoryStorage();
    await setScribeSettings(s2, { enabled: true, baseUrl: 'http://127.0.0.1:1', token: MOCK_SCRIBE_TOKEN, mailboxes: 'troy' });
    await pollScribe(s2, { now: 0 });
    assert.equal((await readScribeState(s2)).boxes.troy.lastStatus, 'network');
  } finally { await api.close(); }
});

test('429 honours Retry-After', async () => {
  const api = await startMockScribe();
  try {
    api.forceStatus = 429; api.retryAfter = 120;
    const s = await ready(api);
    await pollScribe(s, { now: 0 });
    assert.equal((await readScribeState(s)).boxes.muse.nextAt, 120_000);
  } finally { await api.close(); }
});

test('offline and idle: skip without spending budget', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api);
    assert.equal((await pollScribe(s, { online: false })).skipped, 'offline');
    assert.equal((await pollScribe(s, { idle: true })).skipped, 'idle');
    assert.equal(api.requests.length, 0);
    assert.equal((await inboxView(s)).offline, true);
  } finally { await api.close(); }
});

test('daily request budget is shared across mailboxes', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api, { mailboxes: 'muse, troy, paul', dailyBudget: 2 });
    await pollScribe(s, { now: Date.parse('2026-10-29T12:00:00Z') });
    assert.equal(api.requests.length, 2);
    assert.equal((await pollScribe(s, { now: Date.parse('2026-10-29T13:00:00Z') })).skipped, 'budget-spent');
    await pollScribe(s, { now: Date.parse('2026-10-30T00:01:00Z') });
    assert.equal(api.requests.length, 4, 'resets at the UTC day');
  } finally { await api.close(); }
});

test('include_legacy is sent at most every 5 minutes', async () => {
  const api = await startMockScribe();
  try {
    api.legacy.push({ id: 49361, text: 'for-muse hello' });
    const s = await ready(api, { includeLegacy: true });
    for (let t = 0; t <= 300_000; t += 60_000) await pollScribe(s, { now: t, rand: noJitter });
    const flags = api.requests.map((r) => r.query.include_legacy === '1');
    assert.deepEqual(flags, [true, false, false, false, false, true]);
    assert.equal((await inboxView(s)).mailboxes[0].legacyCount, 1);
  } finally { await api.close(); }
});

test('badge and notice text', () => {
  assert.equal(badgeFor(0), ''); assert.equal(badgeFor(5), '5'); assert.equal(badgeFor(150), '99+');
  assert.deepEqual(noticeText('muse', [{ from: 'paul', subject: 'a' }, { from: 'troy', subject: 'b' }]).title, 'Muse: 2 new letters');
});

test('worker: popup-only messages, alarm lifecycle, global badge, notification, nudge', async () => {
  fake.resetStorage();
  assert.equal((await send({ type: 'helmion:scribe-settings', settings: { enabled: true } }, CONTENT)).ok, false);
  assert.equal((await send({ type: 'helmion:scribe-nudge', mailbox: 'chatgpt' }, CONTENT)).ok, false);
  const api = await startMockScribe();
  try {
    api.send({ to: 'claude.ai', from: 'paul', subject: 'Door-knock contract' });
    api.send({ to: 'claude-ai', from: 'troy', subject: 'Second' });
    fake.alarmCalls.length = 0;
    const saved = await send({ type: 'helmion:scribe-settings', settings: { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN, mailboxes: 'claude.ai', notify: true, showBadge: true } }, POPUP);
    assert.equal(saved.ok, true, saved.error);
    assert.doesNotMatch(JSON.stringify(saved), /mock-mailbox-status-token/);
    assert.deepEqual(fake.alarmCalls.at(-1), { call: 'create', name: 'helmion-scribe-poll', periodInMinutes: 1, delayInMinutes: 0.5 });
    fake.badgeCalls.length = 0; fake.notificationCalls.length = 0; fake.tabCalls.length = 0;
    fake.grant('notifications');
    for (const l of fake.alarmListeners) l({ name: 'helmion-scribe-poll' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(fake.badgeCalls.some((c) => c.call === 'setBadgeText' && c.text === '2' && c.tabId === undefined));
    assert.equal(fake.notificationCalls.length, 1);
    assert.equal(fake.notificationCalls[0].title, 'Claude.ai: 2 new letters');
    for (const l of fake.notificationClickListeners) l(fake.notificationCalls[0].id);
    assert.deepEqual(fake.tabCalls.at(-1), { url: 'https://claude.ai/' }, 'click nudges the AI so it runs check_inbox');
    const inbox = await send({ type: 'helmion:scribe-inbox', options: {} }, POPUP);
    assert.equal(inbox.unread, 2);
    assert.equal((await send({ type: 'helmion:scribe-nudge', mailbox: 'claude.ai' }, POPUP)).opened, true);
    assert.ok(api.requests.every((r) => r.method === 'GET'), 'Guard never writes to Scribe');
    const off = await send({ type: 'helmion:scribe-settings', settings: { enabled: false } }, POPUP);
    assert.equal(off.ok, true);
    assert.deepEqual(fake.alarmCalls.at(-1), { call: 'clear', name: 'helmion-scribe-poll' });
  } finally { fake.revokeAll(); await api.close(); }
});

test('without notifications permission, no notification is shown', async () => {
  fake.resetStorage();
  const api = await startMockScribe();
  try {
    api.send({ to: 'troy', from: 'paul', subject: 'x' });
    await send({ type: 'helmion:scribe-settings', settings: { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN, mailboxes: 'troy' } }, POPUP);
    fake.notificationCalls.length = 0;
    const r = await send({ type: 'helmion:scribe-inbox', options: { force: true } }, POPUP);
    assert.equal(r.unread, 1);
    assert.equal(fake.notificationCalls.length, 0);
  } finally { await api.close(); }
});

test('manifests: alarms + idle required, notifications optional, no new install-time hosts', () => {
  for (const f of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url)));
    assert.deepEqual(m.permissions, f === 'manifest.json' ? ['storage', 'alarms', 'idle'] : ['storage', 'alarms', 'idle', 'identity']);
    assert.ok(m.optional_permissions.includes('notifications'));
    assert.deepEqual(m.host_permissions || [], f === 'manifest.json' ? ['https://helmian.cloud/*'] : []);
  }
});

test('the token never reaches console output', async () => {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(' '));
  try {
    const s = memoryStorage();
    await setScribeSettings(s, { enabled: true, baseUrl: 'http://127.0.0.1:1', token: MOCK_SCRIBE_TOKEN, mailboxes: 'troy' });
    await pollScribe(s);
  } finally { Object.assign(console, orig); }
  assert.doesNotMatch(seen.join('\n'), /mock-mailbox-status-token/);
});

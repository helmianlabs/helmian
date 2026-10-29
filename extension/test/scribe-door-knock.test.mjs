// Scribe door-knock: client against a mock Scribe, and the real worker wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryStorage } from '../background/ledger.js';
import {
  backoffMs, badgeFor, clampPeriod, getScribeSettings, isAllowedScribeUrl, openLetter, pollScribe,
  readScribeState, scribeOriginPattern, sendReceipt, setScribeSettings, summarise, MAX_BACKOFF_MS,
} from '../background/scribe-client.js';
import { MOCK_SCRIBE_TOKEN, startMockScribe } from '../test-support/mock-scribe.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';

await installWorker();
const POPUP = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
const CONTENT = { id: chrome.runtime.id, url: 'https://claude.ai/chat/1', tab: { id: 3, url: 'https://claude.ai/chat/1' } };
function send(message, sender) {
  return new Promise((resolve) => {
    const kept = fake.listeners.map((l) => l(message, sender, resolve)).some((r) => r === true);
    if (!kept) setTimeout(() => resolve(undefined), 0);
  });
}
async function ready(api, extra = {}) {
  const s = memoryStorage();
  await setScribeSettings(s, { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN, ...extra });
  return s;
}

test('off by default: no request without opt-in, URL and token', async () => {
  const s = memoryStorage();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('no'); };
  assert.equal((await pollScribe(s, { fetchImpl })).skipped, 'not-enabled');
  await setScribeSettings(s, { enabled: true });
  assert.equal((await pollScribe(s, { fetchImpl })).skipped, 'not-configured');
  assert.equal(calls, 0);
  assert.equal((await getScribeSettings(s)).enabled, true);
});

test('settings: token is stored but never returned; URL rules', async () => {
  const s = memoryStorage();
  const v = await setScribeSettings(s, { baseUrl: 'https://scribe.example.com/', token: MOCK_SCRIBE_TOKEN });
  assert.equal(v.hasToken, true);
  assert.equal(v.baseUrl, 'https://scribe.example.com');
  assert.doesNotMatch(JSON.stringify(v), /smk_/);
  await assert.rejects(setScribeSettings(s, { baseUrl: 'http://evil.example.com' }));
  await assert.rejects(setScribeSettings(s, { token: 'short' }));
  assert.equal(isAllowedScribeUrl('https://a.b/x?y=1'), false);
  assert.equal(isAllowedScribeUrl('http://localhost:8787'), true);
  assert.equal(scribeOriginPattern('https://scribe.example.com:8443/base'), 'https://scribe.example.com/*');
  assert.equal(clampPeriod(0.25), 1); assert.equal(clampPeriod(10), 2); assert.equal(clampPeriod('x'), 2);
});

test('poll: reads /mailbox-status with the bearer, counts unread, reports fresh once', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api);
    const first = await pollScribe(s);
    assert.equal(first.unread, 2);
    assert.equal(first.fresh.length, 1);
    assert.equal(api.requests[0].url, '/mailbox-status');
    assert.equal(api.requests[0].auth, `Bearer ${MOCK_SCRIBE_TOKEN}`);
    const second = await pollScribe(s);
    assert.equal(second.fresh.length, 0, 'same newest letter is not re-notified');
    api.mailboxes[0].newest.id = 8;
    assert.equal((await pollScribe(s)).fresh.length, 1);
  } finally { await api.close(); }
});

test('mailbox filter and both server shapes (self-host tag-only, SaaS agent)', () => {
  const j = { mailboxes: [{ tag: 'for-troy', count: 1, newest: { id: 1, sender: 'a', subject: 's' } }, { agent: 'paul', count: 3, newest: null }] };
  assert.equal(summarise(j, '').unread, 4);
  assert.equal(summarise(j, 'paul').unread, 3);
  assert.equal(summarise({}, '').unread, 0);
});

test('401 stops polling until a new token is pasted', async () => {
  const api = await startMockScribe({ token: 'smk_somethingelse_0123456789' });
  try {
    const s = await ready(api);
    assert.equal((await pollScribe(s)).skipped, 'token-rejected');
    assert.equal((await pollScribe(s)).skipped, 'token-rejected');
    assert.equal(api.requests.length, 1);
    assert.equal((await getScribeSettings(s)).tokenRejected, true);
    await setScribeSettings(s, { token: MOCK_SCRIBE_TOKEN });
    assert.equal((await getScribeSettings(s)).tokenRejected, false);
  } finally { await api.close(); }
});

test('backoff on errors, Retry-After on 429, UTC reset on 402', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api);
    const now = Date.parse('2026-10-29T12:00:00Z');
    api.status = 500;
    assert.equal((await pollScribe(s, { now })).skipped, 'server-error');
    assert.equal((await pollScribe(s, { now: now + 1000 })).skipped, 'backing-off');
    assert.equal(backoffMs(1), 60000); assert.equal(backoffMs(3), 240000); assert.equal(backoffMs(99), MAX_BACKOFF_MS);
    api.status = 429; api.retryAfter = 120;
    assert.equal((await pollScribe(s, { now: now + 61000 })).skipped, 'rate-limited');
    assert.equal((await readScribeState(s)).nextAllowedAt, now + 61000 + 120000);
    api.status = 402;
    const r = await pollScribe(s, { now: now + 400000 });
    assert.equal(r.skipped, 'scribe-limit');
    assert.equal(r.until, Date.parse('2026-10-30T00:00:00Z'));
    api.status = 200;
    assert.equal((await pollScribe(s, { now: Date.parse('2026-10-30T00:00:01Z') })).unread, 2);
  } finally { await api.close(); }
});

test('network failure and offline: no crash, offline does not spend budget', async () => {
  const s = memoryStorage();
  await setScribeSettings(s, { enabled: true, baseUrl: 'http://127.0.0.1:1', token: MOCK_SCRIBE_TOKEN });
  assert.equal((await pollScribe(s, { online: false })).skipped, 'offline');
  assert.equal((await readScribeState(s)).budgetUsed, undefined);
  assert.equal((await pollScribe(s)).skipped, 'network-error');
});

test('daily budget caps polls', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api, { dailyBudget: 2 });
    const now = Date.parse('2026-10-29T12:00:00Z');
    await pollScribe(s, { now }); await pollScribe(s, { now: now + 1 });
    assert.equal((await pollScribe(s, { now: now + 2 })).skipped, 'budget-spent');
    assert.equal(api.requests.length, 2);
  } finally { await api.close(); }
});

test('open a letter and send a receipt', async () => {
  const api = await startMockScribe();
  try {
    const s = await ready(api, { mailbox: 'for-troy' });
    const letter = await openLetter(s, 7);
    assert.equal(letter.body, 'Hello Troy');
    assert.deepEqual(await sendReceipt(s, 7), { ok: true });
    assert.deepEqual(api.receipts, ['7']);
    assert.match(api.requests.at(-1).body, /"mailbox":"troy"/);
    await assert.rejects(openLetter(s, '../admin'), /bad letter id/);
    await assert.rejects(openLetter(s, 99), /404/);
  } finally { await api.close(); }
});

test('badge text', () => {
  assert.equal(badgeFor(0), ''); assert.equal(badgeFor(5), '5'); assert.equal(badgeFor(150), '99+');
});

test('worker: scribe messages are popup-only and never echo the token', async () => {
  fake.resetStorage();
  assert.equal((await send({ type: 'helmion:scribe-settings', settings: { enabled: true } }, CONTENT)).ok, false);
  assert.equal((await send({ type: 'helmion:scribe-open', id: 7 }, CONTENT)).ok, false);
  const api = await startMockScribe();
  try {
    fake.alarmCalls.length = 0;
    const saved = await send({ type: 'helmion:scribe-settings', settings: { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN, periodMinutes: 1 } }, POPUP);
    assert.equal(saved.ok, true, saved.error);
    assert.doesNotMatch(JSON.stringify(saved), /smk_/);
    assert.deepEqual(fake.alarmCalls.at(-1), { call: 'create', name: 'helmion-scribe-poll', periodInMinutes: 1, delayInMinutes: 0.5 });
    fake.badgeCalls.length = 0; fake.notificationCalls.length = 0;
    fake.grant('notifications');
    for (const l of fake.alarmListeners) l({ name: 'helmion-scribe-poll' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(fake.badgeCalls.some((c) => c.call === 'setBadgeText' && c.text === '2' && c.tabId === undefined));
    assert.equal(fake.notificationCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(fake.notificationCalls), /Hello Troy/, 'notification shows subject, never body');
    const inbox = await send({ type: 'helmion:scribe-inbox', options: {} }, POPUP);
    assert.equal(inbox.unread, 2);
    assert.equal((await send({ type: 'helmion:scribe-receipt', id: 7 }, POPUP)).ok, true);
    const off = await send({ type: 'helmion:scribe-settings', settings: { enabled: false } }, POPUP);
    assert.equal(off.ok, true);
    assert.deepEqual(fake.alarmCalls.at(-1), { call: 'clear', name: 'helmion-scribe-poll' });
  } finally { fake.revokeAll(); await api.close(); }
});

test('without notifications permission, no notification is shown', async () => {
  fake.resetStorage();
  const api = await startMockScribe();
  try {
    await send({ type: 'helmion:scribe-settings', settings: { enabled: true, baseUrl: api.url, token: MOCK_SCRIBE_TOKEN } }, POPUP);
    fake.notificationCalls.length = 0;
    await send({ type: 'helmion:scribe-inbox', options: { force: true } }, POPUP);
    assert.equal(fake.notificationCalls.length, 0);
  } finally { await api.close(); }
});

test('manifests: alarms required, notifications optional, no new install-time hosts', () => {
  for (const f of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url)));
    assert.ok(m.permissions.includes('alarms'));
    assert.ok(!m.permissions.includes('notifications'));
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
    await setScribeSettings(s, { enabled: true, baseUrl: 'http://127.0.0.1:1', token: MOCK_SCRIBE_TOKEN });
    await pollScribe(s);
  } finally { Object.assign(console, orig); }
  assert.doesNotMatch(seen.join('\n'), /smk_/);
});

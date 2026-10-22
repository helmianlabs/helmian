// The worker's Flags messages: who may send them, and what they hand back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';
import { MOCK_KEY, startMockFlagsApi } from '../test-support/mock-flags-api.mjs';

await installWorker();

const POPUP = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
const CONTENT = { id: chrome.runtime.id, url: 'https://claude.ai/chat/1', tab: { id: 3, url: 'https://claude.ai/chat/1' } };
const OTHER_EXTENSION = { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' };

function send(message, sender) {
  return new Promise((resolve) => {
    let done = false;
    const respond = (r) => { if (!done) { done = true; resolve(r); } };
    const kept = fake.listeners.map((l) => l(message, sender, respond)).some((r) => r === true);
    if (!kept) setTimeout(() => respond(undefined), 0);
  });
}

test('flags settings: popup only; the saved key is never handed back', async () => {
  fake.resetStorage();
  const refused = await send({ type: 'helmion:flags-settings', settings: { enabled: true } }, CONTENT);
  assert.equal(refused.ok, false);
  const saved = await send({ type: 'helmion:flags-settings', settings: { enabled: true, baseUrl: 'https://memory.example.com', apiKey: MOCK_KEY, scanBeforeSend: true } }, POPUP);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.settings.hasKey, true);
  assert.doesNotMatch(JSON.stringify(saved), /smk_/);
  const read = await send({ type: 'helmion:flags-settings', settings: {} }, POPUP);
  assert.doesNotMatch(JSON.stringify(read), /smk_/);
});

test('flags config: a content script learns only a yes/no', async () => {
  fake.resetStorage();
  assert.deepEqual(await send({ type: 'helmion:flags-config' }, CONTENT), { ok: true, scanBeforeSend: false });
  fake.storageBag.set('helmion.flags.settings', { enabled: true, baseUrl: 'https://memory.example.com', apiKey: MOCK_KEY, scanBeforeSend: true });
  assert.deepEqual(await send({ type: 'helmion:flags-config' }, CONTENT), { ok: true, scanBeforeSend: true });
});

test('flags scan: only from this extension\'s content scripts', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    fake.storageBag.set('helmion.flags.settings', { enabled: true, baseUrl: api.url, apiKey: MOCK_KEY, scanBeforeSend: true });
    assert.equal((await send({ type: 'helmion:flags-scan', text: 'hi' }, POPUP)).ok, false);
    assert.equal((await send({ type: 'helmion:flags-scan', text: 'hi' }, { ...OTHER_EXTENSION, tab: { id: 1 } })).ok, false);
    const ok = await send({ type: 'helmion:flags-scan', text: 'hi' }, CONTENT);
    assert.equal(ok.ok, true);
    assert.equal(ok.result.ok, true);
    assert.equal(api.requests.length, 1);
  } finally { await api.close(); }
});

test('flags alerts: popup only; polls GET /api/flags and marks seen', async () => {
  fake.resetStorage();
  const api = await startMockFlagsApi();
  try {
    fake.storageBag.set('helmion.flags.settings', { enabled: true, baseUrl: api.url, apiKey: MOCK_KEY });
    await send({ type: 'helmion:flag', flag: { kind: 'privacy-leak', rule: 'secret:private_key', label: 'A private key', site: 'claude.ai', excerpt: '[REDACTED:private_key]' } }, CONTENT);
    assert.equal(api.requests[0].body.source_ai, 'claude.ai');
    assert.equal(api.requests[0].body.url, 'https://claude.ai/chat/1');
    assert.equal((await send({ type: 'helmion:flags-alerts', options: { force: true } }, CONTENT)).ok, false);
    const polled = await send({ type: 'helmion:flags-alerts', options: { force: true } }, POPUP);
    assert.equal(polled.ok, true);
    assert.equal(polled.alerts.length, 1);
    assert.equal(polled.alerts[0].severity, 'critical');
    assert.equal(polled.unseen, 1);
    const seen = await send({ type: 'helmion:flags-alerts', options: { markSeen: true } }, POPUP);
    assert.equal(seen.unseen, 0);
  } finally { await api.close(); }
});

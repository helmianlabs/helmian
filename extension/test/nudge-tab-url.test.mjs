// Auto-nudge never typed (seen live, Chromium 156, Guard 0.6.8 / PR 180 build):
// Chrome gives an extension a tab's url only with the "tabs" permission or host
// permission for that site. Guard asked for neither for the AI sites, so the
// pre-typing url re-check got '' and refused EVERY nudge as "not a chat page".
// An unknown url must defer to the in-page check; a known non-chat url is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installWorker } from '../test-support/fake-chrome.mjs';
import { memoryStorage } from '../background/ledger.js';
import { runNudges, setNudgeSettings, noteTab, queuePending, readNudgeLog } from '../background/nudge-policy.js';

await installWorker();
const worker = await import('../background/worker.js');

function fakeApi(tabUrl, answer = { ok: true, reason: 'sent' }) {
  const sent = [];
  return {
    sent,
    runtime: { lastError: undefined },
    tabs: {
      get: (id, cb) => cb(tabUrl === null ? undefined : { id, ...(tabUrl ? { url: tabUrl } : {}) }),
      sendMessage: (id, msg, cb) => { sent.push([id, msg.type]); cb(answer); },
    },
  };
}
const TRY = { type: 'helmion:nudge-try', text: 'x' };

test('url hidden by Chrome (no tabs/host permission): the nudge goes to the tab, whose own check decides', async () => {
  const api = fakeApi('');
  const r = await worker.sendNudgeToTab(5, TRY, api);
  assert.deepEqual(r, { ok: true, reason: 'sent' });
  assert.deepEqual(api.sent, [[5, 'helmion:nudge-try']]);
});

test('known non-chat or lookalike url is still refused before anything reaches the tab', async () => {
  for (const url of ['https://grok.com/imagine', 'https://claude.ai/settings', 'https://chatgpt.com.evil.example/', 'http://chatgpt.com/']) {
    const api = fakeApi(url);
    const r = await worker.sendNudgeToTab(5, TRY, api);
    assert.equal(r.reason, 'refused', url);
    assert.deepEqual(api.sent, [], url);
  }
  assert.equal(worker.nudgeUrlRefusal('https://chatgpt.com/'), null);
  assert.equal(worker.nudgeUrlRefusal(''), null);
  assert.equal(worker.nudgeUrlRefusal(undefined), null);
});

test('end to end: unread mail + a registered chat tab whose url Chrome hides => nudge sent, not refused', async () => {
  const storage = memoryStorage();
  const now = Date.UTC(2026, 10, 12, 3, 0, 0);
  await setNudgeSettings(storage, { enabled: true, sites: { 'grok.com': true } });
  await noteTab(storage, 11, 'grok.com', now);
  await queuePending(storage, 'grok', [{ id: 164, subject: 'cross-check' }], now);
  const api = fakeApi('');
  const attempts = await runNudges(storage, { now, sendToTab: (id, m) => worker.sendNudgeToTab(id, m, api), unread: { grok: { count: 9, newestId: 164 } } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'sent');
  const log = await readNudgeLog(storage);
  assert.ok(!log.some((r) => r.outcome === 'refused'), 'no "not a chat page" refusal');
});

test('the in-page check still refuses a non-chat page on its own (no reliance on the tab url)', async () => {
  const src = await readFile(new URL('../content/nudge.js', import.meta.url), 'utf8');
  assert.match(src, /var site = siteKey\(loc\.hostname, loc\.pathname\)/);
  assert.match(src, /not a supported AI chat page/);
});

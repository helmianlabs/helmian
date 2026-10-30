// 0.6.2 sign-in fix: the popup opened as a full tab was refused by the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';
await installWorker();
const worker = await import('../background/worker.js');
function send(message, sender) {
  return new Promise((resolve) => {
    let done = false; const respond = (r) => { if (!done) { done = true; resolve(r); } };
    const kept = fake.listeners.map((l) => l(message, sender, respond)).some((r) => r === true);
    if (!kept) setTimeout(() => respond(undefined), 0);
  });
}
const POPUP_URL = chrome.runtime.getURL('popup/popup.html');
const POPUP_AS_TAB = { id: chrome.runtime.id, url: POPUP_URL, tab: { id: 9, url: POPUP_URL } };

test('ROOT CAUSE: popup opened as a tab is accepted; content scripts and other extensions are refused', async () => {
  assert.equal((await send({ type: 'helmion:scribe-settings', settings: {} }, POPUP_AS_TAB)).ok, true);
  assert.equal((await send({ type: 'helmion:scribe-settings', settings: {} }, { id: chrome.runtime.id, url: POPUP_URL })).ok, true);
  for (const s of [{ id: chrome.runtime.id, url: 'https://claude.ai/c/1', tab: { id: 3 } }, { id: 'other', url: 'chrome-extension://other/popup/popup.html' }, undefined]) {
    const r = await send({ type: 'helmion:scribe-signin', action: 'signin' }, s);
    assert.equal(r.ok, false); assert.match(r.error, /only accepted/);
  }
});
test('sign-in without identity API fails loudly with what to do', async () => {
  await send({ type: 'helmion:scribe-settings', settings: { baseUrl: 'https://scribe.example.com' } }, POPUP_AS_TAB);
  const saved = chrome.identity; delete chrome.identity;
  try {
    const r = await send({ type: 'helmion:scribe-signin', action: 'signin' }, POPUP_AS_TAB);
    assert.equal(r.ok, false); assert.match(r.error, /identity.*Click Sign in to Scribe again and choose Allow/);
  } finally { if (saved) chrome.identity = saved; }
});
test('identity errors become plain sentences', () => {
  assert.match(worker.plainLaunchError('The user did not approve access.'), /closed before sign-in finished/);
  assert.match(worker.plainLaunchError('Authorization page could not be loaded.'), /internet connection/);
  assert.match(worker.plainLaunchError('x'), /browser said: x/);
});
test('popup: permission request starts before any await, failures go to a loud #scribeError', async () => {
  const js = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const h = js.slice(js.indexOf("$('scribeSignIn').addEventListener"));
  assert.ok(h.indexOf('requestSignInPermissions(url)') < h.indexOf('await perm'), 'permission request precedes the first await');
  const html = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="scribeError" class="loud-error" role="alert"/);
});

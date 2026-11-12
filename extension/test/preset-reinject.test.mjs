// 0.6.9 candidate: settings preset (fills an EMPTY profile only) and putting a
// working copy of Guard into AI tabs that were open across an update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWorker } from '../test-support/fake-chrome.mjs';
import { memoryStorage } from '../background/ledger.js';
import { getScribeSettings } from '../background/scribe-client.js';
import { getNudgeSettings } from '../background/nudge-policy.js';

await installWorker();
const worker = await import('../background/worker.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const api = { runtime: { getURL: (p) => `chrome-extension://abc/${p}` } };
const fetchPreset = (preset) => async (url) => {
  assert.equal(url, 'chrome-extension://abc/preset.json');
  return preset ? { ok: true, json: async () => preset } : { ok: false };
};
const TROY = { name: 'Troy', ais: ['chatgpt', 'claude', 'grok', 'gemini', 'muse'], scribe: { enabled: true }, nudge: { enabled: true } };

test('PRESET fills an empty profile: AIs ticked, Scribe mailboxes incl. Muse, nudge sites, knock on', async () => {
  const storage = memoryStorage();
  const profile = await worker.applyPreset(storage, api, fetchPreset(TROY));
  assert.deepEqual(profile.ais, TROY.ais);
  const back = await worker.readOnboarding(storage);
  assert.equal(back.name, 'Troy');
  const s = await getScribeSettings(storage);
  assert.deepEqual(s.mailboxes, ['chatgpt', 'claude.ai', 'grok', 'gemini', 'muse']);
  assert.equal(s.enabled, true);
  assert.equal(s.signedIn, false, 'a preset never signs in: that needs the person');
  const n = await getNudgeSettings(storage);
  assert.equal(n.enabled, true);
  assert.deepEqual(n.sites, { 'chatgpt.com': true, 'claude.ai': true, 'grok.com': true, 'gemini.google.com': true, 'perplexity.ai': false, 'chat.mistral.ai': false });
  assert.ok(await storage.get(worker.PRESET_APPLIED_KEY));
});

test('PRESET never overwrites what the person already chose; no preset file = nothing happens', async () => {
  const storage = memoryStorage();
  await worker.saveOnboarding(storage, { name: 'Already Me', ais: ['grok'] });
  assert.equal(await worker.applyPreset(storage, api, fetchPreset(TROY)), null);
  assert.equal((await worker.readOnboarding(storage)).name, 'Already Me');
  const empty = memoryStorage();
  assert.equal(await worker.applyPreset(empty, api, fetchPreset(null)), null);
  assert.equal(await worker.readOnboarding(empty), null);
  assert.equal(await worker.applyPreset(empty, api, async () => { throw new Error('offline'); }), null);
});

test('RE-INJECT: on update, every open tab matching the content scripts gets the CSS and the scripts', async () => {
  const calls = [];
  const fakeApi = {
    runtime: { getManifest: () => ({ content_scripts: [{ matches: ['https://grok.com/*', 'https://claude.ai/*'], js: ['content/ui.js', 'content/guard.js'], css: ['content/guard.css'] }] }) },
    tabs: { query: async (q) => { calls.push(['query', q.url.join(',')]); return [{ id: 7, url: 'https://grok.com/c/1' }, { id: 8, discarded: true }, { id: 9, url: 'https://claude.ai/x' }]; } },
    scripting: {
      insertCSS: async ({ target, files }) => { calls.push(['css', target.tabId, files.join(',')]); },
      executeScript: async ({ target, files }) => { if (target.tabId === 9) throw new Error('tab closed'); calls.push(['js', target.tabId, files.join(',')]); },
    },
  };
  const n = await worker.reinjectOpenTabs(fakeApi);
  assert.equal(n, 1, 'one tab refreshed, a discarded tab skipped, a failing tab does not stop the rest');
  assert.deepEqual(calls, [
    ['query', 'https://grok.com/*,https://claude.ai/*'],
    ['css', 7, 'content/guard.css'], ['js', 7, 'content/ui.js,content/guard.js'],
    ['css', 9, 'content/guard.css'],
  ]);
  assert.equal(await worker.reinjectOpenTabs({ runtime: {} }), 0, 'no scripting API: nothing, no crash');
});

test('handleInstalled keeps its contract: install opens the welcome page, update and chrome_update do not by themselves', () => {
  const opened = [];
  const a = { runtime: { getURL: (p) => p, getManifest: () => ({ content_scripts: [] }) }, tabs: { create: (o) => opened.push(o.url), query: async () => [] }, scripting: {} };
  assert.equal(worker.handleInstalled({ reason: 'update' }, a), false);
  assert.equal(worker.handleInstalled({ reason: 'chrome_update' }, a), false);
  assert.equal(worker.handleInstalled({ reason: 'install' }, a), true);
});

test('PACKAGER --preset: copies a valid preset as preset.json; refuses unknown fields and anything secret', async () => {
  const { applyPresetFile } = await import(path.join(ROOT, 'tools', 'package-guard.mjs'));
  const dir = await mkdtemp(path.join(tmpdir(), 'preset-'));
  const good = path.join(dir, 'p.json');
  await writeFile(good, JSON.stringify(TROY));
  const out = await mkdtemp(path.join(tmpdir(), 'out-'));
  await applyPresetFile(out, good);
  const written = JSON.parse(await readFile(path.join(out, 'preset.json'), 'utf8'));
  assert.deepEqual(written, TROY);
  for (const bad of [{ ...TROY, token: 'x' }, { ...TROY, ais: ['bogus'] }, { ...TROY, name: '' }, { ...TROY, scribe: { enabled: true, apiKey: 'k' } }]) {
    const f = path.join(dir, `bad-${Math.random()}.json`);
    await writeFile(f, JSON.stringify(bad));
    await assert.rejects(applyPresetFile(out, f));
  }
  assert.equal(await applyPresetFile(out, undefined), null);
});

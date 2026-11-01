import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pickWindowsAsset, latestWindowsRelease } from '../server/latest-release.js';
import { planDownloads } from '../get-started/downloads.mjs';

test('get-started page exists and prompts sign-up', () => {
  const html = readFileSync(new URL('../get-started/index.html', import.meta.url), 'utf8');
  assert.match(html, /Create your free account/u);
  const js = readFileSync(new URL('../get-started/get-started.js', import.meta.url), 'utf8');
  assert.match(js, /mountSignUp/u);
  assert.match(js, /\/api\/signup/u);
  assert.ok(existsSync(new URL('../downloads/helmian-guard-0.2.3.zip', import.meta.url)));
});

test('picks exe asset from a GitHub release, else unavailable', async () => {
  assert.deepEqual(pickWindowsAsset({ tag_name: 'v0.1.0', assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/x/n' }, { name: 'Helmian-Setup.exe', size: 5, browser_download_url: 'https://github.com/x/e' }] }), { name: 'Helmian-Setup.exe', url: 'https://github.com/x/e', version: 'v0.1.0', size: 5 });
  assert.equal(pickWindowsAsset({ assets: [] }), null);
  assert.deepEqual(await latestWindowsRelease({ fetchImpl: async () => ({ ok: false }) }), { available: false });
});

test('deliver() receives the clerk instance — no out-of-scope clerk reference', () => {
  const js = readFileSync(new URL('../get-started/get-started.js', import.meta.url), 'utf8');
  assert.match(js, /async function deliver\(clerk, email\)/u);
  assert.match(js, /deliver\(clerk, /u);
});

test('get-started copy never promises an installer download', () => {
  const html = readFileSync(new URL('../get-started/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /download starts right after/iu);
  assert.doesNotMatch(html, /account to download/iu);
  assert.doesNotMatch(html, /Free download/u);
  const js = readFileSync(new URL('../get-started/get-started.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /to get \$\{product\.name\}/u);
});

test('planDownloads: exe is ready only with a real published release', () => {
  assert.deepEqual(planDownloads({ items: ['exe'], release: { available: false }, guard: null }), [{ kind: 'exe', ready: false }]);
  assert.deepEqual(planDownloads({ items: ['exe'], release: { available: true, url: 'https://github.com/x/e', name: 'Helmian-Setup.exe', version: 'v1' }, guard: null }), [{ kind: 'exe', ready: true, name: 'Helmian-Setup.exe', url: 'https://github.com/x/e', version: 'v1' }]);
  assert.deepEqual(planDownloads({ items: ['guard'], release: null, guard: { name: 'g.zip', url: '/downloads/g.zip' } }), [{ kind: 'guard', ready: true, name: 'g.zip', url: '/downloads/g.zip' }]);
});

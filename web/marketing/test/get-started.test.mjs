import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pickWindowsAsset, latestWindowsRelease } from '../server/latest-release.js';

test('get-started page exists and prompts sign-up', () => {
  const html = readFileSync(new URL('../get-started/index.html', import.meta.url), 'utf8');
  assert.match(html, /Create your free account/u);
  const js = readFileSync(new URL('../get-started/get-started.js', import.meta.url), 'utf8');
  assert.match(js, /mountSignUp/u);
  assert.match(js, /Windows installer is coming soon/u);
  assert.ok(existsSync(new URL('../downloads/helmian-guard-0.2.3.zip', import.meta.url)));
});

test('picks exe asset from a GitHub release, else unavailable', async () => {
  assert.deepEqual(pickWindowsAsset({ tag_name: 'v0.1.0', assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/x/n' }, { name: 'Helmian-Setup.exe', size: 5, browser_download_url: 'https://github.com/x/e' }] }), { name: 'Helmian-Setup.exe', url: 'https://github.com/x/e', version: 'v0.1.0', size: 5 });
  assert.equal(pickWindowsAsset({ assets: [] }), null);
  assert.deepEqual(await latestWindowsRelease({ fetchImpl: async () => ({ ok: false }) }), { available: false });
});

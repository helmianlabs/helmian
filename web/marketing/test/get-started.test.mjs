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

const releaseJson = (body) => ({ ok: true, json: async () => body });
const EXE_RELEASE = { tag_name: 'v0.2.0', assets: [{ name: 'Helmian-Setup-0.2.0-win-x64.exe', size: 123, browser_download_url: 'https://github.com/helmianlabs/helmian/releases/download/v0.2.0/Helmian-Setup-0.2.0-win-x64.exe' }, { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/x/s' }] };

test('latest release: a release with an installer asset is available', async () => {
  const out = await latestWindowsRelease({ repo: 'test/with-asset', fetchImpl: async () => releaseJson(EXE_RELEASE) });
  assert.equal(out.available, true);
  assert.equal(out.name, 'Helmian-Setup-0.2.0-win-x64.exe');
  assert.equal(out.url, 'https://github.com/helmianlabs/helmian/releases/download/v0.2.0/Helmian-Setup-0.2.0-win-x64.exe');
  assert.equal(out.version, 'v0.2.0');
  assert.equal(out.size, 123);
});

test('latest release: a release without an installer asset stays unavailable', async () => {
  const out = await latestWindowsRelease({ repo: 'test/without-asset', fetchImpl: async () => releaseJson({ tag_name: 'v0.1.0', assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/x/n' }] }) });
  assert.deepEqual(out, { available: false });
});

test('latest release: a network failure reports unavailable, never throws', async () => {
  const out = await latestWindowsRelease({ repo: 'test/network-down', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(out, { available: false });
});

test('latest release: successful reads are memoized per repo, failures are not', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return releaseJson(EXE_RELEASE); };
  const t0 = 1_000_000;
  await latestWindowsRelease({ repo: 'test/memo', fetchImpl, now: () => t0 });
  await latestWindowsRelease({ repo: 'test/memo', fetchImpl, now: () => t0 + 60_000 });
  assert.equal(calls, 1);
  await latestWindowsRelease({ repo: 'test/memo', fetchImpl, now: () => t0 + 6 * 60_000 });
  assert.equal(calls, 2);
  await latestWindowsRelease({ repo: 'test/memo-other', fetchImpl, now: () => t0 });
  assert.equal(calls, 3);

  let failCalls = 0;
  const failThenOk = async () => { failCalls += 1; return failCalls === 1 ? { ok: false } : releaseJson(EXE_RELEASE); };
  assert.deepEqual(await latestWindowsRelease({ repo: 'test/memo-failure', fetchImpl: failThenOk, now: () => t0 }), { available: false });
  assert.equal((await latestWindowsRelease({ repo: 'test/memo-failure', fetchImpl: failThenOk, now: () => t0 })).available, true);
  assert.equal(failCalls, 2);
});

test('download plan follows the release truth', () => {
  const guard = { name: 'helmian-guard-0.2.3.zip', url: '/downloads/helmian-guard-0.2.3.zip' };
  assert.deepEqual(
    planDownloads({ items: ['exe'], release: { available: true, name: 'Helmian-Setup.exe', url: 'https://github.com/x/e', version: 'v1' }, guard }),
    [{ kind: 'exe', ready: true, name: 'Helmian-Setup.exe', url: 'https://github.com/x/e', version: 'v1' }],
  );
  assert.deepEqual(planDownloads({ items: ['exe'], release: { available: false }, guard }), [{ kind: 'exe', ready: false }]);
  assert.deepEqual(planDownloads({ items: ['exe'], release: null, guard }), [{ kind: 'exe', ready: false }]);
  assert.deepEqual(planDownloads({ items: ['exe'], release: { available: true, url: 'http://insecure.example/x.exe' }, guard }), [{ kind: 'exe', ready: false }]);
  assert.deepEqual(
    planDownloads({ items: ['exe', 'guard'], release: { available: false }, guard }),
    [{ kind: 'exe', ready: false }, { kind: 'guard', ready: true, name: 'helmian-guard-0.2.3.zip', url: '/downloads/helmian-guard-0.2.3.zip' }],
  );
  assert.deepEqual(planDownloads({ items: ['guard'], release: null, guard: null }), [{ kind: 'guard', ready: false }]);
  assert.deepEqual(planDownloads({ items: [], release: null, guard }), []);
});

test('deliver() starts the planned download and is honest when none exists', () => {
  const js = readFileSync(new URL('../get-started/get-started.js', import.meta.url), 'utf8');
  assert.match(js, /from '\.\/downloads\.mjs'/u);
  assert.match(js, /planDownloads\(\{/u);
  assert.match(js, /startDownload\(started\.url\)/u);
  assert.match(js, /not published yet/u);
  assert.match(js, /gs-downloads/u);
});

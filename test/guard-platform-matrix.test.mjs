import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chromium = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const firefox = JSON.parse(await readFile(new URL('../extension/manifest.firefox.json', import.meta.url), 'utf8'));
const matrix = await readFile(new URL('../docs/HELMION_GUARD_PLATFORM_MATRIX.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const OPTIONAL_ORIGINS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];

test('Chromium and Firefox packages keep the minimal permission boundary', () => {
  for (const manifest of [chromium, firefox]) {
    assert.deepEqual(manifest.permissions, ['storage', 'alarms']); // alarms: Scribe door-knock (no install warning)
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*', 'https://grok.com/*']);
    assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  }
  // The one install-time host: the opt-in helmian.cloud findings upload (Chromium only).
  assert.deepEqual(chromium.host_permissions, ['https://helmian.cloud/*']);
  assert.equal(firefox.host_permissions, undefined);
  // Optional origins for Executive Guard / Flags, granted only from a popup click.
  assert.deepEqual(chromium.optional_host_permissions, OPTIONAL_ORIGINS);
  assert.deepEqual(chromium.optional_permissions, ['notifications']);
  assert.deepEqual(firefox.optional_permissions, ['notifications', ...OPTIONAL_ORIGINS]);
  assert.equal(chromium.background.service_worker, 'background/worker.js');
  assert.deepEqual(firefox.background.scripts, ['background/worker.js']);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '121.0');
});

test('package scripts and matrix keep store signing and VPN boundaries explicit', () => {
  assert.match(packageJson.scripts['guard:package:chromium'], /package-guard\.mjs --target chromium/u);
  assert.match(packageJson.scripts['guard:package:firefox'], /package-guard\.mjs --target firefox/u);
  assert.match(packageJson.scripts['guard:package:edge'], /package-guard\.mjs --target edge/u);
  assert.match(matrix, /AMO signing\/web-ext build required/u);
  assert.match(matrix, /does \*\*not\*\* provide universal VPN support/u);
  assert.match(matrix, /No current build claims\s+VPN control/u);
});

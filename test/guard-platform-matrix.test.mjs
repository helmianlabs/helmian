import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chromium = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const firefox = JSON.parse(await readFile(new URL('../extension/manifest.firefox.json', import.meta.url), 'utf8'));
const matrix = await readFile(new URL('../docs/HELMION_GUARD_PLATFORM_MATRIX.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('Chromium and Firefox packages keep the minimal permission boundary', () => {
  for (const manifest of [chromium, firefox]) {
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*', 'https://grok.com/*']);
  }
  assert.equal(chromium.background.service_worker, 'background/worker.js');
  assert.deepEqual(firefox.background.scripts, ['background/worker.js']);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '121.0');
});

test('package scripts and matrix keep store signing and VPN boundaries explicit', () => {
  assert.match(packageJson.scripts['guard:package:chromium'], /package-guard\.mjs --target chromium/u);
  assert.match(packageJson.scripts['guard:package:firefox'], /package-guard\.mjs --target firefox/u);
  assert.match(matrix, /AMO signing\/web-ext build required/u);
  assert.match(matrix, /does \*\*not\*\* provide universal VPN support/u);
  assert.match(matrix, /No current build claims\s+VPN control/u);
});

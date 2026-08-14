import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReleaseManifest } from '../src/cloud/release-canary-contract.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'));
}

test('release manifest validator accepts the complete non-secret source checklist', async () => {
  const result = validateReleaseManifest(await fixture('release-canary-valid.json'), await fixture('release-canary-expected.json'));
  assert.equal(result.valid, true);
  assert.match(result.checklist, /\[PASS\] API\/source commit/u);
  assert.match(result.checklist, /\[PASS\] exact canary sequence\/rollback criteria/u);
});

test('release manifest validator rejects mismatched migration, UI, Hume, and canary values', async () => {
  const manifest = await fixture('release-canary-valid.json');
  manifest.migrations = ['010_cora_organization_config.sql', '009_envoy_chat.sql', '011_cora_provider_usage.sql'];
  manifest.ui.bundleRevision = 'wrong';
  manifest.hume.readiness = 'live';
  manifest.canary.sequence = ['deploy-canary'];
  const result = validateReleaseManifest(manifest, await fixture('release-canary-expected.json'));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /migration order|UI bundle|Hume readiness|canary sequence/u);
});

test('release manifest validator rejects secret-bearing fields and source self-approval', async () => {
  const manifest = await fixture('release-canary-valid.json');
  manifest.api.apiKey = 'must-not-be-here';
  const expected = await fixture('release-canary-expected.json');
  expected.sourceCommit = manifest.api.sourceCommit;
  const result = validateReleaseManifest(manifest, expected);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /secret-bearing/u);
});

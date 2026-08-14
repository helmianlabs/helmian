import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_MIGRATIONS } from '../src/cloud/release-canary-contract.mjs';
import { validateReleaseSourceTree } from '../src/cloud/release-source-integrity.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

test('release source integrity accepts the canonical local source tree', async () => {
  const result = await validateReleaseSourceTree({ root });
  assert.equal(result.valid, true);
  assert.deepEqual(result.migrationOrder, REQUIRED_MIGRATIONS);
  assert.deepEqual(result.missingMigrations, []);
  assert.deepEqual(result.missingFiles, []);
  assert.equal(result.externalState, 'not_inspected');
});

test('release source integrity rejects missing or reordered required migrations', async () => {
  const result = await validateReleaseSourceTree({ root, requiredMigrations: [REQUIRED_MIGRATIONS[1], REQUIRED_MIGRATIONS[0]] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingMigrations, []);
  assert.equal(result.migrationsContiguous, false);
});

test('release source integrity rejects missing Cora or Cloud seams', async () => {
  const result = await validateReleaseSourceTree({ root, requiredFiles: ['src/cora/not-present.mjs'] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFiles, ['src/cora/not-present.mjs']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNeonTargetIdentityManifest } from '../src/core/neon-target-identity.mjs';

const expected = {
  projectName: 'Helmion Development', projectId: 'project-123', branchName: 'main',
  databaseName: 'neondb', endpointId: 'ep-helmion-a1b2c3d4',
};
const manifest = { format: 'helmion.neon.target-identity.v1', ...expected, evidence: 'neon-console', secretValuesOmitted: true };

test('Neon identity manifest accepts the exact non-secret target', () => {
  assert.deepEqual(validateNeonTargetIdentityManifest(manifest, expected), manifest);
});

test('Neon identity manifest rejects missing project/branch/database proof', () => {
  for (const field of ['projectName', 'projectId', 'branchName', 'databaseName', 'endpointId']) {
    const copy = { ...manifest, [field]: undefined };
    assert.throws(() => validateNeonTargetIdentityManifest(copy, expected), /missing|expected/u);
  }
});

test('Neon identity manifest rejects secret-bearing fields and mismatched endpoint', () => {
  assert.throws(() => validateNeonTargetIdentityManifest({ ...manifest, databaseUrl: 'postgres://redacted' }, expected), /secret-bearing/u);
  assert.throws(() => validateNeonTargetIdentityManifest({ ...manifest, endpointId: 'ep-other-a1b2c3d4' }, expected), /endpointId/u);
});

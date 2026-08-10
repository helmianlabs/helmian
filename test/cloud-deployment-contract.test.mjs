import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHelmianCloudDeployment } from '../src/cloud/deployment-contract.mjs';

const databaseUrl = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';

test('cloud deployment preflight accepts a dedicated Neon deployment contract', () => {
  const result = inspectHelmianCloudDeployment({
    HELMION_CLOUD_ENVIRONMENT: 'staging',
    HELMION_CORA_PROVIDER: 'claude',
    HELMION_DATABASE_URL: databaseUrl,
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
    HELMION_CORA_TOKEN: 'x'.repeat(32),
    ANTHROPIC_API_KEY: 'configured-outside-git',
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.database.endpointId, 'ep-silent-rain-a1b2c3d4');
});

test('cloud deployment preflight fails closed without every secret and Neon boundary', () => {
  const result = inspectHelmianCloudDeployment({
    HELMION_CLOUD_ENVIRONMENT: 'production',
    HELMION_CORA_PROVIDER: 'claude',
    HELMION_DATABASE_URL: databaseUrl,
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-other-a1b2c3d4',
    HELMION_CORA_TOKEN: 'short',
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('HELMION_CORA_TOKEN'));
  assert.ok(result.missing.some((item) => item.includes('HELMION_EXPECTED_ENDPOINT_ID')));
  assert.ok(result.missing.includes('ANTHROPIC_API_KEY'));
});

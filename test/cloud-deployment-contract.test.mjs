import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHelmianCloudDeployment } from '../src/cloud/deployment-contract.mjs';

const databaseUrl = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';
const adminEnv = {
  HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
  HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
  HELMION_ADMIN_SESSION_SECRET: 's'.repeat(32),
};

test('cloud deployment preflight accepts a dedicated Neon deployment contract', () => {
  const result = inspectHelmianCloudDeployment({
    ...adminEnv,
    HELMION_CLOUD_ENVIRONMENT: 'staging',
    HELMION_CORA_PROVIDER: 'claude',
    HELMION_DATABASE_URL: databaseUrl,
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
    HELMION_CORA_TOKEN: 'x'.repeat(32),
    HELMION_AIMFORGE_BRIDGE_SECRET: 'b'.repeat(32),
    HELMION_AIMFORGE_ACTION_SECRET: 'a'.repeat(32),
    HELMION_AIMFORGE_API_BASE_URL: 'https://aimforge-api.fly.dev',
    ANTHROPIC_API_KEY: 'configured-outside-git',
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.database.endpointId, 'ep-silent-rain-a1b2c3d4');
  assert.deepEqual(result.admin, { configured: true, callbackPath: '/admin/auth/callback' });
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
  assert.ok(result.missing.includes('HELMION_AIMFORGE_BRIDGE_SECRET'));
  assert.ok(result.missing.includes('HELMION_AIMFORGE_ACTION_SECRET'));
  assert.ok(result.missing.includes('HELMION_AIMFORGE_API_BASE_URL'));
  assert.ok(result.missing.some((item) => item.includes('HELMION_EXPECTED_ENDPOINT_ID')));
  assert.ok(result.missing.includes('ANTHROPIC_API_KEY'));
  assert.ok(result.missing.includes('HELMION_ADMIN_ISSUER'));
  assert.ok(result.missing.includes('HELMION_ADMIN_CLIENT_ID'));
  assert.ok(result.missing.includes('HELMION_ADMIN_REDIRECT_URI'));
  assert.ok(result.missing.includes('HELMION_ADMIN_SESSION_SECRET'));
});

test('cloud deployment preflight refuses a wrong-site API origin', () => {
  const result = inspectHelmianCloudDeployment({
    ...adminEnv,
    HELMION_CLOUD_ENVIRONMENT: 'production',
    HELMION_DATABASE_URL: 'postgresql://u:p@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/helmian?sslmode=require',
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
    HELMION_CORA_TOKEN: 'x'.repeat(32),
    HELMION_AIMFORGE_BRIDGE_SECRET: 'b'.repeat(32),
    HELMION_AIMFORGE_ACTION_SECRET: 'a'.repeat(32),
    HELMION_AIMFORGE_API_BASE_URL: 'https://dairyforge-api.fly.dev',
    HELMION_CORA_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'configured-outside-git',
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('HELMION_AIMFORGE_API_BASE_URL'));
});

test('cloud deployment preflight refuses an admin callback outside the mounted path', () => {
  const result = inspectHelmianCloudDeployment({
    ...adminEnv,
    HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/auth/callback',
    HELMION_CLOUD_ENVIRONMENT: 'production',
    HELMION_DATABASE_URL: databaseUrl,
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
    HELMION_CORA_TOKEN: 'x'.repeat(32),
    HELMION_AIMFORGE_BRIDGE_SECRET: 'b'.repeat(32),
    HELMION_AIMFORGE_ACTION_SECRET: 'a'.repeat(32),
    HELMION_AIMFORGE_API_BASE_URL: 'https://aimforge-api.fly.dev',
    HELMION_CORA_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'configured-outside-git',
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('HELMION_ADMIN_REDIRECT_URI'));
});

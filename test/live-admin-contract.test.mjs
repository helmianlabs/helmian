import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { createIdentityGateway } from '../src/cloud/identity-gateway.mjs';

test('live admin fails closed when the exact Neon target is not configured', async () => {
  await assert.rejects(
    () => createLiveHelmianCloudAdminHandler({ env: {} }),
    /HELMION_DATABASE_URL and HELMION_EXPECTED_ENDPOINT_ID/,
  );
});

test('identity gateway requires all OIDC deployment settings', () => {
  assert.throws(
    () => createIdentityGateway({ env: { HELMION_ADMIN_ISSUER: 'https://issuer.example' } }),
    /HELMION_ADMIN_CLIENT_ID is required/,
  );
});

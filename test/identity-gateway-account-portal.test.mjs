import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { createIdentityGateway, accountPortalOriginFor } from '../src/cloud/identity-gateway.mjs';

const gatewayEnv = {
  HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
  HELMION_ADMIN_REDIRECT_URI: 'https://helmian.cloud/admin/auth/callback',
};

test('production Clerk issuer maps clerk.<domain> to accounts.<domain>', () => {
  assert.equal(
    accountPortalOriginFor('https://clerk.helmian.cloud', {}),
    'https://accounts.helmian.cloud',
  );
});

test('development Clerk issuer maps <slug>.clerk.accounts.dev to <slug>.accounts.dev', () => {
  assert.equal(
    accountPortalOriginFor('https://witty-sawfly-97.clerk.accounts.dev', {}),
    'https://witty-sawfly-97.accounts.dev',
  );
});

test('non-Clerk issuer keeps its own host as the portal', () => {
  assert.equal(
    accountPortalOriginFor('https://identity.example.com', {}),
    'https://identity.example.com',
  );
});

test('HELMION_ADMIN_ACCOUNT_PORTAL_URL overrides the derivation', () => {
  assert.equal(
    accountPortalOriginFor('https://clerk.helmian.cloud', { HELMION_ADMIN_ACCOUNT_PORTAL_URL: 'https://accounts.custom.example' }),
    'https://accounts.custom.example',
  );
});

test('gateway exposes the derived portal origin', () => {
  const gateway = createIdentityGateway({
    env: { ...gatewayEnv, HELMION_ADMIN_ISSUER: 'https://clerk.helmian.cloud' },
    fetchImpl: async () => { throw new Error('no fetch expected'); },
  });
  assert.equal(gateway.accountPortal, 'https://accounts.helmian.cloud');
  assert.equal(gateway.issuer, 'https://clerk.helmian.cloud');
});

async function harness(t) {
  const env = {
    HELMION_CLOUD_ENVIRONMENT: 'staging',
    HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require',
    HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
    HELMION_ADMIN_ISSUER: 'https://clerk.example.com',
    HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
    HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
  };
  // No supplied identity: the handler builds a real gateway from env.
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('signup door redirects to the Account Portal host, not the issuer', async (t) => {
  const base = await harness(t);
  const response = await fetch(`${base}/admin/auth/signup?return=/app`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^https:\/\/accounts\.example\.com\/sign-up\?redirect_url=/);
  assert.doesNotMatch(location, /clerk\.example\.com/);
  // Return-cookie behaviour is unchanged.
  assert.match(response.headers.getSetCookie().join('\n'), /helmion_admin_return=app; Max-Age=3600/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

test('callback reports which stage rejected the sign-in', async (t) => {
  const logs = [];
  const identity = { getSession: () => null, finishLogin: async () => { throw Object.assign(new Error('OIDC token exchange failed'), { stage: 'token_exchange', oauthError: 'invalid_client', httpStatus: 401 }); } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], logger: (e) => logs.push(e) });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const call = async (q, cookie) => (await fetch(`${base}/admin/auth/callback${q}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })).json();
  assert.equal((await call('?error=access_denied&state=s')).oauthError, 'access_denied');
  assert.equal((await call('?state=s')).stage, 'missing_code');
  assert.equal((await call('?code=c&state=s')).stage, 'state_cookie_missing');
  assert.equal((await call('?code=c&state=s', 'helmion_admin_login_state=other')).stage, 'state_mismatch');
  const body = await call('?code=c&state=s', 'helmion_admin_login_state=s');
  assert.deepEqual([body.stage, body.oauthError, body.httpStatus], ['token_exchange', 'invalid_client', 401]);
  assert.doesNotMatch(JSON.stringify(logs), /code=c|helmion_admin_login_state=s/);
  assert.ok(logs.some((e) => e.event === 'admin.oidc_callback'));
});

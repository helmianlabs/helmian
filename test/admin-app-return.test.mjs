import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

async function harness(t) {
  const identity = { getSession: () => null, beginLogin: async () => ({ url: 'https://identity.example.com/authorize?x=1', state: 'st' }), finishLogin: async () => ({ sessionId: 'sess' }) };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('login with return=/app remembers the app and the callback lands on /app/', async (t) => {
  const base = await harness(t);
  const login = await fetch(`${base}/admin/auth/login?return=/app`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.match(login.headers.getSetCookie().join('\n'), /helmion_admin_return=app/);
  const cb = await fetch(`${base}/admin/auth/callback?code=c&state=st`, { redirect: 'manual', headers: { cookie: 'helmion_admin_login_state=st; helmion_admin_return=app' } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/app/');
  const cookies = cb.headers.getSetCookie().join('\n');
  assert.match(cookies, /helmion_admin_session=sess; Path=\/api\/admin/);
  assert.match(cookies, /helmion_admin_return=; Max-Age=0/);
});

test('login without return, or with any other return, keeps landing on /admin/', async (t) => {
  const base = await harness(t);
  for (const q of ['', '?return=https://evil.example.com', '?return=//evil.example.com', '?return=/admin']) {
    const login = await fetch(`${base}/admin/auth/login${q}`, { redirect: 'manual' });
    assert.doesNotMatch(login.headers.getSetCookie().join('\n'), /helmion_admin_return=app/);
  }
  const cb = await fetch(`${base}/admin/auth/callback?code=c&state=st`, { redirect: 'manual', headers: { cookie: 'helmion_admin_login_state=st' } });
  assert.equal(cb.headers.get('location'), '/admin/');
});

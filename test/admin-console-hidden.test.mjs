import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_PAGE_PATH,
  LIVE_ADMIN_SCRIPT_PATH,
  LIVE_ADMIN_ENVOY_CLIENT_PATH,
  LIVE_ADMIN_CORA_CONFIG_CLIENT_PATH,
  LIVE_ADMIN_LOGIN_PATH,
  LIVE_ADMIN_LOGOUT_PATH,
  LIVE_ADMIN_SESSION_PATH,
  LIVE_APP_PAGE_PATH,
} from '../src/cloud/live-admin.mjs';

// The /admin console pages are HIDDEN (Troy's order, 2026-11-04): the
// console is the first mock-up and nobody should be able to go to it. The
// page code is NOT deleted — the routes simply 302 to the workbench. The
// plumbing under the same prefix (/admin/auth/*, /api/admin/*) is the
// workbench's own sign-in/session machinery and must behave exactly as
// before; these tests pin both halves of that line.

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

async function harness(t) {
  const identity = { getSession: () => null, beginLogin: async () => ({ url: 'https://identity.example.com/authorize?x=1', state: 'st' }), finishLogin: async () => ({ sessionId: 'sess' }) };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, identity, page: '<p>console</p>', script: 'void 0;', envoyClientScript: 'void 0;', coraConfigClientScript: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

const CONSOLE_PAGE_PATHS = [
  LIVE_ADMIN_PAGE_PATH,
  `${LIVE_ADMIN_PAGE_PATH}/`,
  LIVE_ADMIN_SCRIPT_PATH,
  LIVE_ADMIN_ENVOY_CLIENT_PATH,
  LIVE_ADMIN_CORA_CONFIG_CLIENT_PATH,
];

test('every console page path 302s to the workbench and serves no console content', async (t) => {
  const base = await harness(t);
  for (const path of CONSOLE_PAGE_PATHS) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302, `${path} must redirect, not serve`);
    assert.equal(response.headers.get('location'), `${LIVE_APP_PAGE_PATH}/`, `${path} must land on the workbench`);
    assert.doesNotMatch(await response.text(), /console/, `${path} must not serve the console page`);
  }
});

test('an unknown /admin page subroute is not served either', async (t) => {
  const base = await harness(t);
  const response = await fetch(`${base}/admin/no-such-page`, { redirect: 'manual' });
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/);
});

test('/admin/auth/logout behaves exactly as before (sign-out handoff, cookies cleared)', async (t) => {
  const base = await harness(t);
  const plain = await fetch(`${base}${LIVE_ADMIN_LOGOUT_PATH}`, { redirect: 'manual', headers: { cookie: 'helmion_admin_session=active-session' } });
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get('location'), '/sign-out?return=%2Fadmin%2F');
  const cleared = plain.headers.getSetCookie().join('\n');
  assert.match(cleared, /helmion_admin_session=; Max-Age=0; Path=\/admin/);
  assert.match(cleared, /helmion_admin_session=; Max-Age=0; Path=\/api\/admin/);
  const toApp = await fetch(`${base}${LIVE_ADMIN_LOGOUT_PATH}?return=/app`, { redirect: 'manual', headers: { cookie: 'helmion_admin_session=active-session' } });
  assert.equal(toApp.status, 302);
  assert.equal(toApp.headers.get('location'), '/sign-out?return=%2Fapp%2F');
});

test('/admin/auth/login still starts the identity flow (no redirect to /app)', async (t) => {
  const base = await harness(t);
  const login = await fetch(`${base}${LIVE_ADMIN_LOGIN_PATH}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), 'https://identity.example.com/authorize?x=1');
});

test('/api/admin/session still answers with its own shape (not a redirect)', async (t) => {
  const base = await harness(t);
  const session = await fetch(`${base}${LIVE_ADMIN_SESSION_PATH}`, { redirect: 'manual' });
  assert.notEqual(session.status, 302);
  assert.match(session.headers.get('content-type') ?? '', /application\/json/);
  const body = await session.json();
  assert.equal(session.status, 403);
  assert.equal(body.authenticated, false);
  assert.equal(body.code, 'ADMIN_MEMBERSHIP_REQUIRED');
});

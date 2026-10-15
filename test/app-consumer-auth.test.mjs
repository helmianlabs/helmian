import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { createIdentityGateway, ADMIN_SESSION_MS, REMEMBERED_SESSION_MS } from '../src/cloud/identity-gateway.mjs';
import { smsInviteHref } from '../web/marketing/app/app-model.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

async function harness(t, calls = []) {
  const identity = { issuer: 'https://identity.example.com', getSession: () => null, beginLogin: async () => ({ url: 'https://identity.example.com/authorize?x=1', state: 'st' }), finishLogin: async (c, s, opts) => { calls.push(opts); return { sessionId: 'sess' }; } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }, identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('/app sign-in is remembered for 30 days; owner-console sign-in stays a browser session', async (t) => {
  const calls = [];
  const base = await harness(t, calls);
  const app = await fetch(`${base}/admin/auth/callback?code=c&state=st`, { redirect: 'manual', headers: { cookie: 'helmion_admin_login_state=st; helmion_admin_return=app' } });
  assert.match(app.headers.getSetCookie().join('\n'), /helmion_admin_session=sess; Max-Age=2592000; Path=\/admin/);
  assert.deepEqual(calls.at(-1), { remember: true });
  const owner = await fetch(`${base}/admin/auth/callback?code=c&state=st`, { redirect: 'manual', headers: { cookie: 'helmion_admin_login_state=st' } });
  const oc = owner.headers.getSetCookie().filter((c) => c.startsWith('helmion_admin_session=sess'));
  assert.equal(oc.length, 2); for (const c of oc) assert.doesNotMatch(c, /Max-Age/);
  assert.deepEqual(calls.at(-1), { remember: false });
});

test('signup with return=/app remembers the app; other returns are ignored', async (t) => {
  const base = await harness(t);
  const r = await fetch(`${base}/admin/auth/signup?return=/app`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/identity\.example\.com\/sign-up\?redirect_url=/);
  assert.match(r.headers.getSetCookie().join('\n'), /helmion_admin_return=app; Max-Age=3600/);
  const evil = await fetch(`${base}/admin/auth/signup?return=https://evil.example.com`, { redirect: 'manual' });
  assert.doesNotMatch(evil.headers.getSetCookie().join('\n'), /helmion_admin_return/);
});

test('logout with return=/app lands on /app/, otherwise /admin/', async (t) => {
  const base = await harness(t);
  assert.equal((await fetch(`${base}/admin/auth/logout?return=/app`, { redirect: 'manual' })).headers.get('location'), '/app/');
  assert.equal((await fetch(`${base}/admin/auth/logout?return=//evil.example.com`, { redirect: 'manual' })).headers.get('location'), '/admin/');
});

test('sealed gateway: remembered sessions last 30 days, default 8h', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const tok = (claims) => { const h = b64({ alg: 'RS256', kid: 'k1' }); const b = b64(claims); return `${h}.${b}.${createSign('RSA-SHA256').update(`${h}.${b}`).sign(privateKey).toString('base64url')}`; };
  const genv = { HELMION_ADMIN_ISSUER: 'https://issuer.example', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example/admin/auth/callback', HELMION_ADMIN_SESSION_SECRET: 'x'.repeat(40) };
  const fetchImpl = async (url) => { const u = String(url);
    if (u.endsWith('openid-configuration')) return new Response(JSON.stringify({ authorization_endpoint: 'https://issuer.example/a', token_endpoint: 'https://issuer.example/t', jwks_uri: 'https://issuer.example/j' }));
    if (u.endsWith('/t')) return new Response(JSON.stringify({ id_token: tok({ iss: genv.HELMION_ADMIN_ISSUER, aud: 'helmian', sub: 'user_b', exp: Math.floor(Date.now() / 1000) + 60 }) }));
    return new Response(JSON.stringify({ keys: [jwk] })); };
  const g = createIdentityGateway({ env: genv, fetchImpl });
  const now = Date.now();
  const long = g.getSession((await g.finishLogin('c', (await g.beginLogin()).state, { remember: true })).sessionId);
  assert.ok(Math.abs(long.expiresAt - (now + REMEMBERED_SESSION_MS)) < 5000);
  const short = g.getSession((await g.finishLogin('c', (await g.beginLogin()).state)).sessionId);
  assert.ok(Math.abs(short.expiresAt - (now + ADMIN_SESSION_MS)) < 5000);
});

test('smsInviteHref prefills a text with the invite link', () => {
  const href = smsInviteHref('https://helmian.cloud/join?token=hinv_abc');
  assert.match(href, /^sms:\?&body=/);
  assert.match(decodeURIComponent(href.slice(11)), /https:\/\/helmian\.cloud\/join\?token=hinv_abc$/);
});

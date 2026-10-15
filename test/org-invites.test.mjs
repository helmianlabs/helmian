import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { INVITE_TOKEN, DESKTOP_CODE, DESKTOP_TOKEN, newInviteToken, newDesktopCode, newDesktopToken, normalizeInviteInput } from '../src/cloud/org-invites.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

test('token formats', () => {
  for (let i = 0; i < 50; i++) { assert.match(newInviteToken(), INVITE_TOKEN); assert.match(newDesktopCode(), DESKTOP_CODE); assert.match(newDesktopToken(), DESKTOP_TOKEN); }
  assert.deepEqual(normalizeInviteInput({}), { days: 7, maxUses: 25 });
  assert.throws(() => normalizeInviteInput({ expiresInDays: 90 }));
  assert.throws(() => normalizeInviteInput({ maxUses: 0 }));
});

test('migration 043 stores only hashes and is tenant-scoped', async () => {
  const sql = await readFile(new URL('../sql/043_org_invites_desktop_links.sql', import.meta.url), 'utf8');
  assert.match(sql, /token_hash text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /role text not null default 'member' check \(role = 'member'\)/);
  assert.equal((sql.match(/enable row level security/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /\btoken text\b|\bcode text\b/);
});

async function harness(t, { role = 'owner', subject = 'u1', store }) {
  const client = { async query(sql) { const q = String(sql).toLowerCase(); if (q.includes('from helmion.tenant_memberships')) return { rowCount: role ? 1 : 0, rows: role ? [{ tenant_id: 't1', role }] : [] }; return { rowCount: 0, rows: [] }; }, release() {} };
  const identity = { getSession: (id) => (id === 's' ? { subject } : null), beginLogin: async () => ({ url: 'https://identity.example.com/a', state: 'st' }), finishLogin: async () => ({ sessionId: 's' }) };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => client }, identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], orgInviteStore: store });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('invite routes: owner creates, member cannot; public preview; join redirect sets cookies', async (t) => {
  const calls = [];
  const store = {
    create: async (actor, body, origin) => { calls.push(['create', actor.role, body]); return { invite: { url: `${origin}/join?token=hinv_x` } }; },
    list: async () => ({ invites: [] }), revoke: async () => ({ revoked: true }),
    preview: async (token) => { if (token === 'bad') throw Object.assign(new Error('x'), { status: 410, code: 'INVITE_EXPIRED' }); return { organization: 'Helmian Platform', role: 'member' }; },
    redeem: async (subject, token) => { calls.push(['redeem', subject, token]); return { joined: true, tenantId: 't1' }; },
    desktopIdentity: async () => null,
  };
  const base = await harness(t, { store });
  const headers = { cookie: 'helmion_admin_session=s', 'content-type': 'application/json' };
  const created = await fetch(`${base}/api/admin/organization/invites`, { method: 'POST', headers, body: JSON.stringify({ expiresInDays: 7, maxUses: 25 }) });
  assert.equal(created.status, 200);
  assert.match((await created.json()).invite.url, /\/join\?token=hinv_x$/);
  assert.equal((await fetch(`${base}/api/admin/organization/invites`, { method: 'POST', headers, body: JSON.stringify({ role: 'owner' }) })).status, 400);
  assert.equal((await (await fetch(`${base}/api/admin/join/preview?token=ok`)).json()).organization, 'Helmian Platform');
  assert.equal((await fetch(`${base}/api/admin/join/preview?token=bad`)).status, 410);
  const token = `hinv_${'a'.repeat(32)}`;
  const join = await fetch(`${base}/admin/auth/join?token=${token}`, { redirect: 'manual' });
  assert.equal(join.status, 302);
  assert.equal(join.headers.get('location'), '/admin/auth/signup');
  assert.match(join.headers.getSetCookie().join('\n'), new RegExp(`helmion_admin_join=${token}`));
  assert.equal((await fetch(`${base}/admin/auth/join?token=${token}&mode=signin`, { redirect: 'manual' })).headers.get('location'), '/admin/auth/login');
  assert.equal((await fetch(`${base}/admin/auth/join?token=nope`, { redirect: 'manual' })).headers.get('location'), '/join?error=invalid');
  const cb = await fetch(`${base}/admin/auth/callback?code=c&state=st`, { redirect: 'manual', headers: { cookie: `helmion_admin_login_state=st; helmion_admin_join=${token}; helmion_admin_return=app` } });
  assert.equal(cb.headers.get('location'), '/app/?joined=1');
  assert.deepEqual(calls.find((c) => c[0] === 'redeem'), ['redeem', 'u1', token]);
  assert.match(cb.headers.getSetCookie().join('\n'), /helmion_admin_join=; Max-Age=0/);
});

test('member cannot create invites', async (t) => {
  const store = { create: async () => { throw new Error('must not be called'); }, desktopIdentity: async () => null };
  const base = await harness(t, { role: 'member', store });
  const res = await fetch(`${base}/api/admin/organization/invites`, { method: 'POST', headers: { cookie: 'helmion_admin_session=s', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('desktop bearer token is accepted only on Envoy routes', async (t) => {
  const tok = `hdt_${'b'.repeat(43)}`;
  const store = { desktopIdentity: async (token) => (token === tok ? { subject: 'u1', tenantId: 't1' } : null), exchangeDesktopCode: async (code) => ({ token: tok, tenantId: 't1', code }) };
  const base = await harness(t, { role: 'member', store });
  const auth = { authorization: `Bearer ${tok}` };
  assert.notEqual((await fetch(`${base}/api/admin/envoy/channels`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/session?scope=member`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/cora/approvals`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/envoy/channels`, { headers: { authorization: 'Bearer hdt_wrong' } })).status, 403);
  const ex = await fetch(`${base}/api/admin/desktop/link/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH' }) });
  assert.equal((await ex.json()).token, tok);
});

test('members can read their session with scope=member; admin console still requires owner/admin', async (t) => {
  const base = await harness(t, { role: 'member', store: { desktopIdentity: async () => null } });
  const h = { cookie: 'helmion_admin_session=s' };
  assert.equal((await fetch(`${base}/api/admin/session?scope=member`, { headers: h })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/session`, { headers: h })).status, 403);
});

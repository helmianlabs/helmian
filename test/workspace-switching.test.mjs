import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_SESSION_PATH, LIVE_ADMIN_WORKSPACE_MEMBERSHIPS_PATH, LIVE_ADMIN_WORKSPACE_SELECT_PATH, TENANT_SELECTION_COOKIE, TENANT_SELECTION_HEADER } from '../src/cloud/live-admin.mjs';
import { startCoraClm } from '../src/cora/clm-server.mjs';

// Workspace switching, server selection leg (WS-SWITCH-DESIGN piece 1).
// One subject holding TWO active memberships. As in the raced-signup
// fixture in tenant-membership-pick.test.mjs, the earliest-created row
// carries the alphabetically LATER tenant_id, so only the created_at
// order (or an honoured selection) resolves deterministically.
const SECRET = 'ws-switch-test-secret-0123456789abcdef';
const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback', HELMION_ADMIN_SESSION_SECRET: SECRET };

const TENANTS = {
  'tenant-zzz-first': 'First Workspace',
  'tenant-aaa-second': 'Second Workspace',
  'tenant-not-mine': 'Someone Elses Workspace',
};
const MEMBERSHIPS = [
  { tenant_id: 'tenant-zzz-first', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
  { tenant_id: 'tenant-aaa-second', role: 'member', created_at: '2026-11-04T15:16:42.730Z' },
];
const NOT_A_MEMBER = 'tenant-not-mine';

function pool() {
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('left join helmion.tenants') && q.includes('tenant_id=$2')) {
      // POST select: the (subject, tenant) active-membership proof.
      const row = MEMBERSHIPS.find((m) => m.tenant_id === args[1]);
      return row ? { rowCount: 1, rows: [{ tenant_id: row.tenant_id, role: row.role, display_name: TENANTS[row.tenant_id] }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('left join helmion.tenants')) {
      // GET memberships: the person's own active memberships, named.
      const rows = [...MEMBERSHIPS].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rowCount: rows.length, rows: rows.map((m) => ({ tenant_id: m.tenant_id, role: m.role, display_name: TENANTS[m.tenant_id] })) };
    }
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1')) {
      // requireActiveTenantMembership for the resolved (tenant, subject).
      const row = MEMBERSHIPS.find((m) => m.tenant_id === args[0]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // Tenant resolution: emulate whichever ORDER BY the query asks for.
      const rows = [...MEMBERSHIPS].sort((a, b) => (q.includes('created_at')
        ? (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.tenant_id < b.tenant_id ? -1 : 1))
        : (a.tenant_id < b.tenant_id ? -1 : 1)));
      return { rowCount: rows.length, rows: rows.map(({ tenant_id, role }) => ({ tenant_id, role })) };
    }
    if (q.includes('from helmion.tenants')) {
      // The session read's best-effort workspace-name lookup.
      const name = TENANTS[args[0]];
      return name ? { rowCount: 1, rows: [{ display_name: name }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }, release() {} };
  return { connect: async () => client };
}

const identity = { getSession: (id) => (id === 's1' ? { subject: 'user_two' } : null) };

function fakeResponse() {
  const r = { status: 0, headers: null, body: '',
    writeHead(s, h) { r.status = s; r.headers = h ?? null; },
    write() { return true; },
    end(b) { r.body = b ?? ''; } };
  return r;
}

function sign(tenantId, secret = SECRET) {
  return `${tenantId}.${createHmac('sha256', secret).update(`helmian_tenant:${tenantId}`).digest('base64url')}`;
}

async function makeAdmin(t, overrides = {}) {
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], ...overrides });
  t.after(async () => { await admin.close(); });
  return admin;
}

async function memberSession(admin, extraHeaders = {}) {
  const r = fakeResponse();
  await admin.handler({ method: 'GET', url: `${LIVE_ADMIN_SESSION_PATH}?scope=member`, headers: { cookie: 'helmion_admin_session=s1', host: 'localhost', ...extraHeaders } }, r);
  assert.equal(r.status, 200);
  return JSON.parse(r.body);
}

test('fallback: no selection presented resolves to the earliest-created membership, identical to today', async (t) => {
  const admin = await makeAdmin(t);
  const body = await memberSession(admin);
  assert.equal(body.authenticated, true);
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
  assert.equal(body.actor.role, 'owner');
});

test('switch: a correctly signed helmian_tenant cookie naming the second membership resolves to it', async (t) => {
  const admin = await makeAdmin(t);
  const body = await memberSession(admin, { cookie: `helmion_admin_session=s1; ${TENANT_SELECTION_COOKIE}=${sign('tenant-aaa-second')}` });
  assert.equal(body.actor.tenantId, 'tenant-aaa-second');
  assert.equal(body.actor.role, 'member');
});

test('switch: the x-helmian-tenant header naming the second membership resolves to it', async (t) => {
  const admin = await makeAdmin(t);
  const body = await memberSession(admin, { [TENANT_SELECTION_HEADER]: 'tenant-aaa-second' });
  assert.equal(body.actor.tenantId, 'tenant-aaa-second');
});

test('refusal: a correctly signed cookie naming a workspace the person is NOT a member of falls back, never grants', async (t) => {
  const admin = await makeAdmin(t);
  const body = await memberSession(admin, { cookie: `helmion_admin_session=s1; ${TENANT_SELECTION_COOKIE}=${sign(NOT_A_MEMBER)}` });
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
});

test('refusal: a header naming a non-member workspace falls back, never grants', async (t) => {
  const admin = await makeAdmin(t);
  const body = await memberSession(admin, { [TENANT_SELECTION_HEADER]: NOT_A_MEMBER });
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
});

test('malformed selections fall back: tampered signature and unsigned value in signed mode', async (t) => {
  const admin = await makeAdmin(t);
  const good = sign('tenant-aaa-second');
  const tampered = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
  const a = await memberSession(admin, { cookie: `helmion_admin_session=s1; ${TENANT_SELECTION_COOKIE}=${tampered}` });
  assert.equal(a.actor.tenantId, 'tenant-zzz-first');
  const b = await memberSession(admin, { cookie: `helmion_admin_session=s1; ${TENANT_SELECTION_COOKIE}=tenant-aaa-second` });
  assert.equal(b.actor.tenantId, 'tenant-zzz-first');
});

test('select endpoint: full round trip over HTTP — record a selection, then resolve under it', async (t) => {
  const admin = await makeAdmin(t);
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const sessionCookie = 'helmion_admin_session=s1';

  // Memberships before any selection: both listed in created order,
  // the earliest-created marked selected (today's resolution).
  const before = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_MEMBERSHIPS_PATH}`, { headers: { cookie: sessionCookie } });
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json()).memberships, [
    { tenantId: 'tenant-zzz-first', name: 'First Workspace', role: 'owner', selected: true },
    { tenantId: 'tenant-aaa-second', name: 'Second Workspace', role: 'member', selected: false },
  ]);

  // Record the selection.
  const select = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_SELECT_PATH}`, { method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'tenant-aaa-second' }) });
  assert.equal(select.status, 200);
  const selectBody = await select.json();
  assert.equal(selectBody.valid, true);
  assert.deepEqual(selectBody.selected, { tenantId: 'tenant-aaa-second', name: 'Second Workspace', role: 'member' });
  const setCookies = select.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.ok(setCookies[0].startsWith(`${TENANT_SELECTION_COOKIE}=${sign('tenant-aaa-second')};`));
  assert.ok(setCookies[0].includes('Path=/api/admin'));
  assert.ok(setCookies[0].includes('HttpOnly'));

  // Resolve under the recorded selection.
  const selectionCookie = setCookies[0].split(';')[0];
  const resolved = await fetch(`${base}${LIVE_ADMIN_SESSION_PATH}?scope=member`, { headers: { cookie: `${sessionCookie}; ${selectionCookie}` } });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).actor.tenantId, 'tenant-aaa-second');

  // The memberships list now marks the selection as current.
  const after = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_MEMBERSHIPS_PATH}`, { headers: { cookie: `${sessionCookie}; ${selectionCookie}` } });
  assert.equal(after.status, 200);
  assert.deepEqual((await after.json()).memberships.map((m) => m.selected), [false, true]);
});

test('select endpoint: a non-member selection is refused with 403 and sets no cookie', async (t) => {
  const admin = await makeAdmin(t);
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const res = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_SELECT_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=s1', 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: NOT_A_MEMBER }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'WORKSPACE_SELECTION_MEMBERSHIP_REQUIRED');
  assert.equal(res.headers.getSetCookie().length, 0);
});

test('select endpoint: no member session is refused, and extra body fields are rejected', async (t) => {
  const admin = await makeAdmin(t);
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const anon = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_SELECT_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'tenant-aaa-second' }) });
  assert.equal(anon.status, 403);
  assert.equal((await anon.json()).code, 'WORKSPACE_SELECTION_SESSION_REQUIRED');
  const extra = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_SELECT_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=s1', 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'tenant-aaa-second', admin: true }) });
  assert.equal(extra.status, 400);
});

test('memberships endpoint: no session refuses', async (t) => {
  const admin = await makeAdmin(t);
  const r = fakeResponse();
  await admin.handler({ method: 'GET', url: LIVE_ADMIN_WORKSPACE_MEMBERSHIPS_PATH, headers: { host: 'localhost' } }, r);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).code, 'ADMIN_MEMBERSHIP_REQUIRED');
});

test('no-secret mode mirrors the session fallback: the plain tenant id is the cookie value and is honoured', async (t) => {
  const { HELMION_ADMIN_SESSION_SECRET: _dropped, ...envNoSecret } = env;
  const admin = await makeAdmin(t, { env: envNoSecret });
  const body = await memberSession(admin, { cookie: 'helmion_admin_session=s1; helmian_tenant=tenant-aaa-second' });
  assert.equal(body.actor.tenantId, 'tenant-aaa-second');
});

// --- Piece 1b: the admin (owner-console) leg ---------------------------
// The default session read (no ?scope=member) resolves through
// deriveAdminActor, over owner/admin rows only. Two subjects:
//  - user_admin_two: owner in the earliest-created tenant, admin in a
//    second, and a plain member in a third. The console follows a
//    presented selection among the ADMIN rows — and refuses while no
//    selection is presented (the clm placeholder's denial).
//  - user_admin_one: admin in exactly one tenant, member in another
//    (and that member row is the earlier-created one). The fallback
//    subject: selection or not, the console resolves to the one admin
//    tenant, identical to before piece 1b.
const ADMIN_TENANT_NAMES = {
  'tenant-zzz-first': 'First Workspace',
  'tenant-aaa-second': 'Second Workspace',
  'tenant-member-only': 'Member Only Workspace',
  'tenant-not-mine': 'Someone Elses Workspace',
};
const ADMIN_MEMBERSHIPS = {
  user_admin_two: [
    { tenant_id: 'tenant-zzz-first', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
    { tenant_id: 'tenant-aaa-second', role: 'admin', created_at: '2026-11-04T15:16:42.730Z' },
    { tenant_id: 'tenant-member-only', role: 'member', created_at: '2026-11-04T15:16:42.790Z' },
  ],
  user_admin_one: [
    { tenant_id: 'tenant-aaa-second', role: 'member', created_at: '2026-11-04T15:16:42.670Z' },
    { tenant_id: 'tenant-zzz-first', role: 'admin', created_at: '2026-11-04T15:16:42.730Z' },
  ],
};

function adminPool() {
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    const mine = ADMIN_MEMBERSHIPS[args[0]] ?? [];
    if (q.includes('left join helmion.tenants') && q.includes('tenant_id=$2')) {
      const row = mine.find((m) => m.tenant_id === args[1]);
      return row ? { rowCount: 1, rows: [{ tenant_id: row.tenant_id, role: row.role, display_name: ADMIN_TENANT_NAMES[row.tenant_id] }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('left join helmion.tenants')) {
      const rows = [...mine].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rowCount: rows.length, rows: rows.map((m) => ({ tenant_id: m.tenant_id, role: m.role, display_name: ADMIN_TENANT_NAMES[m.tenant_id] })) };
    }
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1')) {
      // requireActiveTenantMembership for the resolved (tenant, subject).
      const row = (ADMIN_MEMBERSHIPS[args[1]] ?? []).find((m) => m.tenant_id === args[0]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // Deriver queries: the admin deriver's SQL filters to owner/admin
      // rows; the member deriver's does not. Emulate both, with
      // whichever ORDER BY the query asks for.
      const scoped = q.includes("role in ('owner','admin')") ? mine.filter((m) => ['owner', 'admin'].includes(m.role)) : mine;
      const rows = [...scoped].sort((a, b) => (q.includes('created_at')
        ? (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.tenant_id < b.tenant_id ? -1 : 1))
        : (a.tenant_id < b.tenant_id ? -1 : 1)));
      return { rowCount: rows.length, rows: rows.map(({ tenant_id, role }) => ({ tenant_id, role })) };
    }
    if (q.includes('from helmion.tenants')) {
      const name = ADMIN_TENANT_NAMES[args[0]];
      return name ? { rowCount: 1, rows: [{ display_name: name }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }, release() {} };
  return { connect: async () => client };
}

const adminIdentity = { getSession: (id) => (id === 'a2' ? { subject: 'user_admin_two' } : id === 'a1' ? { subject: 'user_admin_one' } : null) };

async function makeConsole(t) {
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: adminPool(), identity: adminIdentity, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  t.after(async () => { await admin.close(); });
  return admin;
}

async function consoleSession(admin, sessionId, extraHeaders = {}) {
  const r = fakeResponse();
  await admin.handler({ method: 'GET', url: LIVE_ADMIN_SESSION_PATH, headers: { cookie: `helmion_admin_session=${sessionId}`, host: 'localhost', ...extraHeaders } }, r);
  return { status: r.status, body: JSON.parse(r.body) };
}

test('admin switch: a correctly signed cookie naming the second admin tenant resolves the console session to it', async (t) => {
  const admin = await makeConsole(t);
  const { status, body } = await consoleSession(admin, 'a2', { cookie: `helmion_admin_session=a2; ${TENANT_SELECTION_COOKIE}=${sign('tenant-aaa-second')}` });
  assert.equal(status, 200);
  assert.equal(body.actor.tenantId, 'tenant-aaa-second');
  assert.equal(body.actor.role, 'admin');
});

test('admin switch: the x-helmian-tenant header naming the earliest admin tenant resolves the console session to it', async (t) => {
  const admin = await makeConsole(t);
  const { status, body } = await consoleSession(admin, 'a2', { [TENANT_SELECTION_HEADER]: 'tenant-zzz-first' });
  assert.equal(status, 200);
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
  assert.equal(body.actor.role, 'owner');
});

test('admin denial: two admin tenants and no selection presented is refused 403 until a selection is presented', async (t) => {
  const admin = await makeConsole(t);
  const { status, body } = await consoleSession(admin, 'a2');
  assert.equal(status, 403);
  assert.equal(body.authenticated, false);
  assert.equal(body.code, 'ADMIN_MEMBERSHIP_REQUIRED');
});

test('admin denial: a selection naming a workspace held only as member, or not held at all, does not resolve the console', async (t) => {
  const admin = await makeConsole(t);
  const memberOnly = await consoleSession(admin, 'a2', { cookie: `helmion_admin_session=a2; ${TENANT_SELECTION_COOKIE}=${sign('tenant-member-only')}` });
  assert.equal(memberOnly.status, 403);
  const notMine = await consoleSession(admin, 'a2', { cookie: `helmion_admin_session=a2; ${TENANT_SELECTION_COOKIE}=${sign('tenant-not-mine')}` });
  assert.equal(notMine.status, 403);
});

test('admin fallback: a single-admin-tenant subject with no selection resolves to that tenant, identical to before', async (t) => {
  const admin = await makeConsole(t);
  const { status, body } = await consoleSession(admin, 'a1');
  assert.equal(status, 200);
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
  assert.equal(body.actor.role, 'admin');
});

test('admin fallback: a single-admin-tenant subject selecting their member workspace still resolves to their admin tenant', async (t) => {
  const admin = await makeConsole(t);
  const { status, body } = await consoleSession(admin, 'a1', { cookie: `helmion_admin_session=a1; ${TENANT_SELECTION_COOKIE}=${sign('tenant-aaa-second')}` });
  assert.equal(status, 200);
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
  assert.equal(body.actor.role, 'admin');
});

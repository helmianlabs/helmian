import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_CONTROL_PATH,
  LIVE_ADMIN_PAGE_PATH,
  LIVE_ADMIN_SESSION_PATH,
} from '../src/cloud/live-admin.mjs';

const databaseUrl = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';
const env = {
  HELMION_CLOUD_ENVIRONMENT: 'staging',
  HELMION_CORA_PROVIDER: 'claude',
  HELMION_DATABASE_URL: databaseUrl,
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
  HELMION_CORA_TOKEN: 'x'.repeat(32),
  HELMION_AIMFORGE_BRIDGE_SECRET: 'b'.repeat(32),
  HELMION_AIMFORGE_ACTION_SECRET: 'a'.repeat(32),
  HELMION_AIMFORGE_API_BASE_URL: 'https://aimforge-api.fly.dev',
  HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
  HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
  ANTHROPIC_API_KEY: 'configured-outside-git',
};

function fakePool({ membershipRoles = { 'tenant-a': 'admin' } } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      queries.push({ text, values });
      if (text.includes('tenant_memberships')) {
        if (text.includes("role in ('owner','admin')")) {
          const rows = Object.entries(membershipRoles).map(([tenant_id, role]) => ({ tenant_id, role }));
          return { rowCount: rows.length, rows };
        }
        const role = membershipRoles[values[0]] ?? null;
        return role ? { rowCount: 1, rows: [{ role }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('from helmion.tenants')) return { rowCount: 1, rows: [{ tenant_id: 'tenant-a', display_name: 'Tenant A' }] };
      if (text.includes('from helmion.audit_events')) return { rowCount: 1, rows: [{ count: 7 }] };
      if (text.includes('from helmion.audit_outbox')) return { rowCount: 1, rows: [{ count: 1 }] };
      if (text.includes("to_regclass('helmion.schema_migrations')")) return { rowCount: 1, rows: [{ migration_table: 'helmion.schema_migrations' }] };
      if (text.includes('from helmion.schema_migrations')) {
        return { rowCount: 2, rows: [
          { version: '001', name: '001_helmion.sql', checksum: 'a'.repeat(64) },
          { version: '002', name: '002_maestro.sql', checksum: 'b'.repeat(64) },
        ] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { queries, connect: async () => client };
}

function identity() {
  return {
    getSession: (sessionId) => sessionId === 'active-session'
      ? { subject: 'user-1' }
      : null,
    beginLogin: async () => ({ url: 'https://identity.example.com/authorize', state: 'state-1' }),
    finishLogin: async () => ({ sessionId: 'active-session' }),
  };
}

async function fixture(options = {}) {
  const pool = fakePool(options);
  const admin = await createLiveHelmianCloudAdminHandler({
    env,
    pool,
    identity: identity(),
    page: '<!doctype html><title>Admin</title>',
    script: 'void 0;',
    expectedMigrations: [
      { version: '001', name: '001_helmion.sql', checksum: 'a'.repeat(64) },
      { version: '002', name: '002_maestro.sql', checksum: 'b'.repeat(64) },
    ],
  });
  const clm = await startCoraClm({
    host: '127.0.0.1',
    port: 0,
    runTurn: async () => ({ text: 'ok', model: 'test' }),
    notifyBackgroundAgents: false,
    httpRequestHandler: admin.handler,
  });
  return {
    pool,
    url: clm.healthUrl.replace('/healthz', ''),
    close: async () => { await clm.close(); await admin.close(); },
  };
}

test('live admin is mounted under /admin on the CLM port and never replaces /llm', async (t) => {
  const app = await fixture();
  t.after(app.close);
  const root = await fetch(`${app.url}/`);
  const llm = await fetch(`${app.url}/llm`);
  const mount = await fetch(`${app.url}${LIVE_ADMIN_PAGE_PATH}`, { redirect: 'manual' });
  const page = await fetch(`${app.url}${LIVE_ADMIN_PAGE_PATH}/`);
  assert.equal(root.status, 426);
  assert.equal(llm.status, 426);
  assert.equal(mount.status, 308);
  assert.equal(mount.headers.get('location'), '/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/u);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/u);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${app.url}/auth/login`)).status, 426);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}`, { method: 'POST' })).status, 405);
  const login = await fetch(`${app.url}/admin/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.match(login.headers.get('set-cookie') ?? '', /Path=\/admin; HttpOnly; Secure; SameSite=Lax/u);
  const callback = await fetch(`${app.url}/admin/auth/callback?code=code&state=state-1`, {
    redirect: 'manual', headers: { cookie: 'helmion_admin_login_state=state-1' },
  });
  assert.equal(callback.headers.get('location'), '/admin/');
  assert.match(callback.headers.get('set-cookie') ?? '', /Path=\/api\/admin; HttpOnly; Secure; SameSite=Lax/u);
  const logout = await fetch(`${app.url}/admin/auth/logout`, {
    redirect: 'manual', headers: { cookie: 'helmion_admin_session=active-session' },
  });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), '/admin/');
});

test('session and readiness routes require live Neon owner/admin membership and remain tenant scoped', async (t) => {
  const app = await fixture();
  t.after(app.close);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`)).status, 403);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const session = await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers });
  assert.equal(session.status, 200);
  assert.deepEqual((await session.json()).actor, { subject: 'user-1', tenantId: 'tenant-a', role: 'admin' });
  const response = await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}?tenant_id=tenant-b`, { headers });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.tenant.tenant_id, 'tenant-a');
  assert.equal(result.authorization, 'oidc_identity_plus_neon_membership_verified');
  assert.deepEqual(result.tools.names, [
    'aimforge_get_dispatch_board_summary',
    'aimforge_prepare_driver_message',
    'aimforge_create_department_handoff',
  ]);
  assert.equal(result.tools.genericTools, false);
  assert.equal(result.release.ready, true);
  assert.equal(result.migrations.ready, true);
  assert.deepEqual(result.audit, { eventCount: 7, pendingOutboxCount: 1 });
  assert.equal(result.invocation, 'read_only');
  assert.equal(result.mutation, 'not_performed');
  const membershipQueries = app.pool.queries.filter(({ text }) => text.includes('tenant_memberships'));
  assert.ok(membershipQueries.length >= 2);
  assert.ok(membershipQueries.some(({ values }) => values[0] === 'user-1'));
  assert.ok(membershipQueries.some(({ values }) => values[0] === 'tenant-a' && values[1] === 'user-1'));
});

test('revoked OIDC subjects fail closed against current Neon membership', async (t) => {
  const app = await fixture({ membershipRoles: {} });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}`, { headers })).status, 403);
});

test('a subject with two admin tenants is denied until a server-bound picker exists', async (t) => {
  const app = await fixture({ membershipRoles: { 'tenant-a': 'admin', 'tenant-b': 'owner' } });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}?tenant_id=tenant-b`, { headers })).status, 403);
});

test('a current role change from admin to member immediately removes admin access', async (t) => {
  const app = await fixture({ membershipRoles: { 'tenant-a': 'member' } });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
});

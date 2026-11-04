import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_SESSION_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

// The raced-signup pair seen live 2026-11-04: two active owner memberships
// for one subject, created 60 ms apart. The earliest-created row carries
// the alphabetically LATER tenant_id, so a pick by tenant_id order (or a
// refusal on duplicates) both fail this fixture — only the created_at
// pick resolves to the first workspace.
const MEMBERSHIPS = [
  { tenant_id: 'tenant-zzz-first', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
  { tenant_id: 'tenant-aaa-second', role: 'owner', created_at: '2026-11-04T15:16:42.730Z' },
];

function pool() {
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1')) {
      // requireActiveTenantMembership for the resolved (tenant, subject).
      const row = MEMBERSHIPS.find((m) => m.tenant_id === args[0]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // Emulate whichever ORDER BY the query asks for.
      const rows = [...MEMBERSHIPS].sort((a, b) => (q.includes('created_at')
        ? (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.tenant_id < b.tenant_id ? -1 : 1))
        : (a.tenant_id < b.tenant_id ? -1 : 1)));
      return { rowCount: rows.length, rows: rows.map(({ tenant_id, role }) => ({ tenant_id, role })) };
    }
    return { rowCount: 0, rows: [] };
  }, release() {} };
  return { connect: async () => client };
}

function fakeResponse() {
  const r = { status: 0, headers: null, body: '',
    writeHead(s, h) { r.status = s; r.headers = h ?? null; },
    write() { return true; },
    end(b) { r.body = b ?? ''; } };
  return r;
}

test('a subject with two active memberships resolves to the earliest-created one, no refusal', async (t) => {
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: { getSession: (id) => (id === 's1' ? { subject: 'user_dup1' } : null) }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  t.after(async () => { await admin.close(); });
  const r = fakeResponse();
  await admin.handler({ method: 'GET', url: `${LIVE_ADMIN_SESSION_PATH}?scope=member`, headers: { cookie: 'helmion_admin_session=s1', host: 'localhost' } }, r);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.authenticated, true);
  assert.equal(body.actor.subject, 'user_dup1');
  assert.equal(body.actor.tenantId, 'tenant-zzz-first');
  assert.equal(body.actor.role, 'owner');
});

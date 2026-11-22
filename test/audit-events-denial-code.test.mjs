import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_EVENTS_PATH } from '../src/cloud/live-admin.mjs';

const env = {
  HELMION_CLOUD_ENVIRONMENT: 'staging',
  HELMION_CORA_PROVIDER: 'claude',
  HELMION_DATABASE_URL: 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require',
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4',
  HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian-cloud-admin',
  HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
};

function fakePool() {
  const client = {
    async query(sql) {
      const text = String(sql);
      if (text.includes('tenant_memberships')) {
        if (text.includes('where subject=$1')) return { rowCount: 1, rows: [{ tenant_id: 'helmian-platform', role: 'owner', job_title: 'owner' }] };
        return { rowCount: 1, rows: [{ role: 'owner' }] };
      }
      if (text.includes("to_regclass('helmion.schema_migrations')")) return { rowCount: 1, rows: [{ migration_table: 'helmion.schema_migrations' }] };
      if (text.includes('from helmion.schema_migrations')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client };
}

test('the events route names an attribute-policy denial with its own code', async (t) => {
  const auditEventRepository = {
    async list() { throw Object.assign(new Error('Attribute policy denied audit read'), { status: 403, code: 'AUDIT_ATTRIBUTE_POLICY_DENIED' }); },
  };
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: fakePool(),
    identity: { issuer: env.HELMION_ADMIN_ISSUER, getSession: (id) => (id === 'active-session' ? { subject: 'user-1' } : null), beginLogin: async () => ({ url: 'https://identity.example.com/authorize', state: 's' }), finishLogin: async () => ({ sessionId: 'active-session' }) },
    page: '<!doctype html><title>Admin</title>', script: 'void 0;', expectedMigrations: [], auditEventRepository,
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const url = clm.healthUrl.replace('/healthz', '');
  const res = await fetch(`${url}${LIVE_ADMIN_EVENTS_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'AUDIT_ATTRIBUTE_POLICY_DENIED');
});

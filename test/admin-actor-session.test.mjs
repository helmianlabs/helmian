import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };
function pool() {
  const client = { async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] }; return { rowCount: 0, rows: [] }; }, release() {} };
  return { connect: async () => client };
}

test('owner/admin routes hand repositories an actor with session and request ids', async (t) => {
  const seen = [];
  const coraConfigRepository = new Proxy({}, { get: (_t, name) => async (actor) => { seen.push([name, actor]); return { sources: [], packs: [], snippets: [], configs: [] }; } });
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: { getSession: () => ({ subject: 'user-1' }) }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [], coraConfigRepository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 't' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  for (const path of ['/api/admin/cora/knowledge/manage', '/api/admin/cora/configs']) {
    const res = await fetch(`${base}${path}`, { headers: { cookie: 'helmion_admin_session=s' } });
    assert.equal(res.status, 200, path);
  }
  for (const [, actor] of seen) { assert.ok(actor.sessionId); assert.ok(actor.requestId); assert.equal(actor.tenantId, 'customer-a'); }
});

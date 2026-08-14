import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_ORGANIZATION_DATABASE_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function pool() {
  const client = { async query(sql, values = []) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'member' }] }; throw new Error(`unexpected query ${q}`); }, release() {} };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

test('authenticated future customer-data resolver derives Organization and rejects selectors', async (t) => {
  const calls = [];
  const databaseRepository = { async resolve(actor) { calls.push(actor); return { status: 'unavailable', reason: 'future customer-data adapter is not enabled', organizationId: actor.tenantId, logicalDatabaseLocator: 'customer-a-primary', secretReferenceName: 'neon/customer-a-primary', region: 'us-east-2', lifecycle: 'planned', connectionString: null }; } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], organizationDatabaseRepository: databaseRepository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const response = await fetch(`${base}${LIVE_ADMIN_ORGANIZATION_DATABASE_PATH}`, { headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.organizationId, 'customer-a');
  assert.equal(body.status, 'unavailable');
  assert.equal(body.connectionString, null);
  assert.equal(calls[0].tenantId, 'customer-a');
  assert.equal(calls[0].subject, 'user-1');
  assert.equal((await fetch(`${base}${LIVE_ADMIN_ORGANIZATION_DATABASE_PATH}?organization_id=customer-b`, { headers })).status, 400);
  assert.equal((await fetch(`${base}${LIVE_ADMIN_ORGANIZATION_DATABASE_PATH}?plant_id=warehouse-1`, { headers })).status, 400);
});

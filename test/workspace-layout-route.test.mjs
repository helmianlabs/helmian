import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_WORKSPACE_LAYOUT_PATH, LIVE_ADMIN_WORKSPACE_LAYOUT_RESET_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };
function pool() { const client = { async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'member' }] }; throw new Error(`unexpected query ${q}`); }, release() {} }; return { connect: async () => client }; }
function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

test('workspace layout route is authenticated, user-scoped, and resettable', async (t) => {
  const calls = [];
  const layout = { async read(actor) { calls.push(['read', actor]); return { layout: { visibleShelves: ['chat', 'cora', 'prepare', 'artifact', 'governance'], panelOrder: ['chat', 'cora', 'prepare', 'artifact', 'governance'], density: 'comfortable', defaultEnvoyChannelId: null, source: 'role_default' } }; }, async save(actor, input) { calls.push(['save', actor, input]); return { layout: { ...input, source: 'role_default_plus_user_override' } }; }, async reset(actor) { calls.push(['reset', actor]); return { reset: true, layout: { density: 'comfortable', source: 'role_default' } }; } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], workspaceLayoutRepository: layout });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', ''); const headers = { cookie: 'helmion_admin_session=active-session' };
  const read = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_PATH}`, { headers }); assert.equal(read.status, 200); assert.equal((await read.json()).layout.source, 'role_default');
  const body = { visibleShelves: ['chat', 'cora', 'prepare', 'artifact', 'governance'], panelOrder: ['cora', 'chat', 'prepare', 'artifact', 'governance'], density: 'compact', defaultEnvoyChannelId: null };
  const save = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(save.status, 200); assert.equal((await save.json()).layout.density, 'compact');
  assert.equal((await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_PATH}?organization_id=customer-b`, { headers })).status, 400);
  assert.equal((await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_PATH}?subject=user-2`, { headers })).status, 400);
  const injected = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, plantId: 'warehouse-1' }) }); assert.equal(injected.status, 400);
  const reset = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_RESET_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }); assert.equal(reset.status, 200); assert.equal((await reset.json()).reset, true); assert.equal(calls[0][1].tenantId, 'customer-a'); assert.equal(calls[0][1].subject, 'user-1');
  assert.equal((await fetch(`${base}${LIVE_ADMIN_WORKSPACE_LAYOUT_RESET_PATH}?plant_id=warehouse-1`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 400);
});

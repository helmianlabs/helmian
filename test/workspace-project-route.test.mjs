import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_WORKSPACE_PROJECTS_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function pool(role = 'member') {
  const client = { async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role }] }; if (q.includes('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: 'rbac-receipt-1' }] }; throw new Error(`unexpected query ${q}`); }, release() {} };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

test('workspace project registry is tenant-scoped and read-only for members', async (t) => {
  const calls = [];
  const repository = { async list(actor) { calls.push(['list', actor]); return { projects: [{ projectKey: 'aimforge', displayName: 'AimForge', sourceKind: 'cloud', defaultBranch: 'main', lifecycle: 'active', execution: 'not_performed', sourceInventory: 'not_connected' }], canManage: false }; }, async save() { throw new Error('member save should not run'); } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool('member'), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], workspaceProjectRepository: repository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const read = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_PROJECTS_PATH}`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).projects[0].projectKey, 'aimforge');
  assert.equal(calls[0][1].tenantId, 'customer-a');
  assert.equal((await fetch(`${base}${LIVE_ADMIN_WORKSPACE_PROJECTS_PATH}?organization_id=other`, { headers })).status, 400);
  const denied = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_PROJECTS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ projectKey: 'bad', displayName: 'Bad', sourceKind: 'cloud', defaultBranch: 'main', lifecycle: 'active' }) });
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.code, 'WORKSPACE_PROJECTS_ACTION_DENIED');
  assert.equal(deniedBody.receiptId, 'rbac-receipt-1');
});

test('workspace project registration is owner/admin-only and exact-keyed', async (t) => {
  const calls = [];
  const repository = { async list(actor) { calls.push(['list', actor]); return { projects: [], canManage: true }; }, async save(actor, input) { calls.push(['save', actor, input]); return { durable: true, project: { projectKey: input.projectKey, execution: 'not_performed' }, source: 'tenant_workspace_project_registry' }; } };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool('admin'), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], workspaceProjectRepository: repository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' };
  const body = { projectKey: 'helmion-cloud', displayName: 'Helmion Cloud', sourceKind: 'cloud', defaultBranch: 'main', lifecycle: 'active' };
  const saved = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_PROJECTS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).durable, true);
  assert.equal(calls[0][1].tenantId, 'customer-a');
  const injected = await fetch(`${base}${LIVE_ADMIN_WORKSPACE_PROJECTS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ ...body, tenantId: 'other' }) });
  assert.equal(injected.status, 400);
});

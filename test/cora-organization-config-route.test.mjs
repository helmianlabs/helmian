import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_CORA_CONFIG_PATH,
  LIVE_ADMIN_CORA_CONFIGS_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_PATH,
  LIVE_ADMIN_CORA_USAGE_PATH,
  LIVE_ADMIN_CORA_PREVIEW_PATH,
} from '../src/cloud/live-admin.mjs';

const env = {
  HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require',
  HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com',
  HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback',
};

function fakePool() {
  const memberships = { member: { tenant_id: 'org-a', role: 'member' }, admin: { tenant_id: 'org-a', role: 'admin' } };
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && q.includes('role in')) {
      const row = memberships[values[0]]; return row && row.role !== 'member' ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    if (q.startsWith('select role from helmion.tenant_memberships')) {
      const row = memberships[values[1]];
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      const row = memberships[values[0]]; return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected route query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'member-session' ? { subject: 'member' } : id === 'admin-session' ? { subject: 'admin' } : null }; }

async function fixture() {
  const calls = [];
  const repository = {
    async readPublishedConfig(actor) { calls.push(['read', actor]); return { status: 'published', config: { organizationId: actor.tenantId, lifecycle: 'published' } }; },
    async listKnowledgeSources(actor) { calls.push(['knowledge', actor]); return { sources: [{ sourceKey: 'manual', lifecycle: 'approved' }] }; },
    async createDraft(actor, input) { calls.push(['draft', actor, input]); return { config: { lifecycle: 'draft', organizationId: actor.tenantId } }; },
    async transition() { throw new Error('not used'); },
  };
  const usageRepository = {
    async readSummary(actor) { calls.push(['usage-summary', actor]); return { budget: null, totals: { eventCount: 0, estimatedCostMinor: 0, reconciledCostMinor: null }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' }; },
    async list(actor, limit) { calls.push(['usage-list', actor, limit]); return { events: [] }; },
  };
  const previewRepository = {
    async append(actor, input) { calls.push(['preview-append', actor, input]); return { durable: true, format: 'cora.workspace-preview-intent.v1', status: 'preview-ready', receiptId: 'receipt-1', execution: 'not_performed' }; },
    async list(actor) { calls.push(['preview-list', actor]); return { receipts: [] }; },
  };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: fakePool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], coraConfigRepository: repository, providerUsageRepository: usageRepository, workspacePreviewRepository: previewRepository });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  return { url: clm.healthUrl.replace('/healthz', ''), calls, close: async () => { await clm.close(); await admin.close(); } };
}

test('authenticated Cora reads derive Organization from membership and reject URL selectors', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session' };
  const config = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIG_PATH}`, { headers });
  assert.equal(config.status, 200);
  assert.equal((await config.json()).config.organizationId, 'org-a');
  const knowledge = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_PATH}?tenant_id=org-b`, { headers });
  assert.equal(knowledge.status, 400);
  assert.equal(app.calls[0][1].tenantId, 'org-a');
});

test('normal members cannot create Cora drafts; admin draft route has no body Organization selector', async (t) => {
  const app = await fixture(); t.after(app.close);
  const member = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' }, body: JSON.stringify({ config: {}, reason: 'x', provenance: {} }) });
  assert.equal(member.status, 403);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: 'org-b', config: {}, reason: 'x', provenance: {} }) });
  assert.equal(injected.status, 400);
  const draft = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify({ config: {}, reason: 'review', provenance: {} }) });
  assert.equal(draft.status, 200);
  assert.equal((await draft.json()).config.organizationId, 'org-a');
});

test('authenticated usage metadata derives Organization from membership and rejects selectors', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session' };
  const summary = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}`, { headers });
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).providerCalls, 'not_performed');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}?organization_id=org-b`, { headers });
  assert.equal(injected.status, 400);
  const memberDetail = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}?limit=10`, { headers });
  assert.equal(memberDetail.status, 200);
  assert.equal(app.calls.some(([name]) => name === 'usage-list'), false);
  const adminDetail = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}?limit=10`, { headers: { cookie: 'helmion_admin_session=admin-session' } });
  assert.equal(adminDetail.status, 200);
  assert.equal(app.calls.some(([name]) => name === 'usage-list'), true);
});

test('authenticated preview intent derives Organization, rejects selectors, and never executes', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const body = { mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'operations-desk', title: 'Desk preview', idempotencyKey: 'preview-0001' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_PREVIEW_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).execution, 'not_performed');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_PREVIEW_PATH}?plant_id=warehouse-1`, { headers });
  assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor]) => name === 'preview-append' && actor.tenantId === 'org-a'), true);
});

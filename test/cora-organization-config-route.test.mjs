import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_CORA_CONFIG_PATH,
  LIVE_ADMIN_CORA_CONFIGS_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_QUERY_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_MANAGE_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_SOURCES_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_PACKS_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_SNIPPETS_PATH,
  LIVE_ADMIN_CORA_KNOWLEDGE_TRANSITION_PATH,
  LIVE_ADMIN_CORA_USAGE_PATH,
  LIVE_ADMIN_CORA_PREVIEW_PATH,
  LIVE_ADMIN_CORA_TASKS_PATH,
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
    async listKnowledgeAdmin(actor) { calls.push(['knowledge-admin', actor]); return { sources: [{ sourceId: 'source-1', sourceKey: 'manual', lifecycle: 'draft' }], packs: [], snippets: [] }; },
    async createKnowledgeSource(actor, input) { calls.push(['knowledge-source-create', actor, input]); return { source: { sourceId: 'source-1', lifecycle: 'draft' } }; },
    async createKnowledgePack(actor, input) { calls.push(['knowledge-pack-create', actor, input]); return { pack: { packId: 'pack-1', lifecycle: 'draft' } }; },
    async createKnowledgeSnippet(actor, input) { calls.push(['knowledge-snippet-create', actor, input]); return { snippet: { snippetId: 'snippet-1', citation: input.citation } }; },
    async transitionKnowledge(actor, input) { calls.push(['knowledge-transition', actor, input]); return { kind: input.kind, id: input.id, lifecycle: input.lifecycle, reviewReceiptId: 'review-1' }; },
    async queryApprovedKnowledge(actor, query) { calls.push(['knowledge-query', actor, query]); return { format: 'cora.approved-knowledge-retrieval.v1', status: 'approved_sources_only', query, answer: null, providerCall: 'not_performed', excerpts: [{ excerpt: 'Stored hours-of-service excerpt.', citation: 'FMCSA §3', provenance: 'reviewed source' }], citations: ['FMCSA §3'] }; },
    async listConfigs(actor) { calls.push(['config-history', actor]); return { configs: [{ configVersion: 2, lifecycle: 'draft', reason: 'review', createdBySubject: actor.subject, isCurrent: false }] }; },
    async createDraft(actor, input) { calls.push(['draft', actor, input]); return { config: { lifecycle: 'draft', organizationId: actor.tenantId } }; },
    async transition() { throw new Error('not used'); },
  };
  const usageRepository = {
    async readSummary(actor) { calls.push(['usage-summary', actor]); return { budget: { period: 'monthly', currency: 'USD', softLimitMinor: null, hardLimitMinor: null, lowCostLimitMinor: null, policyState: 'active', allocations: [] }, totals: { eventCount: 0, estimatedCostMinor: null, reconciledCostMinor: null }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' }; },
    async savePolicy(actor, input) { calls.push(['usage-policy-save', actor, input]); return { policy: input, updatedBySubject: actor.subject, source: 'organization_budget_policy', providerCalls: 'not_performed' }; },
    async list(actor, limit) { calls.push(['usage-list', actor, limit]); return { events: [] }; },
  };
  const previewRepository = {
    async append(actor, input) { calls.push(['preview-append', actor, input]); return { durable: true, format: 'cora.workspace-preview-intent.v1', status: 'preview-ready', receiptId: 'receipt-1', execution: 'not_performed' }; },
    async list(actor) { calls.push(['preview-list', actor]); return { receipts: [] }; },
  };
  const agentTaskRepository = {
    async append(actor, input) { calls.push(['task-append', actor, input]); return { durable: true, format: 'cora.agent-task-intent.v1', taskType: input.taskType, status: input.intent === 'prepare' ? 'prepared' : 'draft', receiptId: 'task-receipt-1', execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed' }; },
    async list(actor) { calls.push(['task-list', actor]); return { receipts: [] }; },
  };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: fakePool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], coraConfigRepository: repository, providerUsageRepository: usageRepository, workspacePreviewRepository: previewRepository, agentTaskRepository });
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

test('Cora config history is admin-only, Organization-derived, and rejects selectors', async (t) => {
  const app = await fixture(); t.after(app.close);
  const member = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}`, { headers: { cookie: 'helmion_admin_session=member-session' } });
  assert.equal(member.status, 403);
  const admin = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}`, { headers: { cookie: 'helmion_admin_session=admin-session' } });
  assert.equal(admin.status, 200); assert.equal((await admin.json()).configs[0].lifecycle, 'draft');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_CONFIGS_PATH}?plant_id=warehouse-1`, { headers: { cookie: 'helmion_admin_session=admin-session' } });
  assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor]) => name === 'config-history' && actor.tenantId === 'org-a'), true);
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

test('budget policy changes are owner/admin-only and reject Organization, Plant, and provider selectors', async (t) => {
  const app = await fixture(); t.after(app.close);
  const body = { period: 'monthly', currency: 'USD', softLimitMinor: 1000, hardLimitMinor: 2000, lowCostLimitMinor: 100, policyState: 'active', allocations: [{ allocationKey: 'ops', department: 'operations', costCenter: null, softLimitMinor: 500, hardLimitMinor: 1000, enabled: true }] };
  const member = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(member.status, 403);
  const admin = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(admin.status, 200); assert.equal((await admin.json()).policy.allocations[0].allocationKey, 'ops');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, plantId: 'warehouse-1' }) }); assert.equal(injected.status, 400);
  const urlInjected = await fetch(`${app.url}${LIVE_ADMIN_CORA_USAGE_PATH}?facility_id=warehouse-1`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(urlInjected.status, 400);
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

test('authenticated task intents derive Organization, reject selectors and remain unexecuted', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const body = { taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare an operations preview', idempotencyKey: 'task-0001' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_TASKS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 200); assert.equal((await created.json()).execution, 'not_performed');
  const listed = await fetch(`${app.url}${LIVE_ADMIN_CORA_TASKS_PATH}`, { headers }); assert.equal(listed.status, 200);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_TASKS_PATH}?plant_id=warehouse-1`, { headers }); assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor]) => name === 'task-append' && actor.tenantId === 'org-a'), true);
});

test('browser check preparation uses the authenticated task receipt path without browser execution', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const response = await fetch(`${app.url}${LIVE_ADMIN_CORA_TASKS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ taskType: 'browser_check', intent: 'prepare', goal: 'Prepare an orientation check', contextRef: 'browser-target:orientation', idempotencyKey: 'browser-0001' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.taskType, 'browser_check');
  assert.equal(body.execution, 'not_performed');
  assert.equal(body.providerInvocation, 'not_performed');
  assert.equal(body.filesystemMutation, 'not_performed');
});

test('authenticated knowledge query returns stored citations only and rejects authority selectors', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session' };
  const result = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_QUERY_PATH}?q=hours%20service`, { headers });
  assert.equal(result.status, 200); const body = await result.json(); assert.equal(body.status, 'approved_sources_only'); assert.equal(body.answer, null); assert.equal(body.providerCall, 'not_performed'); assert.equal(body.excerpts[0].citation, 'FMCSA §3');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_QUERY_PATH}?q=hours&organization_id=org-b`, { headers }); assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor, query]) => name === 'knowledge-query' && actor.tenantId === 'org-a' && query === 'hours service'), true);
});

test('knowledge management is admin-only, bounded, and Organization-derived', async (t) => {
  const app = await fixture(); t.after(app.close);
  const memberHeaders = { cookie: 'helmion_admin_session=member-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_MANAGE_PATH}`, { headers: memberHeaders })).status, 403);
  const adminHeaders = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const managed = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_MANAGE_PATH}`, { headers: adminHeaders }); assert.equal(managed.status, 200);
  const source = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_SOURCES_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ sourceKey: 'manual', title: 'Manual', publisher: 'Ops', canonicalUri: 'manual://ops', provenance: 'reviewed', effectiveAt: null, expiresAt: null }) }); assert.equal(source.status, 200);
  const pack = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_PACKS_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ sourceId: 'source-1', packKey: 'ops', version: '1', provenance: 'reviewed', effectiveAt: null, expiresAt: null }) }); assert.equal(pack.status, 200);
  const snippet = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_SNIPPETS_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ packId: 'pack-1', citation: 'Manual §1', textReference: 'manual://ops#1', excerpt: 'Stored approved excerpt.', contentSha256: null, expiresAt: null }) }); assert.equal(snippet.status, 200);
  const transition = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_TRANSITION_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ kind: 'source', id: 'source-1', lifecycle: 'approved', reason: 'Reviewed' }) }); assert.equal(transition.status, 200);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_KNOWLEDGE_SOURCES_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ sourceKey: 'x', title: 'x', publisher: 'x', canonicalUri: 'x', provenance: 'x', effectiveAt: null, expiresAt: null, plantId: 'warehouse-1' }) }); assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor]) => name === 'knowledge-admin' && actor.tenantId === 'org-a'), true);
});

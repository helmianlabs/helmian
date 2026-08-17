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
  LIVE_ADMIN_CORA_APP_BUILDS_PATH,
  LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH,
  LIVE_ADMIN_CORA_APP_BUILD_REVISIONS_PATH,
  LIVE_ADMIN_CORA_APP_BUILD_APPROVALS_PATH,
  LIVE_ADMIN_CORA_APP_BUILD_EXECUTION_REQUESTS_PATH,
  LIVE_ADMIN_CORA_TASKS_PATH,
  LIVE_ADMIN_CORA_TASK_RESULTS_PATH,
  LIVE_ADMIN_CORA_APPROVED_KNOWLEDGE_RUN_PATH,
  LIVE_ADMIN_PROVIDER_CONNECTIONS_PATH,
  LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH,
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

async function fixture({ appBuildPromptPlanner = null, appBuildExecutionRequestRepository = null, githubAppWorkspaceSourceBindingRepository = null } = {}) {
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
    async append(actor, input) { calls.push(['task-append', actor, input]); return { durable: true, format: 'cora.agent-task-intent.v1', taskType: input.taskType, status: input.intent === 'prepare' ? 'prepared' : 'draft', receiptId: 'task-receipt-1', execution: 'not_performed', agentInvocation: 'not_performed' }; },
    async list(actor) { calls.push(['task-list', actor]); return { receipts: [] }; },
  };
  const agentTaskResultRepository = {
    async list(actor, taskId, limit) { calls.push(['task-result-list', actor, taskId, limit]); return { results: [] }; },
  };
  const approvedKnowledgeTaskWorker = {
    async run(input) { calls.push(['approved-knowledge-run', input]); return { status: 'source_ready', execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed', excerpts: [{ citation: 'FMCSA §3', excerpt: 'Stored excerpt.' }] }; },
  };
  const appBuildRepository = {
    async append(actor, input) { calls.push(['app-build-append', actor, input]); return { durable: true, format: 'cora.app-build-request.v1', status: 'draft-recorded', route: input.route, receiptId: 'app-build-receipt-1', execution: 'not_performed', filesystemMutation: 'not_performed', publication: 'not_performed' }; },
    async list(actor) { calls.push(['app-build-list', actor]); return { receipts: [] }; },
  };
  const appBuildRevisionRepository = {
    async appendRevision(actor, input) { calls.push(['app-build-revision-append', actor, input]); return { durable: true, receiptId: 'revision-receipt-1', execution: 'not_performed', publication: 'not_performed' }; },
    async listRevisions(actor, receipt) { calls.push(['app-build-revision-list', actor, receipt]); return { receipts: [] }; },
    async decideApproval(actor, input) { calls.push(['app-build-approval-decide', actor, input]); if (!['owner', 'admin'].includes(actor.role)) throw Object.assign(new Error('admin required'), { status: 403 }); return { durable: true, receiptId: 'approval-receipt-1', decision: input.decision, execution: 'not_performed', publication: 'not_performed' }; },
  };
  const executionRequestRepository = appBuildExecutionRequestRepository ?? { async append(actor, input) { calls.push(['app-build-execution-append', actor, input]); return { durable: true, receiptId: 'execution-receipt-1', status: 'queued', execution: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed', publication: 'not_performed', deployment: 'not_performed' }; } };
  const sourceBindingRepository = githubAppWorkspaceSourceBindingRepository ?? { async list(actor) { calls.push(['github-source-binding-list', actor]); return { bindings: [], checkout: 'not_performed' }; }, async append(actor, input) { calls.push(['github-source-binding-append', actor, input]); return { durable: true, receiptId: 'github-binding-1', workspaceProjectKey: input.workspaceProjectKey, provider: 'github_app', checkout: 'not_performed', execution: 'not_performed', deployment: 'not_performed' }; } };
  const providerConnectionRepository = {
    async list(actor) { calls.push(['provider-list', actor]); return { connections: [], source: 'tenant_provider_connection_metadata', invocation: 'not_performed', tools: 'not_granted' }; },
    async save(actor, input) { calls.push(['provider-save', actor, input]); return { durable: true, connection: { providerId: input.providerId, credentialReference: input.credentialReference, lifecycle: 'pending' }, vaultStatus: 'external_encrypted_vault_required', invocation: 'not_performed', tools: 'not_granted' }; },
  };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: fakePool(), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [], coraConfigRepository: repository, providerUsageRepository: usageRepository, workspacePreviewRepository: previewRepository, appBuildRepository, appBuildPromptPlanner, appBuildRevisionRepository, appBuildExecutionRequestRepository: executionRequestRepository, githubAppWorkspaceSourceBindingRepository: sourceBindingRepository, agentTaskRepository, agentTaskResultRepository, approvedKnowledgeTaskWorker, providerConnectionRepository });
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

test('only an Organization admin can run the provider-free knowledge worker, while result reads remain tenant-derived', async (t) => {
  const app = await fixture(); t.after(app.close);
  const memberHeaders = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const adminHeaders = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const body = { taskId: 7, claimIdempotencyKey: 'knowledge-run-0007' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APPROVED_KNOWLEDGE_RUN_PATH}`, { method: 'POST', headers: memberHeaders, body: JSON.stringify(body) })).status, 403);
  const run = await fetch(`${app.url}${LIVE_ADMIN_CORA_APPROVED_KNOWLEDGE_RUN_PATH}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
  assert.equal(run.status, 200); assert.equal((await run.json()).providerInvocation, 'not_performed');
  const results = await fetch(`${app.url}${LIVE_ADMIN_CORA_TASK_RESULTS_PATH}?task_id=7`, { headers: memberHeaders }); assert.equal(results.status, 200);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_TASK_RESULTS_PATH}?tenant_id=org-b`, { headers: memberHeaders })).status, 400);
  assert.equal(app.calls.some(([name, input]) => name === 'approved-knowledge-run' && input.actor.tenantId === 'org-a' && input.worker.role === 'worker'), true);
  assert.equal(app.calls.some(([name, actor]) => name === 'task-result-list' && actor.tenantId === 'org-a'), true);
});

test('authenticated app-build drafts derive Organization, reject selectors, and never execute or publish', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const body = { intent: 'draft', title: 'Driver onboarding', department: 'hr', route: '/hr/onboarding', description: 'Draft driver onboarding page.', components: [{ type: 'heading', text: 'Onboarding' }], idempotencyKey: 'app-build-0001' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 200); const receipt = await created.json(); assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.publication, 'not_performed');
  const listed = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_PATH}`, { headers }); assert.equal(listed.status, 200);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_PATH}?plant_id=warehouse-1`, { headers }); assert.equal(injected.status, 400);
  assert.equal(app.calls.some(([name, actor]) => name === 'app-build-append' && actor.tenantId === 'org-a'), true);
});

test('owner/admin prompt route derives tenant, stores only planner-normalized draft, and never executes', async (t) => {
  const plannerCalls = [];
  const plan = Object.freeze({ intent: 'draft', title: 'Driver onboarding', department: 'hr', route: '/hr/onboarding', description: 'Draft driver onboarding page.', components: [{ type: 'heading', text: 'Onboarding' }], idempotencyKey: 'prompt-build-0001' });
  const app = await fixture({ appBuildPromptPlanner: async (userRequest) => { plannerCalls.push(userRequest); return { normalized: plan, providerInvocation: 'performed', rawResponse: 'never return this' }; } }); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}`, { method: 'POST', headers, body: JSON.stringify({ userRequest: 'Build HR driver onboarding.' }) });
  assert.equal(created.status, 200); const receipt = await created.json(); assert.equal(receipt.providerInvocation, 'performed'); assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.filesystemMutation, 'not_performed'); assert.equal(receipt.publication, 'not_performed'); assert.equal(receipt.deployment, 'not_performed'); assert.equal(receipt.approval, 'not_performed'); assert.equal(receipt.revision, 'not_performed');
  assert.deepEqual(plannerCalls, ['Build HR driver onboarding.']);
  const append = app.calls.find(([name]) => name === 'app-build-append'); assert.equal(append[1].tenantId, 'org-a'); assert.deepEqual(append[2], plan);
  assert.equal(JSON.stringify(receipt).includes('never return this'), false);
});

test('prompt route fails closed for member, selector/unsafe input, and missing planner', async (t) => {
  const calls = []; const app = await fixture({ appBuildPromptPlanner: async (prompt) => { calls.push(prompt); if (/tenantId|api_key/u.test(prompt)) throw new Error('unsafe prompt'); return { normalized: { intent: 'draft' }, providerInvocation: 'performed' }; } }); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const member = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}`, { method: 'POST', headers: { ...headers, cookie: 'helmion_admin_session=member-session' }, body: JSON.stringify({ userRequest: 'Build HR.' }) }); assert.equal(member.status, 403);
  const selector = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}?tenant_id=org-b`, { method: 'POST', headers, body: JSON.stringify({ userRequest: 'Build HR.' }) }); assert.equal(selector.status, 400);
  const bodySelector = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}`, { method: 'POST', headers, body: JSON.stringify({ userRequest: 'Build HR.', tenantId: 'org-b' }) }); assert.equal(bodySelector.status, 400);
  const unsafe = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}`, { method: 'POST', headers, body: JSON.stringify({ userRequest: 'tenantId=org-b api_key=x' }) }); assert.equal(unsafe.status, 400);
  assert.deepEqual(calls, ['tenantId=org-b api_key=x']);
  const unavailable = await fixture(); t.after(unavailable.close);
  const missing = await fetch(`${unavailable.url}${LIVE_ADMIN_CORA_APP_BUILDS_FROM_PROMPT_PATH}`, { method: 'POST', headers, body: JSON.stringify({ userRequest: 'Build HR.' }) }); assert.equal(missing.status, 503);
});

test('app-build revision and approval routes keep tenant scope and future-publish boundary', async (t) => {
  const app = await fixture(); t.after(app.close);
  const memberHeaders = { cookie: 'helmion_admin_session=member-session', 'content-type': 'application/json' };
  const revision = { appBuildReceiptId: 'app-build-receipt-1', description: 'Revision', components: [{ type: 'heading', text: 'HR' }], reason: 'review', idempotencyKey: 'revision-0001' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_REVISIONS_PATH}`, { method: 'POST', headers: memberHeaders, body: JSON.stringify(revision) }); assert.equal(created.status, 200); assert.equal((await created.json()).publication, 'not_performed');
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_REVISIONS_PATH}?app_build_receipt_id=app-build-receipt-1`, { headers: memberHeaders })).status, 200);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_REVISIONS_PATH}?tenant_id=org-b&app_build_receipt_id=app-build-receipt-1`, { headers: memberHeaders })).status, 400);
  const denied = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_APPROVALS_PATH}`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ revisionReceiptId: 'revision-receipt-1', decision: 'approve', reason: 'review', idempotencyKey: 'approval-0001' }) }); assert.equal(denied.status, 403);
  const approved = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_APPROVALS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' }, body: JSON.stringify({ revisionReceiptId: 'revision-receipt-1', decision: 'approve', reason: 'review', idempotencyKey: 'approval-0001' }) }); assert.equal(approved.status, 200); assert.equal((await approved.json()).publication, 'not_performed');
});

test('app-build execution request route derives tenant and records only a queued no-execution receipt', async (t) => {
  const app = await fixture(); t.after(app.close);
  const body = { revisionReceiptId: 'revision-receipt-1', approvalReceiptId: 'approval-receipt-1', workspaceProjectKey: 'tms-cloud', idempotencyKey: 'execution-0001' };
  const headers = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_EXECUTION_REQUESTS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(created.status, 200); const receipt = await created.json(); assert.equal(receipt.status, 'queued'); assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.filesystemMutation, 'not_performed'); assert.equal(receipt.deployment, 'not_performed');
  const call = app.calls.find(([name]) => name === 'app-build-execution-append'); assert.equal(call[1].tenantId, 'org-a'); assert.deepEqual(call[2], body);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_EXECUTION_REQUESTS_PATH}`, { method: 'POST', headers: { ...headers, cookie: 'helmion_admin_session=member-session' }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_EXECUTION_REQUESTS_PATH}?tenant_id=org-b`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_APP_BUILD_EXECUTION_REQUESTS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ ...body, tenantId: 'org-b' }) })).status, 400);
});

test('GitHub App source-binding routes derive tenant, require owner/admin, and reject credentials, URLs, and authority selectors', async (t) => {
  const app = await fixture(); t.after(app.close); const body = { workspaceProjectKey: 'tms-cloud', githubRepositoryNodeId: 'R_kgDOExample', githubRepositoryId: 12345, githubOwner: 'Helmion', githubRepositoryName: 'cloud', githubInstallationId: 98765, defaultBranch: 'main', baseCommitSha: 'a'.repeat(40), verificationReceiptId: 'verify-0001', vaultCredentialReference: 'vault://tenant/org-a/github-app/installation-98765', idempotencyKey: 'github-binding-0001' }; const headers = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const created = await fetch(`${app.url}${LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(created.status, 200); assert.equal((await created.json()).checkout, 'not_performed'); const call = app.calls.find(([name]) => name === 'github-source-binding-append'); assert.equal(call[1].tenantId, 'org-a'); assert.deepEqual(call[2], body);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH}`, { headers: { cookie: 'helmion_admin_session=member-session' } })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH}?tenant_id=org-b`, { headers })).status, 400);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ ...body, accessToken: 'ghs_never_accept' }) })).status, 400);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_GITHUB_APP_WORKSPACE_SOURCE_BINDINGS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ ...body, cloneUrl: 'https://github.com/helmion/cloud.git' }) })).status, 400);
});

test('provider connection route derives Organization, stores only vault references, and never invokes providers', async (t) => {
  const app = await fixture(); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=admin-session', 'content-type': 'application/json' };
  const body = { providerId: 'claude', authMode: 'api_key', credentialReference: 'vault://tenant/org-a/claude' };
  const saved = await fetch(`${app.url}${LIVE_ADMIN_PROVIDER_CONNECTIONS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.connection.credentialReference, body.credentialReference);
  assert.equal(savedBody.invocation, 'not_performed');
  assert.equal(app.calls.some(([name, actor]) => name === 'provider-save' && actor.tenantId === 'org-a'), true);
  const raw = await fetch(`${app.url}${LIVE_ADMIN_PROVIDER_CONNECTIONS_PATH}`, { method: 'POST', headers, body: JSON.stringify({ ...body, apiKey: 'sk_raw_never_accept' }) });
  assert.equal(raw.status, 400);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_PROVIDER_CONNECTIONS_PATH}?plant_id=yard-1`, { headers });
  assert.equal(injected.status, 400);
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_CONTROL_PATH,
  LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH,
  LIVE_ADMIN_ACTION_POLICY_PATH,
  LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH,
  LIVE_ADMIN_CORA_ARTIFACTS_PATH,
  LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH,
  LIVE_ADMIN_CORA_ARTIFACT_SOURCE_LINKS_PATH,
  LIVE_ADMIN_CORA_ARTIFACT_SOURCE_TRANSITION_PATH,
  LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH,
  LIVE_ADMIN_CORA_APPROVALS_PATH,
  LIVE_ADMIN_CORA_CONNECTORS_PATH,
  LIVE_CONNECTOR_SLACK_INBOUND_PATH,
  LIVE_CONNECTOR_DISCORD_INBOUND_PATH,
  LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH,
  LIVE_ADMIN_EVENTS_PATH,
  LIVE_ADMIN_ORGANIZATION_MEMBERSHIPS_PATH,
  LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH,
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

function fakePool({ membershipRoles = { 'helmian-platform': 'admin' }, membershipError = false } = {}) {
  const queries = [];
  const auditEntries = [];
  let actionPolicy = null;
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      queries.push({ text, values });
      if (text.includes('tenant_memberships')) {
        if (membershipError) throw new Error('database unavailable');
        if (text.includes("role in ('owner','admin')")) {
          const rows = Object.entries(membershipRoles).map(([tenant_id, role]) => ({ tenant_id, role }));
          return { rowCount: rows.length, rows };
        }
        if (text.includes('where subject=$1')) {
          const rows = Object.entries(membershipRoles).map(([tenant_id, role]) => ({ tenant_id, role }));
          return rows.length === 1 ? { rowCount: 1, rows } : { rowCount: 0, rows: [] };
        }
        const role = membershipRoles[values[0]] ?? null;
        return role ? { rowCount: 1, rows: [{ role }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('from helmion.tenants')) return { rowCount: 1, rows: [{ tenant_id: values[0], display_name: 'Helmian Platform' }] };
      if (text.includes('from helmion.audit_events')) return { rowCount: 1, rows: [{ count: 7 }] };
      if (text.includes('from helmion.audit_outbox')) return { rowCount: 1, rows: [{ count: 1 }] };
      if (text.includes('from helmion.platform_action_policy')) {
        return actionPolicy ? { rowCount: 1, rows: [actionPolicy] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('insert into helmion.platform_action_policy')) {
        if (actionPolicy) return { rowCount: 0, rows: [] };
        actionPolicy = {
          version: 1,
          dispatch_board_summary_enabled: values[2],
          prepare_driver_message_enabled: values[3],
          department_handoff_enabled: values[4],
          equipment_safety_status_enabled: values[5],
          equipment_safety_check_enabled: values[6],
          equipment_safety_escalation_enabled: values[7],
        };
        return { rowCount: 1, rows: [actionPolicy] };
      }
      if (text.includes('update helmion.platform_action_policy')) {
        if (!actionPolicy || Number(actionPolicy.version) !== Number(values[1])) return { rowCount: 0, rows: [] };
        actionPolicy = {
          version: Number(actionPolicy.version) + 1,
          dispatch_board_summary_enabled: values[2],
          prepare_driver_message_enabled: values[3],
          department_handoff_enabled: values[4],
          equipment_safety_status_enabled: values[5],
          equipment_safety_check_enabled: values[6],
          equipment_safety_escalation_enabled: values[7],
        };
        return { rowCount: 1, rows: [actionPolicy] };
      }
      if (text.includes('insert into helmion.audit_events')) {
        auditEntries.push({ actionType: values[5], decision: values[7], reason: JSON.parse(values[11]).reason });
        return { rowCount: 1, rows: [] };
      }
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
  return { queries, auditEntries, connect: async () => client };
}

function identity() {
  return {
    getSession: (sessionId) => sessionId === 'active-session'
      ? { subject: 'user-1' }
      : sessionId === 'second-session' ? { subject: 'user-2' } : null,
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
    artifactStudioRepository: options.artifactStudioRepository ?? undefined,
    artifactSourceRepository: options.artifactSourceRepository ?? undefined,
    artifactScriptRepository: options.artifactScriptRepository ?? undefined,
    artifactExecutionRepository: options.artifactExecutionRepository ?? undefined,
    approvalInboxRepository: options.approvalInboxRepository ?? undefined,
    connectorRegistrationRepository: options.connectorRegistrationRepository ?? undefined,
    personalPreferencesRepository: options.personalPreferencesRepository ?? undefined,
    envoyStore: options.envoyStore ?? undefined,
    connectorSecretResolver: options.connectorSecretResolver ?? undefined,
    connectorResolveUser: options.connectorResolveUser ?? undefined,
    connectorResolveChannel: options.connectorResolveChannel ?? undefined,
    auditEventRepository: options.auditEventRepository ?? undefined,
    organizationRoleRepository: options.organizationRoleRepository ?? undefined,
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

test('Organization role administration exposes fixed capabilities and only prepares external membership changes', async (t) => {
  const calls = [];
  const organizationRoleRepository = {
    async list(actor) { calls.push({ operation: 'list', actor }); return { memberships: [{ subject: actor.subject, serverRole: actor.role, active: true, jobTitle: null, capabilities: ['read_envoy'] }], roles: [{ jobTitle: 'dispatcher', serverRole: 'member', capabilities: ['read_envoy', 'send_envoy'] }], pending: [], source: 'helmion.tenant_memberships', externalIdentityMutation: 'not_performed' }; },
    async prepareRolePlan(actor, input) { if (!['owner', 'admin'].includes(actor.role)) throw Object.assign(new Error('owner or admin membership is required'), { status: 403 }); calls.push({ operation: 'prepare', actor, input }); return { durable: true, replayed: false, receiptId: '41', status: 'prepared', membershipChanged: false, externalIdentityMutation: 'not_performed', plan: { subject: input.subject, currentServerRole: 'member', requestedJobTitle: input.jobTitle, requestedServerRole: 'member' }, approval: 'external_identity_or_admin_action_required' }; },
  };
  const memberApp = await fixture({ membershipRoles: { 'customer-a': 'member' }, organizationRoleRepository }); t.after(memberApp.close);
  const member = await fetch(`${memberApp.url}${LIVE_ADMIN_ORGANIZATION_MEMBERSHIPS_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } }); const memberBody = await member.json(); assert.equal(member.status, 200); assert.equal(memberBody.externalIdentityMutation, 'not_performed'); assert.equal(memberBody.memberships[0].subject, 'user-1');
  const denied = await fetch(`${memberApp.url}${LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-1', jobTitle: 'dispatcher', reason: 'dispatch role', idempotencyKey: 'role-plan-0001' }) }); assert.equal(denied.status, 403);
  const adminApp = await fixture({ organizationRoleRepository }); t.after(adminApp.close);
  const plan = await fetch(`${adminApp.url}${LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH}?plant_id=west`, { method: 'POST', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-2', jobTitle: 'dispatcher', reason: 'Dispatch coverage', idempotencyKey: 'role-plan-0001' }) }); assert.equal(plan.status, 400); assert.equal(calls.some(({ operation }) => operation === 'prepare'), false);
  const prepared = await fetch(`${adminApp.url}${LIVE_ADMIN_ORGANIZATION_ROLE_PLAN_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-2', jobTitle: 'dispatcher', reason: 'Dispatch coverage', idempotencyKey: 'role-plan-0001' }) }); const preparedBody = await prepared.json(); assert.equal(prepared.status, 200); assert.equal(preparedBody.membershipChanged, false); assert.equal(preparedBody.externalIdentityMutation, 'not_performed'); assert.equal(calls.some(({ operation }) => operation === 'prepare'), true);
});

test('Audit/Analysis is Organization-scoped, filtered, cursor-paginated, and read-only', async (t) => {
  const calls = [];
  const auditEventRepository = {
    async list(actor, query) {
      calls.push({ actor, query });
      return { events: query.cursor ? [{ id: '1', actor: 'user-1', actorRole: 'member', actionType: 'envoy.send', status: 'ALLOW', summary: 'Sent an Envoy message', createdAt: '2026-08-14T12:00:00.000Z' }] : [{ id: '2', actor: 'admin-1', actorRole: 'admin', actionType: 'cora.config.publish', status: 'ALLOW', summary: 'Published approved config', createdAt: '2026-08-14T13:00:00.000Z' }], nextCursor: query.cursor ? null : 'cursor-1', hasMore: !query.cursor, empty: false, source: 'helmion.audit_events', mutation: 'not_performed' };
    },
  };
  const app = await fixture({ membershipRoles: { 'customer-a': 'member' }, auditEventRepository }); t.after(app.close);
  const first = await fetch(`${app.url}${LIVE_ADMIN_EVENTS_PATH}?action=envoy.send&actor=user-1&status=ALLOW&from=2026-08-01&to=2026-08-15&limit=1`, { headers: { cookie: 'helmion_admin_session=active-session' } });
  const firstBody = await first.json(); assert.equal(first.status, 200); assert.equal(firstBody.events[0].actionType, 'cora.config.publish'); assert.equal(firstBody.mutation, 'not_performed'); assert.equal(calls[0].actor.tenantId, 'customer-a'); assert.equal(calls[0].actor.role, 'member'); assert.equal(calls[0].query.limit, '1');
  const next = await fetch(`${app.url}${LIVE_ADMIN_EVENTS_PATH}?cursor=${encodeURIComponent(firstBody.nextCursor)}`, { headers: { cookie: 'helmion_admin_session=active-session' } }); assert.equal(next.status, 200); assert.equal(calls[1].query.cursor, 'cursor-1');
  const injected = await fetch(`${app.url}${LIVE_ADMIN_EVENTS_PATH}?organization_id=customer-b`, { headers: { cookie: 'helmion_admin_session=active-session' } }); assert.equal(injected.status, 400); assert.equal(calls.length, 2);
});

test('Artifact Studio routes are Organization-scoped and expose only source-only receipts', async (t) => {
  const receipts = [];
  const artifactStudioRepository = {
    async list() { return { receipts }; },
    async append(actor, input) {
      if (input.stage === 'approval_requested' && !['owner', 'admin'].includes(actor.role)) throw Object.assign(new Error('admin required'), { status: 403 });
      const existing = receipts.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
      if (existing) return { durable: true, replayed: true, ...existing };
      const result = { receiptId: 'artifact-receipt-1', idempotencyKey: input.idempotencyKey, status: input.stage, execution: 'not_performed', media: 'not_generated', providerInvocation: 'not_performed' };
      receipts.push(result); return { durable: true, replayed: false, ...result };
    },
  };
  const app = await fixture({ artifactStudioRepository }); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const selector = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACTS_PATH}?tenant_id=other`, { headers });
  assert.equal(selector.status, 400);
  const draft = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACTS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ artifactType: 'training', title: 'Orientation', department: 'operations', objective: 'Explain steps', sourceRefs: [], stage: 'draft', idempotencyKey: 'artifact-0001', approvalReason: null }) });
  const draftBody = await draft.json(); assert.equal(draft.status, 200, JSON.stringify(draftBody)); assert.equal(draftBody.execution, 'not_performed');
  const approval = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACTS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ artifactType: 'training', title: 'Orientation', department: 'operations', objective: 'Explain steps', sourceRefs: [], stage: 'approval_requested', idempotencyKey: 'artifact-0002', approvalReason: 'Request review' }) });
  assert.equal(approval.status, 200); assert.equal((await approval.json()).status, 'approval_requested');
  const replay = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACTS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ artifactType: 'training', title: 'Orientation', department: 'operations', objective: 'Explain steps', sourceRefs: [], stage: 'draft', idempotencyKey: 'artifact-0001', approvalReason: null, organizationId: 'other' }) });
  assert.equal(replay.status, 400);
});

test('Artifact source routes derive Organization, support metadata/link receipts, and gate review', async (t) => {
  const sourceRepository = {
    async list() { return { sources: [{ sourceId: '1', sourceKey: 'dock-sop', lifecycle: 'draft' }], links: [] }; },
    async append() { return { durable: true, replayed: false, source: { sourceId: '1', sourceKey: 'dock-sop', lifecycle: 'draft' } }; },
    async transition() { return { source: { sourceId: '1', lifecycle: 'approved' }, reviewReceiptId: 'review-1' }; },
    async link() { return { durable: true, replayed: false, link: { linkReceiptId: 'link-1', artifactReceiptId: 'artifact-1', sourceId: '1' } }; },
  };
  const app = await fixture({ artifactSourceRepository: sourceRepository }); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH}?plant_id=west`, { headers })).status, 400);
  const created = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SOURCES_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sourceKey: 'dock-sop', title: 'Dock SOP', publisher: 'Ops', classification: 'sop', provenance: 'reviewed metadata', reference: 'manual://dock-sop', effectiveAt: null, expiresAt: null, idempotencyKey: 'source-0001' }) });
  assert.equal(created.status, 200);
  const transitioned = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SOURCE_TRANSITION_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: '1', lifecycle: 'approved', reason: 'Reviewed by admin' }) });
  assert.equal(transitioned.status, 200);
  const linked = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SOURCE_LINKS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ artifactReceiptId: 'artifact-1', sourceId: '1', linkReason: 'Use for orientation', idempotencyKey: 'link-0001' }) });
  assert.equal(linked.status, 200); assert.equal((await linked.json()).link.linkReceiptId, 'link-1');
});

test('Artifact script routes preserve manual revision and prepared/not-generated truth', async (t) => {
  const artifactScriptRepository = { async list() { return { receipts: [] }; }, async append(actor, input) { if (input.stage === 'approval_requested' && actor.role !== 'admin') throw Object.assign(new Error('admin required'), { status: 403 }); return { durable: true, replayed: false, receiptId: 'script-1', revision: 1, stage: input.stage, draftState: 'prepared', generation: 'not_generated', providerInvocation: 'not_performed' }; } };
  const app = await fixture({ artifactScriptRepository }); t.after(app.close); const headers = { cookie: 'helmion_admin_session=active-session' };
  const selector = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH}?plant_id=west&artifact_receipt_id=a`, { headers }); assert.equal(selector.status, 400);
  const response = await fetch(`${app.url}${LIVE_ADMIN_CORA_ARTIFACT_SCRIPTS_PATH}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ artifactReceiptId: 'artifact-1', scriptKind: 'narration', text: 'Manual draft', sourceLinkReceiptIds: [], stage: 'draft', approvalReason: null, idempotencyKey: 'script-0001' }) });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.generation, 'not_generated'); assert.equal(body.draftState, 'prepared');
});

test('execution request HTTP path reaches the injected fake through CLM', async (t) => {
  const calls = [];
  const artifactExecutionRepository = { async list(actor) { calls.push({ operation: 'list', actor }); return { receipts: [{ status: 'approval_required', execution: 'not_executed' }] }; }, async append(actor, input) { calls.push({ operation: 'append', actor, input }); const status = Number(input.estimatedCostMinor) > 100 ? 'blocked' : input.approvalRef ? 'queued' : 'approval_required'; return { status, policyDecision: status === 'blocked' ? 'deny' : status === 'queued' ? 'allow' : 'step-up', execution: 'not_executed', providerInvocation: 'not_performed', media: 'not_generated', receiptId: `execution-${calls.length}` }; } };
  const body = { approvalRef: null, artifactReceiptId: 'artifact-1', catalogEntryId: 'catalog-1', currency: 'USD', estimatedAudioSeconds: null, estimatedCostMinor: 25, estimatedImageUnits: null, estimatedRequestedTokens: null, estimatedVideoUnits: null, externalExecution: true, idempotencyKey: 'execution-0001', modality: 'text', model: 'model-1', provider: 'model-provider', scriptReceiptId: 'script-1', sourceLinkReceiptIds: ['link-0001'], supersedesReceiptId: null };
  const memberApp = await fixture({ membershipRoles: { 'customer-a': 'member' }, artifactExecutionRepository }); t.after(memberApp.close); const memberHeaders = { cookie: 'helmion_admin_session=active-session' };
  const read = await fetch(`${memberApp.url}/api/admin/cora/artifact-execution-requests?artifact_receipt_id=artifact-1`, { headers: memberHeaders }); const readBody = await read.json(); assert.equal(read.status, 200, JSON.stringify(readBody)); assert.equal(readBody.receipts[0].execution, 'not_executed'); assert.equal(calls[0].actor.tenantId, 'customer-a'); assert.equal(calls[0].actor.role, 'member');
  const normal = await fetch(`${memberApp.url}/api/admin/cora/artifact-execution-requests`, { method: 'POST', headers: { ...memberHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const normalBody = await normal.json(); assert.equal(normal.status, 200, JSON.stringify(normalBody)); assert.equal(normalBody.status, 'approval_required'); assert.equal(normalBody.execution, 'not_executed'); assert.equal(normalBody.providerInvocation, 'not_performed');
  const injected = await fetch(`${memberApp.url}/api/admin/cora/artifact-execution-requests`, { method: 'POST', headers: { ...memberHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, idempotencyKey: 'execution-0002', plantId: 'plant-1' }) }); assert.equal(injected.status, 400);
  const adminApp = await fixture({ artifactExecutionRepository }); t.after(adminApp.close); const adminHeaders = { cookie: 'helmion_admin_session=active-session' };
  const queued = await fetch(`${adminApp.url}/api/admin/cora/artifact-execution-requests`, { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, approvalRef: 'approval-0001', idempotencyKey: 'execution-0003', supersedesReceiptId: 'execution-0001' }) }); const queuedBody = await queued.json(); assert.equal(queued.status, 200, JSON.stringify(queuedBody)); assert.equal(queuedBody.status, 'queued'); assert.equal(queuedBody.execution, 'not_executed');
  const blocked = await fetch(`${adminApp.url}/api/admin/cora/artifact-execution-requests`, { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, estimatedCostMinor: 101, idempotencyKey: 'execution-0004' }) }); const blockedBody = await blocked.json(); assert.equal(blocked.status, 200, JSON.stringify(blockedBody)); assert.equal(blockedBody.status, 'blocked'); assert.equal(blockedBody.policyDecision, 'deny');
});

test('Organization approvals inbox is membership-scoped, admin-decided, and never executes', async (t) => {
  const calls = [];
  const approvalInboxRepository = {
    async list(actor, filters) { calls.push({ operation: 'list', actor, filters }); return { items: [{ requestKind: 'artifact_execution_request', requestReceiptId: 'execution-0001', status: 'approval_required', approvalRequired: true, decision: null, summary: 'provider/model · text', execution: 'not_performed', providerInvocation: 'not_performed' }], source: 'organization_approval_receipts', providerCalls: 'not_performed' }; },
    async decide(actor, input) { calls.push({ operation: 'decide', actor, input }); return { durable: true, format: 'cora.approval-decision.v1', requestKind: input.requestKind, requestReceiptId: input.requestReceiptId, decision: input.decision, reason: input.reason, receiptId: 'approval-0001', execution: 'not_performed', providerInvocation: 'not_performed' }; },
  };
  const memberApp = await fixture({ membershipRoles: { 'customer-a': 'member' }, approvalInboxRepository }); t.after(memberApp.close);
  const member = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_APPROVALS_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } }); assert.equal(member.status, 200); assert.equal((await member.json()).items[0].execution, 'not_performed');
  const denied = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_APPROVALS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', requestKind: 'artifact_execution_request', requestReceiptId: 'execution-0001', reason: 'reviewed', idempotencyKey: 'approval-0001' }) }); assert.equal(denied.status, 403);
  const injected = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_APPROVALS_PATH}?plant_id=west`, { headers: { cookie: 'helmion_admin_session=active-session' } }); assert.equal(injected.status, 400);
  const adminApp = await fixture({ approvalInboxRepository }); t.after(adminApp.close);
  const decided = await fetch(`${adminApp.url}${LIVE_ADMIN_CORA_APPROVALS_PATH}`, { method: 'POST', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', requestKind: 'artifact_execution_request', requestReceiptId: 'execution-0001', reason: 'Reviewed for policy', idempotencyKey: 'approval-0001' }) }); const decidedBody = await decided.json(); assert.equal(decided.status, 200); assert.equal(decidedBody.execution, 'not_performed'); assert.equal(calls.some(({ operation }) => operation === 'decide'), true);
});

test('connector registration routes expose limited member status and admin metadata only', async (t) => {
  const calls = [];
  const connectorRegistrationRepository = {
    async list(actor) { calls.push({ operation: 'list', actor }); return { registrations: [{ provider: 'slack', lifecycle: 'draft', enabled: false, publicEndpointReady: false, secretReferenceName: null, allowedInboundChannels: [], lastVerifiedStatus: 'not_verified', providerCalls: 'not_performed' }], source: 'organization_connector_registration', providerCalls: 'not_performed' }; },
    async save(actor, input) { calls.push({ operation: 'save', actor, input }); return { durable: true, registration: { provider: input.provider, lifecycle: input.lifecycle, secretReferenceName: 'vault/ref', providerCalls: 'not_performed' }, source: 'organization_connector_registration' }; },
  };
  const memberApp = await fixture({ membershipRoles: { 'customer-a': 'member' }, connectorRegistrationRepository }); t.after(memberApp.close);
  const member = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_CONNECTORS_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } }); const memberBody = await member.json(); assert.equal(member.status, 200); assert.equal(memberBody.registrations[0].secretReferenceName, null); assert.equal(memberBody.providerCalls, 'not_performed');
  const denied = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_CONNECTORS_PATH}`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'slack', lifecycle: 'testing', enabled: false, publicEndpointReady: false, secretReferenceName: 'vault/ref', allowedInboundChannels: [] }) }); assert.equal(denied.status, 403);
  const injected = await fetch(`${memberApp.url}${LIVE_ADMIN_CORA_CONNECTORS_PATH}?plant_id=west`, { headers: { cookie: 'helmion_admin_session=active-session' } }); assert.equal(injected.status, 400);
  const adminApp = await fixture({ connectorRegistrationRepository }); t.after(adminApp.close);
  const saved = await fetch(`${adminApp.url}${LIVE_ADMIN_CORA_CONNECTORS_PATH}`, { method: 'PUT', headers: { cookie: 'helmion_admin_session=active-session', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'slack', lifecycle: 'testing', enabled: false, publicEndpointReady: false, secretReferenceName: 'vault/ref', allowedInboundChannels: [{ externalChannelId: 'C1', label: 'Ops', enabled: true }] }) }); assert.equal(saved.status, 200); assert.equal(calls.some(({ operation }) => operation === 'save'), true);
});

test('public Slack inbound route verifies raw body, binds one Organization, and persists Envoy replay safely', async (t) => {
  const messages = []; const seen = new Set();
  const connectorRegistrationRepository = { async resolveEnabled(provider) { assert.equal(provider, 'slack'); return { tenantId: 'customer-a', registration: { provider: 'slack', lifecycle: 'enabled', enabled: true, publicEndpointReady: true, secretReferenceName: 'vault/slack', allowedInboundChannels: [{ externalChannelId: 'C1', label: 'Ops', enabled: true }] } }; }, async list() { return { registrations: [] }; } };
  const envoyStore = { async appendConnectorMessage(binding) { const replayed = seen.has(binding.eventId); if (!replayed) { seen.add(binding.eventId); messages.push(binding); } return { durable: true, replayed, message: { channelId: binding.channelId, body: binding.text } }; } };
  const connectorResolveUser = async ({ provider, externalUserId }) => provider === 'slack' && externalUserId === 'U1' ? [{ active: true, subject: 'user-1', tenantId: 'customer-a', role: 'member' }] : [];
  const connectorResolveChannel = async ({ provider, channelId, tenantId }) => provider === 'slack' && channelId === 'C1' && tenantId === 'customer-a' ? [{ active: true, tenantId }] : [];
  const app = await fixture({ connectorRegistrationRepository, envoyStore, connectorSecretResolver: async ({ secretReferenceName }) => secretReferenceName === 'vault/slack' ? 'slack-secret' : null, connectorResolveUser, connectorResolveChannel }); t.after(app.close);
  const body = JSON.stringify({ event_id: 'evt-public-1', user_id: 'U1', channel_id: 'C1', text: 'hello Envoy' }); const timestamp = Math.floor(Date.now() / 1000); const signature = `v0=${createHmac('sha256', 'slack-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`; const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature };
  const first = await fetch(`${app.url}${LIVE_CONNECTOR_SLACK_INBOUND_PATH}`, { method: 'POST', headers, body }); const firstBody = await first.json(); assert.equal(first.status, 200, JSON.stringify(firstBody)); assert.equal(firstBody.tenantId, 'customer-a'); assert.equal(firstBody.outboundDelivery, 'not_performed');
  const replay = await fetch(`${app.url}${LIVE_CONNECTOR_SLACK_INBOUND_PATH}`, { method: 'POST', headers, body }); assert.equal((await replay.json()).replayed, true); assert.equal(messages.length, 1);
  const bad = await fetch(`${app.url}${LIVE_CONNECTOR_SLACK_INBOUND_PATH}`, { method: 'POST', headers: { ...headers, 'x-slack-signature': `v0=${'0'.repeat(64)}` }, body }); assert.equal(bad.status, 400); assert.equal(messages.length, 1);
  const injectedBody = JSON.stringify({ ...JSON.parse(body), tenant_id: 'customer-b' }); const injectedTimestamp = String(Math.floor(Date.now() / 1000)); const injectedSignature = `v0=${createHmac('sha256', 'slack-secret').update(`v0:${injectedTimestamp}:${injectedBody}`).digest('hex')}`;
  const injected = await fetch(`${app.url}${LIVE_CONNECTOR_SLACK_INBOUND_PATH}`, { method: 'POST', headers: { ...headers, 'x-slack-request-timestamp': injectedTimestamp, 'x-slack-signature': injectedSignature }, body: injectedBody }); assert.equal(injected.status, 400); assert.equal(messages.length, 1);
});

test('public Discord inbound route selects its path verifier and rejects an unregistered channel', async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'); const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'); const messages = [];
  const connectorRegistrationRepository = { async resolveEnabled(provider) { assert.equal(provider, 'discord'); return { tenantId: 'customer-d', registration: { provider: 'discord', lifecycle: 'enabled', enabled: true, publicEndpointReady: true, secretReferenceName: 'discord/public-key', allowedInboundChannels: [{ externalChannelId: 'D1', label: 'Ops', enabled: true }] } }; }, async list() { return { registrations: [] }; } };
  const envoyStore = { async appendConnectorMessage(binding) { messages.push(binding); return { durable: true, replayed: false, message: { channelId: binding.channelId } }; } };
  const connectorResolveUser = async ({ provider, externalUserId }) => provider === 'discord' && externalUserId === 'DU1' ? [{ active: true, subject: 'user-d', tenantId: 'customer-d', role: 'member' }] : [];
  const connectorResolveChannel = async ({ provider, channelId, tenantId }) => provider === 'discord' && channelId === 'D1' && tenantId === 'customer-d' ? [{ active: true, tenantId }] : [];
  const app = await fixture({ connectorRegistrationRepository, envoyStore, connectorSecretResolver: async () => publicKeyHex, connectorResolveUser, connectorResolveChannel }); t.after(app.close);
  const body = JSON.stringify({ id: 'discord-http-1', member: { user: { id: 'DU1' } }, channel_id: 'D1', content: 'hello Discord' }); const timestamp = String(Math.floor(Date.now() / 1000)); const headers = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') };
  const response = await fetch(`${app.url}${LIVE_CONNECTOR_DISCORD_INBOUND_PATH}`, { method: 'POST', headers, body }); const responseBody = await response.json(); assert.equal(response.status, 200, JSON.stringify(responseBody)); assert.equal(responseBody.provider, 'discord'); assert.equal(messages.length, 1);
  const denied = await fetch(`${app.url}${LIVE_CONNECTOR_DISCORD_INBOUND_PATH}`, { method: 'POST', headers: { ...headers, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + JSON.stringify({ ...JSON.parse(body), channel_id: 'D2' })), privateKey).toString('hex') }, body: JSON.stringify({ ...JSON.parse(body), channel_id: 'D2' }) }); assert.equal(denied.status, 403); assert.equal(messages.length, 1);
});

test('personal Cora preferences are membership-derived, bounded, and user-owned', async (t) => {
  const calls = [];
  const personalPreferencesRepository = {
    async read(actor) {
      calls.push({ operation: 'read', actor });
      return { bounds: { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['barge_in'], turnMode: ['concise'], voiceProfiles: ['emma'] }, preferences: { format: 'cora.personal-preferences.v1', valid: true, organizationId: actor.tenantId, subject: actor.subject, preferences: {}, updatedAt: null } };
    },
    async save(actor, input) {
      calls.push({ operation: 'save', actor, input });
      return { bounds: { verbosity: ['concise', 'standard', 'detailed'], interruptMode: ['barge_in'], turnMode: ['concise'], voiceProfiles: ['emma'] }, preferences: { format: 'cora.personal-preferences.v1', valid: true, organizationId: actor.tenantId, subject: actor.subject, preferences: input, updatedAt: '2026-08-14T00:00:00.000Z' } };
    },
  };
  const app = await fixture({ membershipRoles: { 'customer-a': 'member' }, personalPreferencesRepository }); t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const read = await fetch(`${app.url}${LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH}`, { headers });
  const readBody = await read.json();
  assert.equal(read.status, 200, JSON.stringify(readBody));
  assert.equal(readBody.preferences.subject, 'user-1');
  assert.equal(readBody.preferences.organizationId, 'customer-a');
  assert.equal(calls[0].actor.tenantId, 'customer-a');
  assert.equal(calls[0].actor.subject, 'user-1');
  const saved = await fetch(`${app.url}${LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ interruptMode: 'barge_in', muted: true, turnMode: 'concise', verbosity: 'detailed', volume: 35, voiceProfile: 'emma' }) });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.preferences.preferences.voiceProfile, 'emma');
  assert.equal(calls[1].actor.tenantId, 'customer-a');
  assert.equal(calls[1].actor.subject, 'user-1');
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH}?organization_id=other`, { headers })).status, 400);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH}?subject=user-2`, { headers })).status, 400);
  const injected = await fetch(`${app.url}${LIVE_ADMIN_CORA_PERSONAL_PREFERENCES_PATH}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ interruptMode: 'barge_in', muted: false, turnMode: 'concise', verbosity: 'concise', volume: 80, voiceProfile: null, provider: 'claude' }) });
  assert.equal(injected.status, 400);
});

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
  for (const sibling of ['/administrator', '/administer', '/api/administrator']) {
    assert.equal((await fetch(`${app.url}${sibling}`)).status, 426, `${sibling} must remain outside the admin mount`);
  }
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
  assert.deepEqual((await session.json()).actor, { subject: 'user-1', tenantId: 'helmian-platform', role: 'admin' });
  const response = await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}?tenant_id=tenant-b`, { headers });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.tenant.tenant_id, 'helmian-platform');
  assert.equal(result.authorization, 'oidc_identity_plus_neon_membership_verified');
  assert.deepEqual(result.tools.names, [
    'aimforge_get_dispatch_board_summary',
    'aimforge_prepare_driver_message',
    'aimforge_create_department_handoff',
    'aimforge_get_equipment_safety_status',
    'aimforge_record_equipment_safety_check',
    'aimforge_request_safety_supervisor_review',
  ]);
  assert.equal(result.tools.humeAttached.count, 0);
  assert.equal(result.tools.helmianHands.driverSafety.holdRelease, false);
  assert.equal(result.tools.genericTools, false);
  assert.equal(result.release.ready, true);
  assert.equal(result.migrations.ready, true);
  assert.deepEqual(result.audit, { eventCount: 7, pendingOutboxCount: 1 });
  assert.equal(result.invocation, 'read_only');
  assert.equal(result.mutation, 'not_performed');
  const membershipQueries = app.pool.queries.filter(({ text }) => text.includes('tenant_memberships'));
  assert.ok(membershipQueries.length >= 2);
  assert.ok(membershipQueries.some(({ values }) => values[0] === 'user-1'));
  assert.ok(membershipQueries.some(({ values }) => values[0] === 'helmian-platform' && values[1] === 'user-1'));
});

test('revoked OIDC subjects fail closed against current Neon membership', async (t) => {
  const app = await fixture({ membershipRoles: {} });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}`, { headers })).status, 403);
});

test('a subject with two admin tenants is denied until a server-bound picker exists', async (t) => {
  const app = await fixture({ membershipRoles: { 'helmian-platform': 'admin', 'tenant-b': 'owner' } });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}?tenant_id=tenant-b`, { headers })).status, 403);
});

test('a current role change from admin to member immediately removes admin access', async (t) => {
  const app = await fixture({ membershipRoles: { 'helmian-platform': 'member' } });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 403);
});

test('database outages fail closed without being mislabeled as membership revocation', async (t) => {
  const app = await fixture({ membershipError: true });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const session = await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers });
  const control = await fetch(`${app.url}${LIVE_ADMIN_CONTROL_PATH}`, { headers });
  assert.equal(session.status, 503);
  assert.equal((await session.json()).code, 'ADMIN_DATABASE_READ_FAILED');
  assert.equal(control.status, 503);
  assert.equal((await control.json()).code, 'ADMIN_DATABASE_READ_FAILED');
});

test('a customer-tenant admin cannot manage the platform-global action policy', async (t) => {
  const app = await fixture({ membershipRoles: { 'customer-facility-west': 'admin' } });
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_SESSION_PATH}`, { headers })).status, 200);
  const policy = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PATH}`, { headers });
  assert.equal(policy.status, 403);
  assert.equal((await policy.json()).code, 'ADMIN_MEMBERSHIP_REQUIRED');
});

test('action policy requires preview, actor-bound confirm, current ETag, and exact allowlisted actions', async (t) => {
  const app = await fixture();
  t.after(app.close);
  const headers = { cookie: 'helmion_admin_session=active-session' };
  const initial = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PATH}`, { headers });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('etag'), '"helmion-action-policy-v0"');
  assert.deepEqual((await initial.json()).policy.enabledActions, [
    'aimforge_get_dispatch_board_summary',
    'aimforge_prepare_driver_message',
    'aimforge_create_department_handoff',
    'aimforge_get_equipment_safety_status',
    'aimforge_record_equipment_safety_check',
    'aimforge_request_safety_supervisor_review',
  ]);

  const invalid = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ enabledActions: ['run_command'] }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'ACTION_POLICY_INPUT_INVALID');
  const wrongMedia = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/jsonp', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ enabledActions: [] }),
  });
  assert.equal(wrongMedia.status, 415);
  assert.equal((await wrongMedia.json()).code, 'ACTION_POLICY_MEDIA_TYPE_REQUIRED');

  const preview = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH}?tenantId=tenant-b`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ enabledActions: ['aimforge_get_dispatch_board_summary'] }),
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  const previewId = previewBody.preview.previewId;
  assert.equal(previewBody.preview.scope, 'all_signed_aimforge_tenants');
  const stolen = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH}`, {
    method: 'POST', headers: { cookie: 'helmion_admin_session=second-session', 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ previewId }),
  });
  assert.equal(stolen.status, 409);
  assert.equal((await stolen.json()).code, 'ACTION_POLICY_PREVIEW_INVALID');

  const confirmed = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ previewId }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.headers.get('etag'), '"helmion-action-policy-v1"');
  assert.deepEqual((await confirmed.json()).policy.enabledActions, ['aimforge_get_dispatch_board_summary']);
  assert.equal((await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_CONFIRM_PATH}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ previewId }),
  })).status, 409, 'a preview can be confirmed only once');
  const stale = await fetch(`${app.url}${LIVE_ADMIN_ACTION_POLICY_PREVIEW_PATH}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'if-match': '"helmion-action-policy-v0"' },
    body: JSON.stringify({ enabledActions: [] }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { valid: false, code: 'ACTION_POLICY_VERSION_CONFLICT', currentVersion: 1 });
  assert.ok(app.pool.auditEntries.some((entry) => entry.actionType === 'admin.action_policy.preview' && entry.decision === 'ALLOW'));
  assert.ok(app.pool.auditEntries.some((entry) => entry.actionType === 'admin.action_policy.preview' && entry.decision === 'DENY'));
  assert.ok(app.pool.auditEntries.some((entry) => entry.actionType === 'admin.action_policy.confirm' && entry.decision === 'ALLOW'));
  assert.equal(app.pool.queries.some(({ values }) => values.includes?.('tenant-b')), false, 'query parameters never choose the tenant');
});

test('admin page presents fixed Helmian hands with explicit preview and confirmation, never a provider or secret editor', async (t) => {
  const page = await readFile(new URL('../web/cloud-admin/index.html', import.meta.url), 'utf8');
  assert.match(page, /Hume-attached tools:\s*<strong>0<\/strong>/u);
  assert.match(page, /Driver safety hands:\s*<strong>3<\/strong>/u);
  assert.match(page, /Preview change/u);
  assert.match(page, /Confirm action policy/u);
  assert.match(page, /every newly signed AimForge customer session/u);
  assert.doesNotMatch(page, /type="password"|provider selector|model selector|command editor/iu);
});

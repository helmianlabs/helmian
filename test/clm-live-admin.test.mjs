import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

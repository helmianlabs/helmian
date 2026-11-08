import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH, TENANT_SELECTION_COOKIE, TENANT_SELECTION_HEADER } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

// The workspace-picker rule (post-picker world, WS-SWITCH pieces 1 + 1b):
// owner-console writes resolve through deriveAdminActor, which follows
// the person's presented workspace selection (the x-helmian-tenant
// header or the signed helmian_tenant cookie). A subject whose admin
// memberships span exactly ONE workspace always resolves to it —
// duplicate raced rows within that workspace included — with no
// selection needed. A subject holding owner memberships in TWO
// different workspaces must present a selection naming one of them;
// with no selection, the write is refused 403 ADMIN_MEMBERSHIP_REQUIRED
// until they pick. The refusal is never a lockout: presenting a
// selection for either workspace resolves immediately.
//
// History: the cross-tenant fixture below is the raced-signup pair seen
// live 2026-11-04 (two active owner memberships for one subject,
// created 60 ms apart, in two different tenants). The original version
// of this file asserted that pair resolved silently to the
// earliest-created tenant — the stopgap from before a server-bound
// picker existed. The picker now exists, so that premise is retired
// here; the incident coverage that survives is the same-tenant raced
// duplicate pair (user_race), which must keep resolving untouched.
const SECRET = 'admin-pick-test-secret-0123456789abcdef';
const envWithSecret = { ...env, HELMION_ADMIN_SESSION_SECRET: SECRET };

const MEMBERSHIPS_BY_SUBJECT = {
  // Cross-tenant pair. The earliest-created row carries the
  // alphabetically LATER tenant_id, so a pick by tenant_id order would
  // resolve to the second workspace — only the created_at order, or an
  // honoured selection, is deterministic here.
  user_dup1: [
    { tenant_id: 'tenant-zzz-first', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
    { tenant_id: 'tenant-aaa-second', role: 'owner', created_at: '2026-11-04T15:16:42.730Z' },
  ],
  // Raced duplicates within ONE tenant: two owner rows for the same
  // workspace, created 60 ms apart. This subject must never be refused
  // and never need a selection.
  user_race: [
    { tenant_id: 'tenant-mmm-only', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
    { tenant_id: 'tenant-mmm-only', role: 'owner', created_at: '2026-11-04T15:16:42.730Z' },
  ],
  // user_none has no memberships at all (absent from the map).
};

function pool() {
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1')) {
      // Tenant-scoped checks (requireActiveTenantMembership): within one
      // tenant the subject has exactly one effective row — the
      // duplicates are across tenants or duplicate rows of one tenant.
      // Fixture tenants are disjoint across subjects, so a lookup by
      // tenant alone is unambiguous here.
      const row = Object.values(MEMBERSHIPS_BY_SUBJECT).flat().find((m) => m.tenant_id === args[0]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // Subject-scoped deriver query. Emulate whichever ORDER BY the
      // query asks for.
      const mine = MEMBERSHIPS_BY_SUBJECT[args[0]] ?? [];
      const rows = [...mine].sort((a, b) => (q.includes('created_at')
        ? (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.tenant_id < b.tenant_id ? -1 : 1))
        : (a.tenant_id < b.tenant_id ? -1 : 1)));
      return { rowCount: rows.length, rows: rows.map(({ tenant_id, role }) => ({ tenant_id, role })) };
    }
    return { rowCount: 0, rows: [] };
  }, release() {} };
  return { connect: async () => client };
}

function fakeResponse() {
  const r = { status: 0, headers: null, body: '',
    writeHead(s, h) { r.status = s; r.headers = h ?? null; },
    write() { return true; },
    end(b) { r.body = b ?? ''; } };
  return r;
}

function postRequest(path, sessionId, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const req = Readable.from([payload]);
  req.method = 'POST';
  req.url = path;
  req.headers = { cookie: `helmion_admin_session=${sessionId}`, host: 'localhost', 'content-type': 'application/json', 'content-length': String(payload.length), ...extraHeaders };
  return req;
}

function signSelection(tenantId) {
  return `${tenantId}.${createHmac('sha256', SECRET).update(`helmian_tenant:${tenantId}`).digest('base64url')}`;
}

async function makeAdmin(t, saved, handlerEnv = env) {
  const admin = await createLiveHelmianCloudAdminHandler({
    env: handlerEnv,
    pool: pool(),
    identity: { getSession: (id) => (id === 's1' ? { subject: 'user_dup1' } : id === 's2' ? { subject: 'user_none' } : id === 's3' ? { subject: 'user_race' } : null) },
    page: '<p>t</p>',
    script: 'void 0;',
    expectedMigrations: [],
    workspaceProjectRepository: {
      save: async (actor, body) => { saved.push({ actor, body }); return { project: { projectKey: body.projectKey, tenantId: actor.tenantId } }; },
      bindRepo: async (actor, body) => { saved.push({ actor, body }); return { binding: { projectKey: body.projectKey, tenantId: actor.tenantId } }; },
    },
  });
  t.after(async () => { await admin.close(); });
  return admin;
}

test('project create: duplicate owner rows within one workspace (the raced-signup shape) still resolve to that workspace and the POST succeeds', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, 's3', { defaultBranch: 'main', displayName: 'Proof', lifecycle: 'active', projectKey: 'proof', sourceKind: 'local' }), r);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, true);
  assert.equal(body.project.tenantId, 'tenant-mmm-only');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.subject, 'user_race');
  assert.equal(saved[0].actor.tenantId, 'tenant-mmm-only');
  assert.equal(saved[0].actor.role, 'owner');
});

test('repo binding create: duplicate owner rows within one workspace resolve through the same deriver, no selection needed', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH, 's3', { installationId: 'inst-1', projectKey: 'proof', repoName: 'repo', repoOwner: 'owner' }), r);
  assert.equal(r.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.tenantId, 'tenant-mmm-only');
});

test('project create: owner memberships in two different workspaces and no selection presented is refused 403 until a workspace is picked', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, 's1', { defaultBranch: 'main', displayName: 'Proof', lifecycle: 'active', projectKey: 'proof', sourceKind: 'local' }), r);
  assert.equal(r.status, 403);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, false);
  // The deriver's refusal is the picker's ADMIN_MEMBERSHIP_REQUIRED
  // denial; this route has always translated deriver 403s into its
  // route-specific code (the zero-membership case at the bottom of
  // this file asserts the same code on the same route).
  assert.equal(body.code, 'WORKSPACE_PROJECTS_ADMIN_REQUIRED');
  assert.equal(saved.length, 0);
});

test('repo binding create: owner memberships in two different workspaces and no selection presented is refused 403 until a workspace is picked', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH, 's1', { installationId: 'inst-1', projectKey: 'proof', repoName: 'repo', repoOwner: 'owner' }), r);
  assert.equal(r.status, 403);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, false);
  // Same translation as the projects route: the deriver's
  // ADMIN_MEMBERSHIP_REQUIRED denial surfaces under this route's code.
  assert.equal(body.code, 'WORKSPACE_REPO_BINDINGS_ADMIN_REQUIRED');
  assert.equal(saved.length, 0);
});

test('project create: the two-workspace subject presenting the x-helmian-tenant header for the second workspace resolves to it and the POST succeeds', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, 's1', { defaultBranch: 'main', displayName: 'Proof', lifecycle: 'active', projectKey: 'proof', sourceKind: 'local' }, { [TENANT_SELECTION_HEADER]: 'tenant-aaa-second' }), r);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, true);
  assert.equal(body.project.tenantId, 'tenant-aaa-second');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.subject, 'user_dup1');
  assert.equal(saved[0].actor.tenantId, 'tenant-aaa-second');
  assert.equal(saved[0].actor.role, 'owner');
});

test('repo binding create: the two-workspace subject presenting a signed helmian_tenant cookie for the first workspace resolves to it and the POST succeeds', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved, envWithSecret);
  const r = fakeResponse();
  const cookie = `helmion_admin_session=s1; ${TENANT_SELECTION_COOKIE}=${signSelection('tenant-zzz-first')}`;
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH, 's1', { installationId: 'inst-1', projectKey: 'proof', repoName: 'repo', repoOwner: 'owner' }, { cookie }), r);
  assert.equal(r.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.subject, 'user_dup1');
  assert.equal(saved[0].actor.tenantId, 'tenant-zzz-first');
  assert.equal(saved[0].actor.role, 'owner');
});

test('project create: a subject with zero memberships still gets the same 403', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, 's2', { defaultBranch: 'main', displayName: 'Proof', lifecycle: 'active', projectKey: 'proof', sourceKind: 'local' }), r);
  assert.equal(r.status, 403);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, false);
  assert.equal(body.code, 'WORKSPACE_PROJECTS_ADMIN_REQUIRED');
  assert.equal(saved.length, 0);
});

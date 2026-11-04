import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

// The raced-signup pair seen live 2026-11-04: two active owner memberships
// for one subject, created 60 ms apart, in two different tenants. The
// earliest-created row carries the alphabetically LATER tenant_id, so a
// pick by tenant_id order (or a refusal on duplicates, the old
// deriveAdminActor behavior) both fail this fixture — only the
// created_at pick resolves to the first workspace.
const MEMBERSHIPS = [
  { tenant_id: 'tenant-zzz-first', role: 'owner', created_at: '2026-11-04T15:16:42.670Z' },
  { tenant_id: 'tenant-aaa-second', role: 'owner', created_at: '2026-11-04T15:16:42.730Z' },
];

function pool() {
  const client = { async query(sql, args = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && q.includes('tenant_id=$1')) {
      // Tenant-scoped checks (requireActiveTenantMembership): within one
      // tenant the subject has exactly one row — the duplicates are
      // across tenants.
      const row = MEMBERSHIPS.find((m) => m.tenant_id === args[0]);
      return row ? { rowCount: 1, rows: [{ role: row.role }] } : { rowCount: 0, rows: [] };
    }
    if (q.includes('from helmion.tenant_memberships')) {
      // Subject-scoped deriver query. user_none has no memberships at all.
      if (args[0] === 'user_none') return { rowCount: 0, rows: [] };
      // Emulate whichever ORDER BY the query asks for.
      const rows = [...MEMBERSHIPS].sort((a, b) => (q.includes('created_at')
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

function postRequest(path, sessionId, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const req = Readable.from([payload]);
  req.method = 'POST';
  req.url = path;
  req.headers = { cookie: `helmion_admin_session=${sessionId}`, host: 'localhost', 'content-type': 'application/json', 'content-length': String(payload.length) };
  return req;
}

async function makeAdmin(t, saved) {
  const admin = await createLiveHelmianCloudAdminHandler({
    env,
    pool: pool(),
    identity: { getSession: (id) => (id === 's1' ? { subject: 'user_dup1' } : id === 's2' ? { subject: 'user_none' } : null) },
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

test('project create: a subject with two active owner memberships resolves to the earliest-created tenant and the POST succeeds', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_PROJECTS_PATH, 's1', { defaultBranch: 'main', displayName: 'Proof', lifecycle: 'active', projectKey: 'proof', sourceKind: 'local' }), r);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.valid, true);
  assert.equal(body.project.tenantId, 'tenant-zzz-first');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.subject, 'user_dup1');
  assert.equal(saved[0].actor.tenantId, 'tenant-zzz-first');
  assert.equal(saved[0].actor.role, 'owner');
});

test('repo binding create: the same duplicate-membership subject resolves through the same deriver', async (t) => {
  const saved = [];
  const admin = await makeAdmin(t, saved);
  const r = fakeResponse();
  await admin.handler(postRequest(LIVE_ADMIN_WORKSPACE_REPO_BINDINGS_PATH, 's1', { installationId: 'inst-1', projectKey: 'proof', repoName: 'repo', repoOwner: 'owner' }), r);
  assert.equal(r.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.tenantId, 'tenant-zzz-first');
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

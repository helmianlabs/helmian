import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_OVERVIEW_PATH } from '../src/cloud/live-admin.mjs';
import { RELEASE_PHASES, RELEASE_CAPABILITIES, RELEASE_BOUNDARIES, RELEASE_ROADMAP_PATH, getReleaseRoadmap } from '../src/cloud/release-manifest.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

test('roadmap manifest has phases 5A-5E with honest cloud statuses', () => {
  assert.deepEqual(RELEASE_PHASES.map((p) => p.id), ['5A', '5B', '5C', '5D', '5E']);
  for (const phase of RELEASE_PHASES) {
    assert.ok(phase.name && phase.focus && phase.cloudNote, phase.id);
    assert.ok(['IMPLEMENTED', 'IN PROGRESS', 'PLANNED'].includes(phase.status), phase.id);
  }
  const byId = Object.fromEntries(RELEASE_PHASES.map((p) => [p.id, p.status]));
  assert.equal(byId['5C'], 'IMPLEMENTED');
  assert.equal(byId['5E'], 'PLANNED');
});

test('roadmap manifest has nine capabilities with cloud statuses and three boundaries', () => {
  assert.equal(RELEASE_CAPABILITIES.length, 9);
  for (const cap of RELEASE_CAPABILITIES) {
    assert.ok(cap.name && cap.intent && cap.verification, cap.name);
    assert.ok(['IMPLEMENTED', 'IN PROGRESS', 'PLANNED'].includes(cap.cloudStatus), cap.name);
  }
  assert.deepEqual(RELEASE_BOUNDARIES.map((b) => b.name), ['Identity boundary', 'Data boundary', 'Release boundary']);
  for (const boundary of RELEASE_BOUNDARIES) assert.ok(boundary.text.length > 20, boundary.name);
  const roadmap = getReleaseRoadmap();
  assert.equal(roadmap.phases.length, 5);
  assert.equal(roadmap.capabilities.length, 9);
  assert.equal(roadmap.boundaries.length, 3);
});

// Route tests: the roadmap route touches no tables, so the fake pool only
// serves the actor lookup.
function routePool(role = 'member') {
  const client = {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role }] };
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

function identity() { return { getSession: (id) => id === 'active-session' ? { subject: 'user-1' } : null }; }

async function startServer(t, { role = 'member' } = {}) {
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: routePool(role), identity: identity(), page: '<p>test</p>', script: 'void 0;', expectedMigrations: [],
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('roadmap endpoint serves the manifest to members (matches /api/admin/release scoping)', async (t) => {
  const base = await startServer(t, { role: 'member' });
  const response = await fetch(`${base}${RELEASE_ROADMAP_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.valid, true);
  assert.equal(body.phases.length, 5);
  assert.equal(body.capabilities.length, 9);
  assert.equal(body.boundaries.length, 3);
});

test('roadmap endpoint returns 403 without a session', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}${RELEASE_ROADMAP_PATH}`);
  assert.equal(response.status, 403);
});

test('overview settings carry build identity and no secrets', async (t) => {
  const client = {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships') && !q.includes('count(*)')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] };
      if (q.includes('filter (where r.id is null)')) return { rows: [{ queued: 0, ran: 0 }] };
      if (q.includes('count(*)')) return { rows: [{ n: 1 }] };
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: { connect: async () => client }, identity: identity(), page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const body = await (await fetch(`${base}${LIVE_ADMIN_OVERVIEW_PATH}`, { headers: { cookie: 'helmion_admin_session=active-session' } })).json();
  assert.ok(body.settings.build, 'build identity present');
  assert.equal(body.settings.build.runtime, 'Vercel serverless + Neon Postgres');
  assert.equal(body.settings.build.region, 'us-west-2');
  assert.ok(typeof body.settings.build.version === 'string' && body.settings.build.version.length > 0);
  assert.doesNotMatch(JSON.stringify(body.settings), /postgresql:|neon\.tech|sk_|pk_test|pk_live/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { createLiveHelmianCloudAdminHandler, LIVE_ADMIN_OVERVIEW_PATH, LIVE_ADMIN_RELEASE_PATH } from '../src/cloud/live-admin.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function pool() {
  const client = { async query(sql) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships') && !q.includes('count(*)')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] };
    if (q.includes('filter (where r.id is null)')) return { rows: [{ queued: 1, ran: 2 }] };
    if (q.includes('count(*)')) return { rows: [{ n: 3 }] };
    throw new Error(`unexpected query ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('overview and release routes are tenant-scoped and expose no secrets', async (t) => {
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: { getSession: (id) => id === 's1' ? { subject: 'user-1' } : null }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  const realFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = realFetch; await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=s1' };
  const res = await realFetch(`${base}${LIVE_ADMIN_OVERVIEW_PATH}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.actor.tenantId, 'customer-a');
  assert.equal(body.counts.activeProjects, 3);
  assert.deepEqual(body.console, { queued: 1, ran: 2 });
  assert.equal(body.settings.database, true);
  assert.doesNotMatch(JSON.stringify(body), /postgresql:|neon\.tech/);
  assert.equal((await realFetch(`${base}${LIVE_ADMIN_OVERVIEW_PATH}`)).status, 403);
  assert.equal((await realFetch(`${base}${LIVE_ADMIN_OVERVIEW_PATH}?tenant_id=x`, { headers })).status, 400);
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.github.com/') ? new Response(JSON.stringify([{ tag_name: 'v0.1.0', name: 'v0.1.0', published_at: '2026-10-15T00:00:00Z', html_url: 'u', assets: [{ name: 'Setup.exe', download_count: 4, browser_download_url: 'd' }] }])) : realFetch(url, init);
  const rel = await (await realFetch(`${base}${LIVE_ADMIN_RELEASE_PATH}`, { headers })).json();
  assert.equal(rel.releases[0].assets[0].downloads, 4);
});

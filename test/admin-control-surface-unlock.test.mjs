import assert from 'node:assert/strict';
import test from 'node:test';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import {
  createLiveHelmianCloudAdminHandler,
  LIVE_ADMIN_ACTION_POLICY_PATH,
  LIVE_ADMIN_CONTROL_PATH,
  LIVE_ADMIN_SESSION_PATH,
} from '../src/cloud/live-admin.mjs';
import { HELMIAN_ACTION_TOOL_NAMES } from '../src/cloud/tenant-action-policy.mjs';

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

// The owner belongs to exactly one organization: a real tenant with a UUID-
// style id ('customer-a' here), as owner. The platform action policy lives
// under the synthetic 'helmian-platform' tenant, which no organization
// membership can name — the surface reads must not demand it.
const POLICY_ROW = {
  version: 7,
  dispatch_board_summary_enabled: true,
  prepare_driver_message_enabled: false,
  department_handoff_enabled: true,
  equipment_safety_status_enabled: true,
  equipment_safety_check_enabled: false,
  equipment_safety_escalation_enabled: false,
};
const EXPECTED_ENABLED = [HELMIAN_ACTION_TOOL_NAMES[0], HELMIAN_ACTION_TOOL_NAMES[2], HELMIAN_ACTION_TOOL_NAMES[3]];

function pool() {
  const client = { async query(sql) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'begin read only', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) {
      if (q.includes('for share')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] };
    }
    if (q.includes('from helmion.platform_action_policy')) return { rowCount: 1, rows: [POLICY_ROW] };
    if (q.includes('from helmion.tenants')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', display_name: 'Customer A' }] };
    if (q.includes('to_regclass')) return { rowCount: 1, rows: [{ migration_table: null }] };
    if (q.includes('count(*)')) return { rowCount: 1, rows: [{ count: 3 }] };
    throw new Error(`unexpected query ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

async function boot(t) {
  const admin = await createLiveHelmianCloudAdminHandler({ env, pool: pool(), identity: { getSession: (id) => id === 's1' ? { subject: 'user-1' } : null }, page: '<p>t</p>', script: 'void 0;', expectedMigrations: [] });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  return clm.healthUrl.replace('/healthz', '');
}

test('owner of a non-platform organization gets session and control surface; policy management stays platform-gated', async (t) => {
  const base = await boot(t);
  const headers = { cookie: 'helmion_admin_session=s1' };

  const session = await fetch(`${base}${LIVE_ADMIN_SESSION_PATH}`, { headers });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.actor.tenantId, 'customer-a');
  assert.equal(sessionBody.actor.role, 'owner');

  // The control surface embeds the platform-global action policy snapshot.
  // It must answer for the owner's own organization, not demand membership
  // in the synthetic platform tenant the policy row is stored under.
  const surface = await fetch(`${base}${LIVE_ADMIN_CONTROL_PATH}`, { headers });
  assert.equal(surface.status, 200);
  const surfaceBody = await surface.json();
  assert.equal(surfaceBody.result.tenant.tenant_id, 'customer-a');
  assert.equal(surfaceBody.result.tools.helmianHands.policyVersion, 7);
  assert.equal(surfaceBody.result.tools.helmianHands.policySource, 'platform_global_policy');
  assert.deepEqual(surfaceBody.result.tools.helmianHands.enabled, EXPECTED_ENABLED);

  // The dedicated policy-MANAGEMENT read stays platform-gated by design
  // (pinned by clm-live-admin: a customer-tenant admin cannot manage the
  // platform-global policy). The console page absorbs this 403 into the
  // policy panel — it must not flip the console back to signed-out.
  const policy = await fetch(`${base}${LIVE_ADMIN_ACTION_POLICY_PATH}`, { headers });
  assert.equal(policy.status, 403);
  assert.equal((await policy.json()).code, 'ADMIN_MEMBERSHIP_REQUIRED');
});

test('control surface and policy read still refuse anonymous callers', async (t) => {
  const base = await boot(t);
  assert.equal((await fetch(`${base}${LIVE_ADMIN_CONTROL_PATH}`)).status, 403);
  assert.equal((await fetch(`${base}${LIVE_ADMIN_ACTION_POLICY_PATH}`)).status, 403);
});

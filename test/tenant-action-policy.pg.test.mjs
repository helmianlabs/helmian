import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createNeonStore } from '../src/adapters/neon.mjs';
import {
  ActionPolicyConflictError,
  HELMIAN_ACTION_TOOL_NAMES,
  HELMIAN_PLATFORM_TENANT_ID,
  readAdminActionPolicy,
  resolvePlatformActionPolicy,
  updateAdminActionPolicy,
} from '../src/cloud/tenant-action-policy.mjs';

const connectionString = process.env.HELMION_ADMIN_CONFIG_TEST_DATABASE_URL;

function context(tenantId, subject) {
  return {
    tenantId,
    actorSubject: subject,
    actorRole: 'admin',
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
}

test('migrations 007-008 provide platform-owned global kill switches with customer-tenant isolation and conflict audit', {
  skip: !connectionString && 'HELMION_ADMIN_CONFIG_TEST_DATABASE_URL is not configured',
}, async (t) => {
  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  t.after(() => pool.end());
  const store = await createNeonStore(null, { pool });
  await store.migrate();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const customerTenant = `customer-${suffix}`;
  const platformActor = `clerk-platform-${suffix}`;
  const customerActor = `clerk-customer-${suffix}`;
  await pool.query(
    `insert into helmion.tenants(tenant_id, display_name)
       values ($1,'Helmian Platform'),($2,'Customer Tenant')
       on conflict (tenant_id) do nothing`,
    [HELMIAN_PLATFORM_TENANT_ID, customerTenant],
  );
  await pool.query(
    `insert into helmion.tenant_memberships(tenant_id,subject,role,active)
       values ($1,$3,'admin',true),($2,$4,'admin',true)`,
    [HELMIAN_PLATFORM_TENANT_ID, customerTenant, platformActor, customerActor],
  );
  await pool.query('delete from helmion.platform_action_policy where policy_key=$1', ['signed_aimforge_actions']);

  const defaultPolicy = await readAdminActionPolicy(pool, context(HELMIAN_PLATFORM_TENANT_ID, platformActor));
  assert.equal(defaultPolicy.version, 0);
  assert.deepEqual(defaultPolicy.enabledActions, HELMIAN_ACTION_TOOL_NAMES);

  const first = await updateAdminActionPolicy(pool, context(HELMIAN_PLATFORM_TENANT_ID, platformActor), {
    expectedVersion: 0,
    enabledActions: [HELMIAN_ACTION_TOOL_NAMES[0]],
  });
  assert.equal(first.version, 1);
  assert.deepEqual(first.enabledActions, [HELMIAN_ACTION_TOOL_NAMES[0]]);
  assert.deepEqual((await resolvePlatformActionPolicy(pool)).enabledActions, [HELMIAN_ACTION_TOOL_NAMES[0]]);
  await assert.rejects(
    () => readAdminActionPolicy(pool, context(customerTenant, customerActor)),
    /requires the helmian-platform tenant/u,
  );

  await assert.rejects(
    () => updateAdminActionPolicy(pool, context(HELMIAN_PLATFORM_TENANT_ID, platformActor), {
      expectedVersion: 0,
      enabledActions: [],
    }),
    (error) => error instanceof ActionPolicyConflictError && error.currentVersion === 1,
  );
  const audit = await pool.query(
    `select decision, result->>'reason' as reason
       from helmion.audit_events
      where tenant_id=$1 and actor_subject=$2 and action_type='admin.action_policy.confirm'
      order by id`,
    [HELMIAN_PLATFORM_TENANT_ID, platformActor],
  );
  assert.deepEqual(audit.rows.map((row) => [row.decision, row.reason]), [
    ['ALLOW', 'confirmed_by_current_admin'],
    ['DENY', 'optimistic_version_conflict'],
  ]);
  assert.equal((await pool.query(
    `select count(*)::integer as count from helmion.audit_events where tenant_id=$1`,
    [customerTenant],
  )).rows[0].count, 0);
});

test('runtime policy lookup fails closed on database outage', async () => {
  const pool = { connect: async () => { throw new Error('database unavailable'); } };
  await assert.rejects(() => resolvePlatformActionPolicy(pool), /database unavailable/u);
});

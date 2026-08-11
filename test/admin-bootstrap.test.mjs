import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapHelmianAdminOwner } from '../src/cloud/admin-bootstrap.mjs';

const connectionString = 'postgresql://app:password@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require';

function poolFixture({ existing = false, role = 'owner' } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql); queries.push({ text, values });
      if (text.includes("to_regclass('helmion.tenants')")) return { rows: [{ tenants: 'helmion.tenants', memberships: 'helmion.tenant_memberships', audit_events: 'helmion.audit_events' }] };
      if (text.startsWith('insert into helmion.tenants')) return { rowCount: existing ? 0 : 1, rows: existing ? [] : [{ tenant_id: 'helmian-platform' }] };
      if (text.startsWith('select tenant_id, display_name')) return { rowCount: 1, rows: [{ tenant_id: 'helmian-platform', display_name: 'Helmian Platform' }] };
      if (text.startsWith('insert into helmion.tenant_memberships')) return { rowCount: existing ? 0 : 1, rows: existing ? [] : [{ tenant_id: 'helmian-platform' }] };
      if (text.startsWith('select tenant_id, subject, role')) return { rowCount: 1, rows: [{ tenant_id: 'helmian-platform', subject: 'user_clerk_owner', role, active: true }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { queries, connect: async () => client };
}

test('explicit bootstrap creates one owner, reads it back, audits, and commits', async () => {
  const pool = poolFixture();
  const result = await bootstrapHelmianAdminOwner({
    tenantId: 'helmian-platform', displayName: 'Helmian Platform', subject: 'user_clerk_owner', confirmed: true,
  }, { connectionString, expectedEndpointId: 'ep-silent-rain-a1b2c3d4', pool });
  assert.equal(result.created, true);
  assert.equal(result.role, 'owner');
  assert.ok(pool.queries.some(({ text }) => text.includes('admin.bootstrap_owner')));
  assert.equal(pool.queries.at(-1).text, 'commit');
});

test('bootstrap is idempotent but refuses missing confirmation or a conflicting role', async () => {
  await assert.rejects(() => bootstrapHelmianAdminOwner({
    tenantId: 'helmian-platform', displayName: 'Helmian Platform', subject: 'user_clerk_owner', confirmed: false,
  }, { connectionString, expectedEndpointId: 'ep-silent-rain-a1b2c3d4', pool: poolFixture() }), /confirmed=true/u);
  await assert.rejects(() => bootstrapHelmianAdminOwner({
    tenantId: 'helmian-platform', displayName: 'Helmian Platform', subject: 'user_clerk_owner', confirmed: true,
  }, { connectionString, expectedEndpointId: 'ep-silent-rain-a1b2c3d4', pool: poolFixture({ existing: true, role: 'admin' }) }), /not the requested active owner/u);
  const pool = poolFixture({ existing: true });
  const duplicate = await bootstrapHelmianAdminOwner({
    tenantId: 'helmian-platform', displayName: 'Helmian Platform', subject: 'user_clerk_owner', confirmed: true,
  }, { connectionString, expectedEndpointId: 'ep-silent-rain-a1b2c3d4', pool });
  assert.equal(duplicate.created, false);
  assert.equal(pool.queries.some(({ text }) => text.includes('admin.bootstrap_owner')), false);
});

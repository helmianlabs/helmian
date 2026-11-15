// Workspace lease against a real database. The in-memory suite
// (workspace-lease.test.mjs) drives a fake pool that cannot enforce
// the schema, which is how the lease's audit writes shipped with an
// actor role the audit_events check constraint rejects: against the
// real migrations every acquire failed closed with reason 'error'
// and no lease row ever landed. This suite runs the real module
// against the real migrations when HELMIAN_TEST_PG_URL points at a
// scratch database with the repo's sql/ migrations applied, and
// skips cleanly without one (the envoy-findings.test.mjs pattern).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { acquireWorkspaceLease, releaseWorkspaceLease } from '../src/cora/workspace-lease.mjs';

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('lease acquire and release land audit events with a lawful actor role', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Workspace Lease PG Test']);

    const acquired = await acquireWorkspaceLease({ pool, tenantId, holder: 'worker:pg-test' });
    assert.equal(acquired.acquired, true, `acquire must succeed against the real schema, got ${JSON.stringify(acquired)}`);
    assert.match(acquired.leaseToken, /^[0-9a-f-]{36}$/);

    const second = await acquireWorkspaceLease({ pool, tenantId, holder: 'worker:other' });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'held');

    const released = await releaseWorkspaceLease({ pool, tenantId, leaseToken: acquired.leaseToken });
    assert.equal(released.released, true);

    const audit = await pool.query(
      'select action_type, actor_subject, actor_role from helmion.audit_events where tenant_id=$1 order by id',
      [tenantId],
    );
    assert.equal(audit.rowCount, 2, 'acquire and release each write exactly one audit event');
    assert.deepEqual(audit.rows.map((r) => r.action_type), ['workspace.lease.acquired', 'workspace.lease.released']);
    for (const row of audit.rows) {
      assert.equal(row.actor_role, 'member', 'audit events carry the membership-shaped system role');
      assert.equal(row.actor_subject, 'worker:pg-test');
    }

    const leases = await pool.query(
      'select status from helmion.workspace_write_leases where tenant_id=$1 order by id',
      [tenantId],
    );
    assert.deepEqual(leases.rows.map((r) => r.status), ['RELEASED']);
  } finally {
    await pool.query('delete from helmion.audit_outbox where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('delete from helmion.audit_events where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('delete from helmion.workspace_write_leases where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.query('delete from helmion.tenants where tenant_id=$1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

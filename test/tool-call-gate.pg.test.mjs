import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The tool-call gate against a real database: the fake-pool unit
// tests cannot enforce the audit table's own vocabulary, and a
// decision word the audit_events check constraint refuses makes
// every authorization throw on a real database — the failure this
// file exists to keep from coming back.
const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL is not set';

test('tool-call gate on Postgres: allow and deny both land audit receipts in the table vocabulary', { skip }, async () => {
  const pg = (await import('pg')).default;
  const { createToolCallGate } = await import('../src/cloud/tool-call-gate.mjs');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const subject = `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Gate PG test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, subject, 'owner']);
  await pool.query(
    `insert into helmion.tenant_attribute_rules(tenant_id, rule_id, effect, actions, conditions, reason, created_by) values ($1,'deny-test-tool','DENY','["tool.call"]'::jsonb,'{"resource.toolName":"blocked-tool"}'::jsonb,'gate pg test',$2)`,
    [tenantId, subject],
  );
  const gate = createToolCallGate({ pool });
  const actor = { tenantId, subject, role: 'owner', sessionId: randomUUID(), requestId: randomUUID() };
  try {
    const allowed = await gate.authorizeToolCall(actor, { toolName: 'harmless-tool' });
    assert.equal(allowed.allowed, true);
    assert.ok(allowed.receiptId, 'an allow carries its audit receipt id');
    const denied = await gate.authorizeToolCall(actor, { toolName: 'blocked-tool' });
    assert.equal(denied.allowed, false);
    assert.ok(denied.receiptId, 'a deny carries its audit receipt id');
    const rows = await pool.query(
      'select decision from helmion.audit_events where tenant_id=$1 and action_type=$2 order by id asc',
      [tenantId, 'tool.call'],
    );
    assert.deepEqual(rows.rows.map((r) => r.decision), ['ALLOW', 'DENY']);
  } finally {
    await pool.end();
  }
});

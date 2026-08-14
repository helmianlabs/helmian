import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditEventRepository, normalizeAuditQuery } from '../src/cloud/audit-event-repository.mjs';

function fakePool(rows) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (String(sql).startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (String(sql).includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'member' }] };
      if (String(sql).includes('from helmion.audit_events')) return { rowCount: rows.length, rows };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

test('audit query bounds filters and rejects invalid cursors/statuses', () => {
  assert.equal(normalizeAuditQuery({ limit: 25, status: 'allow', action: 'envoy.send' }).status, 'ALLOW');
  assert.throws(() => normalizeAuditQuery({ limit: 101 }), /between 1 and 100/u);
  assert.throws(() => normalizeAuditQuery({ status: 'published' }), /status filter is invalid/u);
  assert.throws(() => normalizeAuditQuery({ cursor: 'not-a-cursor' }), /cursor is invalid/u);
});

test('audit repository derives Organization from actor, returns cursor metadata, and never accepts tenant input', async () => {
  const pool = fakePool([
    { id: 8, actor_subject: 'user-1', actor_role: 'member', action_type: 'envoy.send', decision: 'ALLOW', privacy_summary: 'Sent message', created_at: '2026-08-14T12:00:00.000Z' },
    { id: 7, actor_subject: 'admin-1', actor_role: 'admin', action_type: 'cora.publish', decision: 'ALLOW', privacy_summary: 'Published config', created_at: '2026-08-14T11:00:00.000Z' },
  ]);
  const repo = createAuditEventRepository(pool);
  const result = await repo.list({ tenantId: 'customer-a', subject: 'user-1', role: 'member', organizationId: 'customer-b', plantId: 'west' }, { limit: 1, action: 'envoy.send' });
  assert.equal(result.events.length, 1);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  const auditQuery = pool.calls.find(({ sql }) => sql.includes('from helmion.audit_events'));
  assert.equal(auditQuery.values[0], 'customer-a');
  assert.equal(auditQuery.values.includes('customer-b'), false);
  assert.equal(result.mutation, 'not_performed');
});

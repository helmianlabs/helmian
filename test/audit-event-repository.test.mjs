import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditEventRepository, normalizeAuditExportQuery, normalizeAuditQuery } from '../src/cloud/audit-event-repository.mjs';

function fakePool(rows, receiptId = 'export-1') {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (String(sql).startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (String(sql).includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'member' }] };
      if (String(sql).includes('from helmion.audit_events')) return { rowCount: rows.length, rows };
      if (String(sql).includes('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: receiptId }] };
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

test('audit export requires a bounded date range and caps rows', () => {
  const query = normalizeAuditExportQuery({ from: '2026-08-01', to: '2026-08-15', limit: 100 });
  assert.equal(query.limit, 100);
  assert.equal(query.from, '2026-08-01T00:00:00.000Z');
  assert.throws(() => normalizeAuditExportQuery({ from: '2026-08-01' }), /requires from and to/u);
  assert.throws(() => normalizeAuditExportQuery({ from: '2026-08-01', to: '2026-10-01' }), /no more than 31 days/u);
  assert.throws(() => normalizeAuditExportQuery({ from: '2026-08-15', to: '2026-08-01' }), /no more than 31 days/u);
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

test('audit export repository persists a bounded receipt and excludes raw payload columns', async () => {
  const pool = fakePool([{ id: 8, created_at: '2026-08-14T12:00:00.000Z', action_type: 'envoy.send', decision: 'ALLOW', actor_subject: 'user-1', actor_role: 'member', privacy_summary: 'sent password=do-not-export provider_payload=omit' }], 'receipt-8');
  const result = await createAuditEventRepository(pool).exportCsv({ tenantId: 'customer-a', subject: 'user-1', role: 'member' }, { from: '2026-08-01', to: '2026-08-15' });
  assert.equal(result.receiptId, 'receipt-8');
  assert.equal(result.rowCount, 1);
  assert.match(result.csv, /^id,created_at,action_type,decision,actor_subject,actor_role,privacy_summary/mu);
  assert.doesNotMatch(result.csv, /provider_payload=omit|password=do-not-export/iu);
  assert.doesNotMatch(result.csv, /canonical_target|result|session_id|request_id/iu);
  assert.equal(pool.calls.some(({ sql }) => sql.includes("action_type,\n              canonical_target")), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditEventRepository } from '../src/cloud/audit-event-repository.mjs';

function fakePool() {
  const client = {
    async query(sql) {
      const text = String(sql);
      if (text.startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      if (text.includes('from helmion.audit_events')) return { rowCount: 1, rows: [{ id: 5, actor_subject: 'owner-1', actor_role: 'owner', action_type: 'organization.membership_role_change', decision: 'ALLOW', privacy_summary: 'role changed', created_at: '2026-11-21T00:00:00.000Z' }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

const ACTOR = { tenantId: 'tenant-a', subject: 'owner-1', role: 'owner', attributes: { jobTitle: 'owner' } };

test('a tenant DENY rule on the actor job title refuses the audit read', async () => {
  const repo = createAuditEventRepository(fakePool(), {
    attributeRulesProvider: async () => [{ id: 'owners-paused', effect: 'DENY', actions: ['audit.read'], conditions: { 'actor.jobTitle': 'owner' }, reason: 'audit reads paused for owners' }],
  });
  await assert.rejects(() => repo.list(ACTOR, {}), (e) => e.code === 'AUDIT_ATTRIBUTE_POLICY_DENIED' && e.status === 403);
});

test('the same read passes when the tenant has no matching rule', async () => {
  const repo = createAuditEventRepository(fakePool(), {
    attributeRulesProvider: async () => [{ id: 'drivers-only', effect: 'DENY', actions: ['audit.read'], conditions: { 'actor.jobTitle': 'driver' }, reason: 'drivers only' }],
  });
  const result = await repo.list(ACTOR, {});
  assert.equal(result.events.length, 1);
  assert.equal(result.attributePolicy.decision, 'ALLOW');
});

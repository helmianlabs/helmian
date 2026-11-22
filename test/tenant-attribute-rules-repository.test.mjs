import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantAttributeRulesRepository, loadTenantAttributeRules } from '../src/cloud/tenant-attribute-rules-repository.mjs';

function fakePool() {
  const calls = [];
  const rules = [];
  let receipt = 100;
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (text.startsWith('select set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      if (text.startsWith('select rule_id, effect, actions, conditions, reason from helmion.tenant_attribute_rules')) {
        return { rowCount: rules.length, rows: rules.map((r) => ({ rule_id: r.ruleId, effect: r.effect, actions: r.actions, conditions: r.conditions, reason: r.reason })) };
      }
      if (text.startsWith('select rule_id, effect, actions, conditions, reason, active, created_by, created_at from helmion.tenant_attribute_rules')) {
        return { rowCount: rules.length, rows: rules.map((r) => ({ rule_id: r.ruleId, effect: r.effect, actions: r.actions, conditions: r.conditions, reason: r.reason, active: true, created_by: 'owner-1', created_at: '2026-11-21T00:00:00.000Z' })) };
      }
      if (text.startsWith('select id from helmion.tenant_attribute_rules')) {
        const found = rules.some((r) => r.ruleId === values[1]);
        return { rowCount: found ? 1 : 0, rows: found ? [{ id: 1 }] : [] };
      }
      if (text.startsWith('insert into helmion.tenant_attribute_rules')) {
        const row = { ruleId: values[1], effect: values[2], actions: JSON.parse(values[3]), conditions: JSON.parse(values[4]), reason: values[5] };
        rules.push(row);
        return { rowCount: 1, rows: [{ rule_id: row.ruleId, effect: row.effect, actions: row.actions, conditions: row.conditions, reason: row.reason, active: true, created_by: values[6], created_at: '2026-11-21T00:00:00.000Z' }] };
      }
      if (text.startsWith('delete from helmion.tenant_attribute_rules')) {
        const idx = rules.findIndex((r) => r.ruleId === values[1]);
        if (idx === -1) return { rowCount: 0, rows: [] };
        rules.splice(idx, 1);
        return { rowCount: 1, rows: [{ rule_id: values[1] }] };
      }
      if (text.includes('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: ++receipt }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { calls, rules, async connect() { return client; } };
}

const OWNER = { tenantId: 'tenant-a', subject: 'owner-1', role: 'owner' };
const MEMBER = { tenantId: 'tenant-a', subject: 'member-1', role: 'member' };

test('an admin creates a rule, reads it back, and the enforcement loader returns engine shape', async () => {
  const pool = fakePool();
  const repo = createTenantAttributeRulesRepository(pool);
  const created = await repo.create(OWNER, { ruleId: 'drivers-no-audit', effect: 'DENY', actions: ['audit.read'], conditions: { 'actor.jobTitle': 'driver' }, reason: 'drivers do not read the audit trail' });
  assert.equal(created.status, 'created');
  assert.equal(created.rule.ruleId, 'drivers-no-audit');
  assert.ok(created.receiptId);
  const listed = await repo.list(OWNER);
  assert.equal(listed.rules.length, 1);
  assert.equal(listed.rules[0].effect, 'DENY');
  const client = await pool.connect();
  const loaded = await loadTenantAttributeRules(client, 'tenant-a');
  assert.deepEqual(loaded, [{ id: 'drivers-no-audit', effect: 'DENY', actions: ['audit.read'], conditions: { 'actor.jobTitle': 'driver' }, reason: 'drivers do not read the audit trail' }]);
});

test('duplicate rule id is a 409, a member cannot write, and an invalid rule is a 400', async () => {
  const pool = fakePool();
  const repo = createTenantAttributeRulesRepository(pool);
  await repo.create(OWNER, { ruleId: 'one', effect: 'DENY', actions: ['audit.read'], conditions: {}, reason: 'first' });
  await assert.rejects(() => repo.create(OWNER, { ruleId: 'one', effect: 'ALLOW', actions: ['audit.read'], conditions: {}, reason: 'again' }), (e) => e.status === 409);
  await assert.rejects(() => repo.create(MEMBER, { ruleId: 'two', effect: 'DENY', actions: ['audit.read'], conditions: {}, reason: 'nope' }), (e) => e.status === 403);
  await assert.rejects(() => repo.create(OWNER, { ruleId: 'bad', effect: 'DENY', actions: ['audit.read'], conditions: { 'wrong.path': 'x' }, reason: 'bad path' }), (e) => e.status === 400);
  await assert.rejects(() => repo.list(MEMBER), (e) => e.status === 403);
});

test('removal deletes the rule with a receipt, and a missing rule is a 404', async () => {
  const pool = fakePool();
  const repo = createTenantAttributeRulesRepository(pool);
  await repo.create(OWNER, { ruleId: 'temp', effect: 'DENY', actions: ['audit.read'], conditions: {}, reason: 'temporary' });
  const removed = await repo.remove(OWNER, { ruleId: 'temp', reason: 'no longer needed' });
  assert.equal(removed.status, 'removed');
  assert.equal(pool.rules.length, 0);
  await assert.rejects(() => repo.remove(OWNER, { ruleId: 'temp', reason: 'again' }), (e) => e.status === 404);
});

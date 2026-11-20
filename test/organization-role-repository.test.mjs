import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationRoleRepository } from '../src/cloud/organization-role-repository.mjs';

const ACTOR = { tenantId: 'tenant-a', subject: 'owner-1', role: 'owner', sessionId: 'session-1', requestId: 'request-1' };

function fakePool({ targetRole = 'member', existing = false } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql).replace(/\s+/gu, ' ').trim().toLowerCase();
      queries.push({ text, values });
      if (['begin', 'commit', 'rollback'].includes(text) || text.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (text.startsWith('select role') && text.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'owner' }] };
      if (text.startsWith('select subject, role, active') && text.includes('for update')) return { rowCount: 1, rows: [{ subject: 'member-1', role: targetRole, active: true }] };
      if (text.startsWith('select id, result, created_at') && text.includes('membership_role_change')) return existing ? { rowCount: 1, rows: [{ id: 91 }] } : { rowCount: 0, rows: [] };
      if (text.startsWith('update helmion.tenant_memberships')) return { rowCount: 1, rows: [] };
      if (text.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: 92 }] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, queries };
}

test('owner role change persists the membership role and an audit receipt', async () => {
  const { pool, queries } = fakePool({ targetRole: 'member' });
  const result = await createOrganizationRoleRepository(pool).applyRoleChange(ACTOR, {
    subject: 'member-1', jobTitle: 'admin', reason: 'Admin coverage', idempotencyKey: 'role-change-0001',
  });
  assert.equal(result.membershipChanged, true);
  assert.equal(result.role, 'admin');
  assert.equal(result.jobTitle, 'admin');
  assert.equal(result.receiptId, '92');
  assert.ok(queries.some(({ text, values }) => text.startsWith('update helmion.tenant_memberships') && values[2] === 'admin'));
  assert.ok(queries.some(({ text }) => text.startsWith('insert into helmion.audit_events') && text.includes('membership_role_change')));
});

test('non-admin members cannot apply a role change', async () => {
  const { pool } = fakePool();
  await assert.rejects(() => createOrganizationRoleRepository(pool).applyRoleChange({ ...ACTOR, role: 'member' }, {
    subject: 'member-1', jobTitle: 'dispatcher', reason: 'Dispatch coverage', idempotencyKey: 'role-change-0002',
  }), (error) => error.status === 403);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceProjectRepository } from '../src/cloud/workspace-project-repository.mjs';

function pool({ role = 'admin', auditId = 42 } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const query = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ query, values });
      const lower = query.toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(lower) || lower.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (lower.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role }] };
      if (lower.startsWith('insert into helmion.workspace_projects')) return { rowCount: 1, rows: [{ project_key: 'helmian-cloud', display_name: 'Helmian Cloud', source_kind: 'cloud', default_branch: 'main', lifecycle: 'active', created_by_subject: 'user-1', created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:00:00.000Z' }] };
      if (lower.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: auditId }] };
      throw new Error(`unexpected query ${query}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, queries };
}

const actor = { tenantId: 'customer-a', subject: 'user-1', role: 'admin', sessionId: 'session-1', requestId: 'request-1' };
const input = { projectKey: 'helmian-cloud', displayName: 'Helmian Cloud', sourceKind: 'cloud', defaultBranch: 'main', lifecycle: 'active' };

test('workspace registration writes actor, tenant, action, result, and no provider execution', async () => {
  const fake = pool();
  const result = await createWorkspaceProjectRepository(fake.pool).save(actor, input);
  assert.equal(result.durable, true);
  assert.equal(result.receiptId, '42');
  assert.equal(result.project.execution, 'not_performed');

  const membership = fake.queries.find(({ query }) => query.toLowerCase().includes('from helmion.tenant_memberships'));
  assert.deepEqual(membership.values, ['customer-a', 'user-1']);
  const write = fake.queries.find(({ query }) => query.toLowerCase().startsWith('insert into helmion.workspace_projects'));
  assert.equal(write.values[0], 'customer-a');
  assert.equal(write.values.at(-1), 'user-1');
  const audit = fake.queries.find(({ query }) => query.toLowerCase().startsWith('insert into helmion.audit_events'));
  assert.deepEqual(audit.values.slice(0, 6), ['customer-a', 'user-1', 'admin', 'session-1', 'request-1', 'workspace.project.register']);
  assert.deepEqual(JSON.parse(audit.values[6]), { resource: 'workspace_project_registry', projectKey: 'helmian-cloud' });
  assert.equal(audit.values[7], 'workspace-project.v1');
  assert.equal(audit.values[8], 'ALLOW');
  assert.match(audit.values[9], /execution and provider invocation were not performed/);
  assert.deepEqual(JSON.parse(audit.values[10]), { projectKey: 'helmian-cloud', lifecycle: 'active', execution: 'not_performed', providerInvocation: 'not_performed' });
  assert.equal(fake.queries.some(({ query }) => /provider|fetch\(|exec\(/iu.test(query)), false);
});

test('workspace registration rejects non-owner/admin before any write', async () => {
  const fake = pool({ role: 'member' });
  await assert.rejects(() => createWorkspaceProjectRepository(fake.pool).save({ ...actor, role: 'member' }, input), (error) => error.status === 403);
  assert.equal(fake.queries.some(({ query }) => /insert into helmion\.(workspace_projects|audit_events)/iu.test(query)), false);
});

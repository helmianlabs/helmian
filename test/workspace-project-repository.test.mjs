import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceProjectRepository } from '../src/cloud/workspace-project-repository.mjs';

test('allowed workspace project writes commit the project row and its audit receipt together', async () => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      queries.push({ text, values });
      if (['begin', 'commit', 'rollback'].includes(text) || text.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'admin' }] };
      if (text.includes('insert into helmion.workspace_projects')) return { rowCount: 1, rows: [{
        project_key: 'helmian-cloud', display_name: 'Helmian Cloud', source_kind: 'cloud', default_branch: 'main', lifecycle: 'active',
        created_by_subject: 'admin-user', created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
      }] };
      if (text.includes('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: 73 }] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  const repository = createWorkspaceProjectRepository({ connect: async () => client });
  const result = await repository.save({ tenantId: 'customer-a', subject: 'admin-user', role: 'admin', sessionId: 'session-1', requestId: 'request-1' }, {
    projectKey: 'helmian-cloud', displayName: 'Helmian Cloud', sourceKind: 'cloud', defaultBranch: 'main', lifecycle: 'active',
  });
  assert.equal(result.durable, true);
  assert.equal(result.receiptId, '73');
  assert.equal(result.project.projectKey, 'helmian-cloud');
  assert.equal(queries.filter(({ text }) => text.includes('insert into helmion.workspace_projects')).length, 1);
  assert.equal(queries.filter(({ text }) => text.includes('insert into helmion.audit_events')).length, 1);
  assert.equal(queries.at(-1).text, 'commit');
});

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

function richPool({ role = 'admin', projects = [], bindings = [], selection = null } = {}) {
  const queries = [];
  const selections = selection ? [{ ...selection }] : [];
  const client = {
    async query(sql, values = []) {
      const query = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ query, values });
      const lower = query.toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(lower) || lower.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (lower.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role }] };
      if (lower.startsWith('select lifecycle from helmion.workspace_projects')) {
        const found = projects.find((p) => p.project_key === values[1]);
        return { rowCount: found ? 1 : 0, rows: found ? [{ lifecycle: found.lifecycle }] : [] };
      }
      if (lower.startsWith('select 1 from helmion.workspace_projects')) {
        const found = projects.some((p) => p.project_key === values[1]);
        return { rowCount: found ? 1 : 0, rows: found ? [{ '?column?': 1 }] : [] };
      }
      if (lower.startsWith('insert into helmion.workspace_active_project_selections')) {
        const existing = selections.find((s) => s.subject === values[1]);
        if (existing) existing.project_key = values[2]; else selections.push({ subject: values[1], project_key: values[2] });
        return { rowCount: 1, rows: [] };
      }
      if (lower.startsWith('select project_key from helmion.workspace_active_project_selections')) {
        const found = selections.find((s) => s.subject === values[1]);
        return { rowCount: found ? 1 : 0, rows: found ? [{ project_key: found.project_key }] : [] };
      }
      if (lower.startsWith('insert into helmion.workspace_repo_bindings')) {
        bindings.push({ project_key: values[1], repo_owner: values[2], repo_name: values[3] });
        return { rowCount: 1, rows: [] };
      }
      if (lower.includes('from helmion.workspace_repo_bindings')) {
        return { rowCount: bindings.length, rows: bindings.map((b) => ({ ...b, created_by_subject: 'user-1', created_at: '2026-10-16T00:00:00.000Z' })) };
      }
      if (lower.startsWith('select project_key, display_name')) {
        return { rowCount: projects.length, rows: projects };
      }
      if (lower.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: '43' }] };
      throw new Error(`unexpected query ${query}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, queries, selections };
}

const proj = (key, kind = 'cloud', lifecycle = 'active') => ({ project_key: key, display_name: key, source_kind: kind, default_branch: 'main', lifecycle, created_by_subject: 'user-1', created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:00:00.000Z' });

test('active project set/get round-trips and rejects unknown keys', async () => {
  const fake = richPool({ projects: [proj('helmian-cloud')] });
  const repo = createWorkspaceProjectRepository(fake.pool);
  const set = await repo.setActiveProject(actor, { projectKey: 'helmian-cloud' });
  assert.equal(set.durable, true);
  assert.equal(set.projectKey, 'helmian-cloud');
  const audit = fake.queries.find(({ query }) => query.toLowerCase().startsWith('insert into helmion.audit_events'));
  assert.deepEqual(JSON.parse(audit.values[6]), { resource: 'workspace_active_project_selection', projectKey: 'helmian-cloud' });
  const got = await repo.getActiveProject(actor);
  assert.equal(got.projectKey, 'helmian-cloud');
  await assert.rejects(() => repo.setActiveProject(actor, { projectKey: 'nope-missing' }), (e) => e.status === 404);
  await assert.rejects(() => repo.setActiveProject(actor, { projectKey: '../etc' }), (e) => e.status === 400);
  await assert.rejects(() => repo.setActiveProject(actor, { projectKey: 'c:\\win' }), (e) => e.status === 400);
});

test('active project rejects archived projects', async () => {
  const fake = richPool({ projects: [proj('old-thing', 'cloud', 'archived')] });
  await assert.rejects(() => createWorkspaceProjectRepository(fake.pool).setActiveProject(actor, { projectKey: 'old-thing' }), (e) => e.status === 409);
});

test('repo binding create/list round-trips and rejects non-admins', async () => {
  const fake = richPool({ projects: [proj('helmian-cloud')] });
  const verifiedRepo = async () => ({ verified: true, note: 'repository exists' });
  const repo = createWorkspaceProjectRepository(fake.pool, { verifyRepo: verifiedRepo });
  const bound = await repo.bindRepo(actor, { projectKey: 'helmian-cloud', repoOwner: 'helmianlabs', repoName: 'helmian' });
  assert.equal(bound.durable, true);
  assert.equal(bound.repoOwner, 'helmianlabs');
  assert.equal(bound.verified, true);
  const listed = await repo.listRepoBindings(actor);
  assert.equal(listed.bindings.length, 1);
  assert.equal(listed.bindings[0].repoName, 'helmian');
  await assert.rejects(() => repo.bindRepo({ ...actor, role: 'member' }, { projectKey: 'helmian-cloud', repoOwner: 'helmianlabs', repoName: 'helmian' }), (e) => e.status === 403);
  await assert.rejects(() => repo.bindRepo(actor, { projectKey: 'helmian-cloud', repoOwner: 'not valid!', repoName: 'helmian' }), (e) => e.status === 400);
  await assert.rejects(() => repo.bindRepo(actor, { projectKey: 'missing', repoOwner: 'helmianlabs', repoName: 'helmian' }), (e) => e.status === 404);
});

test('repo binding rejects unknown repos and degrades when GitHub is unreachable', async () => {
  const fake = richPool({ projects: [proj('helmian-cloud')] });
  const notFound = async () => ({ verified: false, note: 'repository not found', notFound: true });
  await assert.rejects(
    () => createWorkspaceProjectRepository(fake.pool, { verifyRepo: notFound }).bindRepo(actor, { projectKey: 'helmian-cloud', repoOwner: 'nope', repoName: 'nope' }),
    (e) => e.status === 400 && /not found/i.test(e.message),
  );
  const degraded = async () => ({ verified: false, note: 'github unreachable; bind accepted without verification' });
  const accepted = await createWorkspaceProjectRepository(fake.pool, { verifyRepo: degraded }).bindRepo(actor, { projectKey: 'helmian-cloud', repoOwner: 'helmianlabs', repoName: 'helmian' });
  assert.equal(accepted.durable, true);
  assert.equal(accepted.verified, false);
  assert.match(accepted.verificationNote, /without verification/);
});

test('sourceInventory is bound/unbound/mirror from real state', async () => {
  const fake = richPool({
    projects: [proj('bound-proj'), proj('plain-proj'), proj('mirror-proj', 'desktop_mirror')],
    bindings: [{ project_key: 'bound-proj', repo_owner: 'helmianlabs', repo_name: 'helmian' }],
  });
  const { projects } = await createWorkspaceProjectRepository(fake.pool).list(actor);
  const byKey = Object.fromEntries(projects.map((p) => [p.projectKey, p]));
  assert.equal(byKey['bound-proj'].sourceInventory, 'bound');
  assert.deepEqual(byKey['bound-proj'].repoBinding, { repoOwner: 'helmianlabs', repoName: 'helmian' });
  assert.equal(byKey['plain-proj'].sourceInventory, 'unbound');
  assert.equal(byKey['plain-proj'].repoBinding, null);
  assert.equal(byKey['mirror-proj'].sourceInventory, 'mirror');
});

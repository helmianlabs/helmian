import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoraOrganizationConfigRepository } from '../src/cora/organization-config-repository.mjs';

function fakePool() {
  const configs = [{
    id: 'config-a-1', tenant_id: 'org-a', config_version: 1, lifecycle: 'published', is_current: true,
    config: { style: 'professional_brief' }, reason: 'initial', provenance: { source: 'reviewed' },
    created_by_subject: 'admin-a', created_by_role: 'admin', created_at: 'now',
    approved_by_subject: 'admin-a', approved_at: 'now', published_by_subject: 'admin-a', published_at: 'now',
    rollback_by_subject: null, rollback_at: null, rollback_reason: null,
  }];
  const memberships = { 'member-a': { tenant_id: 'org-a', role: 'member' }, 'admin-a': { tenant_id: 'org-a', role: 'admin' }, 'admin-b': { tenant_id: 'org-b', role: 'admin' } };
  const client = {
    async query(sql, values = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rowCount: 0, rows: [] };
      if (q.startsWith('select set_config')) return { rowCount: 1, rows: [{}] };
      if (q.startsWith('select role from helmion.tenant_memberships')) {
        const member = memberships[values[1]];
        return member && member.tenant_id === values[0] ? { rowCount: 1, rows: [{ role: member.role }] } : { rowCount: 0, rows: [] };
      }
      if (q.includes('from helmion.cora_configs where tenant_id=$1 and lifecycle=\'published\'')) {
        const rows = configs.filter((row) => row.tenant_id === values[0] && row.lifecycle === 'published' && row.is_current);
        return { rowCount: rows.length, rows };
      }
      if (q.startsWith('select coalesce(max(config_version)')) {
        const rows = configs.filter((row) => row.tenant_id === values[0]);
        return { rowCount: 1, rows: [{ next_version: (rows.at(-1)?.config_version ?? 0) + 1 }] };
      }
      if (q.startsWith('insert into helmion.cora_configs')) {
        const row = { id: `config-${configs.length + 1}`, tenant_id: values[0], config_version: values[1], lifecycle: 'draft', config: JSON.parse(values[2]), reason: values[3], provenance: JSON.parse(values[4]), is_current: false, created_by_subject: values[5], created_by_role: values[6], created_at: 'now', approved_by_subject: null, approved_at: null, published_by_subject: null, published_at: null, rollback_by_subject: null, rollback_at: null, rollback_reason: null };
        configs.push(row); return { rowCount: 1, rows: [row] };
      }
      if (q.startsWith('select id, tenant_id, config_version') && q.includes('where tenant_id=$1 and id=$2')) {
        const row = configs.find((candidate) => candidate.tenant_id === values[0] && candidate.id === values[1]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('select id from helmion.cora_configs')) return { rowCount: 0, rows: [] };
      if (q.startsWith('update helmion.cora_configs set lifecycle=\'approved\'')) {
        const row = configs.find((candidate) => candidate.tenant_id === values[0] && candidate.id === values[1]); row.lifecycle = 'approved'; row.approved_by_subject = values[2]; return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('update helmion.cora_configs set lifecycle=\'published\'')) {
        const row = configs.find((candidate) => candidate.tenant_id === values[0] && candidate.id === values[1]); row.lifecycle = 'published'; row.is_current = true; row.published_by_subject = values[2]; return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('update helmion.cora_configs set lifecycle=\'rolled_back\'')) {
        const row = configs.find((candidate) => candidate.tenant_id === values[0] && candidate.id === values[1]); row.lifecycle = 'rolled_back'; row.is_current = false; row.rollback_by_subject = values[2]; return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('update helmion.cora_configs set lifecycle=$3')) {
        const row = configs.find((candidate) => candidate.tenant_id === values[0] && candidate.id === values[1]); row.lifecycle = values[2]; return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

const member = { tenantId: 'org-a', subject: 'member-a', role: 'member', sessionId: 's1', requestId: 'r1' };
const admin = { tenantId: 'org-a', subject: 'admin-a', role: 'admin', sessionId: 's2', requestId: 'r2' };

test('normal Organization member reads only the current published config', async () => {
  const repo = createCoraOrganizationConfigRepository(fakePool());
  const result = await repo.readPublishedConfig(member);
  assert.equal(result.status, 'published');
  assert.equal(result.config.organizationId, 'org-a');
  assert.equal(result.config.isCurrent, true);
});

test('only an admin can create drafts and client Organization/Plant selectors are rejected', async () => {
  const repo = createCoraOrganizationConfigRepository(fakePool());
  await assert.rejects(() => repo.createDraft(member, { config: {}, reason: 'nope', provenance: {} }), /admin membership/);
  await assert.rejects(() => repo.createDraft(admin, { organizationId: 'org-b', config: {}, reason: 'nope', provenance: {} }), /select Organization/);
  await assert.rejects(() => repo.createDraft(admin, { config: { plantId: 'warehouse-1' }, reason: 'nope', provenance: {} }), /select Organization/);
  const draft = await repo.createDraft(admin, { config: { style: 'professional_brief' }, reason: 'reviewed draft', provenance: { source: 'admin review' } });
  assert.equal(draft.config.lifecycle, 'draft');
  assert.equal(draft.config.organizationId, 'org-a');
});

test('lifecycle refuses unapproved publish and allows draft to testing to approved to published', async () => {
  const repo = createCoraOrganizationConfigRepository(fakePool());
  const draft = await repo.createDraft(admin, { config: { style: 'professional_brief' }, reason: 'test draft', provenance: {} });
  await assert.rejects(() => repo.transition(admin, { id: draft.config.id, lifecycle: 'published', reason: 'skip review' }), /transition draft to published is invalid/);
  assert.equal((await repo.transition(admin, { id: draft.config.id, lifecycle: 'testing', reason: 'test' })).lifecycle, 'testing');
  assert.equal((await repo.transition(admin, { id: draft.config.id, lifecycle: 'approved', reason: 'approved' })).lifecycle, 'approved');
  assert.equal((await repo.transition(admin, { id: draft.config.id, lifecycle: 'published', reason: 'publish' })).lifecycle, 'published');
  await assert.rejects(() => repo.transition(admin, { id: draft.config.id, lifecycle: 'draft', reason: 'backward' }), /transition published to draft is invalid/);
});

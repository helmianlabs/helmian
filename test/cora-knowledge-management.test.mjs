import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoraOrganizationConfigRepository } from '../src/cora/organization-config-repository.mjs';

const admin = { tenantId: 'org-a', subject: 'admin-a', role: 'admin', sessionId: 's1', requestId: 'r1' };

function pool() {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); queries.push(q);
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.startsWith('select role from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'admin' }] };
      if (q.startsWith('select id, lifecycle from helmion.cora_knowledge_sources')) return { rowCount: 1, rows: [{ id: values[1], lifecycle: 'draft' }] };
      if (q.startsWith('select id, lifecycle, allowlisted from helmion.cora_knowledge_packs')) return { rowCount: 1, rows: [{ id: values[1], lifecycle: 'draft', allowlisted: false }] };
      if (q.startsWith('select id, lifecycle, source_id from helmion.cora_knowledge_sources')) return { rowCount: 1, rows: [{ id: values[1], lifecycle: 'draft', source_id: null }] };
      if (q.startsWith('select id, source_id, pack_key')) return { rowCount: 0, rows: [] };
      if (q.startsWith('select id, source_key')) return { rowCount: 0, rows: [] };
      if (q.startsWith('select k.id')) return { rowCount: 0, rows: [] };
      if (q.startsWith('insert into helmion.cora_knowledge_sources')) return { rowCount: 1, rows: [{ id: 'source-1', source_key: values[1], title: values[2], publisher: values[3], canonical_uri: values[4], provenance: values[5], lifecycle: 'draft', effective_at: null, expires_at: null, reviewed_by_subject: null, reviewed_at: null }] };
      if (q.startsWith('insert into helmion.cora_knowledge_packs')) return { rowCount: 1, rows: [{ id: 'pack-1', source_id: values[1], pack_key: values[2], version: values[3], lifecycle: 'draft', allowlisted: false, provenance: values[4], effective_at: null, expires_at: null, reviewed_by_subject: null, reviewed_at: null }] };
      if (q.startsWith('insert into helmion.cora_knowledge_snippets')) return { rowCount: 1, rows: [{ id: 'snippet-1', pack_id: values[1], citation: values[2], text_reference: values[3], excerpt: values[5], content_sha256: null, expires_at: null }] };
      if (q.startsWith('select lifecycle from helmion.cora_knowledge_sources')) return { rowCount: 1, rows: [{ lifecycle: 'approved' }] };
      if (q.startsWith('update helmion.cora_knowledge_sources')) return { rowCount: 1, rows: [{ id: 'source-1', source_key: 'manual', title: 'Manual', publisher: 'Ops', canonical_uri: 'manual://ops', provenance: 'reviewed', lifecycle: values[2], effective_at: null, expires_at: null, reviewed_by_subject: 'admin-a', reviewed_at: 'now' }] };
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, queries };
}

test('knowledge management persists bounded source, pack, excerpt and review receipts through Organization RLS context', async () => {
  const fixture = pool(); const repo = createCoraOrganizationConfigRepository(fixture.pool);
  const source = await repo.createKnowledgeSource(admin, { sourceKey: 'manual', title: 'Manual', publisher: 'Ops', canonicalUri: 'manual://ops', provenance: 'reviewed' });
  assert.equal(source.source.lifecycle, 'draft');
  const pack = await repo.createKnowledgePack(admin, { sourceId: 'source-1', packKey: 'ops', version: '1', provenance: 'reviewed' });
  assert.equal(pack.pack.packId, 'pack-1');
  const snippet = await repo.createKnowledgeSnippet(admin, { packId: 'pack-1', citation: 'Manual §1', textReference: 'manual://ops#1', excerpt: 'Stored approved excerpt.' });
  assert.equal(snippet.snippet.citation, 'Manual §1');
  const transitioned = await repo.transitionKnowledge(admin, { kind: 'source', id: 'source-1', lifecycle: 'approved', reason: 'Reviewed' });
  assert.equal(transitioned.lifecycle, 'approved'); assert.ok(fixture.queries.some((query) => query.includes('set_config')));
  await assert.rejects(() => repo.createKnowledgeSnippet(admin, { packId: 'pack-1', citation: 'x', textReference: 'x', excerpt: 'api_key=do-not-store' }), /credential material/);
  await assert.rejects(() => repo.createKnowledgeSource(admin, { sourceKey: 'x', title: 'x', publisher: 'x', canonicalUri: 'x', provenance: 'x', plantId: 'warehouse-1' }), /Plant/);
});

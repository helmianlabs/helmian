import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoraOrganizationConfigRepository } from '../src/cora/organization-config-repository.mjs';

const member = { tenantId: 'org-a', subject: 'member-a', role: 'member', sessionId: 's1', requestId: 'r1' };

function fakePool() {
  const rows = [{ source_key: 'fmcsa', title: 'FMCSA handbook', publisher: 'FMCSA', canonical_uri: 'https://example.test/fmcsa', provenance: 'admin-reviewed import', pack_key: 'hours', version: '2026-01', pack_provenance: 'reviewed manifest', citation: 'FMCSA §3', text_reference: 'manual://fmcsa/hours', excerpt: 'Stored hours-of-service excerpt.', content_sha256: 'abc' }];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q)) return { rowCount: 0, rows: [] };
    if (q.startsWith('select set_config')) return { rowCount: 1, rows: [{}] };
    if (q.startsWith('select role from helmion.tenant_memberships')) return values[0] === 'org-a' && values[1] === 'member-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.includes('from helmion.cora_knowledge_sources s') && q.includes('k.excerpt is not null')) return { rowCount: rows.length, rows };
    throw new Error(`Unexpected query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('knowledge retrieval returns only stored approved excerpts and citations, never an answer', async () => {
  const result = await createCoraOrganizationConfigRepository(fakePool()).queryApprovedKnowledge(member, 'hours service');
  assert.equal(result.status, 'approved_sources_only'); assert.equal(result.excerpts.length, 1); assert.equal(result.excerpts[0].excerpt, 'Stored hours-of-service excerpt.'); assert.equal(result.excerpts[0].citation, 'FMCSA §3'); assert.equal(result.answer, null); assert.equal(result.legalConclusion, 'not_provided'); assert.equal(result.providerCall, 'not_performed');
});

test('knowledge retrieval derives Organization from membership and rejects empty/cross-Organization access', async () => {
  const repo = createCoraOrganizationConfigRepository(fakePool());
  await assert.rejects(() => repo.queryApprovedKnowledge(member, ''), /knowledge query/);
  await assert.rejects(() => repo.queryApprovedKnowledge({ ...member, tenantId: 'org-b' }, 'hours'), /active member|membership/);
});

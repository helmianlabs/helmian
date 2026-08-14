import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeArtifactSource, normalizeArtifactSourceLink, sourceLifecycleTransitionAllowed } from '../src/cora/artifact-source.mjs';
import { createArtifactSourceRepository } from '../src/cora/artifact-source-repository.mjs';

const source = { sourceKey: 'dock-sop', title: 'Dock SOP', publisher: 'Helmian Operations', classification: 'sop', provenance: 'Reviewed internal SOP metadata', reference: 'manual://dock-sop/v2', effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', idempotencyKey: 'source-0001' };

test('Artifact source registry bounds metadata and rejects authority/secrets', () => {
  assert.equal(normalizeArtifactSource(source).classification, 'sop');
  assert.throws(() => normalizeArtifactSource({ ...source, plantId: 'west' }), /Plant/);
  assert.throws(() => normalizeArtifactSource({ ...source, apiKey: 'secret' }), /unsupported/);
  assert.throws(() => normalizeArtifactSource({ ...source, expiresAt: '2025-01-01T00:00:00Z' }), /expiry/);
  assert.throws(() => normalizeArtifactSourceLink({ artifactReceiptId: 'r1', sourceId: '1', linkReason: 'x', idempotencyKey: 'link-0001', organizationId: 'other' }), /Organization/);
  assert.equal(sourceLifecycleTransitionAllowed('draft', 'review_requested'), true);
  assert.equal(sourceLifecycleTransitionAllowed('review_requested', 'approved'), true);
  assert.equal(sourceLifecycleTransitionAllowed('draft', 'approved'), false);
});

function fakePool() {
  const sources = []; const links = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: values[1] === 'admin-a' ? 'admin' : 'member' }] };
    if (q.startsWith('insert into helmion.cora_artifact_sources')) { if (sources.some((row) => row.idempotency_key === values[10])) return { rowCount: 0, rows: [] }; const row = { id: String(sources.length + 1), source_key: values[1], title: values[2], publisher: values[3], classification: values[4], provenance: values[5], reference: values[6], effective_at: values[7], expires_at: values[8], lifecycle: 'draft', created_by_subject: values[9], reviewed_by_subject: null, reviewed_at: null, created_at: 'now', idempotency_key: values[10] }; sources.push(row); return { rowCount: 1, rows: [row] }; }
    if (q.includes('from helmion.cora_artifact_sources') && q.includes('idempotency_key=$2')) { const found = sources.filter((row) => row.idempotency_key === values[1]); return { rowCount: found.length, rows: found }; }
    if (q.includes('from helmion.cora_artifact_sources') && q.includes('where tenant_id=$1 and id=$2')) return { rowCount: 1, rows: [sources[Number(values[1]) - 1]] };
    if (q.includes('from helmion.cora_artifact_sources')) return { rowCount: sources.length, rows: sources };
    if (q.startsWith('select stage from helmion.cora_artifact_studio_intents')) return { rowCount: 1, rows: [{ stage: 'draft' }] };
    if (q.startsWith('select') && q.includes('from helmion.cora_artifact_source_links') && q.includes('idempotency_key=$2')) return { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_artifact_source_links')) { const row = { id: '1', artifact_receipt_id: values[1], source_id: values[2], source_key: values[3], source_title: values[4], source_lifecycle: values[5], source_classification: values[6], source_provenance: values[7], source_effective_at: values[8], source_expires_at: values[9], link_reason: values[10], link_receipt_id: values[11], idempotency_key: values[12], created_by_subject: values[13], created_at: 'now' }; links.push(row); return { rowCount: 1, rows: [row] }; }
    throw new Error(`Unexpected source query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('Artifact source repository persists and replays Organization metadata and immutable links', async () => {
  const repo = createArtifactSourceRepository(fakePool()); const actor = { subject: 'user-a', tenantId: 'org-a', role: 'member', sessionId: 's1', requestId: 'r1' };
  const first = await repo.append(actor, source); const replay = await repo.append(actor, source);
  assert.equal(first.durable, true); assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  const linked = await repo.link(actor, { artifactReceiptId: 'artifact-1', sourceId: first.source.sourceId, linkReason: 'orientation', idempotencyKey: 'link-0001' });
  assert.equal(linked.link.sourceKey, 'dock-sop'); assert.equal(linked.link.sourceLifecycle, 'draft');
});

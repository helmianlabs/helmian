import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArtifactStudioReceipt, normalizeArtifactStudioIntent } from '../src/cora/artifact-studio-intent.mjs';
import { createArtifactStudioRepository } from '../src/cora/artifact-studio-repository.mjs';

const member = { subject: 'user-a', tenantId: 'org-a', role: 'member', sessionId: 'session-a', requestId: 'request-a' };
const admin = { ...member, subject: 'admin-a', role: 'admin' };
const intent = { artifactType: 'training', title: 'Dock orientation', department: 'operations', objective: 'Explain the approved dock check-in steps.', sourceRefs: [{ citation: 'SOP §2', title: 'Dock SOP' }], stage: 'draft', idempotencyKey: 'artifact-0001' };

function fakePool() {
  const rows = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: values[1] === 'admin-a' ? 'admin' : 'member' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_artifact_studio_intents')) {
      if (rows.some((row) => row.tenant_id === values[0] && row.idempotency_key === values[10])) return { rowCount: 0, rows: [] };
      const row = { id: rows.length + 1, tenant_id: values[0], actor_subject: values[1], artifact_type: values[2], title: values[3], department: values[4], objective: values[5], source_refs: JSON.parse(values[6]), stage: values[7], approval_reason: values[8], receipt_id: values[9], idempotency_key: values[10], created_at: 'now' }; rows.push(row); return { rowCount: 1, rows: [row] };
    }
    if (q.includes('from helmion.cora_artifact_studio_intents') && q.includes('idempotency_key=$2')) { const found = rows.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]); return { rowCount: found.length, rows: found }; }
    if (q.includes('from helmion.cora_artifact_studio_intents')) return { rowCount: rows.length, rows };
    throw new Error(`Unexpected artifact query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('Artifact Studio receipt is source-only and rejects authority or secret-like fields', () => {
  const receipt = buildArtifactStudioReceipt({ intent, receiptId: 'receipt-0001' });
  assert.deepEqual(receipt.workflow.slice(0, 3), ['draft', 'source_checked', 'approval_requested']);
  assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.media, 'not_generated'); assert.equal(receipt.providerInvocation, 'not_performed');
  assert.throws(() => normalizeArtifactStudioIntent({ ...intent, plantId: 'warehouse-1' }), /Plant/);
  assert.throws(() => normalizeArtifactStudioIntent({ ...intent, prompt: 'secret' }), /unsupported/);
  assert.throws(() => normalizeArtifactStudioIntent({ ...intent, sourceRefs: [{ citation: 'x', title: 'x', apiKey: 'secret' }] }), /unsupported/);
});

test('Artifact Studio repository is Organization-derived, append-only in shape, and replay-safe', async () => {
  const repo = createArtifactStudioRepository(fakePool());
  const first = await repo.append(member, intent); const replay = await repo.append(member, intent);
  assert.equal(first.durable, true); assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  await assert.rejects(() => repo.append(member, { ...intent, stage: 'approval_requested', approvalReason: 'publish this' }), /authorized admin/);
  const approval = await repo.append(admin, { ...intent, stage: 'approval_requested', approvalReason: 'Request reviewed approval', idempotencyKey: 'artifact-0002' });
  assert.equal(approval.status, 'approval_requested'); assert.equal(approval.approval, 'requested_not_approved');
  assert.equal((await repo.list(member)).receipts.length, 2);
  await assert.rejects(() => repo.append({ ...member, tenantId: 'org-b' }, intent), /Unexpected|member|Organization/u);
});

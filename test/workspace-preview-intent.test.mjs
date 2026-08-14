import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspacePreviewReceipt, normalizeWorkspacePreviewIntent } from '../src/cora/workspace-preview-intent.mjs';
import { createWorkspacePreviewRepository } from '../src/cora/workspace-preview-repository.mjs';

const actor = { subject: 'user-a', tenantId: 'org-a', role: 'member', sessionId: 'session-a', requestId: 'request-a' };
const intent = { mode: 'workspace', intent: 'prepare', department: 'operations', templateId: 'operations-desk', title: 'Prepare operations desk preview', idempotencyKey: 'preview-0001' };

function fakePool() {
  const rows = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_workspace_preview_intents')) {
      if (rows.some((row) => row.idempotency_key === values[8] && row.tenant_id === values[0])) return { rowCount: 0, rows: [] };
      const row = { id: rows.length + 1, tenant_id: values[0], mode: values[2], intent: values[3], department: values[4], template_id: values[5], title: values[6], receipt_id: values[7], idempotency_key: values[8], status: 'preview_ready', created_at: 'now' }; rows.push(row); return { rowCount: 1, rows: [row] };
    }
    if (q.includes('from helmion.cora_workspace_preview_intents') && q.includes('idempotency_key=$2')) return { rowCount: rows.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]).length, rows: rows.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]) };
    if (q.includes('from helmion.cora_workspace_preview_intents')) return { rowCount: rows.length, rows };
    throw new Error(`Unexpected preview query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('workspace preview intent is bounded and reports no execution or provider invocation', () => {
  const receipt = buildWorkspacePreviewReceipt({ intent, receiptId: 'receipt-0001' });
  assert.equal(receipt.status, 'preview-ready');
  assert.equal(receipt.execution, 'not_performed');
  assert.equal(receipt.providerInvocation, 'not_performed');
  assert.equal(receipt.agentInvocation, 'not_performed');
  assert.equal(receipt.filesystemMutation, 'not_performed');
  assert.throws(() => normalizeWorkspacePreviewIntent({ ...intent, plantId: 'warehouse-1' }), /Plant/);
  assert.throws(() => normalizeWorkspacePreviewIntent({ ...intent, content: 'raw content' }), /preview/);
});

test('workspace preview repository is Organization-derived and replay-safe', async () => {
  const repo = createWorkspacePreviewRepository(fakePool());
  const first = await repo.append(actor, intent);
  const replay = await repo.append(actor, intent);
  assert.equal(first.durable, true);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await repo.list(actor)).receipts.length, 1);
  await assert.rejects(() => repo.append({ ...actor, tenantId: 'org-b' }, intent), /Unexpected|membership|tenant/u);
});

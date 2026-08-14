import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentTaskClaimReceipt, requireAuthorizedWorker } from '../src/cora/agent-task-worker-claim.mjs';
import { createAgentTaskRepository } from '../src/cora/agent-task-repository.mjs';

const worker = { kind: 'internal_worker', verified: true, membershipVerified: true, role: 'worker', membershipRole: 'member', subject: 'worker-service', workerId: 'worker:cloud', tenantId: 'org-a', sessionId: 'worker-session', requestId: 'worker-request' };

function fakePool() {
  const tasks = [{ id: 1, receipt_id: 'task-receipt-1', status: 'prepared' }, { id: 2, receipt_id: 'task-receipt-2', status: 'draft' }]; const claims = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.includes('from helmion.cora_agent_task_claims') && q.includes('idempotency_key=$2')) { const found = claims.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]); return { rowCount: found.length, rows: found }; }
    if (q.includes('from helmion.cora_agent_task_intents')) { const found = tasks.filter((row) => row.id === values[1]); return { rowCount: found.length, rows: found }; }
    if (q.startsWith('insert into helmion.cora_agent_task_claims')) {
      if (claims.some((row) => row.tenant_id === values[0] && row.task_id === values[1])) return { rowCount: 0, rows: [] };
      const row = { tenant_id: values[0], task_id: values[1], task_receipt_id: values[2], worker_subject: values[3], worker_id: values[4], claim_id: values[5], idempotency_key: values[6] }; claims.push(row); return { rowCount: 1, rows: [row] };
    }
    if (q.includes('from helmion.cora_agent_task_claims') && q.includes('task_id=$2')) { const found = claims.filter((row) => row.tenant_id === values[0] && row.task_id === values[1]); return { rowCount: found.length, rows: found }; }
    throw new Error(`Unexpected claim query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

function listPool({ claimsTable = true } = {}) {
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'member' }] };
    if (q.includes('from helmion.cora_agent_task_intents')) return { rowCount: 1, rows: [{ id: 7, task_type: 'workspace_preview', goal: 'Prepare SOP', context_ref: null, department: null, cost_center: null, intent: 'prepare', status: 'prepared', receipt_id: 'task-receipt-7', idempotency_key: 'task-0007', created_at: '2026-08-14T00:00:00.000Z' }] };
    if (q.includes('from helmion.cora_agent_task_claims')) {
      if (!claimsTable) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rowCount: 1, rows: [{ claim_status: 'claimed' }] };
    }
    throw new Error(`Unexpected list query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('worker claim contract requires a verified internal worker and never executes', () => {
  assert.deepEqual(requireAuthorizedWorker(worker).workerId, 'worker:cloud');
  assert.throws(() => requireAuthorizedWorker({ ...worker, kind: 'user' }), /internal worker/);
  assert.throws(() => requireAuthorizedWorker({ ...worker, verified: false }), /internal worker/);
  assert.throws(() => requireAuthorizedWorker({ ...worker, plantId: 'warehouse-1' }), /internal worker/);
  const receipt = buildAgentTaskClaimReceipt({ taskId: 1, taskReceiptId: 'task-receipt-1', taskType: 'workspace_preview', claimId: 'claim-0001', workerId: 'worker:cloud' });
  assert.equal(receipt.claimStatus, 'claimed'); assert.equal(receipt.taskStatus, 'prepared'); assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.providerInvocation, 'not_performed');
  assert.equal(receipt.taskType, 'workspace_preview');
});

test('only an authorized worker can claim prepared tasks, with tenant isolation and replay safety', async () => {
  const repo = createAgentTaskRepository(fakePool());
  const first = await repo.claimPrepared(worker, { taskId: 1, idempotencyKey: 'claim-0001' });
  const replay = await repo.claimPrepared(worker, { taskId: 1, idempotencyKey: 'claim-0001' });
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.execution, 'not_performed');
  await assert.rejects(() => repo.claimPrepared({ ...worker, tenantId: 'org-b' }, { taskId: 1, idempotencyKey: 'claim-0002' }), /membership|tenant/u);
  await assert.rejects(() => repo.claimPrepared({ ...worker, role: 'member' }, { taskId: 1, idempotencyKey: 'claim-0003' }), /internal worker/u);
  await assert.rejects(() => repo.claimPrepared(worker, { taskId: 2, idempotencyKey: 'claim-0004' }), /prepared/u);
});

test('member task read projects claimed state and isolates the Organization source', async () => {
  const actor = { tenantId: 'org-a', subject: 'user-a', role: 'member', membershipRole: 'member', sessionId: 'session-a', requestId: 'request-a' };
  const result = await createAgentTaskRepository(listPool()).list(actor);
  assert.equal(result.claimStatusSource, 'cora_agent_task_claims');
  assert.equal(result.receipts[0].claimStatus, 'claimed');
  assert.equal(result.receipts[0].execution, 'not_performed');
});

test('member task read is truthful when the additive claims schema is unavailable', async () => {
  const actor = { tenantId: 'org-a', subject: 'user-a', role: 'member', membershipRole: 'member', sessionId: 'session-a', requestId: 'request-a' };
  const result = await createAgentTaskRepository(listPool({ claimsTable: false })).list(actor);
  assert.equal(result.claimStatusSource, 'unavailable');
  assert.equal(result.receipts[0].claimStatus, 'unavailable');
  assert.equal(result.receipts[0].execution, 'not_performed');
});

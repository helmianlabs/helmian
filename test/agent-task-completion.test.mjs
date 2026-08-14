import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentTaskCompletionReceipt, buildNotExecutedTaskCompletion, normalizeAgentTaskCompletion } from '../src/cora/agent-task-completion-receipt.mjs';
import { createAgentTaskRepository } from '../src/cora/agent-task-repository.mjs';

const worker = { kind: 'internal_worker', verified: true, membershipVerified: true, role: 'worker', membershipRole: 'member', subject: 'worker-service', workerId: 'worker:cloud', tenantId: 'org-a', sessionId: 'worker-session', requestId: 'worker-request' };

function pool() {
  const rows = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.includes('from helmion.cora_agent_task_completion_receipts')) {
      const found = rows.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]);
      return { rowCount: found.length, rows: found };
    }
    if (q.includes('from helmion.cora_agent_task_claims')) return values[0] === 'org-a' && values[1] === 7 ? { rowCount: 1, rows: [{ task_id: 7, claim_id: 'claim-0007', worker_id: 'worker:cloud' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_agent_task_completion_receipts')) {
      if (rows.some((row) => row.tenant_id === values[0] && row.task_id === values[1])) return { rowCount: 0, rows: [] };
      const row = { tenant_id: values[0], task_id: values[1], claim_id: values[2], worker_id: values[4], completion_status: values[5], execution: values[6], evidence_ref: values[7], failure_code: values[8], idempotency_key: values[9] }; rows.push(row); return { rowCount: 1, rows: [row] };
    }
    throw new Error(`Unexpected completion query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('completion contract defaults missing worker evidence to not executed', () => {
  assert.equal(buildNotExecutedTaskCompletion({ taskId: 7 }).completionStatus, 'not_executed');
  assert.equal(buildNotExecutedTaskCompletion({ taskId: 7 }).execution, 'not_performed');
  assert.throws(() => normalizeAgentTaskCompletion({ status: 'finished', execution: 'not_performed', evidenceRef: 'evidence-1', idempotencyKey: 'complete-0001' }), /performed execution evidence/);
  assert.throws(() => normalizeAgentTaskCompletion({ status: 'finished', execution: 'performed', evidenceRef: 'evidence-1', idempotencyKey: 'complete-0001', plantId: 'plant-1' }), /Plant/);
  assert.equal(buildAgentTaskCompletionReceipt({ taskId: 7, claimId: 'claim-0007', workerId: 'worker:cloud', status: 'failed', evidenceRef: 'evidence-1', failureCode: 'browser_unavailable', idempotencyKey: 'complete-0001' }).execution, 'performed');
});

test('only the verified worker claim can append an Organization completion receipt, with replay safety', async () => {
  const repo = createAgentTaskRepository(pool());
  const first = await repo.recordCompletion(worker, { taskId: 7, claimId: 'claim-0007', status: 'failed', execution: 'performed', evidenceRef: 'evidence-1', failureCode: 'browser_unavailable', idempotencyKey: 'complete-0001' });
  const replay = await repo.recordCompletion(worker, { taskId: 7, claimId: 'claim-0007', status: 'failed', execution: 'performed', evidenceRef: 'evidence-1', failureCode: 'browser_unavailable', idempotencyKey: 'complete-0001' });
  assert.equal(first.completionStatus, 'failed'); assert.equal(first.execution, 'performed'); assert.equal(replay.replayed, true);
  await assert.rejects(() => repo.recordCompletion({ ...worker, tenantId: 'org-b' }, { taskId: 7, claimId: 'claim-0007', status: 'finished', execution: 'performed', evidenceRef: 'evidence-2', idempotencyKey: 'complete-0002' }), /membership|tenant/u);
  await assert.rejects(() => repo.recordCompletion({ ...worker, role: 'member' }, { taskId: 7, claimId: 'claim-0007', status: 'finished', execution: 'performed', evidenceRef: 'evidence-2', idempotencyKey: 'complete-0002' }), /internal worker/u);
});

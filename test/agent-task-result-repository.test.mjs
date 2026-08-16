import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTaskResultRepository } from '../src/cora/agent-task-result-repository.mjs';

const worker = { kind: 'internal_worker', verified: true, membershipVerified: true, role: 'worker', membershipRole: 'member', subject: 'worker-a', workerId: 'worker:approved-knowledge', tenantId: 'org-a', sessionId: 'worker-session', requestId: 'worker-request' };
function fakePool() {
  const rows = []; const transitions = []; const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_agent_task_execution_results')) { if (rows.some((row) => row.idempotency_key === values[9])) return { rowCount: 0, rows: [] }; const row = { task_id: values[1], claim_id: values[2], task_receipt_id: values[3], result_receipt_id: values[4], status: values[5], excerpts: JSON.parse(values[6]), routing: JSON.parse(values[7]), usage: JSON.parse(values[8]), execution: 'provider_free_read_only', agent_invocation: 'performed', provider_invocation: 'not_performed', filesystem_mutation: 'not_performed', created_at: 'now', idempotency_key: values[9] }; rows.push(row); return { rowCount: 1, rows: [row] }; }
    if (q.startsWith('insert into helmion.cora_agent_task_transitions')) { transitions.push(values); return { rowCount: 1, rows: [] }; }
    if (q.includes('from helmion.cora_agent_task_execution_results')) { const found = rows.filter((row) => row.idempotency_key === values[1]); return { rowCount: found.length, rows: found }; }
    throw new Error(`Unexpected result query: ${q}`);
  }, release() {} }; return { connect: async () => client, transitions };
}

test('provider-free task result is append-only, tenant-scoped, and idempotent', async () => {
  const pool = fakePool(); const repo = createAgentTaskResultRepository(pool);
  const receipt = { taskId: 7, claimId: 'claim-0007', taskReceiptId: 'task-receipt-7', status: 'source_ready', excerpts: [{ excerpt: 'stored', citation: 'source' }], routing: { status: 'allowed' }, usage: {}, providerInvocation: 'not_performed', filesystemMutation: 'not_performed', idempotencyKey: 'result-run-0007' };
  const first = await repo.append(worker, receipt); const replay = await repo.append(worker, receipt);
  assert.equal(first.durable, true); assert.equal(first.execution, 'provider_free_read_only'); assert.equal(replay.replayed, true); assert.equal(pool.transitions.length, 1); assert.equal(pool.transitions[0][3], 'provider_free_source_ready');
  await assert.rejects(() => repo.append(worker, { ...receipt, providerInvocation: 'performed', idempotencyKey: 'result-run-0008' }), /provider-free/u);
  await assert.rejects(() => repo.append({ ...worker, tenantId: 'org-b' }, { ...receipt, idempotencyKey: 'result-run-0009' }), /active member/u);
});

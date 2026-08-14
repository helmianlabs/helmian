import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentTaskReceipt, normalizeAgentTaskIntent } from '../src/cora/agent-task-intent.mjs';
import { createAgentTaskRepository } from '../src/cora/agent-task-repository.mjs';

const actor = { subject: 'user-a', tenantId: 'org-a', role: 'member', sessionId: 'session-a', requestId: 'request-a' };
const task = { taskType: 'workspace_preview', intent: 'prepare', goal: 'Prepare a bounded workspace preview', contextRef: 'workspace:ops', department: 'operations', costCenter: 'ops-1', idempotencyKey: 'task-0001' };

function fakePool() {
  const rows = []; const transitions = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return values[0] === 'org-a' ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_agent_task_intents')) {
      if (rows.some((row) => row.idempotency_key === values[10] && row.tenant_id === values[0])) return { rowCount: 0, rows: [] };
      const row = { id: rows.length + 1, tenant_id: values[0], task_type: values[2], goal: values[3], context_ref: values[4], department: values[5], cost_center: values[6], intent: values[7], status: values[7] === 'prepare' ? 'prepared' : 'draft', receipt_id: values[9], idempotency_key: values[10], created_at: 'now' }; rows.push(row); return { rowCount: 1, rows: [row] };
    }
    if (q.startsWith('insert into helmion.cora_agent_task_transitions')) { transitions.push(values); return { rowCount: 1, rows: [] }; }
    if (q.includes('from helmion.cora_agent_task_intents') && q.includes('idempotency_key=$2')) { const found = rows.filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1]); return { rowCount: found.length, rows: found }; }
    if (q.includes('from helmion.cora_agent_task_intents')) return { rowCount: rows.length, rows };
    throw new Error(`Unexpected task query: ${q}`);
  }, release() {} };
  return { connect: async () => client, transitions };
}

test('agent task intent is bounded, allowlisted, and never executed', () => {
  const receipt = buildAgentTaskReceipt({ task, receiptId: 'receipt-0001', status: 'prepared' });
  assert.equal(receipt.status, 'prepared'); assert.equal(receipt.execution, 'not_performed'); assert.equal(receipt.agentInvocation, 'not_performed'); assert.equal(receipt.providerInvocation, 'not_performed'); assert.equal(receipt.filesystemMutation, 'not_performed');
  assert.throws(() => normalizeAgentTaskIntent({ ...task, taskType: 'send_email' }), /unsupported/);
  assert.throws(() => normalizeAgentTaskIntent({ ...task, plantId: 'warehouse-1' }), /Plant/);
  assert.throws(() => normalizeAgentTaskIntent({ ...task, organizationId: 'org-b' }), /Organization/);
});

test('agent task repository is Organization-derived, append-only, and replay-safe', async () => {
  const pool = fakePool(); const repo = createAgentTaskRepository(pool);
  const first = await repo.append(actor, task); const replay = await repo.append(actor, task);
  assert.equal(first.durable, true); assert.equal(first.status, 'prepared'); assert.equal(replay.replayed, true); assert.equal((await repo.list(actor)).receipts.length, 1); assert.equal(pool.transitions.length, 1);
  await assert.rejects(() => repo.append({ ...actor, tenantId: 'org-b' }, task), /Unexpected|membership|tenant/u);
});

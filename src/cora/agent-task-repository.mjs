import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildAgentTaskReceipt, normalizeAgentTaskIntent } from './agent-task-intent.mjs';
import { buildAgentTaskClaimReceipt, requireAuthorizedWorker } from './agent-task-worker-claim.mjs';

function context(actor) { if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required'); return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.membershipRole ?? actor.role, sessionId: actor.sessionId, requestId: actor.requestId }; }
const SELECT = 'id, task_type, goal, context_ref, department, cost_center, intent, status, receipt_id, idempotency_key, created_at';
function rowToReceipt(row, replayed = false) { return buildAgentTaskReceipt({ task: { taskType: row.task_type, goal: row.goal, contextRef: row.context_ref, department: row.department, costCenter: row.cost_center, intent: row.intent, idempotencyKey: row.idempotency_key }, status: row.status, receiptId: row.receipt_id, replayed }); }

export function createAgentTaskRepository(pool) {
  return Object.freeze({
    async append(actor, input) {
      const active = context(actor); const task = normalizeAgentTaskIntent(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const receiptId = randomUUID();
        const result = await client.query(`insert into helmion.cora_agent_task_intents (tenant_id, actor_subject, task_type, goal, context_ref, department, cost_center, intent, status, receipt_id, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (tenant_id, idempotency_key) do nothing returning ${SELECT}`, [active.tenantId, active.subject, task.taskType, task.goal, task.contextRef, task.department, task.costCenter, task.intent, task.intent === 'prepare' ? 'prepared' : 'draft', receiptId, task.idempotencyKey]);
        if (result.rowCount === 1) { const row = result.rows[0]; await client.query('insert into helmion.cora_agent_task_transitions (tenant_id, task_id, actor_subject, from_status, to_status, reason) values ($1,$2,$3,$4,$5,$6)', [active.tenantId, row.id, active.subject, null, row.status, `intent_${task.intent}`]); return { durable: true, ...rowToReceipt(row) }; }
        const replay = await client.query(`select ${SELECT} from helmion.cora_agent_task_intents where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, task.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('agent task receipt was not durable');
        return { durable: true, ...rowToReceipt(replay.rows[0], true) };
      });
    },
    async list(actor, limit = 50) {
      const active = context(actor); const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
      return withTenantTransaction(pool, active, async (client) => { await requireActiveTenantMembership(client, active); const result = await client.query(`select ${SELECT} from helmion.cora_agent_task_intents where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]); return { receipts: result.rows.map((row) => rowToReceipt(row)) }; });
    },
    async claimPrepared(workerActor, { taskId, idempotencyKey } = {}) {
      const worker = requireAuthorizedWorker(workerActor); const active = context(worker); const id = Number(taskId); const idem = String(idempotencyKey ?? '').trim();
      if (!Number.isSafeInteger(id) || id < 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(idem)) throw new Error('task claim input is invalid');
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const existingByKey = await client.query('select task_id, task_receipt_id, claim_id, idempotency_key from helmion.cora_agent_task_claims where tenant_id=$1 and idempotency_key=$2', [active.tenantId, idem]);
        if (existingByKey.rowCount === 1) {
          const task = await client.query('select task_type from helmion.cora_agent_task_intents where tenant_id=$1 and id=$2', [active.tenantId, existingByKey.rows[0].task_id]);
          return buildAgentTaskClaimReceipt({ taskId: existingByKey.rows[0].task_id, taskReceiptId: existingByKey.rows[0].task_receipt_id, taskType: task.rows[0]?.task_type, claimId: existingByKey.rows[0].claim_id, workerId: worker.workerId, replayed: true });
        }
        const taskResult = await client.query('select id, task_type, receipt_id, status from helmion.cora_agent_task_intents where tenant_id=$1 and id=$2', [active.tenantId, id]);
        if (taskResult.rowCount !== 1) throw new Error('prepared task was not found');
        if (taskResult.rows[0].status !== 'prepared') throw new Error('only prepared tasks may be claimed');
        const claimId = randomUUID();
        const inserted = await client.query('insert into helmion.cora_agent_task_claims (tenant_id, task_id, task_receipt_id, worker_subject, worker_id, claim_id, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id, task_id) do nothing returning task_id, task_receipt_id, claim_id, idempotency_key', [active.tenantId, id, taskResult.rows[0].receipt_id, worker.subject, worker.workerId, claimId, idem]);
        if (inserted.rowCount === 1) return buildAgentTaskClaimReceipt({ taskId: id, taskReceiptId: taskResult.rows[0].receipt_id, taskType: taskResult.rows[0].task_type, claimId, workerId: worker.workerId });
        const claimed = await client.query('select task_id, task_receipt_id, claim_id, idempotency_key from helmion.cora_agent_task_claims where tenant_id=$1 and task_id=$2', [active.tenantId, id]);
        if (claimed.rowCount !== 1 || claimed.rows[0].idempotency_key !== idem) throw new Error('prepared task is already claimed');
        const task = await client.query('select task_type from helmion.cora_agent_task_intents where tenant_id=$1 and id=$2', [active.tenantId, claimed.rows[0].task_id]);
        return buildAgentTaskClaimReceipt({ taskId: claimed.rows[0].task_id, taskReceiptId: claimed.rows[0].task_receipt_id, taskType: task.rows[0]?.task_type, claimId: claimed.rows[0].claim_id, workerId: worker.workerId, replayed: true });
      });
    },
  });
}

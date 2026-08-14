import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildAgentTaskReceipt, normalizeAgentTaskIntent } from './agent-task-intent.mjs';

function context(actor) { if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required'); return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId }; }
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
  });
}

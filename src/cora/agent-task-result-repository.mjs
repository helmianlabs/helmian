import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { requireAuthorizedWorker } from './agent-task-worker-claim.mjs';

const STATUSES = new Set(['source_ready', 'unavailable', 'no_route', 'blocked', 'approval_required']);

function text(value, name, max = 256) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function workerContext(worker) {
  const authorized = requireAuthorizedWorker(worker);
  if (!authorized.sessionId || !authorized.requestId) throw new Error('authorized worker request context is required');
  // The worker identity is verified above. Tenant transactions intentionally use
  // the worker's membership role because the SQL tenant context accepts only
  // Organization roles, never the internal execution role.
  return { authorized, active: { tenantId: authorized.tenantId, actorSubject: authorized.subject, actorRole: authorized.membershipRole ?? 'member', sessionId: authorized.sessionId, requestId: authorized.requestId } };
}

function actorContext(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization actor context is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.membershipRole ?? actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function resultRow(row, replayed = false) {
  return Object.freeze({
    taskId: Number(row.task_id), claimId: String(row.claim_id), taskReceiptId: String(row.task_receipt_id),
    resultReceiptId: String(row.result_receipt_id), status: String(row.status), excerpts: row.excerpts ?? [],
    routing: row.routing ?? {}, usage: row.usage ?? {}, execution: String(row.execution),
    agentInvocation: String(row.agent_invocation), providerInvocation: String(row.provider_invocation),
    filesystemMutation: String(row.filesystem_mutation), createdAt: row.created_at ?? null, replayed,
  });
}

function normalizeReceipt(receipt = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('execution receipt is invalid');
  if (!STATUSES.has(receipt.status) || receipt.providerInvocation !== 'not_performed' || receipt.filesystemMutation !== 'not_performed') throw new Error('execution receipt exceeds provider-free authority');
  const taskId = Number(receipt.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error('execution task identity is invalid');
  return Object.freeze({ taskId, claimId: text(receipt.claimId, 'claim id'), taskReceiptId: text(receipt.taskReceiptId, 'task receipt id'), status: receipt.status, excerpts: Array.isArray(receipt.excerpts) ? receipt.excerpts : [], routing: receipt.routing && typeof receipt.routing === 'object' ? receipt.routing : {}, usage: receipt.usage && typeof receipt.usage === 'object' ? receipt.usage : {}, idempotencyKey: text(receipt.idempotencyKey, 'execution idempotency key', 200) });
}

const SELECT = 'task_id, claim_id, task_receipt_id, result_receipt_id, status, excerpts, routing, usage, execution, agent_invocation, provider_invocation, filesystem_mutation, created_at';

export function createAgentTaskResultRepository(pool) {
  return Object.freeze({
    async append(worker, receipt) {
      const { authorized, active } = workerContext(worker); const normalized = normalizeReceipt(receipt);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const resultReceiptId = randomUUID();
        const inserted = await client.query(`insert into helmion.cora_agent_task_execution_results (tenant_id, task_id, claim_id, task_receipt_id, result_receipt_id, status, excerpts, routing, usage, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10) on conflict (tenant_id, idempotency_key) do nothing returning ${SELECT}`, [authorized.tenantId, normalized.taskId, normalized.claimId, normalized.taskReceiptId, resultReceiptId, normalized.status, JSON.stringify(normalized.excerpts), JSON.stringify(normalized.routing), JSON.stringify(normalized.usage), normalized.idempotencyKey]);
        if (inserted.rowCount === 1) {
          await client.query("insert into helmion.cora_agent_task_transitions (tenant_id, task_id, actor_subject, from_status, to_status, reason) values ($1,$2,$3,'prepared','completed',$4)", [authorized.tenantId, normalized.taskId, authorized.subject, `provider_free_${normalized.status}`]);
          return { durable: true, ...resultRow(inserted.rows[0]) };
        }
        const replay = await client.query(`select ${SELECT} from helmion.cora_agent_task_execution_results where tenant_id=$1 and idempotency_key=$2`, [authorized.tenantId, normalized.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('execution result receipt was not durable');
        return { durable: true, ...resultRow(replay.rows[0], true) };
      });
    },
    async list(actor, taskId = null, limit = 50) {
      const active = actorContext(actor); const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const task = taskId == null ? null : Number(taskId);
      if (task !== null && (!Number.isSafeInteger(task) || task < 1)) throw new Error('execution task selector is invalid');
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.cora_agent_task_execution_results where tenant_id=$1${task === null ? '' : ' and task_id=$2'} order by created_at desc, id desc limit $${task === null ? '2' : '3'}`, task === null ? [active.tenantId, bounded] : [active.tenantId, task, bounded]);
        return { results: result.rows.map((row) => resultRow(row)) };
      });
    },
  });
}

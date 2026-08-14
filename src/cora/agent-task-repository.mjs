import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildAgentTaskReceipt, normalizeAgentTaskIntent } from './agent-task-intent.mjs';
import { buildAgentTaskClaimReceipt, requireAuthorizedWorker } from './agent-task-worker-claim.mjs';
import { buildAgentTaskCompletionReceipt, buildNotExecutedTaskCompletion, normalizeAgentTaskCompletion } from './agent-task-completion-receipt.mjs';
import { buildWorkerLifecycleEvent, normalizeWorkerLifecycleEvent } from './agent-task-worker-lifecycle.mjs';

function context(actor) { if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required'); return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.membershipRole ?? actor.role, sessionId: actor.sessionId, requestId: actor.requestId }; }
const SELECT = 'id, task_type, goal, context_ref, department, cost_center, intent, status, receipt_id, idempotency_key, created_at';
function rowToReceipt(row, replayed = false, claimStatus = 'unavailable', completion = null, lifecycle = null) { return { ...buildAgentTaskReceipt({ task: { taskType: row.task_type, goal: row.goal, contextRef: row.context_ref, department: row.department, costCenter: row.cost_center, intent: row.intent, idempotencyKey: row.idempotency_key }, status: row.status, receiptId: row.receipt_id, replayed }), claimStatus, completion: completion ?? buildNotExecutedTaskCompletion({ taskId: row.id, claimStatus }), lifecycle: lifecycle ?? { status: 'unavailable', events: [], source: 'lifecycle_schema_unavailable' } }; }

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
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.cora_agent_task_intents where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]);
        const receipts = [];
        for (const row of result.rows) {
          let claimStatus = 'unavailable';
          try {
            const claim = await client.query('select claim_status from helmion.cora_agent_task_claims where tenant_id=$1 and task_id=$2', [active.tenantId, row.id]);
            claimStatus = claim.rowCount === 1 && claim.rows[0].claim_status === 'claimed' ? 'claimed' : 'unclaimed';
          } catch (error) {
            if (error?.code !== '42P01') throw error;
          }
          let completion = null;
          try {
            const result = await client.query('select completion_status, execution, evidence_ref, failure_code from helmion.cora_agent_task_completion_receipts where tenant_id=$1 and task_id=$2', [active.tenantId, row.id]);
            if (result.rowCount === 1) completion = { completionStatus: result.rows[0].completion_status, execution: result.rows[0].execution, evidenceRef: result.rows[0].evidence_ref, failureCode: result.rows[0].failure_code ?? null };
          } catch (error) {
            if (error?.code === '42P01') completion = { completionStatus: 'unavailable', execution: 'not_performed', evidenceRef: null, failureCode: null, source: 'completion_schema_unavailable' };
            else throw error;
          }
          let lifecycle = { status: 'unavailable', events: [], source: 'lifecycle_schema_unavailable' };
          try {
            const result = await client.query('select claim_id, worker_id, attempt_no, lifecycle_status, execution, evidence_ref, evidence_sha256, failure_code, idempotency_key, created_at from helmion.cora_agent_task_worker_lifecycle where tenant_id=$1 and task_id=$2 order by attempt_no desc, id desc limit 20', [active.tenantId, row.id]);
            lifecycle = { status: 'available', events: result.rows.map((event) => ({ claimId: event.claim_id, workerId: event.worker_id, attemptNo: event.attempt_no, lifecycleStatus: event.lifecycle_status, execution: event.execution, evidenceRef: event.evidence_ref, evidenceSha256: event.evidence_sha256, failureCode: event.failure_code ?? null, idempotencyKey: event.idempotency_key, createdAt: event.created_at })) };
          } catch (error) {
            if (error?.code !== '42P01') throw error;
          }
          receipts.push(rowToReceipt(row, false, claimStatus, completion, lifecycle));
        }
        return { receipts, claimStatusSource: receipts.some((receipt) => receipt.claimStatus === 'unavailable') ? 'unavailable' : 'cora_agent_task_claims' };
      });
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
    async recordCompletion(workerActor, input = {}) {
      const worker = requireAuthorizedWorker(workerActor); const active = context(worker); const completion = normalizeAgentTaskCompletion(input); const taskId = Number(input.taskId); const claimId = String(input.claimId ?? '').trim();
      if (!Number.isSafeInteger(taskId) || taskId < 1 || !/^.{8,256}$/u.test(claimId)) throw new Error('completion task or claim identity is invalid');
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const existing = await client.query('select task_id, claim_id, worker_id, completion_status, execution, evidence_ref, failure_code, idempotency_key from helmion.cora_agent_task_completion_receipts where tenant_id=$1 and idempotency_key=$2', [active.tenantId, completion.idempotencyKey]);
        if (existing.rowCount === 1) return buildAgentTaskCompletionReceipt({ taskId: existing.rows[0].task_id, claimId: existing.rows[0].claim_id, workerId: existing.rows[0].worker_id, status: existing.rows[0].completion_status, evidenceRef: existing.rows[0].evidence_ref, failureCode: existing.rows[0].failure_code, idempotencyKey: existing.rows[0].idempotency_key, replayed: true });
        const claim = await client.query('select task_id, claim_id, worker_id from helmion.cora_agent_task_claims where tenant_id=$1 and task_id=$2', [active.tenantId, taskId]);
        if (claim.rowCount !== 1 || claim.rows[0].claim_id !== claimId || claim.rows[0].worker_id !== worker.workerId) throw new Error('authorized worker claim is required for completion');
        const inserted = await client.query('insert into helmion.cora_agent_task_completion_receipts (tenant_id, task_id, claim_id, worker_subject, worker_id, completion_status, execution, evidence_ref, failure_code, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, task_id) do nothing returning task_id, claim_id, worker_id, completion_status, execution, evidence_ref, failure_code, idempotency_key', [active.tenantId, taskId, claimId, worker.subject, worker.workerId, completion.status, 'performed', completion.evidenceRef, completion.failureCode, completion.idempotencyKey]);
        if (inserted.rowCount !== 1) throw new Error('task completion already recorded');
        return buildAgentTaskCompletionReceipt({ taskId, claimId, workerId: worker.workerId, status: completion.status, evidenceRef: completion.evidenceRef, failureCode: completion.failureCode, idempotencyKey: completion.idempotencyKey });
      });
    },
    async recordRetry(workerActor, input = {}) {
      const worker = requireAuthorizedWorker(workerActor); const active = context(worker); const event = normalizeWorkerLifecycleEvent({ ...input, status: 'retry_scheduled', execution: 'not_performed' }); const taskId = Number(input.taskId); const claimId = String(input.claimId ?? '').trim();
      if (!Number.isSafeInteger(taskId) || taskId < 1 || !/^.{8,256}$/u.test(claimId)) throw new Error('retry task or claim identity is invalid');
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const existing = await client.query('select task_id, claim_id, worker_id, attempt_no, lifecycle_status, execution, evidence_ref, evidence_sha256, failure_code, idempotency_key from helmion.cora_agent_task_worker_lifecycle where tenant_id=$1 and idempotency_key=$2', [active.tenantId, event.idempotencyKey]);
        if (existing.rowCount === 1) { const row = existing.rows[0]; return buildWorkerLifecycleEvent({ taskId: row.task_id, claimId: row.claim_id, workerId: row.worker_id, status: row.lifecycle_status, attemptNo: row.attempt_no, execution: row.execution, evidenceRef: row.evidence_ref, evidenceSha256: row.evidence_sha256, failureCode: row.failure_code, idempotencyKey: row.idempotency_key, replayed: true }); }
        const claim = await client.query('select task_id, claim_id, worker_id from helmion.cora_agent_task_claims where tenant_id=$1 and task_id=$2', [active.tenantId, taskId]);
        if (claim.rowCount !== 1 || claim.rows[0].claim_id !== claimId || claim.rows[0].worker_id !== worker.workerId) throw new Error('authorized worker claim is required for retry');
        const inserted = await client.query('insert into helmion.cora_agent_task_worker_lifecycle (tenant_id, task_id, claim_id, worker_subject, worker_id, attempt_no, lifecycle_status, execution, evidence_ref, evidence_sha256, failure_code, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tenant_id, task_id, attempt_no) do nothing returning task_id, claim_id, worker_id, attempt_no, lifecycle_status, execution, evidence_ref, evidence_sha256, failure_code, idempotency_key', [active.tenantId, taskId, claimId, worker.subject, worker.workerId, event.attemptNo, event.status, event.execution, event.evidenceRef, event.evidenceSha256, event.failureCode, event.idempotencyKey]);
        if (inserted.rowCount !== 1) throw new Error('task retry attempt already recorded');
        return buildWorkerLifecycleEvent({ taskId, claimId, workerId: worker.workerId, status: event.status, attemptNo: event.attemptNo, execution: event.execution, evidenceRef: event.evidenceRef, evidenceSha256: event.evidenceSha256, failureCode: event.failureCode, idempotencyKey: event.idempotencyKey });
      });
    },
  });
}

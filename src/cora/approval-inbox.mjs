import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { appendAuditEvent } from '../cloud/audit-event-repository.mjs';
import { enqueueConnectorMessage } from './connector-outbound-worker.mjs';

const DECISIONS = new Set(['approve', 'reject']);
const KINDS = new Set(['artifact_execution_request']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

export function normalizeApprovalDecision(input = {}) {
  if (input && typeof input === 'object' && ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(input, key))) throw new Error('approval decision cannot select tenant, Organization, Plant, or facility authority');
  const keys = Object.keys(input ?? {});
  if (!input || typeof input !== 'object' || Array.isArray(input) || keys.some((key) => !['decision', 'reason', 'requestKind', 'requestReceiptId', 'idempotencyKey'].includes(key))) throw new Error('approval decision contains unsupported fields');
  const decision = text(input.decision, 'approval decision', 16).toLowerCase();
  const requestKind = text(input.requestKind, 'approval request kind', 64).toLowerCase();
  if (!DECISIONS.has(decision) || !KINDS.has(requestKind)) throw new Error('approval decision kind is unsupported');
  return Object.freeze({ decision, requestKind, requestReceiptId: text(input.requestReceiptId, 'approval request receipt', 256), reason: text(input.reason, 'approval reason', 600), idempotencyKey: text(input.idempotencyKey, 'approval idempotency key', 200) });
}

function decisionReceipt(row, replayed = false) {
  return Object.freeze({ format: 'cora.approval-decision.v1', valid: true, organizationId: String(row.tenant_id), requestKind: row.request_kind, requestReceiptId: row.request_receipt_id, decision: row.decision, reason: row.reason, actorSubject: row.actor_subject, actorRole: row.actor_role, receiptId: row.receipt_id, createdAt: row.created_at ?? null, replayed: replayed === true, execution: 'not_performed', providerInvocation: 'not_performed' });
}

function inboxItem(row) {
  const effectiveStatus = row.decision === 'approve' ? 'approved_not_executed' : row.decision === 'reject' ? 'rejected_not_executed' : row.status;
  const run = row.run_outcome ? Object.freeze({ outcome: row.run_outcome, result: row.run_result, workerId: row.run_worker_id, createdAt: row.run_created_at }) : null;
  return Object.freeze({ requestKind: row.request_kind, requestReceiptId: row.request_receipt_id, status: effectiveStatus, approvalRequired: row.request_kind === 'artifact_execution_request' && row.status === 'approval_required' && !row.decision, decision: row.decision ?? null, decisionReceiptId: row.decision_receipt_id ?? null, decisionReason: row.decision_reason ?? null, createdAt: row.created_at ?? null, actorSubject: row.actor_subject ?? null, summary: row.summary ?? null, execution: run ? run.outcome : 'not_performed', providerInvocation: 'not_performed', run });
}

export function createApprovalInboxRepository(pool) {
  return Object.freeze({
    async list(actor, { status = null, requestKind = null, limit = 100 } = {}) {
      const active = context(actor); const bounded = Math.min(Math.max(Number(limit) || 100, 1), 100);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        let rows;
        try {
          const result = await client.query(`select 'artifact_execution_request' as request_kind, r.receipt_id as request_receipt_id, r.status, r.actor_subject, r.created_at, d.decision, d.receipt_id as decision_receipt_id, d.reason as decision_reason, concat(r.provider, '/', r.model, ' · ', r.modality) as summary, e.outcome as run_outcome, e.result as run_result, e.worker_id as run_worker_id, e.created_at as run_created_at from helmion.cora_artifact_execution_requests r left join helmion.cora_approval_decisions d on d.tenant_id=r.tenant_id and d.request_kind='artifact_execution_request' and d.request_receipt_id=r.receipt_id left join helmion.cora_artifact_execution_runs e on e.tenant_id=r.tenant_id and e.execution_request_id=r.id where r.tenant_id=$1 union all select 'agent_task_intent' as request_kind, t.receipt_id as request_receipt_id, t.status, t.actor_subject, t.created_at, null as decision, null as decision_receipt_id, null as decision_reason, t.task_type || ' · ' || t.goal as summary, null as run_outcome, null as run_result, null as run_worker_id, null as run_created_at from helmion.cora_agent_task_intents t where t.tenant_id=$1 order by created_at desc limit $2`, [active.tenantId, bounded]);
          rows = result.rows;
        } catch (error) {
          // Migration 046 not applied yet: fall back to the runs-less list.
          if (error?.code !== '42P01') throw error;
          const result = await client.query(`select 'artifact_execution_request' as request_kind, r.receipt_id as request_receipt_id, r.status, r.actor_subject, r.created_at, d.decision, d.receipt_id as decision_receipt_id, d.reason as decision_reason, concat(r.provider, '/', r.model, ' · ', r.modality) as summary from helmion.cora_artifact_execution_requests r left join helmion.cora_approval_decisions d on d.tenant_id=r.tenant_id and d.request_kind='artifact_execution_request' and d.request_receipt_id=r.receipt_id where r.tenant_id=$1 union all select 'agent_task_intent' as request_kind, t.receipt_id as request_receipt_id, t.status, t.actor_subject, t.created_at, null as decision, null as decision_receipt_id, null as decision_reason, t.task_type || ' · ' || t.goal as summary from helmion.cora_agent_task_intents t where t.tenant_id=$1 order by created_at desc limit $2`, [active.tenantId, bounded]);
          rows = result.rows;
        }
        const items = rows.map(inboxItem).filter((item) => (!requestKind || item.requestKind === requestKind) && (!status || item.status === status || item.decision === status));
        return { items, source: 'organization_approval_receipts', providerCalls: 'not_performed' };
      });
    },
    async decide(actor, input) {
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('approval decision requires owner or admin membership'), { status: 403 });
      const active = context(actor); const decision = normalizeApprovalDecision(input);
      const outcome = await withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const request = await client.query('select receipt_id, status from helmion.cora_artifact_execution_requests where tenant_id=$1 and receipt_id=$2', [active.tenantId, decision.requestReceiptId]);
        if (request.rowCount !== 1 || request.rows[0].status !== 'approval_required') throw new Error('approval request is unavailable or already decided');
        const receiptId = randomUUID();
        const inserted = await client.query('insert into helmion.cora_approval_decisions (tenant_id, request_kind, request_receipt_id, decision, reason, actor_subject, actor_role, idempotency_key, receipt_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, idempotency_key) do nothing returning tenant_id, request_kind, request_receipt_id, decision, reason, actor_subject, actor_role, idempotency_key, receipt_id, created_at', [active.tenantId, decision.requestKind, decision.requestReceiptId, decision.decision, decision.reason, active.actorSubject, active.actorRole, decision.idempotencyKey, receiptId]);
        if (inserted.rowCount === 1) {
          // Every approval lands in the audit ledger in the same transaction,
          // before any worker can act on the decision.
          await appendAuditEvent(client, active, { actionType: 'cora.approval.decided', canonicalTarget: { requestKind: decision.requestKind, requestReceiptId: decision.requestReceiptId, decisionReceiptId: inserted.rows[0].receipt_id }, policyVersion: 'approval-inbox.v1', decision: decision.decision === 'approve' ? 'ALLOW' : 'DENY', privacySummary: `${decision.decision === 'approve' ? 'Approved' : 'Rejected'} the ${decision.requestKind} request`, result: { decision: decision.decision, receiptId: inserted.rows[0].receipt_id } });
          return { result: { durable: true, ...decisionReceipt(inserted.rows[0]), source: 'organization_approval_receipts' }, notify: { decision: decision.decision, requestKind: decision.requestKind, requestReceiptId: decision.requestReceiptId, decisionReceiptId: inserted.rows[0].receipt_id } };
        }
        const replay = await client.query('select tenant_id, request_kind, request_receipt_id, decision, reason, actor_subject, actor_role, idempotency_key, receipt_id, created_at from helmion.cora_approval_decisions where tenant_id=$1 and idempotency_key=$2', [active.tenantId, decision.idempotencyKey]);
        if (replay.rowCount !== 1 || replay.rows[0].request_kind !== decision.requestKind || replay.rows[0].request_receipt_id !== decision.requestReceiptId || replay.rows[0].decision !== decision.decision) throw new Error('approval decision idempotency key is already bound');
        return { result: { durable: true, ...decisionReceipt(replay.rows[0], true), source: 'organization_approval_receipts' }, notify: null };
      });
      // Best-effort outbox notification for a fresh decision (replays do not
      // re-notify). A failed enqueue never fails the decision itself.
      if (outcome.notify) {
        const verb = outcome.notify.decision === 'approve' ? 'Approved' : 'Rejected';
        for (const provider of ['discord', 'slack']) {
          await enqueueConnectorMessage({ pool, tenantId: active.tenantId, provider, channelLabel: 'approvals', text: `${verb} ${outcome.notify.requestKind}: request ${outcome.notify.requestReceiptId} (decision ${outcome.notify.decisionReceiptId}).` }).catch(() => {});
        }
      }
      return outcome.result;
    },
  });
}

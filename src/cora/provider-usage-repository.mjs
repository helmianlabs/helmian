import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { normalizeBudgetPolicy, normalizeUsageRecord } from './provider-usage-ledger.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function usageRow(row) {
  return Object.freeze({ id: String(row.id), organizationId: String(row.tenant_id), department: row.department ?? null, costCenter: row.cost_center ?? null, userSubject: String(row.user_subject), actionType: String(row.action_type), workflow: row.workflow ?? null, provider: String(row.provider), model: String(row.model), modality: String(row.modality), requestedTokens: row.requested_tokens == null ? null : Number(row.requested_tokens), actualTokens: row.actual_tokens == null ? null : Number(row.actual_tokens), audioSeconds: row.audio_seconds == null ? null : Number(row.audio_seconds), imageUnits: row.image_units == null ? null : Number(row.image_units), videoSeconds: row.video_seconds == null ? null : Number(row.video_seconds), estimatedCostMinor: row.estimated_cost_minor == null ? null : Number(row.estimated_cost_minor), reconciledCostMinor: row.reconciled_cost_minor == null ? null : Number(row.reconciled_cost_minor), currency: row.currency ?? null, providerRequestRef: row.provider_request_ref ?? null, policyDecision: String(row.policy_decision), approvalRef: row.approval_ref ?? null, idempotencyKey: String(row.idempotency_key), status: String(row.status), startedAt: row.started_at ?? null, completedAt: row.completed_at ?? null, createdAt: row.created_at });
}

export function createProviderUsageRepository(pool) {
  return Object.freeze({
    async readSummary(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const [budget, totals] = await Promise.all([
          client.query('select period, currency, soft_limit_minor, hard_limit_minor, low_cost_limit_minor, policy_state from helmion.cora_usage_budgets where tenant_id=$1', [active.tenantId]),
          client.query(`select count(*)::integer as event_count, coalesce(sum(estimated_cost_minor),0) as estimated_cost_minor, sum(reconciled_cost_minor) as reconciled_cost_minor from helmion.cora_provider_usage where tenant_id=$1`, [active.tenantId]),
        ]);
        const row = budget.rows[0] ?? null;
        return { budget: row ? normalizeBudgetPolicy({ period: row.period, currency: row.currency, softLimitMinor: row.soft_limit_minor, hardLimitMinor: row.hard_limit_minor, lowCostLimitMinor: row.low_cost_limit_minor, policyState: row.policy_state }) : null, totals: { eventCount: Number(totals.rows[0]?.event_count ?? 0), estimatedCostMinor: Number(totals.rows[0]?.estimated_cost_minor ?? 0), reconciledCostMinor: totals.rows[0]?.reconciled_cost_minor == null ? null : Number(totals.rows[0].reconciled_cost_minor) }, source: 'tenant_append_only_ledger', providerCalls: 'not_performed' };
      });
    },
    async list(actor, limit = 50) {
      const active = context(actor);
      const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select id, tenant_id, department, cost_center, user_subject, action_type, workflow, provider, model, modality, requested_tokens, actual_tokens, audio_seconds, image_units, video_seconds, estimated_cost_minor, reconciled_cost_minor, currency, provider_request_ref, policy_decision, approval_ref, idempotency_key, status, started_at, completed_at, created_at from helmion.cora_provider_usage where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]);
        return { events: result.rows.map(usageRow) };
      });
    },
    async append(actor, input) {
      const active = context(actor);
      const usage = normalizeUsageRecord(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`insert into helmion.cora_provider_usage (tenant_id, department, cost_center, user_subject, action_type, workflow, provider, model, modality, requested_tokens, actual_tokens, audio_seconds, image_units, video_seconds, estimated_cost_minor, reconciled_cost_minor, currency, provider_request_ref, policy_decision, approval_ref, idempotency_key, status, started_at, completed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) on conflict (tenant_id, idempotency_key) do nothing returning id, tenant_id, department, cost_center, user_subject, action_type, workflow, provider, model, modality, requested_tokens, actual_tokens, audio_seconds, image_units, video_seconds, estimated_cost_minor, reconciled_cost_minor, currency, provider_request_ref, policy_decision, approval_ref, idempotency_key, status, started_at, completed_at, created_at`, [active.tenantId, usage.department, usage.costCenter, usage.userSubject, usage.actionType, usage.workflow, usage.provider, usage.model, usage.modality, usage.requestedTokens, usage.actualTokens, usage.audioSeconds, usage.imageUnits, usage.videoSeconds, usage.estimatedCostMinor, usage.reconciledCostMinor, usage.currency, usage.providerRequestRef, usage.policyDecision, usage.approvalRef, usage.idempotencyKey, usage.status, usage.startedAt, usage.completedAt]);
        if (result.rowCount === 1) return { durable: true, replayed: false, event: usageRow(result.rows[0]) };
        const replay = await client.query(`select id, tenant_id, department, cost_center, user_subject, action_type, workflow, provider, model, modality, requested_tokens, actual_tokens, audio_seconds, image_units, video_seconds, estimated_cost_minor, reconciled_cost_minor, currency, provider_request_ref, policy_decision, approval_ref, idempotency_key, status, started_at, completed_at, created_at from helmion.cora_provider_usage where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, usage.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('usage receipt was not durable');
        return { durable: true, replayed: true, event: usageRow(replay.rows[0]) };
      });
    },
  });
}


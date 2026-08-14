import { evaluateCoraActionPolicy } from './action-policy.mjs';

export const CORA_USAGE_LEDGER_FORMAT = 'cora.provider-usage-ledger.v1';
export const CORA_USAGE_BUDGET_FORMAT = 'cora.usage-budget-policy.v1';

const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'multimodal']);
const STATUSES = new Set(['requested', 'started', 'completed', 'failed', 'cancelled', 'reconciled']);
const POLICY_DECISIONS = new Set(['allow', 'step-up', 'deny', 'not_evaluated']);
const BUDGET_STATES = new Set(['active', 'soft_exceeded', 'hard_exceeded', 'paused']);
const NORMAL_ACTIONS = new Set(['navigate', 'read', 'draft', 'prepare']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function optionalText(value, name, max) { return value == null || value === '' ? null : text(value, name, max); }
function nonNegative(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > max) throw new Error(`${name} is invalid`);
  return result;
}
function rejectAuthority(input, name) {
  if (input && ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(input, key))) throw new Error(`${name} cannot select tenant, Organization, Plant, or facility authority`);
}

export function normalizeUsageRecord(input = {}) {
  rejectAuthority(input, 'usage record');
  const modality = text(input.modality, 'usage modality', 16).toLowerCase();
  const status = text(input.status ?? 'completed', 'usage status', 16).toLowerCase();
  const policyDecision = text(input.policyDecision ?? input.policy_decision ?? 'not_evaluated', 'policy decision', 16).toLowerCase();
  if (!MODALITIES.has(modality)) throw new Error('usage modality is unsupported');
  if (!STATUSES.has(status)) throw new Error('usage status is unsupported');
  if (!POLICY_DECISIONS.has(policyDecision)) throw new Error('usage policy decision is unsupported');
  const approvalRef = optionalText(input.approvalRef ?? input.approval_ref, 'approval reference', 256);
  const reconciledCostMinor = nonNegative(input.reconciledCostMinor ?? input.reconciled_cost_minor, 'reconciled cost');
  const currency = optionalText(input.currency, 'usage currency', 3)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('usage currency is invalid');
  if (reconciledCostMinor != null && status !== 'reconciled') throw new Error('reconciled cost requires reconciled status');
  if (policyDecision === 'step-up' && !approvalRef) throw new Error('step-up usage requires approval reference');
  return Object.freeze({
    department: optionalText(input.department, 'department', 160), costCenter: optionalText(input.costCenter ?? input.cost_center, 'cost center', 160),
    userSubject: text(input.userSubject ?? input.user_subject, 'usage user subject', 256), actionType: text(input.actionType ?? input.action_type, 'usage action', 160),
    workflow: optionalText(input.workflow, 'workflow', 160), provider: text(input.provider, 'usage provider', 80), model: text(input.model, 'usage model', 160), modality,
    requestedTokens: nonNegative(input.requestedTokens ?? input.requested_tokens, 'requested tokens'), actualTokens: nonNegative(input.actualTokens ?? input.actual_tokens, 'actual tokens'),
    audioSeconds: nonNegative(input.audioSeconds ?? input.audio_seconds, 'audio seconds'), imageUnits: nonNegative(input.imageUnits ?? input.image_units, 'image units'), videoSeconds: nonNegative(input.videoSeconds ?? input.video_seconds, 'video seconds'),
    estimatedCostMinor: nonNegative(input.estimatedCostMinor ?? input.estimated_cost_minor, 'estimated cost'), reconciledCostMinor,
    currency, providerRequestRef: optionalText(input.providerRequestRef ?? input.provider_request_ref, 'provider request reference', 512),
    policyDecision, approvalRef, idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'usage idempotency key', 200), status,
    startedAt: input.startedAt ?? input.started_at ?? null, completedAt: input.completedAt ?? input.completed_at ?? null,
  });
}

export function normalizeBudgetPolicy(input = {}) {
  rejectAuthority(input, 'budget policy');
  const period = text(input.period ?? 'monthly', 'budget period', 32).toLowerCase();
  const currency = text(input.currency ?? 'USD', 'budget currency', 3).toUpperCase();
  if (!['monthly', 'calendar_month', 'rolling_30d'].includes(period) || !/^[A-Z]{3}$/.test(currency)) throw new Error('budget policy period or currency is invalid');
  const softLimitMinor = nonNegative(input.softLimitMinor ?? input.soft_limit_minor, 'soft budget limit');
  const hardLimitMinor = nonNegative(input.hardLimitMinor ?? input.hard_limit_minor, 'hard budget limit');
  const lowCostLimitMinor = nonNegative(input.lowCostLimitMinor ?? input.low_cost_limit_minor, 'low-cost limit');
  if (softLimitMinor != null && hardLimitMinor != null && softLimitMinor > hardLimitMinor) throw new Error('soft budget limit exceeds hard limit');
  if (lowCostLimitMinor != null && softLimitMinor != null && lowCostLimitMinor > softLimitMinor) throw new Error('low-cost limit exceeds soft limit');
  const policyState = text(input.policyState ?? 'active', 'budget policy state', 32).toLowerCase();
  if (!BUDGET_STATES.has(policyState)) throw new Error('budget policy state is invalid');
  const allocations = Array.isArray(input.allocations) ? input.allocations.slice(0, 32).map(normalizeBudgetAllocation) : [];
  return Object.freeze({ period, currency, softLimitMinor, hardLimitMinor, lowCostLimitMinor, policyState, allocations: Object.freeze(allocations) });
}

export function normalizeBudgetAllocation(input = {}) {
  rejectAuthority(input, 'budget allocation');
  const department = optionalText(input.department, 'allocation department', 160);
  const costCenter = optionalText(input.costCenter ?? input.cost_center, 'allocation cost center', 160);
  const allocationKey = text(input.allocationKey ?? input.allocation_key, 'allocation key', 160);
  if (!department && !costCenter) throw new Error('allocation department or cost center is required');
  const softLimitMinor = nonNegative(input.softLimitMinor ?? input.soft_limit_minor, 'allocation soft limit');
  const hardLimitMinor = nonNegative(input.hardLimitMinor ?? input.hard_limit_minor, 'allocation hard limit');
  if (softLimitMinor != null && hardLimitMinor != null && softLimitMinor > hardLimitMinor) throw new Error('allocation soft limit exceeds hard limit');
  return Object.freeze({ allocationKey, department, costCenter, softLimitMinor, hardLimitMinor, enabled: input.enabled !== false });
}

export function evaluateUsageBudget({ budget = {}, spentMinor = 0, estimatedCostMinor = null, action, roleVerified = true, inScope = true, external = false } = {}) {
  const policy = normalizeBudgetPolicy(budget);
  const spent = nonNegative(spentMinor, 'spent cost') ?? 0;
  const estimate = nonNegative(estimatedCostMinor, 'estimated cost');
  const projected = estimate == null ? null : spent + estimate;
  const actionPolicy = evaluateCoraActionPolicy({ action, role_verified: roleVerified, in_scope: inScope, external_write: external });
  if (actionPolicy.decision === 'deny') return Object.freeze({ format: CORA_USAGE_BUDGET_FORMAT, decision: 'deny', state: 'authorization_required', costKnown: estimate != null });
  if (policy.hardLimitMinor != null && projected != null && projected > policy.hardLimitMinor) return Object.freeze({ format: CORA_USAGE_BUDGET_FORMAT, decision: 'deny', state: 'hard_exceeded', costKnown: true });
  if (external || !NORMAL_ACTIONS.has(String(action ?? '').toLowerCase()) || actionPolicy.decision === 'step-up') return Object.freeze({ format: CORA_USAGE_BUDGET_FORMAT, decision: 'step-up', state: 'high_cost_or_external', costKnown: estimate != null });
  if (policy.softLimitMinor != null && projected != null && projected > policy.softLimitMinor) return Object.freeze({ format: CORA_USAGE_BUDGET_FORMAT, decision: 'step-up', state: 'soft_exceeded', costKnown: true });
  return Object.freeze({ format: CORA_USAGE_BUDGET_FORMAT, decision: 'allow', state: estimate == null ? 'cost_unknown' : 'within_budget', costKnown: estimate != null });
}

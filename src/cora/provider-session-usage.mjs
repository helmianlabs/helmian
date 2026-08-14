import { normalizeUsageRecord } from './provider-usage-ledger.mjs';

const OUTCOMES = new Set(['success', 'failed']);

function bounded(value, name, max = 256) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

export function buildProviderSessionUsage({ bridgeContext, outcome, providerRequestRef = null } = {}) {
  const result = String(outcome ?? '').trim().toLowerCase();
  if (!OUTCOMES.has(result)) throw new Error('provider session outcome is invalid');
  if (bridgeContext && ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(bridgeContext, key) && !['tenantId'].includes(key))) {
    throw new Error('session context cannot carry client tenant, Organization, Plant, or facility authority');
  }
  if (!bridgeContext?.tenantId || !bridgeContext.subjectId || !bridgeContext.role || !bridgeContext.sessionId || !bridgeContext.receiptId) {
    throw new Error('verified Organization session context is required');
  }
  return normalizeUsageRecord({
    userSubject: bounded(bridgeContext.subjectId, 'session subject'),
    actionType: 'cora_session_open',
    workflow: 'signed_cora_session_bridge',
    provider: 'hume',
    model: 'evi-clm',
    modality: 'audio',
    providerRequestRef: providerRequestRef == null ? null : bounded(providerRequestRef, 'provider request reference', 512),
    policyDecision: 'allow',
    idempotencyKey: `cora-session-${bounded(bridgeContext.receiptId, 'bridge receipt', 160)}-${result}`,
    status: result === 'success' ? 'completed' : 'failed',
  });
}

export async function recordProviderSessionUsage({ append, bridgeContext, outcome, providerRequestRef = null } = {}) {
  if (typeof append !== 'function') return Object.freeze({ recorded: false, reason: 'usage append adapter unavailable' });
  const usage = buildProviderSessionUsage({ bridgeContext, outcome, providerRequestRef });
  const actor = {
    tenantId: bounded(bridgeContext.tenantId, 'session Organization'),
    subject: bounded(bridgeContext.subjectId, 'session subject'),
    role: bounded(bridgeContext.role, 'session role', 64),
    sessionId: bounded(bridgeContext.sessionId, 'session id'),
    requestId: bridgeContext.receiptId,
  };
  const receipt = await append(actor, usage);
  return Object.freeze({ recorded: true, ...receipt });
}

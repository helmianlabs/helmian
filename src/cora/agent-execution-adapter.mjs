import { createHash } from 'node:crypto';
import { requireAuthorizedWorker } from './agent-task-worker-claim.mjs';
import { resolveCoraExecutionRoute } from './routing-policy.mjs';

export const CORA_AGENT_EXECUTION_FORMAT = 'cora.agent-execution-receipt.v1';
export const CORA_APPROVED_KNOWLEDGE_TASK = 'approved_knowledge_lookup';

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id',
  'facilityId', 'facility_id',
]);
const USAGE_NULLS = Object.freeze({
  requestedTokens: null, inputTokens: null, outputTokens: null,
  audioSeconds: null, imageUnits: null, videoUnits: null,
  estimatedCostMinor: null, reconciledCostMinor: null, providerRequestRef: null,
});

function text(value, name, max = 256) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthoritySelection(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  if ([...FORBIDDEN_AUTHORITY_KEYS].some((key) => Object.hasOwn(value, key))) throw new Error(message);
}

function rejectRouteInjection(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (['provider', 'model', 'providerId', 'modelId', 'apiKey', 'credential'].some((key) => Object.hasOwn(value, key))) throw new Error(message);
}

export function requireSignedOrganizationContext(context = {}) {
  rejectAuthoritySelection(context, 'signed Organization context cannot select tenant, Organization, Plant, or facility authority');
  if (context.format !== 'cora.signed-organization-context.v1' || context.verified !== true || context.membershipVerified !== true) {
    throw new Error('verified signed Organization context is required');
  }
  return Object.freeze({
    format: context.format,
    verified: true,
    membershipVerified: true,
    tenantId: text(context.tenantId, 'signed tenant'),
    subjectId: text(context.subjectId, 'signed subject'),
    role: text(context.role, 'signed role', 64),
    sessionId: text(context.sessionId, 'signed session', 256),
    receiptId: text(context.receiptId, 'signed receipt', 256),
  });
}

function claimForExecution(claim, worker) {
  rejectAuthoritySelection(claim, 'worker claim cannot select tenant, Organization, Plant, or facility authority');
  rejectRouteInjection(claim, 'worker claim cannot select provider or model');
  const authorized = requireAuthorizedWorker(worker);
  if (claim?.format !== 'cora.agent-task-worker-claim.v1' || claim.valid !== true
    || claim.claimStatus !== 'claimed' || claim.taskStatus !== 'prepared'
    || claim.execution !== 'not_performed' || claim.workerId !== authorized.workerId) {
    throw new Error('a valid prepared claim from the authorized worker is required');
  }
  const taskId = Number(claim.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error('worker claim task identity is invalid');
  return Object.freeze({ ...claim, taskId, workerId: authorized.workerId, tenantId: authorized.tenantId });
}

function idempotencyKey(claim, context) {
  return createHash('sha256').update(`${claim.claimId}:${context.receiptId}:${claim.taskId}`).digest('hex');
}

function normalizeEvidence(result) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) throw new Error('knowledge adapter result is invalid');
  if (result.providerCall === 'performed' || result.modelCall === 'performed' || result.answer != null) {
    throw new Error('provider/model answers are not allowed in the provider-free adapter');
  }
  const excerpts = Array.isArray(result.excerpts) ? result.excerpts : [];
  if (excerpts.some((item) => !item || typeof item !== 'object' || !item.citation || !item.excerpt)) throw new Error('knowledge evidence must contain stored excerpts and citations');
  const status = result.status === 'source_ready' && excerpts.length > 0 ? 'source_ready' : 'unavailable';
  return Object.freeze({ status, excerpts: Object.freeze(excerpts.map((item) => Object.freeze({
    excerpt: text(item.excerpt, 'knowledge excerpt', 4000), citation: text(item.citation, 'knowledge citation', 1000),
    provenance: item.provenance == null ? null : text(item.provenance, 'knowledge provenance', 1000),
  }))) });
}

export function createApprovedKnowledgeExecutionAdapter({ knowledgeLookup, receiptSink, routingPolicy = null, approvedCatalog = [], routingPolicyLookup = null } = {}) {
  if (typeof knowledgeLookup !== 'function' || typeof receiptSink !== 'function') throw new Error('provider-free knowledge adapter and receipt sink are required');
  const replay = new Map();
  return Object.freeze({
    async execute({ worker, claim, signedOrganizationContext, query, requestedCatalogId = null, requestedBudgetTier = null, requestedLatencyTier = null, external = false } = {}) {
      const context = requireSignedOrganizationContext(signedOrganizationContext);
      rejectRouteInjection(signedOrganizationContext, 'signed Organization context cannot select provider or model');
      const verifiedClaim = claimForExecution(claim, worker);
      if (verifiedClaim.tenantId !== context.tenantId) throw new Error('worker claim and signed Organization context do not match');
      if (claim.taskType !== CORA_APPROVED_KNOWLEDGE_TASK) throw new Error('task class is not an approved read-only knowledge lookup');
      const boundedQuery = text(query, 'knowledge query', 1000);
      const key = idempotencyKey(verifiedClaim, context);
      if (replay.has(key)) return Object.freeze({ ...replay.get(key), replayed: true });
      const selectedPolicy = routingPolicyLookup ? await routingPolicyLookup({ tenantId: context.tenantId, subjectId: context.subjectId }) : { routingPolicy, approvedCatalog };
      if (selectedPolicy?.tenantId && selectedPolicy.tenantId !== context.tenantId) throw new Error('routing policy Organization does not match signed context');
      const route = resolveCoraExecutionRoute({ policy: selectedPolicy?.routingPolicy, approvedCatalog: selectedPolicy?.approvedCatalog ?? [], taskType: claim.taskType, requestedCatalogId, requestedBudgetTier, requestedLatencyTier, external });
      if (route.status !== 'allowed') {
        const denied = Object.freeze({ format: CORA_AGENT_EXECUTION_FORMAT, valid: true, taskType: claim.taskType, taskId: verifiedClaim.taskId, claimId: verifiedClaim.claimId, receiptId: context.receiptId, status: route.status, reason: route.reason, execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed', answer: null, excerpts: Object.freeze([]), usage: USAGE_NULLS, routing: route, usageLedger: route.route?.usageLedger ?? null, idempotencyKey: key, replayed: false });
        const persisted = await receiptSink({ worker, context, receipt: denied });
        if (persisted?.recorded === false) throw new Error('execution receipt was not recorded');
        replay.set(key, denied);
        return denied;
      }
      const evidence = normalizeEvidence(await knowledgeLookup({ query: boundedQuery, context }));
      const receipt = Object.freeze({
        format: CORA_AGENT_EXECUTION_FORMAT, valid: true, taskType: CORA_APPROVED_KNOWLEDGE_TASK,
        taskId: verifiedClaim.taskId, claimId: verifiedClaim.claimId, receiptId: context.receiptId,
        status: evidence.status, execution: 'not_performed', agentInvocation: 'not_performed',
        providerInvocation: 'not_performed', filesystemMutation: 'not_performed', answer: null,
        excerpts: evidence.excerpts, usage: USAGE_NULLS, idempotencyKey: key, replayed: false,
        routing: route, usageLedger: route.route.usageLedger,
      });
      const persisted = await receiptSink({ worker: worker, context, receipt });
      if (persisted?.recorded === false) throw new Error('execution receipt was not recorded');
      replay.set(key, receipt);
      return receipt;
    },
  });
}

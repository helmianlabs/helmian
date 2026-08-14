import { evaluateUsageBudget } from './provider-usage-ledger.mjs';

export const CORA_ARTIFACT_EXECUTION_REQUEST_FORMAT = 'cora.artifact-execution-request.v1';
const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'multimodal']);
const AUTHORITY_KEYS = ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'];
const ALLOWED_KEYS = new Set(['artifactReceiptId', 'scriptReceiptId', 'sourceLinkReceiptIds', 'catalogEntryId', 'provider', 'model', 'modality', 'estimatedRequestedTokens', 'estimatedAudioSeconds', 'estimatedImageUnits', 'estimatedVideoUnits', 'estimatedCostMinor', 'currency', 'externalExecution', 'budgetState', 'approvalRef', 'supersedesReceiptId', 'idempotencyKey']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function text(value, name, max) { const result = String(value ?? '').trim(); if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`); return result; }
function amount(value, name) { if (value == null || value === '') return null; const result = Number(value); if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) throw new Error(`${name} is invalid`); return result; }
function rejectAuthority(input) { if (input && AUTHORITY_KEYS.some((key) => Object.hasOwn(input, key))) throw new Error('execution request cannot select tenant, Organization, Plant, or facility authority'); }

export function normalizeArtifactExecutionRequest(input = {}) {
  rejectAuthority(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('execution request contains unsupported fields');
  const links = input.sourceLinkReceiptIds ?? [];
  if (!Array.isArray(links) || links.length === 0 || links.length > 20 || links.some((id) => !ID.test(String(id)))) throw new Error('approved source links are required');
  const modality = text(input.modality, 'execution modality', 16).toLowerCase();
  const currency = text(input.currency ?? 'USD', 'execution currency', 3).toUpperCase();
  if (!MODALITIES.has(modality) || !/^[A-Z]{3}$/u.test(currency) || input.externalExecution !== true) throw new Error('execution request metadata is invalid');
  const request = Object.freeze({
    artifactReceiptId: text(input.artifactReceiptId, 'artifact receipt', 256), scriptReceiptId: text(input.scriptReceiptId, 'script receipt', 256), sourceLinkReceiptIds: Object.freeze(links.map((id) => String(id))),
    catalogEntryId: text(input.catalogEntryId, 'catalog entry', 128), provider: text(input.provider, 'provider', 64), model: text(input.model, 'model', 128), modality,
    estimatedRequestedTokens: amount(input.estimatedRequestedTokens, 'estimated requested tokens'), estimatedAudioSeconds: amount(input.estimatedAudioSeconds, 'estimated audio seconds'), estimatedImageUnits: amount(input.estimatedImageUnits, 'estimated image units'), estimatedVideoUnits: amount(input.estimatedVideoUnits, 'estimated video units'), estimatedCostMinor: amount(input.estimatedCostMinor, 'estimated cost'), currency,
    externalExecution: true, budgetState: text(input.budgetState ?? 'unknown', 'budget state', 32), ...(input.approvalRef == null ? {} : { approvalRef: text(input.approvalRef, 'approval reference', 256) }), ...(input.supersedesReceiptId == null ? {} : { supersedesReceiptId: text(input.supersedesReceiptId, 'superseded receipt', 256) }), idempotencyKey: text(input.idempotencyKey, 'execution idempotency key', 200),
  });
  return request;
}

export function buildArtifactExecutionReceipt({ request, receiptId, actorSubject, role, budget, spentMinor = 0, replayed = false, statusOverride = null, policyDecisionOverride = null, budgetStateOverride = null } = {}) {
  const normalized = normalizeArtifactExecutionRequest(request);
  const policy = evaluateUsageBudget({ budget, spentMinor, estimatedCostMinor: normalized.estimatedCostMinor, action: 'prepare', roleVerified: true, inScope: true, external: true });
  const approved = normalized.approvalRef != null && ['owner', 'admin'].includes(String(role).toLowerCase());
  const status = statusOverride ?? (policy.state === 'hard_exceeded' || policy.state === 'authorization_required' ? 'blocked' : approved ? 'queued' : 'approval_required');
  return Object.freeze({ format: CORA_ARTIFACT_EXECUTION_REQUEST_FORMAT, valid: true, artifactReceiptId: normalized.artifactReceiptId, scriptReceiptId: normalized.scriptReceiptId, sourceLinkReceiptIds: normalized.sourceLinkReceiptIds, catalogEntryId: normalized.catalogEntryId, provider: normalized.provider, model: normalized.model, modality: normalized.modality, estimatedRequestedTokens: normalized.estimatedRequestedTokens, estimatedAudioSeconds: normalized.estimatedAudioSeconds, estimatedImageUnits: normalized.estimatedImageUnits, estimatedVideoUnits: normalized.estimatedVideoUnits, estimatedCostMinor: normalized.estimatedCostMinor, currency: normalized.currency, externalExecution: true, policyDecision: policyDecisionOverride ?? (status === 'blocked' ? 'deny' : approved ? 'allow' : 'step-up'), budgetState: budgetStateOverride ?? policy.state, status, receiptId: text(receiptId, 'execution receipt', 256), actorSubject: text(actorSubject, 'actor subject', 256), approvalRequired: status === 'approval_required', approvalRef: normalized.approvalRef ?? null, replayed: replayed === true, execution: 'not_executed', providerInvocation: 'not_performed', media: 'not_generated' });
}

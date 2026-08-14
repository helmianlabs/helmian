export const CORA_ARTIFACT_SCRIPT_FORMAT = 'cora.artifact-script.v1';
const STAGES = new Set(['draft', 'source_checked', 'approval_requested']);
const SCRIPT_KINDS = new Set(['narration', 'training_script', 'orientation_script']);
const AUTHORITY_KEYS = ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'];
const ALLOWED_KEYS = new Set(['artifactReceiptId', 'scriptKind', 'text', 'sourceLinkReceiptIds', 'stage', 'approvalReason', 'idempotencyKey']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
function text(value, name, max) { const result = String(value ?? '').trim(); if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`); return result; }
export function normalizeArtifactScript(input = {}) {
  if (input && AUTHORITY_KEYS.some((key) => Object.hasOwn(input, key))) throw new Error('script cannot select tenant, Organization, Plant, or facility authority');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('script contains unsupported fields');
  const stage = text(input.stage ?? 'draft', 'script stage', 32).toLowerCase(); const links = input.sourceLinkReceiptIds ?? [];
  if (!STAGES.has(stage) || !Array.isArray(links) || links.length > 20 || links.some((id) => !SAFE_ID.test(String(id))) || (stage === 'source_checked' && links.length === 0)) throw new Error('script stage or source links are invalid');
  const scriptKind = text(input.scriptKind ?? 'narration', 'script kind', 32).toLowerCase();
  if (!SCRIPT_KINDS.has(scriptKind)) throw new Error('script kind is invalid');
  return Object.freeze({ artifactReceiptId: text(input.artifactReceiptId, 'artifact receipt', 256), scriptKind, text: text(input.text, 'script text', 12000), sourceLinkReceiptIds: Object.freeze(links.map((id) => String(id))), stage, ...(stage === 'approval_requested' ? { approvalReason: text(input.approvalReason, 'approval reason', 600) } : {}), idempotencyKey: text(input.idempotencyKey, 'script idempotency key', 200) });
}
export function buildArtifactScriptReceipt({ script, receiptId, revision, replayed = false, createdBySubject = null, createdAt = null } = {}) { const normalized = normalizeArtifactScript(script); return Object.freeze({ format: CORA_ARTIFACT_SCRIPT_FORMAT, valid: true, artifactReceiptId: normalized.artifactReceiptId, scriptKind: normalized.scriptKind, text: normalized.text, revision: Number(revision), stage: normalized.stage, sourceLinkReceiptIds: normalized.sourceLinkReceiptIds, receiptId: text(receiptId, 'script receipt', 256), replayed: replayed === true, createdBySubject: createdBySubject ? text(createdBySubject, 'created by subject', 256) : null, createdAt: createdAt ? String(createdAt) : null, draftState: 'prepared', generation: 'not_generated', providerInvocation: 'not_performed', media: 'not_generated' }); }

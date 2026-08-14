export const CORA_ARTIFACT_SOURCE_FORMAT = 'cora.artifact-source.v1';
const CLASSIFICATIONS = new Set(['internal_manual', 'sop', 'regulatory', 'training_reference', 'other']);
const SOURCE_LIFECYCLES = new Set(['draft', 'review_requested', 'approved', 'rejected']);
const AUTHORITY_KEYS = ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'];
const ALLOWED_KEYS = new Set(['sourceKey', 'source_key', 'title', 'publisher', 'classification', 'provenance', 'reference', 'effectiveAt', 'effective_at', 'expiresAt', 'expires_at', 'idempotencyKey', 'idempotency_key']);
const SAFE_KEY = /^[a-z][a-z0-9._:-]{0,95}$/u;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthority(value) {
  if (value && AUTHORITY_KEYS.some((key) => Object.hasOwn(value, key))) throw new Error('artifact source cannot select tenant, Organization, Plant, or facility authority');
}

function dateOrNull(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const result = text(value, name, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} is invalid`);
  return result;
}

export function normalizeArtifactSource(input = {}) {
  rejectAuthority(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('artifact source contains unsupported fields');
  const sourceKey = text(input.sourceKey ?? input.source_key, 'source key', 96).toLowerCase();
  const classification = text(input.classification, 'source classification', 32).toLowerCase();
  const idempotencyKey = text(input.idempotencyKey ?? input.idempotency_key, 'source idempotency key', 200);
  if (!SAFE_KEY.test(sourceKey) || !CLASSIFICATIONS.has(classification) || !SAFE_IDEMPOTENCY.test(idempotencyKey)) throw new Error('source key, classification, or idempotency key is unsupported');
  const effectiveAt = dateOrNull(input.effectiveAt ?? input.effective_at, 'source effective date');
  const expiresAt = dateOrNull(input.expiresAt ?? input.expires_at, 'source expiry date');
  if (effectiveAt && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveAt)) throw new Error('source expiry must be after effective date');
  return Object.freeze({ sourceKey, title: text(input.title, 'source title', 240), publisher: text(input.publisher, 'source publisher', 240), classification, provenance: text(input.provenance, 'source provenance', 800), reference: text(input.reference, 'source reference', 800), effectiveAt, expiresAt, idempotencyKey });
}

export function normalizeArtifactSourceLink(input = {}) {
  rejectAuthority(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('artifact source link is invalid');
  const keys = Object.keys(input);
  if (keys.some((key) => !['artifactReceiptId', 'sourceId', 'idempotencyKey', 'linkReason'].includes(key))) throw new Error('artifact source link contains unsupported fields');
  return Object.freeze({ artifactReceiptId: text(input.artifactReceiptId, 'artifact receipt', 256), sourceId: text(input.sourceId, 'source id', 64), idempotencyKey: text(input.idempotencyKey, 'link idempotency key', 200), linkReason: text(input.linkReason, 'link reason', 600) });
}

export function sourceLifecycleTransitionAllowed(from, to) {
  if (!SOURCE_LIFECYCLES.has(from) || !SOURCE_LIFECYCLES.has(to)) return false;
  return (from === 'draft' && to === 'review_requested') || (from === 'review_requested' && ['approved', 'rejected'].includes(to));
}

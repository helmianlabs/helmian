export const CORA_ARTIFACT_STUDIO_FORMAT = 'cora.artifact-studio-intent.v1';
const TYPES = new Set(['training', 'orientation']);
const STAGES = new Set(['draft', 'source_checked', 'approval_requested']);
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const AUTHORITY_KEYS = ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'];
const ALLOWED_KEYS = new Set(['artifactType', 'artifact_type', 'title', 'department', 'objective', 'sourceRefs', 'source_refs', 'stage', 'idempotencyKey', 'idempotency_key', 'approvalReason']);

function bounded(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthority(input) {
  if (input && AUTHORITY_KEYS.some((key) => Object.hasOwn(input, key))) throw new Error('artifact intent cannot select tenant, Organization, Plant, or facility authority');
}

function sourceRefs(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('artifact source references are invalid');
  return value.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`artifact source reference ${index + 1} is invalid`);
    const keys = Object.keys(source);
    if (keys.some((key) => !['citation', 'title', 'version'].includes(key))) throw new Error('artifact source reference contains unsupported fields');
    return Object.freeze({
      citation: bounded(source.citation, 'artifact source citation', 512),
      title: bounded(source.title, 'artifact source title', 240),
      ...(source.version === undefined ? {} : { version: bounded(source.version, 'artifact source version', 120) }),
    });
  });
}

export function normalizeArtifactStudioIntent(input = {}) {
  rejectAuthority(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('artifact intent contains unsupported fields');
  const artifactType = bounded(input.artifactType ?? input.artifact_type, 'artifact type', 24).toLowerCase();
  const stage = bounded(input.stage ?? 'draft', 'artifact stage', 32).toLowerCase();
  const idempotencyKey = bounded(input.idempotencyKey ?? input.idempotency_key, 'artifact idempotency key', 200);
  if (!TYPES.has(artifactType) || !STAGES.has(stage) || !SAFE_IDEMPOTENCY.test(idempotencyKey)) throw new Error('artifact type, stage, or idempotency key is unsupported');
  return Object.freeze({
    artifactType,
    title: bounded(input.title, 'artifact title', 240),
    department: bounded(input.department, 'artifact department', 160),
    objective: bounded(input.objective, 'artifact objective', 1200),
    sourceRefs: Object.freeze(sourceRefs(input.sourceRefs ?? input.source_refs ?? [])),
    stage,
    idempotencyKey,
    ...(stage === 'approval_requested' ? { approvalReason: bounded(input.approvalReason, 'artifact approval reason', 600) } : {}),
  });
}

export function buildArtifactStudioReceipt({ intent, receiptId, replayed = false } = {}) {
  const normalized = normalizeArtifactStudioIntent(intent);
  return Object.freeze({
    format: CORA_ARTIFACT_STUDIO_FORMAT,
    valid: true,
    status: normalized.stage,
    artifactType: normalized.artifactType,
    title: normalized.title,
    department: normalized.department,
    objective: normalized.objective,
    sourceRefs: normalized.sourceRefs,
    receiptId: bounded(receiptId, 'artifact receipt', 256),
    replayed: replayed === true,
    workflow: ['draft', 'source_checked', 'approval_requested', 'approved', 'queued', 'running', 'provider_result', 'accepted', 'rejected'],
    availableThrough: 'approval_requested',
    approval: normalized.stage === 'approval_requested' ? 'requested_not_approved' : 'not_requested',
    execution: 'not_performed',
    media: 'not_generated',
    providerInvocation: 'not_performed',
  });
}

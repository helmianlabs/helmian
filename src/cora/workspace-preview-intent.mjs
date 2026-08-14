export const CORA_WORKSPACE_PREVIEW_FORMAT = 'cora.workspace-preview-intent.v1';
const MODES = new Set(['workspace', 'builder']);
const INTENTS = new Set(['draft', 'prepare']);
const SAFE_ID = /^[a-z][a-z0-9-]{0,47}$/u;
const ALLOWED_KEYS = new Set(['mode', 'intent', 'department', 'templateId', 'template_id', 'title', 'idempotencyKey', 'idempotency_key']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function rejectAuthority(input) {
  if (input && ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(input, key))) {
    throw new Error('preview intent cannot select tenant, Organization, Plant, or facility authority');
  }
}

export function normalizeWorkspacePreviewIntent(input = {}) {
  rejectAuthority(input);
  if (input === null || typeof input !== 'object' || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('preview intent contains unsupported fields');
  const mode = text(input.mode, 'preview mode', 16).toLowerCase();
  const intent = text(input.intent, 'preview intent', 16).toLowerCase();
  const templateId = text(input.templateId ?? input.template_id, 'preview template', 48).toLowerCase();
  if (!MODES.has(mode) || !INTENTS.has(intent) || !SAFE_ID.test(templateId)) throw new Error('preview mode, intent, or template is unsupported');
  return Object.freeze({
    mode,
    intent,
    department: text(input.department, 'preview department', 160),
    templateId,
    title: text(input.title, 'preview title', 240),
    idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'preview idempotency key', 200),
  });
}

export function buildWorkspacePreviewReceipt({ intent, receiptId, replayed = false } = {}) {
  const normalized = normalizeWorkspacePreviewIntent(intent);
  return Object.freeze({
    format: CORA_WORKSPACE_PREVIEW_FORMAT,
    valid: true,
    status: 'preview-ready',
    mode: normalized.mode,
    intent: normalized.intent,
    department: normalized.department,
    templateId: normalized.templateId,
    title: normalized.title,
    receiptId: text(receiptId, 'preview receipt', 256),
    replayed: replayed === true,
    execution: 'not_performed',
    providerInvocation: 'not_performed',
    agentInvocation: 'not_performed',
    filesystemMutation: 'not_performed',
  });
}

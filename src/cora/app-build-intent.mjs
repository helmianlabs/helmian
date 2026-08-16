export const CORA_APP_BUILD_REQUEST_FORMAT = 'cora.app-build-request.v1';

const INTENTS = new Set(['draft']);
const COMPONENTS = new Set(['heading', 'paragraph', 'field', 'button', 'table']);
const FIELD_TYPES = new Set(['text', 'email', 'date', 'select']);
const ALLOWED_KEYS = new Set(['intent', 'title', 'department', 'route', 'description', 'components', 'idempotencyKey', 'idempotency_key']);
const AUTHORITY_KEYS = new Set(['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id']);
const ROUTE = /^\/[a-z0-9][a-z0-9-]{0,47}(?:\/[a-z0-9][a-z0-9-]{0,47}){0,3}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function component(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('app component is invalid');
  const type = text(value.type, 'component type', 16).toLowerCase();
  if (!COMPONENTS.has(type)) throw new Error('component type is unsupported');
  const allowed = type === 'field' ? ['type', 'label', 'fieldType', 'required']
    : type === 'button' ? ['type', 'label', 'action']
      : type === 'table' ? ['type', 'label', 'columns'] : ['type', 'text'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('component contains unsupported fields');
  if (type === 'field') {
    const fieldType = text(value.fieldType, 'field type', 16).toLowerCase();
    if (!FIELD_TYPES.has(fieldType) || typeof value.required !== 'boolean') throw new Error('field definition is invalid');
    return Object.freeze({ type, label: text(value.label, 'field label', 120), fieldType, required: value.required });
  }
  if (type === 'button') {
    if (value.action !== 'save_draft') throw new Error('button action is unsupported');
    return Object.freeze({ type, label: text(value.label, 'button label', 120), action: 'save_draft' });
  }
  if (type === 'table') {
    if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 12) throw new Error('table columns are invalid');
    return Object.freeze({ type, label: text(value.label, 'table label', 120), columns: Object.freeze(value.columns.map((column) => text(column, 'table column', 80))) });
  }
  return Object.freeze({ type, text: text(value.text, 'component text', 500) });
}

export function normalizeAppBuildRequest(input = {}) {
  if ([...AUTHORITY_KEYS].some((key) => Object.hasOwn(input, key))) throw new Error('app build request cannot select tenant, Organization, Plant, or facility authority');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('app build request contains unsupported fields');
  const intent = text(input.intent, 'app build intent', 16).toLowerCase();
  const route = text(input.route, 'app route', 200).toLowerCase();
  if (!INTENTS.has(intent) || !ROUTE.test(route)) throw new Error('app build intent or route is unsupported');
  if (!Array.isArray(input.components) || input.components.length < 1 || input.components.length > 32) throw new Error('app components are invalid');
  const idempotencyKey = text(input.idempotencyKey ?? input.idempotency_key, 'app build idempotency key', 200);
  if (!IDEMPOTENCY.test(idempotencyKey)) throw new Error('app build idempotency key is invalid');
  return Object.freeze({ intent, title: text(input.title, 'app title', 240), department: text(input.department, 'app department', 160), route, description: text(input.description, 'app description', 1200), components: Object.freeze(input.components.map(component)), idempotencyKey });
}

export function buildAppBuildRequestReceipt({ request, receiptId, replayed = false } = {}) {
  const normalized = normalizeAppBuildRequest(request);
  return Object.freeze({ format: CORA_APP_BUILD_REQUEST_FORMAT, valid: true, status: 'draft-recorded', intent: normalized.intent, title: normalized.title, department: normalized.department, route: normalized.route, description: normalized.description, components: normalized.components, receiptId: text(receiptId, 'app build receipt', 256), replayed: replayed === true, execution: 'not_performed', providerInvocation: 'not_performed', agentInvocation: 'not_performed', filesystemMutation: 'not_performed', publication: 'not_performed' });
}

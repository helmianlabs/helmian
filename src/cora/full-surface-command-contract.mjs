import { createHash } from 'node:crypto';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';

// This is a consumer contract for Cora's future operator surface. It is not a
// router, an authorization service, a provider adapter, or an executor.
export const CORA_FULL_SURFACE_SCHEMA_VERSION = 1;
export const CORA_FULL_SURFACE_FORMAT = 'cora.full-surface-command.v1';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SENSITIVE_KEY = /(secret|token|credential|password|private.?key|api.?key|ssn|bank|routing|account.?number|payload|content|target|endpoint|path)/i;
const SURFACE_OPERATIONS = Object.freeze(['open', 'read', 'select', 'control', 'prepare', 'simulate']);
const ROLE_IDS = Object.freeze(['owner', 'admin', 'member', 'auditor']);
const READ_ROLES = Object.freeze(['owner', 'admin', 'member', 'auditor']);
const PREPARE_ROLES = Object.freeze(['owner', 'admin']);

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function entry(surfaceId, label, pageId, options = {}) {
  return Object.freeze({
    surface_id: surfaceId,
    label,
    page_id: pageId,
    category: options.category ?? 'operations',
    availability: options.availability ?? 'sample-ready',
    aliases: Object.freeze(options.aliases ?? []),
    operations: Object.freeze(options.operations ?? SURFACE_OPERATIONS),
    read_roles: READ_ROLES,
    prepare_roles: Object.freeze(options.prepareRoles ?? []),
    confirmation_required: options.confirmationRequired === true,
    approval_required: options.approvalRequired === true,
  });
}

// Stable IDs are consumer IDs, not URLs or browser instructions. New tenant
// surfaces can be appended here without changing the existing four-intent
// planner or Helmian orchestration provider contracts.
export const CORA_TENANT_SURFACE_REGISTRY = freeze({
  dashboard: entry('dashboard', 'Operations dashboard', 'desk', {
    category: 'overview', aliases: ['desk'],
  }),
  activity: entry('activity', 'Activity', 'activity', {
    category: 'overview', aliases: ['audit-activity'],
  }),
  'dispatch-board': entry('dispatch-board', 'Dispatch board', 'dispatch', {
    aliases: ['dispatch'],
  }),
  fleet: entry('fleet', 'Fleet', 'fleet', { aliases: ['trucks'] }),
  'truck-detail': entry('truck-detail', 'Truck detail', 'truck-detail', {
    aliases: ['vehicle-detail', 'vehicle-status'],
  }),
  loads: entry('loads', 'Loads and load search', 'board', {
    aliases: ['load-board', 'loadboard'],
  }),
  'load-detail': entry('load-detail', 'Load detail', 'load-detail', {
    aliases: ['load'],
  }),
  driver: entry('driver', 'Driver workspace', 'driver', {
    aliases: ['drivers'],
  }),
  'pre-trip': entry('pre-trip', 'Driver pre-trip', 'pre-trip', {
    aliases: ['pretrip', 'inspection'],
  }),
  payroll: entry('payroll', 'Payroll work', 'payroll', {
    aliases: ['payroll-work'],
    prepareRoles: PREPARE_ROLES,
    confirmationRequired: true,
    approvalRequired: true,
  }),
  documents: entry('documents', 'Documents', 'docs', {
    aliases: ['docs'],
  }),
  money: entry('money', 'Money', 'money', {
    aliases: ['finance'],
  }),
  settlements: entry('settlements', 'Settlements', 'settlements', {
    availability: 'sample-unavailable',
    aliases: ['settlement'],
    prepareRoles: PREPARE_ROLES,
    confirmationRequired: true,
    approvalRequired: true,
  }),
  integrations: entry('integrations', 'Integrations and status', 'connect', {
    aliases: ['connectors', 'connections'],
  }),
  settings: entry('settings', 'Settings', 'settings', {
    category: 'configuration',
  }),
  help: entry('help', 'Help', 'help', {
    category: 'support',
  }),
  notifications: entry('notifications', 'Notifications', 'notifications', {
    availability: 'sample-unavailable',
    category: 'activity',
  }),
  approvals: entry('approvals', 'Approval handoffs', 'approvals', {
    category: 'governance',
    prepareRoles: PREPARE_ROLES,
    confirmationRequired: true,
    approvalRequired: true,
  }),
});

export const CORA_TENANT_SURFACE_IDS = Object.freeze(Object.keys(CORA_TENANT_SURFACE_REGISTRY));
export const CORA_TENANT_SURFACE_OPERATION_IDS = SURFACE_OPERATIONS;

// The fixtures intentionally contain only safe counts and stable sample IDs.
// They are keyed by tenant so a preview cannot fall through to another tenant.
const SAMPLE_TENANT_FIXTURES = freeze({
  'acme-operations': {
    dashboard: { sample_count: 4, sample_ids: ['card-101', 'card-102'] },
    activity: { sample_count: 3, sample_ids: ['activity-101', 'activity-102'] },
    'dispatch-board': { sample_count: 2, sample_ids: ['dispatch-101', 'dispatch-102'] },
    fleet: { sample_count: 2, sample_ids: ['truck-101', 'truck-102'] },
    'truck-detail': { sample_count: 2, sample_ids: ['truck-101', 'truck-102'] },
    loads: { sample_count: 2, sample_ids: ['load-301', 'load-302'] },
    'load-detail': { sample_count: 2, sample_ids: ['load-301', 'load-302'] },
    driver: { sample_count: 2, sample_ids: ['driver-001', 'driver-002'] },
    'pre-trip': { sample_count: 2, sample_ids: ['inspection-101', 'inspection-102'] },
    payroll: { sample_count: 2, sample_ids: ['work-101', 'work-102'] },
    documents: { sample_count: 2, sample_ids: ['document-101', 'document-102'] },
    money: { sample_count: 2, sample_ids: ['money-101', 'money-102'] },
    integrations: { sample_count: 2, sample_ids: ['integration-101', 'integration-102'] },
    settings: { sample_count: 3, sample_ids: ['setting-101', 'setting-102'] },
    help: { sample_count: 3, sample_ids: ['help-101', 'help-102'] },
  },
  'northstar-logistics': {
    dashboard: { sample_count: 3, sample_ids: ['card-201', 'card-202'] },
    activity: { sample_count: 2, sample_ids: ['activity-201', 'activity-202'] },
    'dispatch-board': { sample_count: 1, sample_ids: ['dispatch-201'] },
    fleet: { sample_count: 1, sample_ids: ['truck-201'] },
    'truck-detail': { sample_count: 1, sample_ids: ['truck-201'] },
    loads: { sample_count: 1, sample_ids: ['load-401'] },
    'load-detail': { sample_count: 1, sample_ids: ['load-401'] },
    driver: { sample_count: 1, sample_ids: ['driver-201'] },
    'pre-trip': { sample_count: 1, sample_ids: ['inspection-201'] },
    payroll: { sample_count: 1, sample_ids: ['work-201'] },
    documents: { sample_count: 1, sample_ids: ['document-201'] },
    money: { sample_count: 1, sample_ids: ['money-201'] },
    integrations: { sample_count: 1, sample_ids: ['integration-201'] },
    settings: { sample_count: 2, sample_ids: ['setting-201'] },
    help: { sample_count: 2, sample_ids: ['help-201'] },
  },
});

const FIXED_STATUS = Object.freeze({
  schemaVersion: CORA_FULL_SURFACE_SCHEMA_VERSION,
  format: CORA_FULL_SURFACE_FORMAT,
  mode: 'sample-data-only',
  enabled: false,
  wired: false,
  execution: 'not-wired',
  mutation: 'not-performed',
  submission: 'not-performed',
  notification: 'not-performed',
  authorization: 'not_evaluated',
  invocation: 'not_performed',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Reflect.ownKeys(value).filter((key) => typeof key === 'string').sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function knownKeys(value, expected) {
  return isObject(value) && Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && expected.includes(key),
  );
}

function safeTree(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 4 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.length <= 16 && value.every((child) => safeTree(child, seen, depth + 1));
  }
  return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string'
      && SAFE_KEY.test(key)
      && !SENSITIVE_KEY.test(key)
      && safeTree(value[key], seen, depth + 1)
  ));
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function normalizeSurface(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (CORA_TENANT_SURFACE_REGISTRY[normalized]) return normalized;
  return CORA_TENANT_SURFACE_IDS.find((surfaceId) => (
    CORA_TENANT_SURFACE_REGISTRY[surfaceId].aliases.includes(normalized)
  )) ?? null;
}

function normalizedScope(input) {
  try {
    if (!Array.isArray(input.authorized_tenant_ids)
        || input.authorized_tenant_ids.length !== 1) return null;
    const tenantId = normalizeTenantId(input.tenant_id);
    const authorizedTenantId = normalizeTenantId(input.authorized_tenant_ids[0]);
    if (tenantId !== authorizedTenantId) return null;
    const actorRole = normalizeActorRole(input.actor_role);
    if (!ROLE_IDS.includes(actorRole)) return null;
    return Object.freeze({ tenant_id: tenantId, actor_role: actorRole });
  } catch {
    return null;
  }
}

function auditId(scope, surfaceId, operation, request) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ tenant_id: scope.tenant_id, surface_id: surfaceId, operation, request }))
    .digest('hex')
    .slice(0, 24);
  return `surface-${operation}-${digest}`;
}

function failure(code, status = 'clarification-required') {
  return freeze({
    ...FIXED_STATUS,
    valid: false,
    status,
    code,
    request: null,
    response: null,
    gates: { confirmation_required: false, approval_required: false, decision: 'not_evaluated' },
    audit_refs: [],
  });
}

function validateRequest(request) {
  if (!isObject(request) || !safeTree(request) || !knownKeys(request, ['filter', 'limit', 'period', 'record_id'])) {
    return null;
  }
  const normalized = {};
  if (request.filter !== undefined) {
    if (!['active', 'available', 'open', 'pending', 'today', 'all'].includes(request.filter)) return null;
    normalized.filter = request.filter;
  }
  if (request.limit !== undefined) {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 25) return null;
    normalized.limit = request.limit;
  }
  if (request.period !== undefined) {
    if (!['current-week', 'previous-week'].includes(request.period)) return null;
    normalized.period = request.period;
  }
  if (request.record_id !== undefined) {
    if (!safeId(request.record_id)) return null;
    normalized.record_id = request.record_id;
  }
  return Object.freeze(normalized);
}

function surfaceView(entryValue, fixture) {
  return Object.freeze({
    surface_id: entryValue.surface_id,
    page_id: entryValue.page_id,
    label: entryValue.label,
    category: entryValue.category,
    availability: entryValue.availability,
    supported_operations: entryValue.operations,
    confirmation_required: entryValue.confirmation_required,
    approval_required: entryValue.approval_required,
    sample: entryValue.availability === 'sample-ready'
      ? Object.freeze({
        source: 'tenant-sample-fixture',
        sample_count: fixture?.sample_count ?? 0,
        sample_ids: Object.freeze([...(fixture?.sample_ids ?? [])]),
      })
      : Object.freeze({ source: 'tenant-sample-fixture', status: 'not-available' }),
  });
}

function listEnvelope(scope, fixture) {
  return freeze({
    ...FIXED_STATUS,
    valid: true,
    status: 'registry-ready',
    scope,
    surfaces: CORA_TENANT_SURFACE_IDS.map((surfaceId) => surfaceView(
      CORA_TENANT_SURFACE_REGISTRY[surfaceId], fixture[surfaceId],
    )),
    audit_refs: [],
  });
}

/**
 * Return the complete known tenant-surface posture for one asserted active
 * tenant scope. The authorization assertion is supplied by the caller; this
 * pure contract never grants membership or lists another tenant's data.
 */
export function listCoraTenantSurfaces(input) {
  if (!isObject(input)
      || !exactKeys(input, ['actor_role', 'authorized_tenant_ids', 'mode', 'tenant_id'])
      || input.mode !== 'sample'
      || !safeTree(input)) {
    return failure('CORA_SURFACE_REGISTRY_REQUEST_INVALID');
  }
  const scope = normalizedScope(input);
  if (!scope) return failure('CORA_SURFACE_TENANT_SCOPE_INVALID', 'rejected');
  const fixture = SAMPLE_TENANT_FIXTURES[scope.tenant_id];
  if (!fixture) return failure('CORA_SURFACE_TENANT_UNAVAILABLE', 'rejected');
  return listEnvelope(scope, fixture);
}

/**
 * Create one deterministic, sample-data-only preview. It can open/read/select
 * or prepare/simulate a known surface, but it cannot execute, mutate, submit,
 * notify, approve, authorize, contact a provider, or receive raw content.
 */
export function previewCoraTenantSurface(input) {
  const topLevel = ['actor_role', 'authorized_tenant_ids', 'mode', 'operation', 'request', 'surface', 'tenant_id'];
  if (!isObject(input) || !exactKeys(input, topLevel) || input.mode !== 'sample' || !safeTree(input)) {
    return failure('CORA_SURFACE_REQUEST_INVALID');
  }
  const scope = normalizedScope(input);
  if (!scope) return failure('CORA_SURFACE_TENANT_SCOPE_INVALID', 'rejected');

  const surfaceId = normalizeSurface(input.surface);
  if (!surfaceId) return failure('CORA_SURFACE_UNKNOWN', 'clarification-required');
  const surface = CORA_TENANT_SURFACE_REGISTRY[surfaceId];
  if (!SURFACE_OPERATIONS.includes(input.operation) || !surface.operations.includes(input.operation)) {
    return failure('CORA_SURFACE_OPERATION_UNSUPPORTED', 'clarification-required');
  }
  const fixture = SAMPLE_TENANT_FIXTURES[scope.tenant_id];
  if (!fixture) return failure('CORA_SURFACE_TENANT_UNAVAILABLE', 'rejected');
  if (!surface.read_roles.includes(scope.actor_role)
      || (input.operation === 'prepare' && !surface.prepare_roles.includes(scope.actor_role))) {
    return failure('CORA_SURFACE_ROLE_NOT_ALLOWED', 'rejected');
  }
  const request = validateRequest(input.request);
  if (!request) return failure('CORA_SURFACE_REQUEST_INVALID');
  if (input.operation === 'prepare' && !request.period) {
    return failure('CORA_SURFACE_PREPARE_PERIOD_REQUIRED');
  }
  if (request.record_id !== undefined && !fixture[surfaceId]?.sample_ids.includes(request.record_id)) {
    return failure('CORA_SURFACE_SAMPLE_RECORD_NOT_FOUND', 'rejected');
  }
  if (surface.availability !== 'sample-ready') {
    return failure('CORA_SURFACE_SAMPLE_UNAVAILABLE', 'rejected');
  }

  const gatedOperation = ['control', 'prepare', 'simulate'].includes(input.operation);
  const gates = {
    confirmation_required: surface.confirmation_required && gatedOperation,
    approval_required: surface.approval_required && gatedOperation,
    decision: surface.approval_required && gatedOperation ? 'pending' : 'not_required',
  };
  const view = surfaceView(surface, fixture[surfaceId]);
  const response = Object.freeze({
    status: 'preview-ready',
    valid: true,
    format: 'cora.surface-preview.v1',
    result: Object.freeze({
      surface: view,
      operation: input.operation,
      request,
      simulation: ['control', 'simulate'].includes(input.operation) ? 'preview-only' : 'not-performed',
    }),
  });
  return freeze({
    ...FIXED_STATUS,
    valid: true,
    status: 'preview-ready',
    scope,
    request: Object.freeze({
      tenant_id: scope.tenant_id,
      actor_role: scope.actor_role,
      surface_id: surfaceId,
      page_id: surface.page_id,
      operation: input.operation,
    }),
    response,
    gates,
    audit_refs: Object.freeze([auditId(scope, surfaceId, input.operation, request)]),
  });
}

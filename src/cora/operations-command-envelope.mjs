import {
  preparePayrollWork,
  readFleetStatus,
  searchLoadBoard,
} from '../core/local-orchestration.mjs';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';
import {
  CORA_DEMO_INTENT_CATALOG,
  CORA_DEMO_INTENT_IDS,
  planCoraDemoCommand,
} from './demo-command-planner.mjs';
import { getCoraHelmionIntentCompatibility } from './action-intent-compat.mjs';

// Pure Cora consumer boundary. It creates a bounded request/response envelope;
// it does not authorize, invoke, navigate, or contact a provider.
export const CORA_OPERATIONS_ENVELOPE_SCHEMA_VERSION = 1;
export const CORA_OPERATIONS_ENVELOPE_FORMAT = 'cora.operations-command-envelope.v1';

export const CORA_HELMIAN_PAGE_IDS = Object.freeze(['dashboard', 'activity']);
export const CORA_AIMFORGE_PAGE_IDS = Object.freeze([
  'desk', 'board', 'dispatch', 'fleet', 'money', 'docs', 'connect', 'settings',
]);

// The accepted planner names are translated to the stable consumer IDs. The
// stable IDs are intentionally not routes or browser-control instructions.
export const CORA_OPERATIONS_PAGE_CATALOG = Object.freeze({
  helmian: Object.freeze({
    dashboard: Object.freeze({ pageId: 'dashboard', label: 'Helmian dashboard' }),
    activity: Object.freeze({ pageId: 'activity', label: 'Helmian activity' }),
  }),
  'aim-forge': Object.freeze({
    dashboard: Object.freeze({ pageId: 'desk', label: 'Aim Forge desk' }),
    desk: Object.freeze({ pageId: 'desk', label: 'Aim Forge desk' }),
    'load-board': Object.freeze({ pageId: 'board', label: 'Aim Forge board' }),
    board: Object.freeze({ pageId: 'board', label: 'Aim Forge board' }),
    dispatch: Object.freeze({ pageId: 'dispatch', label: 'Aim Forge dispatch' }),
    fleet: Object.freeze({ pageId: 'fleet', label: 'Aim Forge fleet' }),
    payroll: Object.freeze({ pageId: 'money', label: 'Aim Forge money' }),
    money: Object.freeze({ pageId: 'money', label: 'Aim Forge money' }),
    docs: Object.freeze({ pageId: 'docs', label: 'Aim Forge docs' }),
    connect: Object.freeze({ pageId: 'connect', label: 'Aim Forge connect' }),
    settings: Object.freeze({ pageId: 'settings', label: 'Aim Forge settings' }),
  }),
});

const REQUEST_KEYS = Object.freeze({
  'switch-dashboard': Object.freeze(['page', 'surface']),
  'locate-trucks': Object.freeze(['limit', 'truck_id']),
  'search-loads': Object.freeze(['criteria', 'limit']),
  'prepare-payroll-work': Object.freeze(['period_end', 'period_start', 'workers']),
});
const TOP_LEVEL_KEYS = Object.freeze(['actor_role', 'intent', 'request', 'tenant_id']);
const FORBIDDEN_KEY_PATTERN = /(secret|token|credential|password|private.?key|api.?key|ssn|bank|routing|account.?number)/i;
const FIXED_STATUS = Object.freeze({
  schemaVersion: CORA_OPERATIONS_ENVELOPE_SCHEMA_VERSION,
  format: CORA_OPERATIONS_ENVELOPE_FORMAT,
  mode: 'local-mock-only',
  enabled: false,
  wired: false,
  execution: 'not-wired',
  authorization: 'not_evaluated',
  invocation: 'not_performed',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  const actual = keys.sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function knownKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function safeKeys(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 8 || seen.has(value)) return false;
  seen.add(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
  return Object.entries(value).every(([key, child]) => (
    !FORBIDDEN_KEY_PATTERN.test(key) && safeKeys(child, seen, depth + 1)
  ));
}

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function failClosed(kind, code, prompt = 'That request does not match a supported tenant-scoped operations shape.') {
  return freeze({
    ...FIXED_STATUS,
    kind,
    status: kind === 'clarification-required' ? 'clarification-required' : 'rejected',
    code,
    prompt,
    knownIntents: CORA_DEMO_INTENT_IDS,
    request: null,
    response: null,
    gates: { confirmation_required: false, approval_required: false, decision: 'not_evaluated' },
    audit_refs: [],
  });
}

function scopeOf(input) {
  try {
    return Object.freeze({
      tenant_id: normalizeTenantId(input.tenant_id),
      actor_role: normalizeActorRole(input.actor_role),
    });
  } catch {
    return null;
  }
}

function serviceResponse(result, expectedFormat) {
  if (result?.valid === true && result.result?.format === expectedFormat) {
    return Object.freeze({
      status: 'preview-ready',
      valid: true,
      format: result.result.format,
      result: result.result,
    });
  }
  return Object.freeze({
    status: 'rejected',
    valid: false,
    code: result?.code ?? 'CORA_OPERATIONS_SERVICE_REJECTED',
    result: null,
  });
}

function auditRefs(response) {
  const result = response?.result;
  if (!result) return [];
  if (result.format === 'helmion.fleet-status-read.v1') return result.trucks.map((row) => row.audit_id);
  if (result.format === 'helmion.load-board-search.v1') return result.loads.map((row) => row.audit_id);
  if (result.format === 'helmion.payroll-work-plan.v1') {
    return [result.plan_id, ...result.items.map((row) => row.audit_id)];
  }
  return [];
}

function buildEnvelope(scope, intent, data, compatibility, response, gates, refs = []) {
  return freeze({
    ...FIXED_STATUS,
    kind: 'command-envelope',
    status: response.status,
    request: {
      tenant_id: scope.tenant_id,
      actor_role: scope.actor_role,
      intent,
      cora_action: compatibility.coraAction,
      helmion_intent: compatibility.helmionIntent,
      data,
    },
    response,
    gates,
    audit_refs: refs,
  });
}

function pageEnvelope(scope, request, compatibility) {
  if (!exactKeys(request, REQUEST_KEYS['switch-dashboard'])) {
    return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  }
  const page = CORA_OPERATIONS_PAGE_CATALOG[request.surface]?.[request.page];
  if (!page) return failClosed('clarification-required', 'CORA_OPERATIONS_PAGE_INVALID');
  return buildEnvelope(
    scope,
    'switch-dashboard',
    { surface: request.surface, page_id: page.pageId, label: page.label },
    compatibility,
    {
      status: 'preview-ready',
      valid: true,
      format: 'cora.navigation-plan-response.v1',
      result: { surface: request.surface, page_id: page.pageId, label: page.label, navigation: 'not_performed' },
    },
    { confirmation_required: false, approval_required: false, decision: 'not_required' },
  );
}

function fleetEnvelope(scope, request, compatibility) {
  if (!knownKeys(request, REQUEST_KEYS['locate-trucks'])) {
    return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  }
  const result = readFleetStatus({
    ...scope,
    provider_id: 'fleet-eld-mock',
    ...(request.truck_id === undefined ? {} : { truck_id: request.truck_id }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  });
  const response = serviceResponse(result, 'helmion.fleet-status-read.v1');
  return buildEnvelope(scope, 'locate-trucks', { ...request }, compatibility, response,
    { confirmation_required: false, approval_required: false, decision: 'not_required' }, auditRefs(response));
}

function loadEnvelope(scope, request, compatibility) {
  if (!knownKeys(request, REQUEST_KEYS['search-loads']) || !isObject(request.criteria)) {
    return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  }
  const result = searchLoadBoard({
    ...scope,
    provider_id: 'load-board-mock',
    criteria: request.criteria,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  });
  const response = serviceResponse(result, 'helmion.load-board-search.v1');
  const data = response.valid
    ? { criteria: response.result.criteria, ...(request.limit === undefined ? {} : { limit: request.limit }) }
    : {};
  return buildEnvelope(scope, 'search-loads', data, compatibility, response,
    { confirmation_required: false, approval_required: false, decision: 'not_required' }, auditRefs(response));
}

function payrollEnvelope(scope, request, compatibility) {
  if (!exactKeys(request, REQUEST_KEYS['prepare-payroll-work'])) {
    return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  }
  const result = preparePayrollWork({ ...scope, provider_id: 'payroll-mock', ...request });
  const response = serviceResponse(result, 'helmion.payroll-work-plan.v1');
  const approval = response.valid
    ? planCoraDemoCommand({ intent: 'prepare-payroll-work', period: 'current-week', group: 'drivers' }).approval
    : null;
  const data = response.valid
    ? {
      period_start: response.result.period_start,
      period_end: response.result.period_end,
      workers: response.result.items.map((item) => ({
        worker_id: item.worker_id,
        regular_hours: item.regular_hours,
        overtime_hours: item.overtime_hours,
      })),
    }
    : {};
  const gates = response.valid
    ? {
      confirmation_required: response.result.confirmation_required,
      approval_required: response.result.approval_required,
      decision: response.result.decision,
      approval_projection: approval,
    }
    : { confirmation_required: true, approval_required: true, decision: 'not_evaluated' };
  return buildEnvelope(scope, 'prepare-payroll-work', data, compatibility, response, gates, auditRefs(response));
}

/** Return one frozen, tenant/role-scoped, preview-only operations envelope. */
export function createCoraOperationsEnvelope(input) {
  if (!isObject(input) || !exactKeys(input, TOP_LEVEL_KEYS) || !safeKeys(input)) {
    return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  }
  if (typeof input.intent !== 'string' || !CORA_DEMO_INTENT_IDS.includes(input.intent)) {
    return failClosed('clarification-required', 'UNKNOWN_INTENT',
      'Choose switch dashboard, locate trucks, search loads, or prepare payroll work.');
  }
  const scope = scopeOf(input);
  if (!scope) return failClosed('rejected', 'CORA_OPERATIONS_SCOPE_INVALID');
  if (!isObject(input.request)) return failClosed('clarification-required', 'CORA_OPERATIONS_REQUEST_INVALID');
  const compatibility = getCoraHelmionIntentCompatibility(CORA_DEMO_INTENT_CATALOG[input.intent].coraAction);
  if (!compatibility) return failClosed('clarification-required', 'CORA_OPERATIONS_INTENT_UNMAPPED');
  switch (input.intent) {
    case 'switch-dashboard': return pageEnvelope(scope, input.request, compatibility);
    case 'locate-trucks': return fleetEnvelope(scope, input.request, compatibility);
    case 'search-loads': return loadEnvelope(scope, input.request, compatibility);
    case 'prepare-payroll-work': return payrollEnvelope(scope, input.request, compatibility);
    default: return failClosed('clarification-required', 'UNKNOWN_INTENT');
  }
}

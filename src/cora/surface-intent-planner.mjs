import { previewCoraTenantSurface } from './full-surface-command-contract.mjs';

// Typed intent seam for a future voice/UI parser. This module accepts only
// already-classified bounded intents; it does not perform natural-language
// interpretation, authorization, navigation, provider access, or execution.
export const CORA_SURFACE_INTENT_SCHEMA_VERSION = 1;
export const CORA_SURFACE_INTENT_FORMAT = 'cora.surface-intent-plan.v1';

export const CORA_SURFACE_INTENT_IDS = Object.freeze([
  'open-surface',
  'read-surface',
  'select-surface',
  'control-surface',
  'prepare-surface',
  'simulate-surface',
]);

const OPERATION_BY_INTENT = Object.freeze({
  'open-surface': 'open',
  'read-surface': 'read',
  'select-surface': 'select',
  'control-surface': 'control',
  'prepare-surface': 'prepare',
  'simulate-surface': 'simulate',
});

const TOP_LEVEL_KEYS = Object.freeze([
  'actor_role',
  'authorized_tenant_ids',
  'intent',
  'mode',
  'request',
  'tenant_id',
]);

const FIXED_STATUS = Object.freeze({
  schemaVersion: CORA_SURFACE_INTENT_SCHEMA_VERSION,
  format: CORA_SURFACE_INTENT_FORMAT,
  mode: 'sample-data-only',
  enabled: false,
  wired: false,
  execution: 'not-wired',
  invocation: 'not_performed',
  authorization: 'not_evaluated',
});

function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Reflect.ownKeys(value).filter((key) => typeof key === 'string').sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function fail(code, status = 'clarification-required') {
  return freeze({
    ...FIXED_STATUS,
    valid: false,
    status,
    code,
    intent: null,
    operation: null,
    request: null,
    preview: null,
  });
}

function safeInput(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 4 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.length <= 16 && value.every((child) => safeInput(child, seen, depth + 1));
  return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string'
      && /^[a-z][a-z0-9_]{0,31}$/.test(key)
      && !/(secret|token|credential|password|payload|content|target|endpoint|path)/i.test(key)
      && safeInput(value[key], seen, depth + 1)
  ));
}

/**
 * Map one known typed surface intent into the full-surface preview contract.
 * Callers must classify speech or UI input before this seam; unknown or
 * incomplete shapes never get interpreted by guessing.
 */
export function planCoraSurfaceIntent(input) {
  if (!isObject(input)
      || !exactKeys(input, TOP_LEVEL_KEYS)
      || input.mode !== 'sample'
      || !safeInput(input)) {
    return fail('CORA_SURFACE_INTENT_REQUEST_INVALID');
  }
  if (typeof input.intent !== 'string' || !CORA_SURFACE_INTENT_IDS.includes(input.intent)) {
    return fail('CORA_SURFACE_INTENT_UNKNOWN');
  }
  if (!isObject(input.request)
      || !exactKeys(input.request, ['request', 'surface'])
      || typeof input.request.surface !== 'string'
      || !isObject(input.request.request)) {
    return fail('CORA_SURFACE_INTENT_REQUEST_INVALID');
  }

  const operation = OPERATION_BY_INTENT[input.intent];
  const preview = previewCoraTenantSurface({
    tenant_id: input.tenant_id,
    authorized_tenant_ids: input.authorized_tenant_ids,
    actor_role: input.actor_role,
    mode: input.mode,
    surface: input.request?.surface,
    operation,
    request: input.request?.request ?? {},
  });
  if (preview.valid !== true) {
    return fail(preview.code ?? 'CORA_SURFACE_INTENT_PREVIEW_REJECTED', preview.status ?? 'rejected');
  }

  return freeze({
    ...FIXED_STATUS,
    valid: true,
    status: 'preview-ready',
    intent: input.intent,
    operation,
    request: preview.request,
    preview,
  });
}

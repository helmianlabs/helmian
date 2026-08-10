import { createHash } from 'node:crypto';
import { canonicalJson } from './maestro.mjs';
import { normalizeActorRole, normalizeTenantId } from './tenant-context.mjs';

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EQUIPMENT_TYPES = new Set(['dry_van', 'reefer', 'flatbed']);
const TRUCK_STATUSES = new Set(['available', 'in_transit', 'stopped', 'offline']);
const PAYROLL_ROLES = new Set(['owner', 'admin']);
const FORBIDDEN_KEY_PATTERN = /(secret|token|credential|password|private.?key|api.?key|ssn|bank|routing|account.?number)/i;

export const LOCAL_ORCHESTRATION_LIMITS = Object.freeze({
  maxProviderContracts: 3,
  maxFleetRows: 50,
  maxLoadRows: 50,
  maxPayrollWorkers: 50,
  maxTextLength: 128,
});

const CONTRACT_KEYS = Object.freeze([
  'capabilities',
  'credentials',
  'deterministic',
  'domain',
  'format',
  'mutations',
  'network',
  'provider_id',
  'transport',
  'tenant_scoped',
]);

const FLEET_INPUT_KEYS = Object.freeze([
  'actor_role',
  'limit',
  'provider_id',
  'tenant_id',
  'truck_id',
]);

const LOAD_INPUT_KEYS = Object.freeze([
  'actor_role',
  'criteria',
  'limit',
  'provider_id',
  'tenant_id',
]);

const PAYROLL_INPUT_KEYS = Object.freeze([
  'actor_role',
  'period_end',
  'period_start',
  'provider_id',
  'tenant_id',
  'workers',
]);

const REQUEST_INPUT_KEYS = Object.freeze([
  'actor_role',
  'operation',
  'parameters',
  'policy_version',
  'provider_id',
  'request_id',
  'tenant_id',
]);

const REQUEST_ENVELOPE_KEYS = Object.freeze([
  'actor_role',
  'approval_required',
  'audit_id',
  'authorization',
  'confirmation_required',
  'decision',
  'format',
  'invocation',
  'intent',
  'mutation',
  'operation',
  'parameter_summary',
  'policy_version',
  'provider_id',
  'request_digest',
  'request_id',
  'tenant_id',
]);

const ORCHESTRATION_OPERATIONS = Object.freeze({
  FLEET_STATUS_READ: 'fleet_status_read',
  LOAD_BOARD_SEARCH: 'load_board_search',
  PAYROLL_WORK_PREPARE: 'payroll_work_prepare',
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code) {
  return Object.freeze({ valid: false, code });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, field, maxLength = LOCAL_ORCHESTRATION_LIMITS.maxTextLength) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function safeId(value, field) {
  const normalized = safeText(value, field);
  if (!SAFE_ID_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function safeDate(value, field) {
  const normalized = safeText(value, field, 10);
  if (!DATE_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid`);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function safeLimit(value, max, defaultValue = max) {
  const normalized = Number(value ?? defaultValue);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > max) {
    throw new TypeError('limit is invalid');
  }
  return normalized;
}

function safeHours(value, field, max) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > max) {
    throw new TypeError(`${field} is invalid`);
  }
  return Math.round(normalized * 100) / 100;
}

function rejectForbiddenKeys(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return;
  if (depth > 8 || seen.has(value)) throw new TypeError('input is invalid');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) throw new TypeError('input is invalid');
    rejectForbiddenKeys(child, seen, depth + 1);
  }
}

function requireExactKeys(value, allowed) {
  if (!isPlainObject(value)) throw new TypeError('input is invalid');
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError('input is invalid');
  }
}

function hasExactKeys(value, allowed) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeScope(input) {
  if (!isPlainObject(input)) throw new TypeError('scope is invalid');
  return Object.freeze({
    tenant_id: normalizeTenantId(input.tenant_id ?? input.tenantId),
    actor_role: normalizeActorRole(input.actor_role ?? input.actorRole),
  });
}

function stableDigest(kind, value) {
  return createHash('sha256')
    .update(canonicalJson({ kind, value }))
    .digest('hex');
}

function auditId(kind, tenantId, value) {
  return `${kind}-${stableDigest(kind, { tenant_id: tenantId, ...value }).slice(0, 24)}`;
}

function normalizeProviderId(value, expected) {
  const providerId = safeText(value ?? expected, 'provider_id', 64).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(providerId) || providerId !== expected) {
    throw new TypeError('provider_id is invalid');
  }
  return providerId;
}

function contractSummary(contract) {
  return Object.freeze({
    format: contract.format,
    provider_id: contract.provider_id,
    domain: contract.domain,
    deterministic: contract.deterministic,
    tenant_scoped: contract.tenant_scoped,
    transport: contract.transport,
    network: contract.network,
    credentials: contract.credentials,
    mutations: contract.mutations,
    capabilities: Object.freeze({ ...contract.capabilities }),
    authorization: 'not_evaluated',
    invocation: 'not_performed',
  });
}

function validateContract(contract) {
  if (!isPlainObject(contract)) throw new TypeError('provider contract is invalid');
  requireExactKeys(contract, CONTRACT_KEYS);
  if (contract.format !== 'helmion.mock-provider-contract.v1') {
    throw new TypeError('provider contract format is invalid');
  }
  if (typeof contract.provider_id !== 'string' || !PROVIDER_ID_PATTERN.test(contract.provider_id)) {
    throw new TypeError('provider_id is invalid');
  }
  if (!['fleet_eld', 'load_board', 'payroll'].includes(contract.domain)) {
    throw new TypeError('provider domain is invalid');
  }
  if (contract.deterministic !== true || contract.tenant_scoped !== true
      || contract.transport !== 'none' || contract.network !== 'disabled'
      || contract.credentials !== 'none' || contract.mutations !== 'disabled') {
    throw new TypeError('mock provider safety contract is invalid');
  }
  if (!isPlainObject(contract.capabilities)
      || contract.capabilities.read !== true
      || contract.capabilities.plan !== true
      || contract.capabilities.write !== false) {
    throw new TypeError('provider capabilities are invalid');
  }
}

export function defineMockProviderContract(input) {
  try {
    const candidate = structuredClone(input);
    validateContract(candidate);
    return deepFreeze(candidate);
  } catch {
    throw new TypeError('mock provider contract is invalid');
  }
}

export function createMockProviderRegistry(contracts) {
  if (!Array.isArray(contracts) || contracts.length < 1
      || contracts.length > LOCAL_ORCHESTRATION_LIMITS.maxProviderContracts) {
    throw new TypeError('mock provider contracts are invalid');
  }
  const byId = new Map();
  for (const candidate of contracts) {
    const contract = defineMockProviderContract(candidate);
    if (byId.has(contract.provider_id)) throw new TypeError('duplicate provider_id');
    byId.set(contract.provider_id, contract);
  }
  return Object.freeze({
    list() {
      return Object.freeze([...byId.values()]);
    },
    get(providerId) {
      return byId.get(providerId) ?? null;
    },
  });
}

const CONTRACTS = Object.freeze([
  {
    format: 'helmion.mock-provider-contract.v1',
    provider_id: 'fleet-eld-mock',
    domain: 'fleet_eld',
    deterministic: true,
    tenant_scoped: true,
    transport: 'none',
    network: 'disabled',
    credentials: 'none',
    mutations: 'disabled',
    capabilities: { read: true, plan: true, write: false },
  },
  {
    format: 'helmion.mock-provider-contract.v1',
    provider_id: 'load-board-mock',
    domain: 'load_board',
    deterministic: true,
    tenant_scoped: true,
    transport: 'none',
    network: 'disabled',
    credentials: 'none',
    mutations: 'disabled',
    capabilities: { read: true, plan: true, write: false },
  },
  {
    format: 'helmion.mock-provider-contract.v1',
    provider_id: 'payroll-mock',
    domain: 'payroll',
    deterministic: true,
    tenant_scoped: true,
    transport: 'none',
    network: 'disabled',
    credentials: 'none',
    mutations: 'disabled',
    capabilities: { read: true, plan: true, write: false },
  },
]);

export const localMockProviderRegistry = createMockProviderRegistry(CONTRACTS);

export const INTEGRATION_READINESS_STATES = Object.freeze({
  MOCK_ONLY: 'mock_only',
  AWAITING_USER_CONNECTION: 'awaiting_user_connection',
  DISABLED: 'disabled',
});

const READINESS_DESCRIPTOR_KEYS = Object.freeze([
  'activation',
  'approval_required',
  'capabilities',
  'connection',
  'credential_state',
  'deterministic',
  'execution',
  'format',
  'integration_id',
  'mutations',
  'provider_id',
  'readiness',
  'role_policy',
  'surface',
  'tenant_scoped',
  'transport',
]);

const READINESS_SURFACES = new Set(['fleet_eld', 'load_board', 'payroll']);
const READINESS_ROLE_POLICIES = new Set(['all_roles_read', 'owner_admin_prepare']);

function validateReadinessDescriptor(descriptor, providerRegistry) {
  if (!isPlainObject(descriptor)) throw new TypeError('readiness descriptor is invalid');
  requireExactKeys(descriptor, READINESS_DESCRIPTOR_KEYS);
  if (descriptor.format !== 'helmion.integration-readiness-descriptor.v1'
      || typeof descriptor.integration_id !== 'string'
      || !PROVIDER_ID_PATTERN.test(descriptor.integration_id)
      || typeof descriptor.provider_id !== 'string'
      || !PROVIDER_ID_PATTERN.test(descriptor.provider_id)
      || !READINESS_SURFACES.has(descriptor.surface)
      || !Object.values(INTEGRATION_READINESS_STATES).includes(descriptor.readiness)
      || descriptor.activation !== 'awaiting_user_connection'
      || descriptor.connection !== 'not_configured'
      || descriptor.credential_state !== 'not_present'
      || descriptor.transport !== 'disabled'
      || descriptor.execution !== 'disabled'
      || descriptor.mutations !== 'disabled'
      || descriptor.deterministic !== true
      || descriptor.tenant_scoped !== true
      || typeof descriptor.approval_required !== 'boolean'
      || !READINESS_ROLE_POLICIES.has(descriptor.role_policy)) {
    throw new TypeError('readiness descriptor is invalid');
  }
  const provider = providerRegistry.get(descriptor.provider_id);
  if (!provider || provider.domain !== descriptor.surface) {
    throw new TypeError('readiness provider binding is invalid');
  }
  if (!isPlainObject(descriptor.capabilities)
      || !hasExactKeys(descriptor.capabilities, ['plan', 'read', 'write'])
      || typeof descriptor.capabilities.read !== 'boolean'
      || typeof descriptor.capabilities.plan !== 'boolean'
      || descriptor.capabilities.write !== false) {
    throw new TypeError('readiness capabilities are invalid');
  }
  if (descriptor.surface === 'payroll'
      && (descriptor.approval_required !== true
        || descriptor.role_policy !== 'owner_admin_prepare')) {
    throw new TypeError('payroll readiness policy is invalid');
  }
  if (descriptor.surface !== 'payroll'
      && (descriptor.approval_required !== false
        || descriptor.role_policy !== 'all_roles_read')) {
    throw new TypeError('readiness role policy is invalid');
  }
}

export function defineIntegrationReadinessDescriptor(
  input,
  providerRegistry = localMockProviderRegistry,
) {
  try {
    const descriptor = structuredClone(input);
    validateReadinessDescriptor(descriptor, providerRegistry);
    return deepFreeze(descriptor);
  } catch {
    throw new TypeError('integration readiness descriptor is invalid');
  }
}

export function createIntegrationReadinessRegistry(
  descriptors,
  providerRegistry = localMockProviderRegistry,
) {
  if (!Array.isArray(descriptors)
      || descriptors.length < 1
      || descriptors.length > LOCAL_ORCHESTRATION_LIMITS.maxProviderContracts) {
    throw new TypeError('integration readiness descriptors are invalid');
  }
  const byId = new Map();
  for (const candidate of descriptors) {
    const descriptor = defineIntegrationReadinessDescriptor(candidate, providerRegistry);
    if (byId.has(descriptor.integration_id)) {
      throw new TypeError('duplicate integration_id');
    }
    byId.set(descriptor.integration_id, descriptor);
  }
  return Object.freeze({
    list() {
      return Object.freeze([...byId.values()].sort(
        (left, right) => left.integration_id.localeCompare(right.integration_id),
      ));
    },
    get(integrationId) {
      return byId.get(integrationId) ?? null;
    },
  });
}

const READINESS_DESCRIPTORS = Object.freeze([
  {
    format: 'helmion.integration-readiness-descriptor.v1',
    integration_id: 'fleet-eld-readiness',
    provider_id: 'fleet-eld-mock',
    surface: 'fleet_eld',
    readiness: INTEGRATION_READINESS_STATES.MOCK_ONLY,
    activation: 'awaiting_user_connection',
    connection: 'not_configured',
    credential_state: 'not_present',
    transport: 'disabled',
    execution: 'disabled',
    mutations: 'disabled',
    deterministic: true,
    tenant_scoped: true,
    role_policy: 'all_roles_read',
    approval_required: false,
    capabilities: { read: true, plan: true, write: false },
  },
  {
    format: 'helmion.integration-readiness-descriptor.v1',
    integration_id: 'load-board-readiness',
    provider_id: 'load-board-mock',
    surface: 'load_board',
    readiness: INTEGRATION_READINESS_STATES.MOCK_ONLY,
    activation: 'awaiting_user_connection',
    connection: 'not_configured',
    credential_state: 'not_present',
    transport: 'disabled',
    execution: 'disabled',
    mutations: 'disabled',
    deterministic: true,
    tenant_scoped: true,
    role_policy: 'all_roles_read',
    approval_required: false,
    capabilities: { read: true, plan: true, write: false },
  },
  {
    format: 'helmion.integration-readiness-descriptor.v1',
    integration_id: 'payroll-readiness',
    provider_id: 'payroll-mock',
    surface: 'payroll',
    readiness: INTEGRATION_READINESS_STATES.MOCK_ONLY,
    activation: 'awaiting_user_connection',
    connection: 'not_configured',
    credential_state: 'not_present',
    transport: 'disabled',
    execution: 'disabled',
    mutations: 'disabled',
    deterministic: true,
    tenant_scoped: true,
    role_policy: 'owner_admin_prepare',
    approval_required: true,
    capabilities: { read: true, plan: true, write: false },
  },
]);

export const localIntegrationReadinessRegistry = createIntegrationReadinessRegistry(
  READINESS_DESCRIPTORS,
);

function readinessRoleEligible(descriptor, actorRole) {
  return descriptor.role_policy === 'all_roles_read' || PAYROLL_ROLES.has(actorRole);
}

function readinessAuditId(descriptor, tenantId, actorRole) {
  return auditId('integration-readiness', tenantId, {
    actor_role: actorRole,
    integration_id: descriptor.integration_id,
    provider_id: descriptor.provider_id,
    surface: descriptor.surface,
    readiness: descriptor.readiness,
    activation: descriptor.activation,
  });
}

function readinessSummary(descriptor, scope) {
  return Object.freeze({
    format: 'helmion.integration-readiness.v1',
    integration_id: descriptor.integration_id,
    provider_id: descriptor.provider_id,
    surface: descriptor.surface,
    readiness: descriptor.readiness,
    activation: descriptor.activation,
    connection: descriptor.connection,
    credential_state: descriptor.credential_state,
    transport: descriptor.transport,
    execution: descriptor.execution,
    mutations: descriptor.mutations,
    tenant_id: scope.tenant_id,
    actor_role: scope.actor_role,
    tenant_scoped: descriptor.tenant_scoped,
    deterministic: descriptor.deterministic,
    role_policy: descriptor.role_policy,
    role_eligible: readinessRoleEligible(descriptor, scope.actor_role),
    approval_required: descriptor.approval_required,
    capabilities: Object.freeze({ ...descriptor.capabilities }),
    audit_id: readinessAuditId(descriptor, scope.tenant_id, scope.actor_role),
    authorization: 'not_evaluated',
    invocation: 'not_performed',
  });
}

export function listLocalIntegrationReadiness(input = {}) {
  return serviceFailure('ORCHESTRATION_READINESS_INVALID', () => {
    rejectForbiddenKeys(input);
    requireExactKeys(input, ['actor_role', 'tenant_id']);
    const scope = normalizeScope(input);
    const integrations = localIntegrationReadinessRegistry
      .list()
      .map((descriptor) => readinessSummary(descriptor, scope));
    return Object.freeze({
      valid: true,
      result: Object.freeze({
        format: 'helmion.integration-readiness-list.v1',
        tenant_id: scope.tenant_id,
        actor_role: scope.actor_role,
        count: integrations.length,
        complete: true,
        integrations: Object.freeze(integrations),
        authorization: 'not_evaluated',
        invocation: 'not_performed',
      }),
    });
  });
}

export function inspectLocalIntegrationReadiness(input = {}) {
  return serviceFailure('ORCHESTRATION_READINESS_INVALID', () => {
    rejectForbiddenKeys(input);
    requireExactKeys(input, ['actor_role', 'integration_id', 'tenant_id']);
    const scope = normalizeScope(input);
    const integrationId = safeText(input.integration_id, 'integration_id', 64).toLowerCase();
    if (!PROVIDER_ID_PATTERN.test(integrationId)) throw new TypeError('integration_id is invalid');
    const descriptor = localIntegrationReadinessRegistry.get(integrationId);
    if (!descriptor) return fail('ORCHESTRATION_READINESS_NOT_FOUND');
    return Object.freeze({
      valid: true,
      readiness: readinessSummary(descriptor, scope),
    });
  });
}

const MOCK_FIXTURES = deepFreeze({
  fleet_eld: {
    'acme-operations': [
      {
        truck_id: 'truck-101',
        status: 'in_transit',
        city: 'Dallas',
        state: 'TX',
        observed_at: '2026-08-08T15:30:00.000Z',
      },
      {
        truck_id: 'truck-102',
        status: 'available',
        city: 'Tulsa',
        state: 'OK',
        observed_at: '2026-08-08T15:32:00.000Z',
      },
    ],
    'northstar-logistics': [
      {
        truck_id: 'truck-201',
        status: 'stopped',
        city: 'Denver',
        state: 'CO',
        observed_at: '2026-08-08T15:35:00.000Z',
      },
    ],
  },
  load_board: {
    'acme-operations': [
      {
        load_id: 'load-301',
        origin: 'Dallas, TX',
        destination: 'Tulsa, OK',
        equipment: 'dry_van',
        pickup_date: '2026-08-12',
        miles: 240,
        rate_cents: 78000,
      },
      {
        load_id: 'load-302',
        origin: 'Dallas, TX',
        destination: 'Denver, CO',
        equipment: 'reefer',
        pickup_date: '2026-08-13',
        miles: 800,
        rate_cents: 242000,
      },
    ],
    'northstar-logistics': [
      {
        load_id: 'load-401',
        origin: 'Denver, CO',
        destination: 'Omaha, NE',
        equipment: 'flatbed',
        pickup_date: '2026-08-14',
        miles: 540,
        rate_cents: 165000,
      },
    ],
  },
});

function getContract(providerId, domain) {
  const contract = localMockProviderRegistry.get(providerId);
  if (!contract || contract.domain !== domain) throw new TypeError('provider_id is invalid');
  return contract;
}

function beginService(input, allowedKeys, providerId, domain) {
  rejectForbiddenKeys(input);
  requireExactKeys(input, allowedKeys);
  const scope = normalizeScope(input);
  normalizeProviderId(input.provider_id, providerId);
  const contract = getContract(providerId, domain);
  return { scope, contract };
}

function serviceFailure(operation, callback) {
  try {
    return callback();
  } catch {
    return fail(operation);
  }
}

export function listMockProviderContracts(input = {}) {
  return serviceFailure('ORCHESTRATION_SCOPE_INVALID', () => {
    rejectForbiddenKeys(input);
    requireExactKeys(input, ['actor_role', 'tenant_id']);
    const scope = normalizeScope(input);
    const providers = localMockProviderRegistry.list().map(contractSummary);
    return Object.freeze({
      valid: true,
      result: Object.freeze({
        format: 'helmion.orchestration-provider-list.v1',
        tenant_id: scope.tenant_id,
        actor_role: scope.actor_role,
        provider_count: providers.length,
        providers: Object.freeze(providers),
        authorization: 'not_evaluated',
        invocation: 'not_performed',
      }),
    });
  });
}

export function readFleetStatus(input = {}) {
  return serviceFailure('ORCHESTRATION_FLEET_READ_INVALID', () => {
    const { scope, contract } = beginService(input, FLEET_INPUT_KEYS, 'fleet-eld-mock', 'fleet_eld');
    const truckId = input.truck_id == null ? null : safeId(input.truck_id, 'truck_id');
    const limit = safeLimit(input.limit, LOCAL_ORCHESTRATION_LIMITS.maxFleetRows);
    const source = MOCK_FIXTURES.fleet_eld[scope.tenant_id] ?? [];
    const rows = source
      .filter((row) => truckId === null || row.truck_id === truckId)
      .sort((left, right) => left.truck_id.localeCompare(right.truck_id))
      .slice(0, limit)
      .map((row) => {
        if (!TRUCK_STATUSES.has(row.status) || !ISO_TIMESTAMP_PATTERN.test(row.observed_at)) {
          throw new TypeError('fixture is invalid');
        }
        return Object.freeze({
          audit_id: auditId('fleet-read', scope.tenant_id, {
            truck_id: row.truck_id,
            observed_at: row.observed_at,
          }),
          truck_id: row.truck_id,
          status: row.status,
          location: Object.freeze({ city: row.city, state: row.state }),
          observed_at: row.observed_at,
        });
      });
    return Object.freeze({
      valid: true,
      result: Object.freeze({
        format: 'helmion.fleet-status-read.v1',
        provider_id: contract.provider_id,
        tenant_id: scope.tenant_id,
        actor_role: scope.actor_role,
        count: rows.length,
        complete: rows.length < limit || rows.length === source.length,
        trucks: Object.freeze(rows),
        authorization: 'not_evaluated',
        invocation: 'not_performed',
      }),
    });
  });
}

function normalizeLoadCriteria(criteria) {
  if (!isPlainObject(criteria)) throw new TypeError('criteria is invalid');
  requireExactKeys(criteria, ['destination', 'equipment', 'origin', 'pickup_date']);
  const result = {};
  for (const field of ['origin', 'destination']) {
    if (criteria[field] != null) result[field] = safeText(criteria[field], field).toLowerCase();
  }
  if (criteria.equipment != null) {
    const equipment = safeText(criteria.equipment, 'equipment').toLowerCase();
    if (!EQUIPMENT_TYPES.has(equipment)) throw new TypeError('equipment is invalid');
    result.equipment = equipment;
  }
  if (criteria.pickup_date != null) result.pickup_date = safeDate(criteria.pickup_date, 'pickup_date');
  if (Object.keys(result).length < 1) throw new TypeError('criteria is invalid');
  return result;
}

export function searchLoadBoard(input = {}) {
  return serviceFailure('ORCHESTRATION_LOAD_SEARCH_INVALID', () => {
    const { scope, contract } = beginService(input, LOAD_INPUT_KEYS, 'load-board-mock', 'load_board');
    const criteria = normalizeLoadCriteria(input.criteria);
    const limit = safeLimit(input.limit, LOCAL_ORCHESTRATION_LIMITS.maxLoadRows);
    const source = MOCK_FIXTURES.load_board[scope.tenant_id] ?? [];
    const matches = source
      .filter((row) => Object.entries(criteria).every(([key, value]) => {
        if (key === 'origin' || key === 'destination') return row[key].toLowerCase() === value;
        return row[key] === value;
      }))
      .sort((left, right) => left.load_id.localeCompare(right.load_id))
      .slice(0, limit)
      .map((row) => Object.freeze({
        audit_id: auditId('load-search', scope.tenant_id, {
          load_id: row.load_id,
          pickup_date: row.pickup_date,
        }),
        load_id: row.load_id,
        origin: row.origin,
        destination: row.destination,
        equipment: row.equipment,
        pickup_date: row.pickup_date,
        miles: row.miles,
        rate_cents: row.rate_cents,
      }));
    return Object.freeze({
      valid: true,
      result: Object.freeze({
        format: 'helmion.load-board-search.v1',
        provider_id: contract.provider_id,
        tenant_id: scope.tenant_id,
        actor_role: scope.actor_role,
        criteria: Object.freeze({ ...criteria }),
        count: matches.length,
        complete: matches.length < limit || matches.length === source.length,
        loads: Object.freeze(matches),
        authorization: 'not_evaluated',
        invocation: 'not_performed',
      }),
    });
  });
}

function normalizePayrollWorkers(workers) {
  if (!Array.isArray(workers) || workers.length < 1
      || workers.length > LOCAL_ORCHESTRATION_LIMITS.maxPayrollWorkers) {
    throw new TypeError('workers are invalid');
  }
  const seen = new Set();
  return workers
    .map((worker) => {
      rejectForbiddenKeys(worker);
      requireExactKeys(worker, ['overtime_hours', 'regular_hours', 'worker_id']);
      const workerId = safeId(worker.worker_id, 'worker_id');
      if (seen.has(workerId)) throw new TypeError('workers are invalid');
      seen.add(workerId);
      const regularHours = safeHours(worker.regular_hours, 'regular_hours', 168);
      const overtimeHours = safeHours(worker.overtime_hours, 'overtime_hours', 12);
      if (regularHours + overtimeHours <= 0) throw new TypeError('workers are invalid');
      return { worker_id: workerId, regular_hours: regularHours, overtime_hours: overtimeHours };
    })
    .sort((left, right) => left.worker_id.localeCompare(right.worker_id));
}

export function preparePayrollWork(input = {}) {
  return serviceFailure('ORCHESTRATION_PAYROLL_PLAN_INVALID', () => {
    const { scope, contract } = beginService(
      input,
      PAYROLL_INPUT_KEYS,
      'payroll-mock',
      'payroll',
    );
    if (!PAYROLL_ROLES.has(scope.actor_role)) return fail('ORCHESTRATION_PAYROLL_ROLE_REQUIRED');
    const periodStart = safeDate(input.period_start, 'period_start');
    const periodEnd = safeDate(input.period_end, 'period_end');
    if (periodEnd < periodStart) return fail('ORCHESTRATION_PAYROLL_PERIOD_INVALID');
    const workers = normalizePayrollWorkers(input.workers);
    const planId = `payroll-plan-${stableDigest('payroll-plan', {
      tenant_id: scope.tenant_id,
      period_start: periodStart,
      period_end: periodEnd,
      workers,
    }).slice(0, 24)}`;
    const items = workers.map((worker) => Object.freeze({
      audit_id: auditId('payroll-plan', scope.tenant_id, {
        plan_id: planId,
        worker_id: worker.worker_id,
      }),
      worker_id: worker.worker_id,
      regular_hours: worker.regular_hours,
      overtime_hours: worker.overtime_hours,
      total_hours: worker.regular_hours + worker.overtime_hours,
    }));
    const regularHours = workers.reduce((total, worker) => total + worker.regular_hours, 0);
    const overtimeHours = workers.reduce((total, worker) => total + worker.overtime_hours, 0);
    return Object.freeze({
      valid: true,
      result: Object.freeze({
        format: 'helmion.payroll-work-plan.v1',
        provider_id: contract.provider_id,
        plan_id: planId,
        tenant_id: scope.tenant_id,
        actor_role: scope.actor_role,
        period_start: periodStart,
        period_end: periodEnd,
        worker_count: items.length,
        regular_hours: regularHours,
        overtime_hours: overtimeHours,
        total_hours: regularHours + overtimeHours,
        items: Object.freeze(items),
        decision: 'pending',
        approval_required: true,
        confirmation_required: true,
        authorization: 'not_evaluated',
        invocation: 'not_performed',
        mutation: 'not_performed',
      }),
    });
  });
}

function normalizeRequestParameters(operation, parameters) {
  if (!isPlainObject(parameters)) throw new TypeError('parameters are invalid');
  if (operation === ORCHESTRATION_OPERATIONS.FLEET_STATUS_READ) {
    requireExactKeys(parameters, ['limit', 'truck_id']);
    return {
      truck_id: parameters.truck_id == null ? null : safeId(parameters.truck_id, 'truck_id'),
      limit: safeLimit(parameters.limit, LOCAL_ORCHESTRATION_LIMITS.maxFleetRows),
    };
  }
  if (operation === ORCHESTRATION_OPERATIONS.LOAD_BOARD_SEARCH) {
    requireExactKeys(parameters, ['criteria', 'limit']);
    const criteria = normalizeLoadCriteria(parameters.criteria);
    return {
      criteria,
      limit: safeLimit(parameters.limit, LOCAL_ORCHESTRATION_LIMITS.maxLoadRows),
    };
  }
  if (operation === ORCHESTRATION_OPERATIONS.PAYROLL_WORK_PREPARE) {
    requireExactKeys(parameters, ['period_end', 'period_start', 'workers']);
    const periodStart = safeDate(parameters.period_start, 'period_start');
    const periodEnd = safeDate(parameters.period_end, 'period_end');
    if (periodEnd < periodStart) throw new TypeError('period is invalid');
    const workers = normalizePayrollWorkers(parameters.workers);
    return { period_start: periodStart, period_end: periodEnd, workers };
  }
  throw new TypeError('operation is invalid');
}

function operationSpec(operation) {
  if (operation === ORCHESTRATION_OPERATIONS.FLEET_STATUS_READ) {
    return {
      provider_id: 'fleet-eld-mock',
      domain: 'fleet_eld',
      intent: 'read_search',
      approval_required: false,
      confirmation_required: false,
      decision: 'not_required',
    };
  }
  if (operation === ORCHESTRATION_OPERATIONS.LOAD_BOARD_SEARCH) {
    return {
      provider_id: 'load-board-mock',
      domain: 'load_board',
      intent: 'read_search',
      approval_required: false,
      confirmation_required: false,
      decision: 'not_required',
    };
  }
  if (operation === ORCHESTRATION_OPERATIONS.PAYROLL_WORK_PREPARE) {
    return {
      provider_id: 'payroll-mock',
      domain: 'payroll',
      intent: 'draft',
      approval_required: true,
      confirmation_required: true,
      decision: 'pending',
    };
  }
  return null;
}

function requestParameterSummary(operation, parameters) {
  if (operation === ORCHESTRATION_OPERATIONS.FLEET_STATUS_READ) {
    return Object.freeze({
      kind: 'fleet_status_filter',
      truck_filter: parameters.truck_id !== null,
      limit: parameters.limit,
    });
  }
  if (operation === ORCHESTRATION_OPERATIONS.LOAD_BOARD_SEARCH) {
    return Object.freeze({
      kind: 'load_search_criteria',
      criteria_fields: Object.freeze(Object.keys(parameters.criteria).sort()),
      limit: parameters.limit,
    });
  }
  return Object.freeze({
    kind: 'payroll_work_period',
    period_start: parameters.period_start,
    period_end: parameters.period_end,
    worker_count: parameters.workers.length,
    total_hours: parameters.workers.reduce(
      (total, worker) => total + worker.regular_hours + worker.overtime_hours,
      0,
    ),
  });
}

function requestAuditId(envelope) {
  return auditId('orchestration-request', envelope.tenant_id, {
    request_id: envelope.request_id,
    operation: envelope.operation,
    provider_id: envelope.provider_id,
    policy_version: envelope.policy_version,
    request_digest: envelope.request_digest,
    parameter_summary: envelope.parameter_summary,
  });
}

function normalizedRequestEnvelope(input) {
  rejectForbiddenKeys(input);
  requireExactKeys(input, REQUEST_INPUT_KEYS);
  const scope = normalizeScope(input);
  const operation = safeText(input.operation, 'operation', 64).toLowerCase();
  const spec = operationSpec(operation);
  if (!spec) throw new TypeError('operation is invalid');
  const providerId = normalizeProviderId(input.provider_id, spec.provider_id);
  getContract(providerId, spec.domain);
  if (operation === ORCHESTRATION_OPERATIONS.PAYROLL_WORK_PREPARE
      && !PAYROLL_ROLES.has(scope.actor_role)) {
    return { invalid: 'ORCHESTRATION_REQUEST_ROLE_REQUIRED' };
  }
  const requestId = safeId(input.request_id, 'request_id');
  const policyVersion = safeText(input.policy_version, 'policy_version', 64);
  if (!SAFE_ID_PATTERN.test(policyVersion)) throw new TypeError('policy_version is invalid');
  const parameters = normalizeRequestParameters(operation, input.parameters);
  const requestDigest = stableDigest('orchestration-request', {
    tenant_id: scope.tenant_id,
    actor_role: scope.actor_role,
    operation,
    provider_id: providerId,
    policy_version: policyVersion,
    parameters,
  });
  return {
    scope,
    operation,
    providerId,
    spec,
    requestId,
    policyVersion,
    parameters,
    requestDigest,
  };
}

/**
 * Bind safe orchestration request metadata to a deterministic local envelope.
 * The request parameters are validated and hashed, but never copied into the
 * envelope. This creates an audit-friendly handoff shape without authorizing,
 * invoking, notifying, transporting, or mutating anything.
 */
export function buildOrchestrationRequestEnvelope(input = {}) {
  return serviceFailure('ORCHESTRATION_REQUEST_INVALID', () => {
    const normalized = normalizedRequestEnvelope(input);
    if (normalized.invalid) return fail(normalized.invalid);
    const {
      scope,
      operation,
      providerId,
      spec,
      requestId,
      policyVersion,
      parameters,
      requestDigest,
    } = normalized;
    const envelope = {
      format: 'helmion.orchestration-request.v1',
      request_id: requestId,
      audit_id: '',
      request_digest: requestDigest,
      policy_version: policyVersion,
      tenant_id: scope.tenant_id,
      actor_role: scope.actor_role,
      operation,
      provider_id: providerId,
      intent: spec.intent,
      parameter_summary: requestParameterSummary(operation, parameters),
      approval_required: spec.approval_required,
      confirmation_required: spec.confirmation_required,
      decision: spec.decision,
      authorization: 'not_evaluated',
      invocation: 'not_performed',
      mutation: 'not_performed',
    };
    envelope.audit_id = requestAuditId(envelope);
    return Object.freeze({ valid: true, envelope: deepFreeze(envelope) });
  });
}

function invalidRequestInspection(code = 'ORCHESTRATION_REQUEST_INSPECTION_INVALID') {
  return fail(code);
}

function validateRequestParameterSummary(operation, summary) {
  if (!isPlainObject(summary)) return false;
  if (operation === ORCHESTRATION_OPERATIONS.FLEET_STATUS_READ) {
    return hasExactKeys(summary, ['kind', 'limit', 'truck_filter'])
      && summary.kind === 'fleet_status_filter'
      && typeof summary.truck_filter === 'boolean'
      && Number.isInteger(summary.limit)
      && summary.limit >= 1
      && summary.limit <= LOCAL_ORCHESTRATION_LIMITS.maxFleetRows;
  }
  if (operation === ORCHESTRATION_OPERATIONS.LOAD_BOARD_SEARCH) {
    const allowedCriteriaFields = new Set(['destination', 'equipment', 'origin', 'pickup_date']);
    return hasExactKeys(summary, ['criteria_fields', 'kind', 'limit'])
      && summary.kind === 'load_search_criteria'
      && Array.isArray(summary.criteria_fields)
      && summary.criteria_fields.length >= 1
      && summary.criteria_fields.length <= 4
      && summary.criteria_fields.every((field, index, fields) => (
        typeof field === 'string'
        && allowedCriteriaFields.has(field)
        && fields.indexOf(field) === index
        && (index === 0 || fields[index - 1] < field)
      ))
      && Number.isInteger(summary.limit)
      && summary.limit >= 1
      && summary.limit <= LOCAL_ORCHESTRATION_LIMITS.maxLoadRows;
  }
  return hasExactKeys(summary, ['kind', 'period_end', 'period_start', 'total_hours', 'worker_count'])
    && summary.kind === 'payroll_work_period'
    && DATE_PATTERN.test(summary.period_start)
    && DATE_PATTERN.test(summary.period_end)
    && summary.period_end >= summary.period_start
    && Number.isInteger(summary.worker_count)
    && summary.worker_count >= 1
    && summary.worker_count <= LOCAL_ORCHESTRATION_LIMITS.maxPayrollWorkers
    && Number.isFinite(summary.total_hours)
    && summary.total_hours > 0
    && summary.total_hours <= 9000;
}

/**
 * Inspect only the bounded envelope metadata. The original request content is
 * not required and is never returned; the self-bound audit ID and exact safe
 * contract fields are verified against the supplied tenant/role scope.
 */
export function inspectOrchestrationRequest(envelope, scopeInput = {}) {
  try {
    if (!isPlainObject(envelope) || !hasExactKeys(envelope, REQUEST_ENVELOPE_KEYS)) {
      return invalidRequestInspection();
    }
    const scope = normalizeScope(scopeInput);
    if (envelope.tenant_id !== scope.tenant_id || envelope.actor_role !== scope.actor_role) {
      return invalidRequestInspection('ORCHESTRATION_REQUEST_SCOPE_INVALID');
    }
    const spec = operationSpec(envelope.operation);
    if (!spec || envelope.provider_id !== spec.provider_id) return invalidRequestInspection();
    getContract(envelope.provider_id, spec.domain);
    if (!SAFE_ID_PATTERN.test(envelope.request_id)
        || !SAFE_ID_PATTERN.test(envelope.policy_version)
        || !/^[0-9a-f]{64}$/.test(envelope.request_digest)
        || !/^orchestration-request-[0-9a-f]{24}$/.test(envelope.audit_id)) {
      return invalidRequestInspection();
    }
    if (!validateRequestParameterSummary(envelope.operation, envelope.parameter_summary)) {
      return invalidRequestInspection();
    }
    if (envelope.format !== 'helmion.orchestration-request.v1'
        || envelope.intent !== spec.intent
        || envelope.approval_required !== spec.approval_required
        || envelope.confirmation_required !== spec.confirmation_required
        || envelope.decision !== spec.decision
        || envelope.authorization !== 'not_evaluated'
        || envelope.invocation !== 'not_performed'
        || envelope.mutation !== 'not_performed'
        || envelope.audit_id !== requestAuditId(envelope)) {
      return invalidRequestInspection('ORCHESTRATION_REQUEST_INTEGRITY_INVALID');
    }
    const summary = {
      format: 'helmion.orchestration-request-inspection.v1',
      integrity: 'verified',
      request_id: envelope.request_id,
      audit_id: envelope.audit_id,
      request_digest: envelope.request_digest,
      policy_version: envelope.policy_version,
      tenant_id: envelope.tenant_id,
      actor_role: envelope.actor_role,
      operation: envelope.operation,
      provider_id: envelope.provider_id,
      parameter_summary: envelope.parameter_summary,
      approval_required: envelope.approval_required,
      confirmation_required: envelope.confirmation_required,
      decision: envelope.decision,
      authorization: envelope.authorization,
      invocation: envelope.invocation,
      mutation: envelope.mutation,
    };
    return Object.freeze({ valid: true, summary: deepFreeze(summary) });
  } catch {
    return invalidRequestInspection();
  }
}

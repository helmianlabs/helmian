import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_ORCHESTRATION_LIMITS,
  createMockProviderRegistry,
  createIntegrationReadinessRegistry,
  defineMockProviderContract,
  defineIntegrationReadinessDescriptor,
  buildOrchestrationRequestEnvelope,
  inspectOrchestrationRequest,
  inspectLocalIntegrationReadiness,
  listMockProviderContracts,
  listLocalIntegrationReadiness,
  INTEGRATION_READINESS_STATES,
  preparePayrollWork,
  readFleetStatus,
  searchLoadBoard,
} from '../src/core/local-orchestration.mjs';

const acmeAuditor = { tenant_id: 'Acme-Operations', actor_role: 'Auditor' };
const acmeAdmin = { tenant_id: 'Acme-Operations', actor_role: 'Admin' };

test('lists deterministic local mock provider contracts without activation authority', () => {
  const first = listMockProviderContracts(acmeAuditor);
  const second = listMockProviderContracts(acmeAuditor);
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.equal(first.result.format, 'helmion.orchestration-provider-list.v1');
  assert.deepEqual(first.result.providers.map((provider) => provider.provider_id), [
    'fleet-eld-mock',
    'load-board-mock',
    'payroll-mock',
  ]);
  for (const provider of first.result.providers) {
    assert.equal(provider.transport, 'none');
    assert.equal(provider.network, 'disabled');
    assert.equal(provider.credentials, 'none');
    assert.equal(provider.mutations, 'disabled');
    assert.equal(provider.authorization, 'not_evaluated');
    assert.equal(provider.invocation, 'not_performed');
  }
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.result), true);
  assert.equal(Object.isFrozen(first.result.providers), true);
});

test('mock provider contract validation rejects activation, secret, and mutation drift', () => {
  const base = {
    format: 'helmion.mock-provider-contract.v1',
    provider_id: 'safe-mock',
    domain: 'fleet_eld',
    deterministic: true,
    tenant_scoped: true,
    transport: 'none',
    network: 'disabled',
    credentials: 'none',
    mutations: 'disabled',
    capabilities: { read: true, plan: true, write: false },
  };
  assert.equal(Object.isFrozen(defineMockProviderContract(base)), true);
  for (const altered of [
    { ...base, network: 'enabled' },
    { ...base, mutations: 'enabled' },
    { ...base, api_key: 'must-not-be-accepted' },
    { ...base, capabilities: { read: true, plan: true, write: true } },
  ]) {
    assert.throws(() => defineMockProviderContract(altered), TypeError);
  }
  assert.throws(() => createMockProviderRegistry([base, base]), TypeError);
});

test('fleet read is deterministic, tenant-scoped, role-shaped, and bounded', () => {
  const first = readFleetStatus({ ...acmeAuditor, limit: 1 });
  const second = readFleetStatus({ ...acmeAuditor, limit: 1 });
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.deepEqual(first.result.trucks.map((truck) => truck.truck_id), ['truck-101']);
  assert.equal(first.result.tenant_id, 'acme-operations');
  assert.equal(first.result.actor_role, 'auditor');
  assert.equal(first.result.complete, false);
  assert.equal(first.result.trucks[0].audit_id.startsWith('fleet-read-'), true);
  assert.equal(Object.keys(first.result.trucks[0]).includes('tenant_id'), false);
  assert.equal(Object.isFrozen(first.result.trucks[0]), true);

  const otherTenant = readFleetStatus({ tenant_id: 'Northstar-Logistics', actor_role: 'member' });
  assert.equal(otherTenant.valid, true);
  assert.deepEqual(otherTenant.result.trucks.map((truck) => truck.truck_id), ['truck-201']);
  assert.equal(JSON.stringify(otherTenant).includes('truck-101'), false);
});

test('fleet read fails closed for scope, provider, limit, and sensitive-field drift', () => {
  for (const input of [
    { tenant_id: 'acme-operations', actor_role: 'unknown' },
    { tenant_id: 'acme-operations', actor_role: 'member', provider_id: 'load-board-mock' },
    { tenant_id: 'acme-operations', actor_role: 'member', limit: LOCAL_ORCHESTRATION_LIMITS.maxFleetRows + 1 },
    { tenant_id: 'acme-operations', actor_role: 'member', credential: 'must-not-be-read' },
  ]) {
    assert.deepEqual(readFleetStatus(input), {
      valid: false,
      code: 'ORCHESTRATION_FLEET_READ_INVALID',
    });
  }
});

test('load-board search uses basic criteria and never crosses tenant fixtures', () => {
  const input = {
    ...acmeAuditor,
    criteria: { origin: 'dallas, tx', equipment: 'DRY_VAN' },
  };
  const before = structuredClone(input);
  const result = searchLoadBoard(input);
  assert.deepEqual(input, before);
  assert.equal(result.valid, true);
  assert.equal(result.result.count, 1);
  assert.deepEqual(result.result.loads[0], {
    audit_id: result.result.loads[0].audit_id,
    load_id: 'load-301',
    origin: 'Dallas, TX',
    destination: 'Tulsa, OK',
    equipment: 'dry_van',
    pickup_date: '2026-08-12',
    miles: 240,
    rate_cents: 78000,
  });
  assert.equal(result.result.loads[0].audit_id.startsWith('load-search-'), true);

  const otherTenant = searchLoadBoard({
    tenant_id: 'northstar-logistics',
    actor_role: 'auditor',
    criteria: { destination: 'Tulsa, OK' },
  });
  assert.equal(otherTenant.valid, true);
  assert.equal(otherTenant.result.count, 0);
  assert.equal(JSON.stringify(otherTenant).includes('load-301'), false);
});

test('load-board search rejects empty, unknown, malformed, and secret-bearing criteria', () => {
  for (const input of [
    { ...acmeAuditor, criteria: {} },
    { ...acmeAuditor, criteria: { origin: 'Dallas, TX', secret: 'x' } },
    { ...acmeAuditor, criteria: { equipment: 'unknown' } },
    { ...acmeAuditor, criteria: { pickup_date: '2026-02-30' } },
    { ...acmeAuditor, criteria: { origin: 'Dallas, TX' }, limit: 0 },
  ]) {
    assert.deepEqual(searchLoadBoard(input), {
      valid: false,
      code: 'ORCHESTRATION_LOAD_SEARCH_INVALID',
    });
  }
});

test('payroll preparation returns a deterministic pending plan with explicit gates', () => {
  const input = {
    ...acmeAdmin,
    period_start: '2026-08-01',
    period_end: '2026-08-07',
    workers: [
      { worker_id: 'worker-002', regular_hours: 32, overtime_hours: 2 },
      { worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 },
    ],
  };
  const before = structuredClone(input);
  const first = preparePayrollWork(input);
  const second = preparePayrollWork(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.equal(first.result.format, 'helmion.payroll-work-plan.v1');
  assert.equal(first.result.tenant_id, 'acme-operations');
  assert.equal(first.result.actor_role, 'admin');
  assert.deepEqual(first.result.items.map((item) => item.worker_id), ['worker-001', 'worker-002']);
  assert.equal(first.result.worker_count, 2);
  assert.equal(first.result.total_hours, 74);
  assert.equal(first.result.decision, 'pending');
  assert.equal(first.result.approval_required, true);
  assert.equal(first.result.confirmation_required, true);
  assert.equal(first.result.authorization, 'not_evaluated');
  assert.equal(first.result.invocation, 'not_performed');
  assert.equal(first.result.mutation, 'not_performed');
  assert.equal(Object.isFrozen(first.result.items), true);
  assert.equal(Object.keys(first.result).includes('pay_rate'), false);
  assert.equal(Object.keys(first.result).includes('bank_account'), false);
});

test('payroll preparation fails closed for non-payroll roles and execution-shaped input', () => {
  const base = {
    ...acmeAuditor,
    period_start: '2026-08-01',
    period_end: '2026-08-07',
    workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 }],
  };
  assert.deepEqual(preparePayrollWork(base), {
    valid: false,
    code: 'ORCHESTRATION_PAYROLL_ROLE_REQUIRED',
  });
  for (const [altered, expectedCode] of [
    [{ ...base, actor_role: 'admin', approved: true }, 'ORCHESTRATION_PAYROLL_PLAN_INVALID'],
    [{ ...base, actor_role: 'admin', workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0, ssn: 'x' }] }, 'ORCHESTRATION_PAYROLL_PLAN_INVALID'],
    [{ ...base, actor_role: 'admin', period_end: '2026-07-31' }, 'ORCHESTRATION_PAYROLL_PERIOD_INVALID'],
    [{ ...base, actor_role: 'admin', workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 }, { worker_id: 'worker-001', regular_hours: 1, overtime_hours: 0 }] }, 'ORCHESTRATION_PAYROLL_PLAN_INVALID'],
  ]) {
    const result = preparePayrollWork(altered);
    assert.equal(result.valid, false);
    assert.equal(result.code, expectedCode);
    assert.equal(JSON.stringify(result).includes('ssn'), false);
  }
});

test('request envelopes bind safe operation metadata without copying request payloads', () => {
  const input = {
    ...acmeAuditor,
    request_id: 'req-fleet-001',
    policy_version: 'helmion-orchestration-v1',
    operation: 'fleet_status_read',
    provider_id: 'fleet-eld-mock',
    parameters: { truck_id: 'truck-101', limit: 1 },
  };
  const before = structuredClone(input);
  const first = buildOrchestrationRequestEnvelope(input);
  const second = buildOrchestrationRequestEnvelope(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.deepEqual(Object.keys(first.envelope).sort(), [
    'actor_role',
    'approval_required',
    'audit_id',
    'authorization',
    'confirmation_required',
    'decision',
    'format',
    'intent',
    'invocation',
    'mutation',
    'operation',
    'parameter_summary',
    'policy_version',
    'provider_id',
    'request_digest',
    'request_id',
    'tenant_id',
  ]);
  assert.equal(first.envelope.format, 'helmion.orchestration-request.v1');
  assert.equal(first.envelope.request_id, 'req-fleet-001');
  assert.equal(first.envelope.audit_id.startsWith('orchestration-request-'), true);
  assert.equal(first.envelope.request_digest.length, 64);
  assert.deepEqual(first.envelope.parameter_summary, {
    kind: 'fleet_status_filter',
    truck_filter: true,
    limit: 1,
  });
  assert.equal(JSON.stringify(first).includes('truck-101'), false);
  assert.equal(Object.isFrozen(first.envelope), true);
  assert.equal(Object.isFrozen(first.envelope.parameter_summary), true);
});

test('request envelopes retain read versus pending-payroll posture across domains', () => {
  const load = buildOrchestrationRequestEnvelope({
    ...acmeAuditor,
    request_id: 'req-load-001',
    policy_version: 'v1',
    operation: 'load_board_search',
    provider_id: 'load-board-mock',
    parameters: {
      criteria: { origin: 'Dallas, TX', equipment: 'dry_van' },
      limit: 10,
    },
  });
  assert.equal(load.valid, true);
  assert.deepEqual(load.envelope.parameter_summary, {
    kind: 'load_search_criteria',
    criteria_fields: ['equipment', 'origin'],
    limit: 10,
  });
  assert.equal(load.envelope.approval_required, false);
  assert.equal(load.envelope.decision, 'not_required');
  assert.equal(JSON.stringify(load).includes('Dallas'), false);

  const payroll = buildOrchestrationRequestEnvelope({
    ...acmeAdmin,
    request_id: 'req-payroll-001',
    policy_version: 'v1',
    operation: 'payroll_work_prepare',
    provider_id: 'payroll-mock',
    parameters: {
      period_start: '2026-08-01',
      period_end: '2026-08-07',
      workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 2 }],
    },
  });
  assert.equal(payroll.valid, true);
  assert.equal(payroll.envelope.intent, 'draft');
  assert.equal(payroll.envelope.approval_required, true);
  assert.equal(payroll.envelope.confirmation_required, true);
  assert.equal(payroll.envelope.decision, 'pending');
  assert.equal(payroll.envelope.mutation, 'not_performed');
  assert.deepEqual(payroll.envelope.parameter_summary, {
    kind: 'payroll_work_period',
    period_start: '2026-08-01',
    period_end: '2026-08-07',
    worker_count: 1,
    total_hours: 42,
  });
  assert.equal(JSON.stringify(payroll).includes('worker-001'), false);
});

test('request inspection verifies scope, safe shape, and self-bound audit integrity', () => {
  const built = buildOrchestrationRequestEnvelope({
    ...acmeAdmin,
    request_id: 'req-inspect-001',
    policy_version: 'v1',
    operation: 'payroll_work_prepare',
    provider_id: 'payroll-mock',
    parameters: {
      period_start: '2026-08-01',
      period_end: '2026-08-07',
      workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 2 }],
    },
  });
  const inspected = inspectOrchestrationRequest(built.envelope, acmeAdmin);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.summary.integrity, 'verified');
  assert.equal(inspected.summary.request_id, 'req-inspect-001');
  assert.equal(inspected.summary.tenant_id, 'acme-operations');
  assert.equal(inspected.summary.approval_required, true);
  assert.equal(inspected.summary.authorization, 'not_evaluated');
  assert.equal(inspected.summary.invocation, 'not_performed');
  assert.equal(inspected.summary.mutation, 'not_performed');
  assert.equal(Object.isFrozen(inspected.summary), true);

  const alteredSummary = {
    ...built.envelope,
    parameter_summary: { ...built.envelope.parameter_summary, worker_count: 50 },
  };
  assert.deepEqual(inspectOrchestrationRequest(alteredSummary, acmeAdmin), {
    valid: false,
    code: 'ORCHESTRATION_REQUEST_INTEGRITY_INVALID',
  });
  assert.deepEqual(inspectOrchestrationRequest({ ...built.envelope, payload: 'secret' }, acmeAdmin), {
    valid: false,
    code: 'ORCHESTRATION_REQUEST_INSPECTION_INVALID',
  });
  assert.deepEqual(inspectOrchestrationRequest(built.envelope, {
    tenant_id: 'other-tenant',
    actor_role: 'admin',
  }), {
    valid: false,
    code: 'ORCHESTRATION_REQUEST_SCOPE_INVALID',
  });
});

test('request envelope building fails closed before any external or approval path', () => {
  const base = {
    ...acmeAuditor,
    request_id: 'req-invalid-001',
    policy_version: 'v1',
    operation: 'fleet_status_read',
    provider_id: 'fleet-eld-mock',
    parameters: { truck_id: null, limit: 1 },
  };
  for (const input of [
    { ...base, provider_id: 'load-board-mock' },
    { ...base, operation: 'unknown_operation' },
    { ...base, parameters: { truck_id: null, limit: 1, credential: 'x' } },
    { ...base, parameters: { truck_id: null, limit: 1 }, payload: 'x' },
    { ...base, operation: 'payroll_work_prepare', provider_id: 'payroll-mock', parameters: { period_start: '2026-08-01', period_end: '2026-08-07', workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 }] } },
  ]) {
    const result = buildOrchestrationRequestEnvelope(input);
    assert.equal(result.valid, false);
    assert.equal(
      ['ORCHESTRATION_REQUEST_INVALID', 'ORCHESTRATION_REQUEST_ROLE_REQUIRED'].includes(result.code),
      true,
    );
    assert.equal(JSON.stringify(result).includes('credential'), false);
  }
});

test('integration readiness lists every mock surface with safe disabled adapter states', () => {
  const first = listLocalIntegrationReadiness(acmeAuditor);
  const second = listLocalIntegrationReadiness(acmeAuditor);
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.deepEqual(first.result.integrations.map((item) => item.integration_id), [
    'fleet-eld-readiness',
    'load-board-readiness',
    'payroll-readiness',
  ]);
  for (const item of first.result.integrations) {
    assert.equal(item.readiness, INTEGRATION_READINESS_STATES.MOCK_ONLY);
    assert.equal(item.activation, 'awaiting_user_connection');
    assert.equal(item.connection, 'not_configured');
    assert.equal(item.credential_state, 'not_present');
    assert.equal(item.transport, 'disabled');
    assert.equal(item.execution, 'disabled');
    assert.equal(item.mutations, 'disabled');
    assert.equal(item.tenant_id, 'acme-operations');
    assert.equal(item.actor_role, 'auditor');
    assert.equal(item.tenant_scoped, true);
    assert.equal(item.deterministic, true);
    assert.equal(item.authorization, 'not_evaluated');
    assert.equal(item.invocation, 'not_performed');
    assert.equal(item.audit_id.startsWith('integration-readiness-'), true);
    assert.equal(Object.isFrozen(item), true);
  }
  const payroll = first.result.integrations.find((item) => item.surface === 'payroll');
  assert.equal(payroll.approval_required, true);
  assert.equal(payroll.role_policy, 'owner_admin_prepare');
  assert.equal(payroll.role_eligible, false);
  assert.equal(Object.isFrozen(first.result), true);
  assert.equal(Object.isFrozen(first.result.integrations), true);
});

test('integration readiness preserves role posture and tenant-scoped audit identity', () => {
  const owner = inspectLocalIntegrationReadiness({
    tenant_id: 'Acme-Operations',
    actor_role: 'Owner',
    integration_id: 'payroll-readiness',
  });
  const otherTenant = inspectLocalIntegrationReadiness({
    tenant_id: 'Northstar-Logistics',
    actor_role: 'Owner',
    integration_id: 'payroll-readiness',
  });
  assert.equal(owner.valid, true);
  assert.equal(owner.readiness.role_eligible, true);
  assert.equal(owner.readiness.approval_required, true);
  assert.equal(owner.readiness.tenant_id, 'acme-operations');
  assert.equal(otherTenant.valid, true);
  assert.equal(otherTenant.readiness.tenant_id, 'northstar-logistics');
  assert.notEqual(owner.readiness.audit_id, otherTenant.readiness.audit_id);
  assert.equal(JSON.stringify(owner).includes('credential'), true);
  assert.equal(JSON.stringify(owner).includes('api_key'), false);
});

test('integration readiness registry is extensible but rejects unsafe or mismatched descriptors', () => {
  const base = {
    format: 'helmion.integration-readiness-descriptor.v1',
    integration_id: 'fleet-eld-secondary',
    provider_id: 'fleet-eld-mock',
    surface: 'fleet_eld',
    readiness: 'mock_only',
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
  };
  const descriptor = defineIntegrationReadinessDescriptor(base);
  assert.equal(Object.isFrozen(descriptor), true);
  const registry = createIntegrationReadinessRegistry([base]);
  assert.deepEqual(registry.list().map((item) => item.integration_id), ['fleet-eld-secondary']);
  for (const altered of [
    { ...base, transport: 'api' },
    { ...base, provider_id: 'load-board-mock' },
    { ...base, credential_state: 'configured' },
    { ...base, capabilities: { read: true, plan: true, write: true } },
    { ...base, secret: 'must-not-be-accepted' },
  ]) {
    assert.throws(() => defineIntegrationReadinessDescriptor(altered), TypeError);
  }
  assert.throws(() => createIntegrationReadinessRegistry([base, base]), TypeError);
});

test('integration readiness fails closed for malformed scope, unknown IDs, and sensitive fields', () => {
  assert.deepEqual(listLocalIntegrationReadiness({
    tenant_id: 'acme-operations',
    actor_role: 'member',
    credential: 'must-not-be-read',
  }), {
    valid: false,
    code: 'ORCHESTRATION_READINESS_INVALID',
  });
  assert.deepEqual(inspectLocalIntegrationReadiness({
    tenant_id: 'acme-operations',
    actor_role: 'member',
    integration_id: 'unknown-readiness',
  }), {
    valid: false,
    code: 'ORCHESTRATION_READINESS_NOT_FOUND',
  });
  assert.deepEqual(inspectLocalIntegrationReadiness({
    tenant_id: 'acme-operations',
    actor_role: 'unknown',
    integration_id: 'fleet-eld-readiness',
  }), {
    valid: false,
    code: 'ORCHESTRATION_READINESS_INVALID',
  });
});

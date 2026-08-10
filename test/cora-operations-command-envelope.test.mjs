import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORA_AIMFORGE_PAGE_IDS,
  CORA_HELMIAN_PAGE_IDS,
  CORA_OPERATIONS_ENVELOPE_FORMAT,
  CORA_OPERATIONS_PAGE_CATALOG,
  createCoraOperationsEnvelope,
} from '../src/cora/operations-command-envelope.mjs';

const scope = { tenant_id: 'acme-operations', actor_role: 'auditor' };

test('page catalog exposes stable Aim Forge and Helmian IDs without navigation wiring', () => {
  assert.deepEqual(CORA_HELMIAN_PAGE_IDS, ['dashboard', 'activity']);
  assert.deepEqual(CORA_AIMFORGE_PAGE_IDS, [
    'desk', 'board', 'dispatch', 'fleet', 'money', 'docs', 'connect', 'settings',
  ]);
  const envelope = createCoraOperationsEnvelope({
    ...scope,
    intent: 'switch-dashboard',
    request: { surface: 'aim-forge', page: 'load-board' },
  });
  assert.equal(envelope.format, CORA_OPERATIONS_ENVELOPE_FORMAT);
  assert.equal(envelope.status, 'preview-ready');
  assert.deepEqual(envelope.request.data, {
    surface: 'aim-forge',
    page_id: 'board',
    label: 'Aim Forge board',
  });
  assert.equal(envelope.response.result.navigation, 'not_performed');
  assert.equal(envelope.request.helmion_intent, 'read_search');
  assert.equal(envelope.enabled, false);
  assert.equal(Object.isFrozen(envelope), true);
});

test('fleet requests use the tenant-scoped Helmian mock contract and retain audit IDs', () => {
  const envelope = createCoraOperationsEnvelope({
    ...scope,
    intent: 'locate-trucks',
    request: { truck_id: 'truck-101', limit: 1 },
  });
  assert.equal(envelope.response.format, 'helmion.fleet-status-read.v1');
  assert.equal(envelope.response.result.tenant_id, 'acme-operations');
  assert.equal(envelope.response.result.actor_role, 'auditor');
  assert.deepEqual(envelope.response.result.trucks.map((truck) => truck.truck_id), ['truck-101']);
  assert.equal(envelope.audit_refs.length, 1);
  assert.equal(envelope.audit_refs[0].startsWith('fleet-read-'), true);
  assert.equal(envelope.gates.approval_required, false);
  assert.equal(envelope.invocation, 'not_performed');

  const otherTenant = createCoraOperationsEnvelope({
    tenant_id: 'northstar-logistics',
    actor_role: 'member',
    intent: 'locate-trucks',
    request: { limit: 5 },
  });
  assert.deepEqual(otherTenant.response.result.trucks.map((truck) => truck.truck_id), ['truck-201']);
  assert.equal(JSON.stringify(otherTenant).includes('truck-101'), false);
});

test('load requests preserve the Helmian search response and bounded criteria', () => {
  const envelope = createCoraOperationsEnvelope({
    ...scope,
    intent: 'search-loads',
    request: {
      criteria: { origin: 'dallas, tx', equipment: 'DRY_VAN' },
      limit: 2,
    },
  });
  assert.equal(envelope.response.format, 'helmion.load-board-search.v1');
  assert.deepEqual(envelope.request.data, {
    criteria: { origin: 'dallas, tx', equipment: 'dry_van' },
    limit: 2,
  });
  assert.deepEqual(envelope.response.result.criteria, {
    origin: 'dallas, tx',
    equipment: 'dry_van',
  });
  assert.deepEqual(envelope.response.result.loads.map((load) => load.load_id), ['load-301']);
  assert.equal(envelope.audit_refs[0].startsWith('load-search-'), true);
});

test('payroll requests retain the pending approval handoff and plan audit IDs', () => {
  const envelope = createCoraOperationsEnvelope({
    tenant_id: 'acme-operations',
    actor_role: 'admin',
    intent: 'prepare-payroll-work',
    request: {
      period_start: '2026-08-01',
      period_end: '2026-08-07',
      workers: [
        { worker_id: 'worker-002', regular_hours: 32, overtime_hours: 2 },
        { worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 },
      ],
    },
  });
  assert.equal(envelope.response.format, 'helmion.payroll-work-plan.v1');
  assert.equal(envelope.response.result.decision, 'pending');
  assert.equal(envelope.response.result.mutation, 'not_performed');
  assert.equal(envelope.gates.confirmation_required, true);
  assert.equal(envelope.gates.approval_required, true);
  assert.equal(envelope.gates.approval_projection.format, 'cora.helmion-approval-projection.v1');
  assert.equal(envelope.gates.approval_projection.decision, 'pending');
  assert.equal(envelope.audit_refs[0].startsWith('payroll-plan-'), true);
  assert.equal(envelope.audit_refs.length, 3);
  assert.equal(JSON.stringify(envelope).includes('pay_rate'), false);
});

test('unknown, incomplete, extra, sensitive, and unauthorized requests fail closed', () => {
  const cases = [
    [{ ...scope, intent: 'book-load', request: {} }, 'UNKNOWN_INTENT'],
    [{ ...scope, intent: 'locate-trucks', request: { truck_id: 'truck-101', extra: true } }, 'CORA_OPERATIONS_REQUEST_INVALID'],
    [{ ...scope, intent: 'search-loads', request: { criteria: { secret: 'must-not-leak' } } }, 'CORA_OPERATIONS_REQUEST_INVALID'],
    [{ ...scope, intent: 'prepare-payroll-work', request: { period_start: '2026-08-01' } }, 'CORA_OPERATIONS_REQUEST_INVALID'],
    [{ tenant_id: 'acme-operations', actor_role: 'member', intent: 'prepare-payroll-work', request: {
      period_start: '2026-08-01',
      period_end: '2026-08-07',
      workers: [{ worker_id: 'worker-001', regular_hours: 40, overtime_hours: 0 }],
    } }, 'ORCHESTRATION_PAYROLL_ROLE_REQUIRED'],
  ];
  for (const [input, code] of cases) {
    const envelope = createCoraOperationsEnvelope(input);
    assert.equal(envelope.code ?? envelope.response?.code, code);
    assert.equal(JSON.stringify(envelope).includes('must-not-leak'), false);
    assert.equal(envelope.execution, 'not-wired');
    assert.equal(envelope.invocation, 'not_performed');
  }
});

test('envelopes are bounded, frozen, and contain no runtime or credential surface', () => {
  const envelope = createCoraOperationsEnvelope({
    ...scope,
    intent: 'search-loads',
    request: { criteria: { destination: 'tulsa, ok' } },
  });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.length <= 12000, true);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.request), true);
  assert.equal(Object.isFrozen(envelope.response.result), true);
  for (const forbidden of ['credential', 'secret', 'token', 'endpoint', 'network', 'browser', 'navigate']) {
    assert.equal(serialized.includes(forbidden), false, `unexpected ${forbidden}`);
  }
});

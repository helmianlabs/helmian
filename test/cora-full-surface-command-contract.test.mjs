import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORA_FULL_SURFACE_FORMAT,
  CORA_TENANT_SURFACE_IDS,
  CORA_TENANT_SURFACE_REGISTRY,
  listCoraTenantSurfaces,
  previewCoraTenantSurface,
} from '../src/cora/full-surface-command-contract.mjs';

const scope = {
  tenant_id: 'acme-operations',
  authorized_tenant_ids: ['acme-operations'],
  actor_role: 'admin',
  mode: 'sample',
};

test('full registry exposes every known tenant-facing surface with stable IDs and bounded posture', () => {
  assert.deepEqual(CORA_TENANT_SURFACE_IDS, [
    'dashboard', 'activity', 'dispatch-board', 'fleet', 'truck-detail',
    'loads', 'load-detail', 'driver', 'pre-trip', 'payroll', 'documents',
    'money', 'settlements', 'integrations', 'settings', 'help',
    'notifications', 'approvals',
  ]);
  const listed = listCoraTenantSurfaces(scope);
  assert.equal(listed.valid, true);
  assert.equal(listed.format, CORA_FULL_SURFACE_FORMAT);
  assert.equal(listed.surfaces.length, CORA_TENANT_SURFACE_IDS.length);
  assert.equal(listed.surfaces.find((row) => row.surface_id === 'dispatch-board').page_id, 'dispatch');
  assert.equal(listed.surfaces.find((row) => row.surface_id === 'settlements').availability, 'sample-unavailable');
  assert.equal(listed.enabled, false);
  assert.equal(listed.mutation, 'not-performed');
  assert.equal(Object.isFrozen(listed), true);
});

test('known surfaces produce deterministic sample previews without execution or raw content', () => {
  const input = {
    ...scope,
    surface: 'truck-detail',
    operation: 'read',
    request: { record_id: 'truck-101' },
  };
  const first = previewCoraTenantSurface(input);
  const second = previewCoraTenantSurface(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'preview-ready');
  assert.equal(first.response.result.surface.surface_id, 'truck-detail');
  assert.equal(first.response.result.operation, 'read');
  assert.equal(first.response.result.simulation, 'not-performed');
  assert.equal(first.invocation, 'not_performed');
  assert.equal(first.audit_refs[0].startsWith('surface-read-'), true);
  assert.equal(JSON.stringify(first).includes('acme-operations'), true);
  for (const forbidden of ['secret', 'token', 'credential', 'payload', 'endpoint', 'network', 'path']) {
    assert.equal(JSON.stringify(first).toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('all sample-ready surfaces accept a read preview while unavailable surfaces remain explicit', () => {
  for (const surfaceId of CORA_TENANT_SURFACE_IDS) {
    const result = previewCoraTenantSurface({
      ...scope,
      surface: surfaceId,
      operation: 'read',
      request: {},
    });
    const entry = CORA_TENANT_SURFACE_REGISTRY[surfaceId];
    assert.equal(result.status, entry.availability === 'sample-ready' ? 'preview-ready' : 'rejected');
    if (entry.availability !== 'sample-ready') assert.equal(result.code, 'CORA_SURFACE_SAMPLE_UNAVAILABLE');
  }
});

test('payroll preparation keeps confirmation and approval pending, never executing', () => {
  const result = previewCoraTenantSurface({
    ...scope,
    surface: 'payroll',
    operation: 'prepare',
    request: { period: 'current-week' },
  });
  assert.equal(result.status, 'preview-ready');
  assert.deepEqual(result.gates, {
    confirmation_required: true,
    approval_required: true,
    decision: 'pending',
  });
  assert.equal(result.execution, 'not-wired');
  assert.equal(result.submission, 'not-performed');
  assert.equal(result.notification, 'not-performed');
});

test('control and simulate are bounded previews and cannot become notify or execute', () => {
  const result = previewCoraTenantSurface({
    ...scope,
    surface: 'integrations',
    operation: 'control',
    request: { filter: 'available' },
  });
  assert.equal(result.status, 'preview-ready');
  assert.equal(result.response.result.simulation, 'preview-only');
  assert.equal(result.notification, 'not-performed');
  assert.equal(result.execution, 'not-wired');

  const simulation = previewCoraTenantSurface({
    ...scope,
    surface: 'settings',
    operation: 'simulate',
    request: {},
  });
  assert.equal(simulation.status, 'preview-ready');
  assert.equal(simulation.response.result.simulation, 'preview-only');
});

test('unknown, unauthorized, cross-tenant, unavailable, and sensitive requests fail closed', () => {
  const cases = [
    [{ ...scope, surface: 'unknown-surface', operation: 'read', request: {} }, 'CORA_SURFACE_UNKNOWN'],
    [{ ...scope, surface: 'dashboard', operation: 'execute', request: {} }, 'CORA_SURFACE_OPERATION_UNSUPPORTED'],
    [{ ...scope, surface: 'dashboard', operation: 'read', request: { payload: 'hidden' } }, 'CORA_SURFACE_REQUEST_INVALID'],
    [{ ...scope, tenant_id: 'northstar-logistics', surface: 'dashboard', operation: 'read', request: {} }, 'CORA_SURFACE_TENANT_SCOPE_INVALID'],
    [{ ...scope, authorized_tenant_ids: ['acme-operations', 'northstar-logistics'], surface: 'dashboard', operation: 'read', request: {} }, 'CORA_SURFACE_TENANT_SCOPE_INVALID'],
    [{ ...scope, actor_role: 'member', surface: 'payroll', operation: 'prepare', request: { period: 'current-week' } }, 'CORA_SURFACE_ROLE_NOT_ALLOWED'],
    [{ ...scope, surface: 'settlements', operation: 'read', request: {} }, 'CORA_SURFACE_SAMPLE_UNAVAILABLE'],
    [{ ...scope, surface: 'truck-detail', operation: 'read', request: { record_id: 'truck-201' } }, 'CORA_SURFACE_SAMPLE_RECORD_NOT_FOUND'],
  ];
  for (const [input, code] of cases) {
    const result = previewCoraTenantSurface(input);
    assert.equal(result.code, code);
    assert.equal(result.valid, false);
    assert.equal(result.execution, 'not-wired');
    assert.equal(result.invocation, 'not_performed');
    assert.equal(JSON.stringify(result).includes('hidden'), false);
  }
  assert.equal(listCoraTenantSurfaces({ ...scope, tenant_id: 'not-a-sample-tenant', authorized_tenant_ids: ['not-a-sample-tenant'] }).code, 'CORA_SURFACE_TENANT_UNAVAILABLE');
});

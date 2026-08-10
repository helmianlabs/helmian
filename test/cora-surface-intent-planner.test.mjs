import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORA_SURFACE_INTENT_FORMAT,
  CORA_SURFACE_INTENT_IDS,
  planCoraSurfaceIntent,
} from '../src/cora/surface-intent-planner.mjs';

const scope = {
  tenant_id: 'acme-operations',
  authorized_tenant_ids: ['acme-operations'],
  actor_role: 'admin',
  mode: 'sample',
};

test('typed surface intents map one-to-one to safe operations', () => {
  assert.deepEqual(CORA_SURFACE_INTENT_IDS, [
    'open-surface', 'read-surface', 'select-surface',
    'control-surface', 'prepare-surface', 'simulate-surface',
  ]);
  for (const [intent, operation] of [
    ['open-surface', 'open'],
    ['read-surface', 'read'],
    ['select-surface', 'select'],
    ['control-surface', 'control'],
    ['prepare-surface', 'prepare'],
    ['simulate-surface', 'simulate'],
  ]) {
    const request = intent === 'prepare-surface'
      ? { surface: 'payroll', request: { period: 'current-week' } }
      : { surface: 'dispatch-board', request: {} };
    const result = planCoraSurfaceIntent({
      ...scope,
      intent,
      request,
    });
    assert.equal(result.valid, true);
    assert.equal(result.format, CORA_SURFACE_INTENT_FORMAT);
    assert.equal(result.operation, operation);
    assert.equal(result.preview.execution, 'not-wired');
    assert.equal(result.preview.invocation, 'not_performed');
  }
});

test('surface aliases and safe selectors flow through the existing preview contract', () => {
  const result = planCoraSurfaceIntent({
    ...scope,
    intent: 'read-surface',
    request: { surface: 'trucks', request: { record_id: 'truck-101', limit: 1 } },
  });
  assert.equal(result.valid, true);
  assert.equal(result.request.surface_id, 'fleet');
  assert.equal(result.request.page_id, 'fleet');
  assert.deepEqual(result.preview.response.result.request, { record_id: 'truck-101', limit: 1 });
  assert.equal(Object.isFrozen(result), true);
});

test('prepare keeps payroll approval pending and control remains simulation-only', () => {
  const payroll = planCoraSurfaceIntent({
    ...scope,
    intent: 'prepare-surface',
    request: { surface: 'payroll', request: { period: 'current-week' } },
  });
  assert.deepEqual(payroll.preview.gates, {
    confirmation_required: true,
    approval_required: true,
    decision: 'pending',
  });

  const control = planCoraSurfaceIntent({
    ...scope,
    intent: 'control-surface',
    request: { surface: 'integrations', request: { filter: 'available' } },
  });
  assert.equal(control.preview.response.result.simulation, 'preview-only');
  assert.equal(control.preview.notification, 'not-performed');
  assert.equal(control.preview.mutation, 'not-performed');
});

test('unknown, incomplete, cross-tenant, and sensitive intents fail closed without echoing input', () => {
  const cases = [
    [{ ...scope, intent: 'execute-surface', request: { surface: 'fleet', request: {} } }, 'CORA_SURFACE_INTENT_UNKNOWN'],
    [{ ...scope, intent: 'read-surface', request: { surface: 'fleet' } }, 'CORA_SURFACE_INTENT_REQUEST_INVALID'],
    [{ ...scope, tenant_id: 'northstar-logistics', intent: 'read-surface', request: { surface: 'fleet', request: {} } }, 'CORA_SURFACE_TENANT_SCOPE_INVALID'],
    [{ ...scope, intent: 'read-surface', request: { surface: 'fleet', request: { payload: 'do-not-echo' } } }, 'CORA_SURFACE_INTENT_REQUEST_INVALID'],
  ];
  for (const [input, code] of cases) {
    const result = planCoraSurfaceIntent(input);
    assert.equal(result.valid, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('do-not-echo'), false);
    assert.equal(result.execution, 'not-wired');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORA_DESKTOP_SURFACE_PROJECTION_FORMAT,
  CORA_HELMIAN_DESKTOP_PAGE_CATALOG,
  projectCoraSurfaceIntentToDesktop,
} from '../src/cora/desktop-surface-intent-projection.mjs';

const scope = {
  tenant_id: 'acme-operations',
  authorized_tenant_ids: ['acme-operations'],
  actor_role: 'admin',
  mode: 'sample',
};

function request(surface, intent = 'open-surface', requestBody = {}) {
  return { ...scope, intent, request: { surface, request: requestBody } };
}

test('known Helmian desktop surfaces project to the existing desktop page names without navigation', () => {
  assert.deepEqual(CORA_HELMIAN_DESKTOP_PAGE_CATALOG.integrations, {
    page_id: 'Integrations', label: 'Helmian integrations',
  });
  for (const [surface, pageId] of [
    ['dashboard', 'Overview'], ['activity', 'Activity'], ['documents', 'Workspace'],
    ['integrations', 'Integrations'], ['settings', 'Settings'], ['help', 'Console'],
    ['approvals', 'Approvals'],
  ]) {
    const result = projectCoraSurfaceIntentToDesktop(request(surface));
    assert.equal(result.valid, true);
    assert.equal(result.format, CORA_DESKTOP_SURFACE_PROJECTION_FORMAT);
    assert.equal(result.desktop.status, 'preview-ready');
    assert.equal(result.desktop.page_id, pageId);
    assert.equal(result.desktop.navigation, 'not_performed');
    assert.equal(result.execution, 'not-wired');
    assert.equal(result.invocation, 'not_performed');
  }
});

test('operational surfaces remain explicit pending desktop implementation instead of pretending they opened', () => {
  const result = projectCoraSurfaceIntentToDesktop(request('fleet', 'read-surface', { limit: 1 }));
  assert.equal(result.valid, true);
  assert.equal(result.status, 'awaiting-desktop-surface');
  assert.deepEqual(result.desktop, {
    status: 'awaiting-desktop-surface',
    availability: 'not-installed',
    page_id: null,
    label: null,
    navigation: 'not_performed',
  });
  assert.equal(result.plan.request.surface_id, 'fleet');
});

test('approval-gated sample preparation preserves the original plan gates', () => {
  const result = projectCoraSurfaceIntentToDesktop(request(
    'payroll', 'prepare-surface', { period: 'current-week' },
  ));
  assert.equal(result.valid, true);
  assert.equal(result.status, 'awaiting-desktop-surface');
  assert.deepEqual(result.plan.preview.gates, {
    confirmation_required: true,
    approval_required: true,
    decision: 'pending',
  });
  assert.equal(result.plan.execution, 'not-wired');
});

test('invalid, extra, or cross-tenant inputs fail closed and do not echo rejected data', () => {
  const cases = [
    [{ ...scope, request: { surface: 'fleet' } }, 'CORA_DESKTOP_SURFACE_REQUEST_INVALID'],
    [{ ...request('fleet'), extra: true }, 'CORA_DESKTOP_SURFACE_REQUEST_INVALID'],
    [{ ...request('fleet', 'read-surface', { payload: 'do-not-echo' }) }, 'CORA_SURFACE_INTENT_REQUEST_INVALID'],
    [{ ...request('fleet'), tenant_id: 'northstar-logistics' }, 'CORA_SURFACE_TENANT_SCOPE_INVALID'],
  ];
  for (const [input, code] of cases) {
    const result = projectCoraSurfaceIntentToDesktop(input);
    assert.equal(result.valid, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('do-not-echo'), false);
    assert.equal(result.execution, 'not-wired');
  }
});

test('outputs are frozen, bounded, and do not expose a runtime-control channel', () => {
  const result = projectCoraSurfaceIntentToDesktop(request('integrations', 'control-surface', { filter: 'available' }));
  const serialized = JSON.stringify(result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.desktop), true);
  assert.equal(serialized.length <= 12000, true);
  for (const forbidden of ['credential', 'secret', 'token', 'endpoint', 'network', 'navigate']) {
    assert.equal(serialized.includes(forbidden), false, `unexpected ${forbidden}`);
  }
});

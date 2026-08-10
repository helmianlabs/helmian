import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORA_DESKTOP_WORKFLOW_STUDIO_FORMAT,
  CORA_DESKTOP_WORKFLOW_TEMPLATES,
  createCoraDesktopWorkflowPreview,
} from '../src/cora/desktop-workflow-studio.mjs';

const scope = {
  tenant_id: 'acme-operations',
  authorized_tenant_ids: ['acme-operations'],
  actor_role: 'admin',
  mode: 'sample',
};

function request(template_id, department, kind = 'sample-page') {
  return { ...scope, request: { template_id, department, kind } };
}

test('the studio covers operational, safety, HR, payroll, finance, document, integration, and approval sample templates', () => {
  assert.equal(Object.keys(CORA_DESKTOP_WORKFLOW_TEMPLATES).length, 13);
  for (const [templateId, department] of [
    ['operations-desk', 'operations'], ['dispatch-board', 'dispatch'], ['fleet-status', 'operations'],
    ['load-search', 'dispatch'], ['multi-board-load-workflow', 'dispatch'],
    ['safety-pretrip-review', 'safety'], ['hr-driver-records', 'hr'], ['driver-mobile-handoff', 'driver'],
    ['payroll-work-review', 'payroll'], ['document-review', 'operations'], ['money-review', 'finance'],
    ['integration-readiness', 'operations'], ['approval-handoff', 'governance'],
  ]) {
    const result = createCoraDesktopWorkflowPreview(request(templateId, department));
    assert.equal(result.valid, true, templateId);
    assert.equal(result.format, CORA_DESKTOP_WORKFLOW_STUDIO_FORMAT);
    assert.equal(result.definition.created, 'sample-preview');
    assert.equal(result.definition.panels.length > 0, true);
    assert.equal(result.definition.steps.length > 0, true);
    assert.equal(result.persistence, 'not_performed');
    assert.equal(result.execution, 'not-wired');
  }
});

test('the normalized load-board and driver-mobile handoff templates use sample adapters and retain gates', () => {
  const loads = createCoraDesktopWorkflowPreview(request('multi-board-load-workflow', 'dispatch', 'sample-workflow'));
  assert.deepEqual(loads.definition.panels.map(({ panel_id: panelId }) => panelId), [
    'normalized-load-results', 'sample-provider-adapters', 'load-handoff-status',
  ]);
  assert.deepEqual(loads.definition.steps.map(({ action }) => action), ['read', 'select', 'simulate']);
  assert.equal(loads.definition.gates.confirmation_required, true);
  assert.equal(loads.definition.gates.approval_required, false);

  const handoff = createCoraDesktopWorkflowPreview(request('driver-mobile-handoff', 'driver', 'sample-workflow'));
  assert.deepEqual(handoff.definition.steps.map(({ action }) => action), ['read', 'prepare', 'simulate']);
  assert.deepEqual(handoff.definition.gates, {
    confirmation_required: true, approval_required: true, decision: 'pending',
  });
  assert.equal(handoff.desktop.status, 'awaiting-desktop-surface');
  assert.equal(handoff.execution, 'not-wired');
});

test('known Helmian pages are surfaced while operational pages remain explicit pending desktop installation', () => {
  const integrations = createCoraDesktopWorkflowPreview(request('integration-readiness', 'operations'));
  assert.deepEqual(integrations.desktop, {
    status: 'preview-ready', availability: 'desktop-page-known', page_id: 'Integrations',
    label: 'Helmian integrations', navigation: 'not_performed',
  });
  const fleet = createCoraDesktopWorkflowPreview(request('fleet-status', 'operations'));
  assert.equal(fleet.desktop.status, 'awaiting-desktop-surface');
  assert.equal(fleet.desktop.availability, 'not-installed');
});

test('payroll, money, and approval templates retain confirmation and approval gates', () => {
  for (const [templateId, department] of [
    ['payroll-work-review', 'payroll'], ['money-review', 'finance'], ['approval-handoff', 'governance'],
  ]) {
    const result = createCoraDesktopWorkflowPreview(request(templateId, department, 'sample-workflow'));
    assert.deepEqual(result.definition.gates, {
      confirmation_required: true, approval_required: true, decision: 'pending',
    });
  }
});

test('member, cross-tenant, unknown, mismatched, and malformed creation requests fail closed', () => {
  const cases = [
    [{ ...request('fleet-status', 'operations'), actor_role: 'member' }, 'CORA_DESKTOP_WORKFLOW_ROLE_NOT_ALLOWED'],
    [{ ...request('fleet-status', 'operations'), tenant_id: 'northstar-logistics' }, 'CORA_DESKTOP_WORKFLOW_SCOPE_INVALID'],
    [request('missing-template', 'operations'), 'CORA_DESKTOP_WORKFLOW_TEMPLATE_INVALID'],
    [request('fleet-status', 'hr'), 'CORA_DESKTOP_WORKFLOW_TEMPLATE_INVALID'],
    [{ ...request('fleet-status', 'operations'), request: { template_id: 'fleet-status', department: 'operations' } }, 'CORA_DESKTOP_WORKFLOW_REQUEST_INVALID'],
  ];
  for (const [input, code] of cases) {
    const result = createCoraDesktopWorkflowPreview(input);
    assert.equal(result.valid, false);
    assert.equal(result.code, code);
    assert.equal(result.execution, 'not-wired');
  }
});

test('definitions are deterministic, frozen, bounded, and contain no runtime or credential channel', () => {
  const left = createCoraDesktopWorkflowPreview(request('safety-pretrip-review', 'safety'));
  const right = createCoraDesktopWorkflowPreview(request('safety-pretrip-review', 'safety'));
  assert.deepEqual(left, right);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.definition), true);
  const serialized = JSON.stringify(left);
  assert.equal(serialized.length <= 12000, true);
  for (const forbidden of ['credential', 'secret', 'token', 'endpoint', 'network', 'navigate']) {
    assert.equal(serialized.includes(forbidden), false, `unexpected ${forbidden}`);
  }
});

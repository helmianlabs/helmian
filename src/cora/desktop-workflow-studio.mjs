import { createHash } from 'node:crypto';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';
import { projectCoraSurfaceIntentToDesktop } from './desktop-surface-intent-projection.mjs';

// A bounded sample-workflow studio for the desktop host.  This is deliberately
// a definition factory, not a code generator or a persistence/execution API.
// It gives Cora real, inspectable demo page/workflow models while keeping every
// consequential action in Helmian's future authorized action boundary.
export const CORA_DESKTOP_WORKFLOW_STUDIO_SCHEMA_VERSION = 1;
export const CORA_DESKTOP_WORKFLOW_STUDIO_FORMAT = 'cora.desktop-workflow-preview.v1';

const ROLES = Object.freeze(['owner', 'admin', 'member', 'auditor']);
const BUILD_ROLES = Object.freeze(['owner', 'admin']);
const MODES = Object.freeze(['sample-page', 'sample-workflow']);
const SAFE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const TOP_LEVEL_KEYS = Object.freeze([
  'actor_role', 'authorized_tenant_ids', 'mode', 'request', 'tenant_id',
]);
const REQUEST_KEYS = Object.freeze(['department', 'kind', 'template_id']);

function template(id, department, surface, title, panels, steps, options = {}) {
  return Object.freeze({
    template_id: id,
    department,
    surface,
    title,
    panels: Object.freeze(panels.map((panel) => Object.freeze(panel))),
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
    confirmation_required: options.confirmationRequired === true,
    approval_required: options.approvalRequired === true,
  });
}

// Panel and step IDs are stable sample identifiers. They are not routes,
// components, instructions, provider calls, or fields for user-entered data.
export const CORA_DESKTOP_WORKFLOW_TEMPLATES = Object.freeze({
  'operations-desk': template('operations-desk', 'operations', 'dashboard', 'Operations desk', [
    { panel_id: 'operations-summary', sample_count: 4 },
    { panel_id: 'dispatch-exceptions', sample_count: 2 },
  ], [
    { step_id: 'review-summary', action: 'read' },
    { step_id: 'select-exception', action: 'select' },
  ]),
  'dispatch-board': template('dispatch-board', 'dispatch', 'dispatch-board', 'Dispatch board', [
    { panel_id: 'dispatch-queue', sample_count: 2 },
    { panel_id: 'equipment-status', sample_count: 2 },
  ], [
    { step_id: 'review-dispatch', action: 'read' },
    { step_id: 'simulate-assignment', action: 'simulate' },
  ]),
  'fleet-status': template('fleet-status', 'operations', 'fleet', 'Fleet status', [
    { panel_id: 'truck-status', sample_count: 2 },
    { panel_id: 'location-summary', sample_count: 2 },
  ], [
    { step_id: 'read-fleet', action: 'read' },
    { step_id: 'select-truck', action: 'select' },
  ]),
  'load-search': template('load-search', 'dispatch', 'loads', 'Load search', [
    { panel_id: 'normalized-load-results', sample_count: 2 },
    { panel_id: 'provider-readiness', sample_count: 3 },
  ], [
    { step_id: 'search-normalized-sample-loads', action: 'read' },
    { step_id: 'select-load', action: 'select' },
  ]),
  'multi-board-load-workflow': template('multi-board-load-workflow', 'dispatch', 'loads', 'Multi-board load workflow', [
    { panel_id: 'normalized-load-results', sample_count: 2 },
    { panel_id: 'sample-provider-adapters', sample_count: 3 },
    { panel_id: 'load-handoff-status', sample_count: 1 },
  ], [
    { step_id: 'read-normalized-results', action: 'read' },
    { step_id: 'select-sample-load', action: 'select' },
    { step_id: 'simulate-driver-handoff', action: 'simulate' },
  ], { confirmationRequired: true }),
  'safety-pretrip-review': template('safety-pretrip-review', 'safety', 'pre-trip', 'Safety pre-trip review', [
    { panel_id: 'inspection-queue', sample_count: 2 },
    { panel_id: 'exception-summary', sample_count: 2 },
  ], [
    { step_id: 'review-inspection', action: 'read' },
    { step_id: 'simulate-follow-up', action: 'simulate' },
  ]),
  'hr-driver-records': template('hr-driver-records', 'hr', 'driver', 'Driver records', [
    { panel_id: 'driver-directory', sample_count: 2 },
    { panel_id: 'training-summary', sample_count: 2 },
  ], [
    { step_id: 'review-driver', action: 'read' },
    { step_id: 'select-driver', action: 'select' },
  ]),
  'driver-mobile-handoff': template('driver-mobile-handoff', 'driver', 'driver', 'Driver mobile handoff', [
    { panel_id: 'driver-work-summary', sample_count: 2 },
    { panel_id: 'mobile-handoff-status', sample_count: 1 },
  ], [
    { step_id: 'review-driver-work', action: 'read' },
    { step_id: 'prepare-mobile-handoff', action: 'prepare' },
    { step_id: 'simulate-mobile-receipt', action: 'simulate' },
  ], { confirmationRequired: true, approvalRequired: true }),
  'payroll-work-review': template('payroll-work-review', 'payroll', 'payroll', 'Payroll work review', [
    { panel_id: 'payroll-work-items', sample_count: 2 },
    { panel_id: 'approval-status', sample_count: 1 },
  ], [
    { step_id: 'review-work-items', action: 'read' },
    { step_id: 'prepare-payroll-work', action: 'prepare' },
  ], { confirmationRequired: true, approvalRequired: true }),
  'document-review': template('document-review', 'operations', 'documents', 'Document review', [
    { panel_id: 'document-queue', sample_count: 2 },
    { panel_id: 'document-status', sample_count: 2 },
  ], [
    { step_id: 'review-documents', action: 'read' },
    { step_id: 'select-document', action: 'select' },
  ]),
  'money-review': template('money-review', 'finance', 'money', 'Money review', [
    { panel_id: 'money-summary', sample_count: 2 },
    { panel_id: 'settlement-review-status', sample_count: 1 },
  ], [
    { step_id: 'review-money', action: 'read' },
    { step_id: 'simulate-settlement-review', action: 'simulate' },
  ], { confirmationRequired: true, approvalRequired: true }),
  'integration-readiness': template('integration-readiness', 'operations', 'integrations', 'Integration readiness', [
    { panel_id: 'provider-status', sample_count: 3 },
    { panel_id: 'connection-readiness', sample_count: 3 },
  ], [
    { step_id: 'review-readiness', action: 'read' },
    { step_id: 'simulate-connection-request', action: 'simulate' },
  ]),
  'approval-handoff': template('approval-handoff', 'governance', 'approvals', 'Approval handoff', [
    { panel_id: 'pending-approvals', sample_count: 2 },
    { panel_id: 'integrity-status', sample_count: 1 },
  ], [
    { step_id: 'review-approval', action: 'read' },
    { step_id: 'prepare-handoff', action: 'prepare' },
  ], { confirmationRequired: true, approvalRequired: true }),
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
    schemaVersion: CORA_DESKTOP_WORKFLOW_STUDIO_SCHEMA_VERSION,
    format: CORA_DESKTOP_WORKFLOW_STUDIO_FORMAT,
    mode: 'sample-data-only',
    valid: false,
    status,
    code,
    definition: null,
    desktop: null,
    audit_refs: [],
    persistence: 'not_performed',
    execution: 'not-wired',
    authorization: 'not_evaluated',
    invocation: 'not_performed',
  });
}

function scopeOf(input) {
  try {
    if (!Array.isArray(input.authorized_tenant_ids) || input.authorized_tenant_ids.length !== 1) return null;
    const tenantId = normalizeTenantId(input.tenant_id);
    const authorizedTenantId = normalizeTenantId(input.authorized_tenant_ids[0]);
    const actorRole = normalizeActorRole(input.actor_role);
    if (tenantId !== authorizedTenantId || !ROLES.includes(actorRole)) return null;
    return Object.freeze({ tenant_id: tenantId, actor_role: actorRole });
  } catch {
    return null;
  }
}

function auditRef(scope, templateId, kind) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ tenant_id: scope.tenant_id, actor_role: scope.actor_role, template_id: templateId, kind }))
    .digest('hex').slice(0, 24);
  return `desktop-workflow-${digest}`;
}

function viewFor(templateValue, kind) {
  return Object.freeze({
    definition_id: `${kind}-${templateValue.template_id}`,
    kind,
    template_id: templateValue.template_id,
    department: templateValue.department,
    surface_id: templateValue.surface,
    title: templateValue.title,
    panels: Object.freeze(templateValue.panels.map((panel) => Object.freeze({ ...panel }))),
    steps: Object.freeze(templateValue.steps.map((step) => Object.freeze({ ...step }))),
    gates: Object.freeze({
      confirmation_required: templateValue.confirmation_required,
      approval_required: templateValue.approval_required,
      decision: templateValue.approval_required ? 'pending' : 'not_required',
    }),
    created: 'sample-preview',
  });
}

/**
 * Build a ready-to-render sample page or workflow definition for a known
 * department template. It is a deterministic demo result—not durable creation
 * and not authority to alter a real desktop page or business system.
 */
export function createCoraDesktopWorkflowPreview(input) {
  if (!isObject(input) || !exactKeys(input, TOP_LEVEL_KEYS) || input.mode !== 'sample') {
    return fail('CORA_DESKTOP_WORKFLOW_REQUEST_INVALID');
  }
  const scope = scopeOf(input);
  if (!scope) return fail('CORA_DESKTOP_WORKFLOW_SCOPE_INVALID', 'rejected');
  if (!BUILD_ROLES.includes(scope.actor_role)) {
    return fail('CORA_DESKTOP_WORKFLOW_ROLE_NOT_ALLOWED', 'rejected');
  }
  if (!isObject(input.request) || !exactKeys(input.request, REQUEST_KEYS)) {
    return fail('CORA_DESKTOP_WORKFLOW_REQUEST_INVALID');
  }
  const { department, kind, template_id: templateId } = input.request;
  if (!MODES.includes(kind) || typeof department !== 'string' || typeof templateId !== 'string'
      || !SAFE_ID.test(templateId)) {
    return fail('CORA_DESKTOP_WORKFLOW_REQUEST_INVALID');
  }
  const templateValue = CORA_DESKTOP_WORKFLOW_TEMPLATES[templateId];
  if (!templateValue || templateValue.department !== department) {
    return fail('CORA_DESKTOP_WORKFLOW_TEMPLATE_INVALID', 'rejected');
  }

  const desktopProjection = projectCoraSurfaceIntentToDesktop({
    tenant_id: scope.tenant_id,
    authorized_tenant_ids: [scope.tenant_id],
    actor_role: scope.actor_role,
    mode: 'sample',
    intent: 'open-surface',
    request: { surface: templateValue.surface, request: {} },
  });
  if (desktopProjection.valid !== true) {
    return fail('CORA_DESKTOP_WORKFLOW_SURFACE_UNAVAILABLE', 'rejected');
  }

  return freeze({
    schemaVersion: CORA_DESKTOP_WORKFLOW_STUDIO_SCHEMA_VERSION,
    format: CORA_DESKTOP_WORKFLOW_STUDIO_FORMAT,
    mode: 'sample-data-only',
    valid: true,
    status: 'preview-ready',
    scope,
    definition: viewFor(templateValue, kind),
    desktop: desktopProjection.desktop,
    audit_refs: Object.freeze([auditRef(scope, templateValue.template_id, kind)]),
    persistence: 'not_performed',
    execution: 'not-wired',
    authorization: 'not_evaluated',
    invocation: 'not_performed',
  });
}

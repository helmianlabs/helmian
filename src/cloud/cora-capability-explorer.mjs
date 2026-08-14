import { HELMIAN_ACTION_TOOL_NAMES } from './tenant-action-policy.mjs';
import { AIMFORGE_HAND_LABELS } from '../cora/clm-server.mjs';
import { evaluateCoraActionPolicy } from '../cora/action-policy.mjs';
import { CORA_ROUTING_TASK_CLASSES } from '../cora/routing-policy.mjs';

const NORMAL = new Set(['aimforge_get_dispatch_board_summary', 'aimforge_prepare_driver_message', 'aimforge_get_equipment_safety_status', 'aimforge_record_equipment_safety_check']);
const CONFIRMATION = new Set(['aimforge_create_department_handoff', 'aimforge_request_safety_supervisor_review']);
const CLASS_FOR = Object.freeze({
  aimforge_get_dispatch_board_summary: 'read',
  aimforge_prepare_driver_message: 'prepare',
  aimforge_get_equipment_safety_status: 'read',
  aimforge_record_equipment_safety_check: 'prepare',
  aimforge_create_department_handoff: 'prepare',
  aimforge_request_safety_supervisor_review: 'prepare',
});

function capability(name) {
  const action = CLASS_FOR[name];
  const policy = CONFIRMATION.has(name)
    ? evaluateCoraActionPolicy({ action, in_scope: true, role_verified: true, external_write: true })
    : evaluateCoraActionPolicy({ action, in_scope: true, role_verified: true });
  return Object.freeze({ name, label: AIMFORGE_HAND_LABELS[name], classification: CONFIRMATION.has(name) ? 'confirmation_or_approval_required' : NORMAL.has(name) ? 'normal_immediate' : 'unavailable', policyDecision: policy.decision, policyReason: policy.reason ?? policy.reasons?.join(', ') ?? 'policy unavailable', registration: 'fixed_manifest', execution: 'not_performed', providerInvocation: 'not_performed', externalWrite: 'not_performed' });
}

export function buildCoraCapabilityExplorer({ configResult = null, admin = false } = {}) {
  const published = configResult?.status === 'published' && configResult.config;
  const config = published ? configResult.config.config : null;
  const routing = config?.routingPolicy ?? null;
  const routingState = routing ? 'published' : 'unavailable';
  return Object.freeze({
    format: 'cora.capability-explorer.v1',
    source: { manifest: 'src/cora/clm-server.mjs:AIMFORGE_HAND_LABELS', actionPolicy: 'src/cora/action-policy.mjs:cora.action-policy.v1', routingPolicy: 'src/cora/routing-policy.mjs:cora.routing-policy.v1' },
    capabilities: Object.freeze(HELMIAN_ACTION_TOOL_NAMES.map(capability)),
    normalWork: Object.freeze(['navigate', 'read', 'draft', 'prepare', 'in-scope record'].map((name) => Object.freeze({ name, classification: 'normal_immediate', policyDecision: 'allow', policyReason: 'normal in-scope action for verified role', execution: 'not_performed' }))),
    highRisk: Object.freeze(['external_write', 'irreversible', 'credential_access', 'money', 'delete', 'publish', 'permission_change', 'identity_change', 'safety_release'].map((name) => Object.freeze({ name, classification: 'confirmation_or_approval_required', policyDecision: 'step-up', policyReason: `${name} requires confirmation or approval`, execution: 'not_performed' }))),
    routing: admin ? { state: routingState, version: routing?.version ?? null, entries: routing?.entries ?? [], approvedModelCatalog: config?.approvedModelCatalog ?? [], providerInvocation: 'not_performed' } : { state: routingState, detail: 'admin_configuration_only' },
    taskClasses: Object.freeze(CORA_ROUTING_TASK_CLASSES.map((taskClass) => Object.freeze({ taskClass, state: routing?.entries?.some((entry) => entry.taskClass === taskClass) ? 'configured' : 'unavailable', execution: 'not_performed', providerInvocation: 'not_performed' }))),
    currentExecution: Object.freeze({ execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', externalWrite: 'not_performed' }),
    providerCalls: 'not_performed',
  });
}

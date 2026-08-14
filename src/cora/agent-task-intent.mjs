export const CORA_AGENT_TASK_FORMAT = 'cora.agent-task-intent.v1';
const TASK_TYPES = new Set(['workspace_preview', 'browser_check']);
const INTENTS = new Set(['draft', 'prepare']);
const ALLOWED_KEYS = new Set(['taskType', 'task_type', 'goal', 'contextRef', 'context_ref', 'department', 'costCenter', 'cost_center', 'intent', 'idempotencyKey', 'idempotency_key']);

function text(value, name, max, optional = false) {
  if (value == null && optional) return null;
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

export function normalizeAgentTaskIntent(input = {}) {
  if (input && typeof input === 'object' && ['tenantId', 'tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(input, key))) throw new Error('agent task intent cannot select tenant, Organization, Plant, or facility authority');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('agent task intent contains unsupported fields');
  const taskType = text(input.taskType ?? input.task_type, 'task type', 48).toLowerCase();
  const intent = text(input.intent, 'task intent', 16).toLowerCase();
  if (!TASK_TYPES.has(taskType) || !INTENTS.has(intent)) throw new Error('task type or intent is unsupported');
  const contextRef = text(input.contextRef ?? input.context_ref, 'task context reference', 240, true);
  if (taskType === 'browser_check' && (!contextRef || !/^browser-target:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(contextRef))) throw new Error('browser check requires a bounded browser-target reference');
  return Object.freeze({
    taskType, intent,
    goal: text(input.goal, 'task goal', 1000),
    contextRef,
    department: text(input.department, 'task department', 160, true),
    costCenter: text(input.costCenter ?? input.cost_center, 'task cost center', 120, true),
    idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'task idempotency key', 200),
  });
}

export function buildAgentTaskReceipt({ task, receiptId, status = task?.intent, replayed = false } = {}) {
  const normalized = normalizeAgentTaskIntent(task);
  if (!['draft', 'prepared'].includes(status)) throw new Error('task status is invalid');
  return Object.freeze({ format: CORA_AGENT_TASK_FORMAT, valid: true, taskType: normalized.taskType, intent: normalized.intent, status, goal: normalized.goal, contextRef: normalized.contextRef, department: normalized.department, costCenter: normalized.costCenter, receiptId: text(receiptId, 'task receipt', 256), replayed: replayed === true, execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed' });
}

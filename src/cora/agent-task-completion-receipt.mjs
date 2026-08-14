export const CORA_AGENT_TASK_COMPLETION_FORMAT = 'cora.agent-task-completion-receipt.v1';

const STATUSES = new Set(['finished', 'failed']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

export function normalizeAgentTaskCompletion(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ['tenantId', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id', 'provider', 'model'].some((key) => Object.hasOwn(input, key))) throw new Error('completion receipt cannot select tenant, Organization, Plant, facility, provider, or model authority');
  const status = text(input.status, 'completion status', 16).toLowerCase();
  if (!STATUSES.has(status)) throw new Error('completion status is invalid');
  const evidenceRef = text(input.evidenceRef, 'execution evidence reference', 512);
  if (input.execution !== 'performed') throw new Error('finished or failed completion requires performed execution evidence');
  return Object.freeze({ status, evidenceRef, failureCode: input.failureCode == null ? null : text(input.failureCode, 'failure code', 96).toLowerCase(), idempotencyKey: text(input.idempotencyKey, 'completion idempotency key', 200) });
}

export function buildAgentTaskCompletionReceipt({ taskId, claimId, workerId, status, evidenceRef, failureCode = null, idempotencyKey, replayed = false } = {}) {
  const completion = normalizeAgentTaskCompletion({ status, evidenceRef, failureCode, idempotencyKey, execution: 'performed' });
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1 || !/^worker:[a-z0-9][a-z0-9._:-]{0,95}$/u.test(String(workerId ?? ''))) throw new Error('completion worker identity is invalid');
  return Object.freeze({ format: CORA_AGENT_TASK_COMPLETION_FORMAT, valid: true, taskId: id, claimId: text(claimId, 'claim id', 256), workerId: String(workerId), completionStatus: completion.status, execution: 'performed', evidenceRef: completion.evidenceRef, failureCode: completion.failureCode, idempotencyKey: completion.idempotencyKey, replayed: replayed === true });
}

export function buildNotExecutedTaskCompletion({ taskId, claimStatus = 'unclaimed', source = 'no_worker_completion_receipt' } = {}) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('task identity is invalid');
  return Object.freeze({ format: CORA_AGENT_TASK_COMPLETION_FORMAT, valid: true, taskId: id, claimStatus, completionStatus: 'not_executed', execution: 'not_performed', evidenceRef: null, failureCode: null, source });
}

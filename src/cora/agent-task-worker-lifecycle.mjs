export const CORA_AGENT_TASK_WORKER_LIFECYCLE_FORMAT = 'cora.agent-task-worker-lifecycle.v1';

const STATUSES = new Set(['retry_scheduled', 'finished', 'failed']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

export function normalizeWorkerLifecycleEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ['tenantId', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id', 'provider', 'model'].some((key) => Object.hasOwn(input, key))) throw new Error('worker lifecycle cannot select tenant, Organization, Plant, facility, provider, or model authority');
  const status = text(input.status, 'lifecycle status', 32).toLowerCase();
  if (!STATUSES.has(status)) throw new Error('lifecycle status is invalid');
  const attemptNo = Number(input.attemptNo);
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > 1000) throw new Error('attempt number is invalid');
  const execution = input.execution === 'performed' ? 'performed' : input.execution === 'not_performed' ? 'not_performed' : '';
  if (!execution || (status === 'retry_scheduled' && execution !== 'not_performed') || (status !== 'retry_scheduled' && execution !== 'performed')) throw new Error('lifecycle execution state is invalid');
  const evidenceSha256 = text(input.evidenceSha256, 'evidence sha256', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(evidenceSha256)) throw new Error('evidence sha256 is invalid');
  return Object.freeze({ status, attemptNo, execution, evidenceRef: text(input.evidenceRef, 'evidence reference', 512), evidenceSha256, failureCode: input.failureCode == null ? null : text(input.failureCode, 'failure code', 96).toLowerCase(), idempotencyKey: text(input.idempotencyKey, 'lifecycle idempotency key', 200) });
}

export function buildWorkerLifecycleEvent({ taskId, claimId, workerId, status, attemptNo, execution, evidenceRef, evidenceSha256, failureCode = null, idempotencyKey, replayed = false } = {}) {
  const event = normalizeWorkerLifecycleEvent({ status, attemptNo, execution, evidenceRef, evidenceSha256, failureCode, idempotencyKey });
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1 || !/^worker:[a-z0-9][a-z0-9._:-]{0,95}$/u.test(String(workerId ?? ''))) throw new Error('lifecycle worker identity is invalid');
  return Object.freeze({ format: CORA_AGENT_TASK_WORKER_LIFECYCLE_FORMAT, valid: true, taskId: id, claimId: text(claimId, 'claim id', 256), workerId: String(workerId), attemptNo: event.attemptNo, lifecycleStatus: event.status, execution: event.execution, evidenceRef: event.evidenceRef, evidenceSha256: event.evidenceSha256, failureCode: event.failureCode, idempotencyKey: event.idempotencyKey, replayed: replayed === true });
}

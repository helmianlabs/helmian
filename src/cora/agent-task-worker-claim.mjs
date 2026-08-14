import { randomUUID } from 'node:crypto';

export const CORA_AGENT_TASK_CLAIM_FORMAT = 'cora.agent-task-worker-claim.v1';

export function requireAuthorizedWorker(actor = {}) {
  if (['tenant_id', 'organizationId', 'organization_id', 'plantId', 'plant_id', 'facilityId', 'facility_id'].some((key) => Object.hasOwn(actor, key))) throw new Error('authorized internal worker identity cannot select Organization, Plant, or facility authority');
  if (actor.kind !== 'internal_worker' || actor.verified !== true || actor.role !== 'worker' || actor.membershipVerified !== true) throw new Error('authorized internal worker identity is required');
  if (!actor.tenantId || !actor.subject || !/^worker:[a-z0-9][a-z0-9._:-]{0,95}$/u.test(String(actor.workerId ?? ''))) throw new Error('authorized internal worker identity is invalid');
  return Object.freeze({ ...actor, workerId: String(actor.workerId) });
}

export function buildAgentTaskClaimReceipt({ taskId, taskReceiptId, claimId = randomUUID(), workerId, replayed = false } = {}) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1 || !/^worker:[a-z0-9][a-z0-9._:-]{0,95}$/u.test(String(workerId ?? ''))) throw new Error('task claim identity is invalid');
  return Object.freeze({ format: CORA_AGENT_TASK_CLAIM_FORMAT, valid: true, taskId: id, taskReceiptId: String(taskReceiptId ?? '').slice(0, 256), claimId: String(claimId).slice(0, 256), workerId: String(workerId), claimStatus: 'claimed', taskStatus: 'prepared', replayed: replayed === true, execution: 'not_performed', providerInvocation: 'not_performed', agentInvocation: 'not_performed', filesystemMutation: 'not_performed' });
}

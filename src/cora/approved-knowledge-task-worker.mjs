import { createHash } from 'node:crypto';
import { CORA_APPROVED_KNOWLEDGE_TASK, createApprovedKnowledgeExecutionAdapter } from './agent-execution-adapter.mjs';

function text(value, name, max = 1000) { const result = String(value ?? '').trim(); if (!result || result.length > max) throw new Error(`${name} is invalid`); return result; }
function resultKey(claim, actor) { return createHash('sha256').update(`approved-knowledge:${claim.claimId}:${actor.sessionId}:${claim.taskId}`).digest('hex'); }

export function createApprovedKnowledgeTaskWorker({ taskRepository, resultRepository, knowledgeRepository, routingPolicyLookup }) {
  if (!taskRepository || !resultRepository || !knowledgeRepository || typeof routingPolicyLookup !== 'function') throw new Error('approved knowledge worker dependencies are required');
  return Object.freeze({
    async run({ worker, actor, taskId, claimIdempotencyKey }) {
      if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization actor context is required');
      const claim = await taskRepository.claimPrepared(worker, { taskId, idempotencyKey: text(claimIdempotencyKey, 'claim idempotency key', 200) });
      if (claim.taskType !== CORA_APPROVED_KNOWLEDGE_TASK) throw new Error('only approved knowledge tasks are executable');
      const task = (await taskRepository.list(actor, 100)).receipts.find((item) => Number(item.taskId) === Number(taskId));
      if (!task || task.taskType !== CORA_APPROVED_KNOWLEDGE_TASK || task.status !== 'prepared') throw new Error('prepared approved knowledge task was not found');
      const signedOrganizationContext = Object.freeze({ format: 'cora.signed-organization-context.v1', verified: true, membershipVerified: true, tenantId: actor.tenantId, subjectId: actor.subject, role: actor.role, sessionId: actor.sessionId, receiptId: task.receiptId });
      const service = createApprovedKnowledgeExecutionAdapter({
        knowledgeLookup: async ({ query }) => {
          const result = await knowledgeRepository.queryApprovedKnowledge(actor, query);
          return { status: result.status === 'approved_sources_only' ? 'source_ready' : 'unavailable', excerpts: result.excerpts.map(({ excerpt, citation, provenance }) => ({ excerpt, citation, provenance })) };
        },
        routingPolicyLookup,
        receiptSink: async ({ receipt }) => resultRepository.append(worker, { ...receipt, idempotencyKey: resultKey(claim, actor) }),
      });
      return service.execute({ worker, claim, signedOrganizationContext, query: task.goal });
    },
  });
}

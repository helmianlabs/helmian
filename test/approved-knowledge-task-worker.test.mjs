import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovedKnowledgeTaskWorker } from '../src/cora/approved-knowledge-task-worker.mjs';

const actor = { tenantId: 'org-a', subject: 'member-a', role: 'member', sessionId: 'session-a', requestId: 'request-a' };
const worker = { kind: 'internal_worker', verified: true, membershipVerified: true, role: 'worker', subject: 'worker-a', workerId: 'worker:approved-knowledge', tenantId: 'org-a', sessionId: 'worker-session', requestId: 'worker-request' };
const task = { taskId: 7, taskType: 'approved_knowledge_lookup', status: 'prepared', goal: 'hours service', receiptId: 'task-receipt-7' };
const catalog = [{ id: 'text-primary', provider: 'catalog-only', model: 'catalog-only', version: '1', status: 'approved', source: 'test' }];
const policy = { version: 1, entries: ['voice_conversation', 'cited_knowledge', 'safe_action_preparation', 'artifact_execution_request'].map((taskClass) => ({ taskClass, allowedCatalogIds: ['text-primary'], defaultCatalogId: 'text-primary', fallbackCatalogIds: [], budgetTier: 'low', latencyTier: 'interactive', userSelectable: false, usageWorkflow: 'cora.knowledge', usageAction: 'lookup', modality: 'text' })) };

test('approved knowledge worker claims, reads stored evidence, and persists a provider-free result', async () => {
  const calls = []; const persisted = [];
  const service = createApprovedKnowledgeTaskWorker({
    taskRepository: {
      async claimPrepared(actualWorker, input) { calls.push(['claim', actualWorker, input]); return { taskId: 7, taskReceiptId: task.receiptId, taskType: task.taskType, claimId: 'claim-0007', workerId: worker.workerId, claimStatus: 'claimed', taskStatus: 'prepared', valid: true, format: 'cora.agent-task-worker-claim.v1', execution: 'not_performed', agentInvocation: 'not_performed', providerInvocation: 'not_performed', filesystemMutation: 'not_performed' }; },
      async list(actualActor) { calls.push(['list', actualActor]); return { receipts: [task] }; },
    },
    resultRepository: { async append(actualWorker, receipt) { persisted.push({ actualWorker, receipt }); return { durable: true, resultReceiptId: 'result-0007' }; } },
    knowledgeRepository: { async queryApprovedKnowledge(actualActor, query) { calls.push(['knowledge', actualActor, query]); return { status: 'approved_sources_only', excerpts: [{ excerpt: 'Stored hours-of-service excerpt.', citation: 'FMCSA §3', provenance: 'reviewed source' }] }; } },
    routingPolicyLookup: async ({ tenantId, subjectId }) => ({ tenantId, subjectId, routingPolicy: policy, approvedCatalog: catalog }),
  });
  const result = await service.run({ worker, actor, taskId: 7, claimIdempotencyKey: 'claim-run-0007' });
  assert.equal(result.status, 'source_ready');
  assert.equal(result.providerInvocation, 'not_performed');
  assert.equal(result.filesystemMutation, 'not_performed');
  assert.equal(result.agentInvocation, 'not_performed');
  assert.equal(result.excerpts[0].citation, 'FMCSA §3');
  assert.equal(calls.filter(([name]) => name === 'knowledge').length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].receipt.status, 'source_ready');
  assert.equal(persisted[0].receipt.idempotencyKey.length, 64);
});

test('approved knowledge worker refuses a non-knowledge task before lookup or persistence', async () => {
  const service = createApprovedKnowledgeTaskWorker({
    taskRepository: { async claimPrepared() { return { taskId: 7, taskType: 'workspace_preview' }; }, async list() { throw new Error('must not list'); } },
    resultRepository: { async append() { throw new Error('must not persist'); } },
    knowledgeRepository: { async queryApprovedKnowledge() { throw new Error('must not query'); } },
    routingPolicyLookup: async () => ({ routingPolicy: policy, approvedCatalog: catalog }),
  });
  await assert.rejects(() => service.run({ worker, actor, taskId: 7, claimIdempotencyKey: 'claim-run-0007' }), /only approved knowledge/u);
});

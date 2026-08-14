import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovedKnowledgeExecutionAdapter, CORA_APPROVED_KNOWLEDGE_TASK, requireSignedOrganizationContext } from '../src/cora/agent-execution-adapter.mjs';
import { buildAgentTaskClaimReceipt } from '../src/cora/agent-task-worker-claim.mjs';
import { evaluateCoraActionPolicy } from '../src/cora/action-policy.mjs';

const worker = { kind: 'internal_worker', verified: true, membershipVerified: true, role: 'worker', subject: 'worker-service', workerId: 'worker:cloud', tenantId: 'org-a' };
const context = { format: 'cora.signed-organization-context.v1', verified: true, membershipVerified: true, tenantId: 'org-a', subjectId: 'user-a', role: 'member', sessionId: 'session-a', receiptId: 'signed-receipt-a' };
const claim = { ...buildAgentTaskClaimReceipt({ taskId: 4, taskReceiptId: 'task-receipt-4', claimId: 'claim-4', workerId: worker.workerId }), taskType: CORA_APPROVED_KNOWLEDGE_TASK };
const approvedCatalog = [{ id: 'text-primary', provider: 'openai', model: 'text-v1', version: '1', status: 'approved', source: 'reviewed catalog' }];
const routingPolicy = { version: 1, entries: ['voice_conversation', 'cited_knowledge', 'safe_action_preparation', 'artifact_execution_request'].map((taskClass) => ({ taskClass, allowedCatalogIds: ['text-primary'], defaultCatalogId: 'text-primary', fallbackCatalogIds: [], budgetTier: 'low', latencyTier: 'interactive', userSelectable: false, usageWorkflow: 'cora.knowledge', usageAction: 'lookup', modality: 'text' })) };

function adapter(result, options = {}) {
  const receipts = [];
  return { receipts, service: createApprovedKnowledgeExecutionAdapter({ routingPolicy, approvedCatalog, ...options, knowledgeLookup: async (input) => { receipts.push({ lookup: input }); return result; }, receiptSink: async ({ receipt }) => { receipts.push({ receipt }); return { recorded: true }; } }) };
}

test('provider-free knowledge execution returns stored evidence and null usage with replay safety', async () => {
  const { receipts, service } = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'Stored manual excerpt.', citation: 'Manual §2', provenance: 'approved-pack-v1' }] });
  const first = await service.execute({ worker, claim, signedOrganizationContext: context, query: 'manual' });
  const replay = await service.execute({ worker, claim, signedOrganizationContext: context, query: 'ignored on replay' });
  assert.equal(first.status, 'source_ready'); assert.equal(first.answer, null); assert.equal(first.execution, 'not_performed'); assert.equal(first.providerInvocation, 'not_performed');
  assert.equal(first.usage.estimatedCostMinor, null); assert.equal(first.usage.outputTokens, null); assert.equal(first.excerpts[0].citation, 'Manual §2');
  assert.equal(first.routing.status, 'allowed'); assert.equal(first.routing.route.catalogId, 'text-primary'); assert.equal(first.usageLedger.action, 'lookup');
  assert.equal(replay.replayed, true); assert.equal(receipts.filter((item) => item.receipt).length, 1); assert.equal(receipts.filter((item) => item.lookup).length, 1);
});

test('routing policy blocks, steps up, and closes with no_route without invoking the adapter', async () => {
  const blocked = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'unused', citation: 'c' }] });
  const blockedResult = await blocked.service.execute({ worker, claim, signedOrganizationContext: context, query: 'x', requestedBudgetTier: 'high' });
  assert.equal(blockedResult.status, 'blocked'); assert.equal(blockedResult.execution, 'not_performed'); assert.equal(blocked.receipts.some((item) => item.lookup), false);
  const approval = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'unused', citation: 'c' }] });
  const approvalResult = await approval.service.execute({ worker, claim, signedOrganizationContext: { ...context, receiptId: 'signed-receipt-c' }, query: 'x', external: true });
  assert.equal(approvalResult.status, 'approval_required'); assert.equal(approvalResult.routing.route.catalogId, 'text-primary');
  const unavailable = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'unused', citation: 'c' }] }, { routingPolicy: null });
  const noRoute = await unavailable.service.execute({ worker, claim, signedOrganizationContext: { ...context, receiptId: 'signed-receipt-d' }, query: 'x' });
  assert.equal(noRoute.status, 'no_route'); assert.equal(noRoute.routing.reason, 'published routing policy is unavailable'); assert.equal(unavailable.receipts.some((item) => item.lookup), false);
});

test('routing policy lookup is server-owned and receives only verified Organization context', async () => {
  const calls = [];
  const { service } = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'stored', citation: 'Manual §1' }] }, { routingPolicy: null, routingPolicyLookup: async ({ tenantId, subjectId }) => { calls.push({ tenantId, subjectId }); return { tenantId, routingPolicy, approvedCatalog }; } });
  const result = await service.execute({ worker, claim, signedOrganizationContext: context, query: 'stored' });
  assert.equal(result.status, 'source_ready');
  assert.deepEqual(calls, [{ tenantId: 'org-a', subjectId: 'user-a' }]);
  await assert.rejects(() => adapter({ status: 'source_ready', excerpts: [{ excerpt: 'x', citation: 'c' }] }, { routingPolicy: null, routingPolicyLookup: async () => ({ tenantId: 'org-b', routingPolicy, approvedCatalog }) }).service.execute({ worker, claim, signedOrganizationContext: { ...context, receiptId: 'signed-receipt-e' }, query: 'x' }), /Organization does not match/u);
});

test('unavailable evidence is truthful and never fabricates provider usage', async () => {
  const { service } = adapter({ status: 'unavailable', excerpts: [] });
  const result = await service.execute({ worker, claim, signedOrganizationContext: { ...context, receiptId: 'signed-receipt-b' }, query: 'FMCSA' });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.usage, { requestedTokens: null, inputTokens: null, outputTokens: null, audioSeconds: null, imageUnits: null, videoUnits: null, estimatedCostMinor: null, reconciledCostMinor: null, providerRequestRef: null });
});

test('worker, signed Organization, task class, and authority boundaries fail closed', async () => {
  const { service } = adapter({ status: 'source_ready', excerpts: [{ excerpt: 'x', citation: 'c' }] });
  await assert.rejects(() => service.execute({ worker: { ...worker, role: 'member' }, claim, signedOrganizationContext: context, query: 'x' }), /internal worker/u);
  await assert.rejects(() => service.execute({ worker, claim, signedOrganizationContext: { ...context, tenantId: 'org-b' }, query: 'x' }), /do not match/u);
  await assert.rejects(() => service.execute({ worker, claim: { ...claim, taskType: 'filesystem_build' }, signedOrganizationContext: context, query: 'x' }), /read-only knowledge/u);
  await assert.rejects(() => service.execute({ worker, claim, signedOrganizationContext: { ...context, plantId: 'plant-1' }, query: 'x' }), /Plant/u);
  await assert.rejects(() => service.execute({ worker, claim, signedOrganizationContext: { ...context, verified: false }, query: 'x' }), /verified signed/u);
  await assert.rejects(() => service.execute({ worker, claim: { ...claim, provider: 'openai' }, signedOrganizationContext: context, query: 'x' }), /provider or model/u);
  assert.equal(requireSignedOrganizationContext(context).tenantId, 'org-a');
  assert.equal(evaluateCoraActionPolicy({ action: 'read', in_scope: true, role_verified: true }).decision, 'allow');
  assert.equal(evaluateCoraActionPolicy({ action: 'publish', in_scope: true, role_verified: true, publish: true }).decision, 'step-up');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArtifactExecutionReceipt, normalizeArtifactExecutionRequest } from '../src/cora/artifact-execution-request.mjs';

const request = { artifactReceiptId: 'artifact-0001', scriptReceiptId: 'script-0001', sourceLinkReceiptIds: ['link-0001'], catalogEntryId: 'catalog-text-1', provider: 'approved-provider', model: 'approved-model', modality: 'text', estimatedCostMinor: 25, currency: 'USD', externalExecution: true, idempotencyKey: 'execution-0001' };

test('execution request is bounded, catalog-shaped, and truthful about non-execution', () => {
  const normalized = normalizeArtifactExecutionRequest(request);
  const receipt = buildArtifactExecutionReceipt({ request: normalized, receiptId: 'receipt-0001', actorSubject: 'user-1', role: 'member', budget: { period: 'monthly', currency: 'USD', softLimitMinor: 100, hardLimitMinor: 1000, lowCostLimitMinor: 50, policyState: 'active' } });
  assert.equal(receipt.status, 'approval_required'); assert.equal(receipt.policyDecision, 'step-up'); assert.equal(receipt.execution, 'not_executed'); assert.equal(receipt.providerInvocation, 'not_performed'); assert.equal(receipt.media, 'not_generated');
});

test('approval queues only for an authorized role and hard budget blocks', () => {
  const approved = buildArtifactExecutionReceipt({ request: { ...request, approvalRef: 'approval-0001' }, receiptId: 'receipt-0002', actorSubject: 'admin-1', role: 'admin', budget: { period: 'monthly', currency: 'USD', softLimitMinor: 100, hardLimitMinor: 1000, lowCostLimitMinor: 50, policyState: 'active' } });
  const blocked = buildArtifactExecutionReceipt({ request, receiptId: 'receipt-0003', actorSubject: 'user-1', role: 'member', budget: { period: 'monthly', currency: 'USD', softLimitMinor: 5, hardLimitMinor: 10, lowCostLimitMinor: 2, policyState: 'active' } });
  assert.equal(approved.status, 'queued'); assert.equal(approved.execution, 'not_executed'); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.policyDecision, 'deny');
});

test('client authority and raw prompt/secret fields are rejected', () => {
  assert.throws(() => normalizeArtifactExecutionRequest({ ...request, plantId: 'plant-1' }), /authority/u);
  assert.throws(() => normalizeArtifactExecutionRequest({ ...request, prompt: 'secret' }), /unsupported/u);
  assert.throws(() => normalizeArtifactExecutionRequest({ ...request, externalExecution: false }), /metadata/u);
});

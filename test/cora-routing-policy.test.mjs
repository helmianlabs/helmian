import assert from 'node:assert/strict';
import test from 'node:test';
import { CORA_ROUTING_POLICY_FORMAT, normalizeCoraRoutingPolicy, resolveCoraRouting } from '../src/cora/routing-policy.mjs';

const catalog = [
  { id: 'voice-primary', provider: 'hume', model: 'voice-v1', version: '1', status: 'approved', source: 'admin catalog' },
  { id: 'text-primary', provider: 'openai', model: 'text-v1', version: '1', status: 'approved', source: 'admin catalog' },
  { id: 'text-fallback', provider: 'anthropic', model: 'text-v2', version: '1', status: 'approved', source: 'admin catalog' },
];
const policy = { format: CORA_ROUTING_POLICY_FORMAT, version: 3, entries: [
  ['voice_conversation', 'voice-primary', 'audio', 'interactive', 'low', true, 'cora.voice', 'conversation'],
  ['cited_knowledge', 'text-primary', 'text', 'interactive', 'low', false, 'cora.knowledge', 'lookup'],
  ['safe_action_preparation', 'text-primary', 'text', 'standard', 'standard', true, 'cora.prepare', 'prepare'],
  ['artifact_execution_request', 'text-primary', 'text', 'batch', 'high', false, 'cora.artifact', 'execution_request'],
].map(([taskClass, id, modality, latencyTier, budgetTier, userSelectable, usageWorkflow, usageAction]) => ({ taskClass, allowedCatalogIds: [id], defaultCatalogId: id, fallbackCatalogIds: [], budgetTier, latencyTier, userSelectable, usageWorkflow, usageAction, modality })) };

test('routing policy is versioned, task-complete, catalog-bound, and carries ledger metadata', () => {
  const normalized = normalizeCoraRoutingPolicy(policy, catalog);
  assert.equal(normalized.version, 3);
  assert.equal(normalized.entries.length, 4);
  const result = resolveCoraRouting({ policy: normalized, approvedCatalog: catalog, taskClass: 'cited_knowledge', requestedCatalogId: 'text-primary' });
  assert.equal(result.selection, 'user_selected');
  assert.deepEqual(result.usageLedger, { workflow: 'cora.knowledge', action: 'lookup', modality: 'text' });
});

test('routing policy rejects Plant, unknown catalog, incomplete, and unauthorized user selection', () => {
  assert.throws(() => normalizeCoraRoutingPolicy({ ...policy, plantId: 'warehouse-1' }, catalog), /Plant/);
  assert.throws(() => normalizeCoraRoutingPolicy({ ...policy, entries: policy.entries.map((entry, index) => index === 0 ? { ...entry, allowedCatalogIds: ['secret-model'] } : entry) }, catalog), /unapproved/);
  assert.throws(() => normalizeCoraRoutingPolicy({ ...policy, entries: policy.entries.slice(0, 3) }, catalog), /every task class/);
  const result = resolveCoraRouting({ policy, approvedCatalog: catalog, taskClass: 'cited_knowledge', requestedCatalogId: 'text-fallback' });
  assert.equal(result.catalogId, 'text-primary');
  assert.equal(result.selection, 'policy_selected');
});

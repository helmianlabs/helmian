import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateUsageBudget, normalizeBudgetAllocation, normalizeBudgetPolicy, normalizeUsageRecord } from '../src/cora/provider-usage-ledger.mjs';

const base = { userSubject: 'user-a', actionType: 'read', provider: 'openai', model: 'unknown-until-receipt', modality: 'text', idempotencyKey: 'usage-0001', status: 'completed' };

test('usage records preserve absent actual usage and cost as null', () => {
  const record = normalizeUsageRecord(base);
  assert.equal(record.actualTokens, null);
  assert.equal(record.estimatedCostMinor, null);
  assert.equal(record.reconciledCostMinor, null);
  assert.equal(record.providerRequestRef, null);
});

test('usage rejects client Organization, Plant, negative cost, and unapproved step-up records', () => {
  assert.throws(() => normalizeUsageRecord({ ...base, tenantId: 'org-b' }), /cannot select tenant/);
  assert.throws(() => normalizeUsageRecord({ ...base, plantId: 'warehouse' }), /cannot select tenant/);
  assert.throws(() => normalizeUsageRecord({ ...base, estimatedCostMinor: -1 }), /estimated cost/);
  assert.throws(() => normalizeUsageRecord({ ...base, policyDecision: 'step-up' }), /approval reference/);
});

test('budget contract allows low-cost normal reads, steps up external work, and denies hard overage', () => {
  const budget = normalizeBudgetPolicy({ period: 'monthly', currency: 'USD', softLimitMinor: 1000, hardLimitMinor: 2000, lowCostLimitMinor: 100 });
  assert.equal(evaluateUsageBudget({ budget, action: 'read', estimatedCostMinor: 10 }).decision, 'allow');
  assert.equal(evaluateUsageBudget({ budget, action: 'read', estimatedCostMinor: 1500 }).decision, 'step-up');
  assert.equal(evaluateUsageBudget({ budget, action: 'prepare', estimatedCostMinor: 2500 }).decision, 'deny');
  assert.equal(evaluateUsageBudget({ budget, action: 'read', estimatedCostMinor: null }).state, 'cost_unknown');
  assert.equal(evaluateUsageBudget({ budget, action: 'write', external: true, estimatedCostMinor: 10 }).decision, 'step-up');
});

test('budget allocations are bounded Organization metadata and preserve unknown actuals', () => {
  const policy = normalizeBudgetPolicy({ softLimitMinor: 1000, hardLimitMinor: 2000, allocations: [{ allocationKey: 'ops', department: 'operations', softLimitMinor: 500, hardLimitMinor: 800 }] });
  assert.equal(policy.allocations[0].allocationKey, 'ops');
  assert.throws(() => normalizeBudgetAllocation({ allocationKey: 'bad', plantId: 'warehouse-1', department: 'operations' }), /authority/);
  assert.throws(() => normalizeBudgetAllocation({ allocationKey: 'bad' }), /department or cost center/);
});

test('usage schema is append-only and tenant idempotency is durable', async () => {
  const sql = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', '011_cora_provider_usage.sql'), 'utf8');
  assert.match(sql, /before update or delete on helmion\.cora_provider_usage/u);
  assert.match(sql, /unique \(tenant_id, idempotency_key\)/u);
  assert.match(sql, /current_setting\('helmion\.tenant_id', true\)/u);
});

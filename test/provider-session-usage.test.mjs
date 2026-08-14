import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProviderSessionUsage, recordProviderSessionUsage } from '../src/cora/provider-session-usage.mjs';

const bridgeContext = { tenantId: 'org-a', subjectId: 'user-a', role: 'member', sessionId: 'session-a', receiptId: 'receipt-a-0001' };

test('provider session usage records real signed-session outcomes without fabricating usage or cost', async () => {
  const calls = [];
  const append = async (actor, usage) => { calls.push({ actor, usage }); return { durable: true, replayed: false, event: { id: '1' } }; };
  const success = await recordProviderSessionUsage({ append, bridgeContext, outcome: 'success' });
  const failed = buildProviderSessionUsage({ bridgeContext, outcome: 'failed', providerRequestRef: 'hume-request-1' });
  assert.equal(success.recorded, true);
  assert.equal(calls[0].actor.tenantId, 'org-a');
  assert.equal(calls[0].usage.actualTokens, null);
  assert.equal(calls[0].usage.audioSeconds, null);
  assert.equal(calls[0].usage.estimatedCostMinor, null);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.providerRequestRef, 'hume-request-1');
});

test('provider session usage is replay-safe and rejects cross-Organization injection', async () => {
  const seen = new Map();
  const append = async (_actor, usage) => {
    if (seen.has(usage.idempotencyKey)) return { durable: true, replayed: true, event: seen.get(usage.idempotencyKey) };
    const event = { id: String(seen.size + 1) }; seen.set(usage.idempotencyKey, event); return { durable: true, replayed: false, event };
  };
  const first = await recordProviderSessionUsage({ append, bridgeContext, outcome: 'success' });
  const replay = await recordProviderSessionUsage({ append, bridgeContext, outcome: 'success' });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.throws(() => buildProviderSessionUsage({ bridgeContext: { ...bridgeContext, tenantId: '' }, outcome: 'success' }), /Organization session context/);
  await assert.rejects(() => recordProviderSessionUsage({ append, bridgeContext: { ...bridgeContext, plantId: 'warehouse' }, outcome: 'success' }), /client tenant|Organization|Plant/u);
});

test('missing usage sink does not add friction to a normal session', async () => {
  const result = await recordProviderSessionUsage({ bridgeContext, outcome: 'success' });
  assert.deepEqual(result, { recorded: false, reason: 'usage append adapter unavailable' });
});

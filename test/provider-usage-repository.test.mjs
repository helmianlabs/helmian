import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderUsageRepository } from '../src/cora/provider-usage-repository.mjs';

function fakePool() {
  const events = [];
  const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.startsWith('select role from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: 'member' }] };
    if (q.startsWith('insert into helmion.cora_provider_usage')) {
      const existing = events.find((row) => row.tenant_id === values[0] && row.idempotency_key === values[20]);
      if (existing) return { rowCount: 0, rows: [] };
      const row = { id: String(events.length + 1), tenant_id: values[0], department: values[1], cost_center: values[2], user_subject: values[3], action_type: values[4], workflow: values[5], provider: values[6], model: values[7], modality: values[8], requested_tokens: values[9], actual_tokens: values[10], audio_seconds: values[11], image_units: values[12], video_seconds: values[13], estimated_cost_minor: values[14], reconciled_cost_minor: values[15], currency: values[16], provider_request_ref: values[17], policy_decision: values[18], approval_ref: values[19], idempotency_key: values[20], status: values[21], started_at: values[22], completed_at: values[23], created_at: 'now' }; events.push(row); return { rowCount: 1, rows: [row] };
    }
    if (q.includes('where tenant_id=$1 and idempotency_key=$2')) { const row = events.find((item) => item.tenant_id === values[0] && item.idempotency_key === values[1]); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; }
    throw new Error(`Unexpected usage query: ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

const actor = { tenantId: 'org-a', subject: 'user-a', role: 'member', sessionId: 's1', requestId: 'r1' };
const input = { userSubject: 'user-a', actionType: 'read', provider: 'openai', model: 'unknown-until-receipt', modality: 'text', idempotencyKey: 'usage-0002', status: 'completed' };

test('usage repository is tenant-scoped and idempotent without fabricating actuals', async () => {
  const repo = createProviderUsageRepository(fakePool());
  const first = await repo.append(actor, input);
  const replay = await repo.append(actor, input);
  assert.equal(first.durable, true); assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  assert.equal(first.event.actualTokens, null); assert.equal(first.event.reconciledCostMinor, null);
  await assert.rejects(() => repo.append(actor, { ...input, organizationId: 'org-b', idempotencyKey: 'usage-0003' }), /cannot select tenant/);
});


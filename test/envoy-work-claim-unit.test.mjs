// Bite J: the claim statement's shape, pinned without a database —
// one statement per poll, duplicate (message, seat) pairs deduped
// before the statement (Postgres refuses to touch one row twice
// in a single upsert), takeover gated on the standing claim's
// expiry, and the won set taken from RETURNING alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claimWorkItems, WORK_CLAIM_TTL_MS } from '../src/cloud/envoy-mesh.mjs';

test('claimWorkItems: one statement, duplicate pairs deduped, the won set is the RETURNING set', async () => {
  const calls = [];
  const client = {
    async query(text, vals) {
      calls.push({ text: String(text), vals });
      return { rows: [{ message_id: 'm-1', seat: 'claude' }], rowCount: 1 };
    },
  };
  const won = await claimWorkItems(client, {
    tenantId: 't-1',
    claimedBy: 'user_x',
    at: Date.parse('2026-11-16T12:00:00.000Z'),
    items: [
      { channelId: 'c-1', messageId: 'm-1', seats: ['claude', 'gemini'] },
      { channelId: 'c-1', messageId: 'm-1', seats: ['claude'] },
    ],
  });
  assert.equal(calls.length, 1, 'exactly one statement decides the whole poll');
  assert.equal(calls[0].vals.length, 14, 'two unique pairs at seven values each — the repeated pair rides once');
  assert.ok(calls[0].text.includes('on conflict (tenant_id, message_id, seat) do update'), 'the arbitration is the conditional upsert');
  assert.ok(calls[0].text.includes('helmion.envoy_work_claims.expires_at <= excluded.claimed_at'), 'takeover only once the standing claim has expired');
  assert.deepEqual([...won], ['m-1|claude'], 'only what RETURNING returned was won');
  const expiry = Date.parse(calls[0].vals[6]);
  assert.equal(expiry - Date.parse(calls[0].vals[5]), WORK_CLAIM_TTL_MS, 'the lease written is the named TTL');
});

test('claimWorkItems: nothing to claim asks the database nothing', async () => {
  let calls = 0;
  const client = { async query() { calls += 1; return { rows: [], rowCount: 0 }; } };
  const won = await claimWorkItems(client, { tenantId: 't-1', claimedBy: 'user_x', at: 0, items: [] });
  assert.equal(calls, 0);
  assert.equal(won.size, 0);
});


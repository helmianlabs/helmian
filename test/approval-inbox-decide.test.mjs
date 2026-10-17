import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalInboxRepository } from '../src/cora/approval-inbox.mjs';

function fakePool({ requestStatus }) {
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.startsWith('select set_config')) return { rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'admin' }], rowCount: 1 };
      if (q.includes('from helmion.cora_artifact_execution_requests where')) {
        return { rows: [{ receipt_id: params[1], status: requestStatus }], rowCount: 1 };
      }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

const ACTOR = { tenantId: 't-a', subject: 'admin:1', role: 'admin', sessionId: 'session-1', requestId: 'request-1' };
const INPUT = { decision: 'approve', reason: 'looks good', requestKind: 'artifact_execution_request', requestReceiptId: 'exec-receipt-0001', idempotencyKey: 'idem-key-0001' };

test('decide() refuses pre-approved queued requests', async () => {
  const repo = createApprovalInboxRepository(fakePool({ requestStatus: 'queued' }));
  await assert.rejects(() => repo.decide(ACTOR, INPUT), /unavailable or already decided/);
});

test('decide() refuses blocked requests', async () => {
  const repo = createApprovalInboxRepository(fakePool({ requestStatus: 'blocked' }));
  await assert.rejects(() => repo.decide(ACTOR, INPUT), /unavailable or already decided/);
});

test('decide() refuses unknown requests', async () => {
  const empty = { connect: async () => ({ async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] }; if (q.startsWith('select set_config')) return { rows: [] }; if (q.includes('from helmion.tenant_memberships')) return { rows: [{ role: 'admin' }], rowCount: 1 }; if (q.includes('from helmion.cora_artifact_execution_requests where')) return { rows: [], rowCount: 0 }; throw new Error(`unexpected ${q}`); }, release() {} }) };
  const repo = createApprovalInboxRepository(empty);
  await assert.rejects(() => repo.decide(ACTOR, INPUT), /unavailable or already decided/);
});

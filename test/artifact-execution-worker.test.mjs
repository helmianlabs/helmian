import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactExecutionWorker, ARTIFACT_EXECUTION_WORKER_FORMAT } from '../src/cora/artifact-execution-worker.mjs';

function fakePool({ requests, decisions }) {
  const runs = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.includes('from helmion.cora_artifact_execution_requests r')) {
        return {
          rows: requests
            .filter((r) => decisions.some((d) => d.request_receipt_id === r.receipt_id && d.decision === 'approve') && !runs.some((run) => run.execution_request_id === r.id))
            .map((r) => ({ id: r.id, tenant_id: r.tenant_id, receipt_id: r.receipt_id, decision_receipt_id: decisions.find((d) => d.request_receipt_id === r.receipt_id).receipt_id })),
        };
      }
      if (q.startsWith('insert into helmion.cora_artifact_execution_runs')) { runs.push({ tenant_id: params[0], execution_request_id: params[1], request_receipt_id: params[2], decision_receipt_id: params[3], outcome: params[5], result: JSON.parse(params[6]) }); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, runs };
}

test('worker queues approved requests as needs_desktop and ignores the rest', async () => {
  const requests = [
    { id: 1, tenant_id: 't-a', receipt_id: 'exec-receipt-0001' },
    { id: 2, tenant_id: 't-a', receipt_id: 'exec-receipt-0002' },
    { id: 3, tenant_id: 't-a', receipt_id: 'exec-receipt-0003' },
  ];
  const decisions = [
    { request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' },
    { request_receipt_id: 'exec-receipt-0002', decision: 'reject', receipt_id: 'decision-receipt-0002' },
  ];
  const { pool, runs } = fakePool({ requests, decisions });
  const worker = createArtifactExecutionWorker({ pool, workerId: 'worker:test-artifact' });
  const done = await worker.runOnce();
  assert.equal(done.length, 1, 'only the approved request is claimed; rejected and undecided are untouched');
  assert.equal(done[0].outcome, 'needs_desktop');
  assert.equal(done[0].receiptId, 'exec-receipt-0001');
  assert.equal(runs[0].decision_receipt_id, 'decision-receipt-0001');
  assert.equal(runs[0].result.format, ARTIFACT_EXECUTION_WORKER_FORMAT);
  assert.match(runs[0].result.reason, /paired Helmian desktop/);
  assert.equal((await worker.runOnce()).length, 0, 'each request runs once');
});

test('worker is a no-op when migration 046 is not applied', async () => {
  const pool = { connect: async () => ({ async query(sql) { const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] }; const error = new Error('relation "helmion.cora_artifact_execution_runs" does not exist'); error.code = '42P01'; throw error; }, release() {} }) };
  const done = await createArtifactExecutionWorker({ pool }).runOnce();
  assert.deepEqual(done, []);
});

test('worker rejects invalid ids and missing pool', () => {
  assert.throws(() => createArtifactExecutionWorker({}));
  assert.throws(() => createArtifactExecutionWorker({ pool: { connect() {} }, workerId: 'bad' }));
});

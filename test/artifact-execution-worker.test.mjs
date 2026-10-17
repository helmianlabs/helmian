import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactExecutionWorker, ARTIFACT_EXECUTION_WORKER_FORMAT } from '../src/cora/artifact-execution-worker.mjs';

function fakePool({ requests, decisions, existingLeases = [] }) {
  const runs = [];
  const leases = existingLeases.map((l, i) => ({ id: i + 1, ...l }));
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.includes('from helmion.workspace_write_leases') && q.includes('for update')) {
        if (q.includes('lease_token=$2')) {
          const found = leases.find((l) => l.lease_token === params[1]);
          return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
        }
        const active = leases.find((l) => l.status === 'ACTIVE');
        return { rows: active ? [active] : [], rowCount: active ? 1 : 0 };
      }
      if (q.startsWith('insert into helmion.workspace_write_leases')) {
        if (leases.some((l) => l.status === 'ACTIVE')) { const error = new Error('duplicate'); error.code = '23505'; throw error; }
        leases.push({ id: leases.length + 1, tenant_id: params[0], project_key: params[1], holder: params[2], lease_token: params[3], status: 'ACTIVE', expires_at: params[4] });
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('update helmion.workspace_write_leases')) {
        const target = leases.find((l) => l.id === params[params.length - 1]);
        if (target) { target.status = q.includes("'expired'") ? 'EXPIRED' : 'RELEASED'; target.closed_at = new Date().toISOString(); }
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith('insert into helmion.audit_events')) return { rowCount: 1, rows: [{ id: '7' }] };
      if (q.includes('from helmion.cora_artifact_execution_requests r')) {
        return {
          rows: requests
            .filter((r) => {
              const approvedDecision = decisions.some((d) => d.request_receipt_id === r.receipt_id && d.decision === 'approve');
              const preapproved = r.status === 'queued' && r.approval_ref != null;
              const claimable = (r.status === 'approval_required' && approvedDecision) || preapproved;
              return claimable && !runs.some((run) => run.execution_request_id === r.id);
            })
            .map((r) => {
              const decision = decisions.find((d) => d.request_receipt_id === r.receipt_id && d.decision === 'approve');
              return { id: r.id, tenant_id: r.tenant_id, receipt_id: r.receipt_id, decision_receipt_id: decision ? decision.receipt_id : `approval_ref:${r.approval_ref}` };
            }),
        };
      }
      if (q.startsWith('insert into helmion.cora_artifact_execution_runs')) { runs.push({ tenant_id: params[0], execution_request_id: params[1], request_receipt_id: params[2], decision_receipt_id: params[3], outcome: params[5], result: JSON.parse(params[6]) }); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, runs, leases };
}

test('worker queues approved requests as needs_desktop and ignores the rest', async () => {
  const requests = [
    { id: 1, tenant_id: 't-a', receipt_id: 'exec-receipt-0001', status: 'approval_required' },
    { id: 2, tenant_id: 't-a', receipt_id: 'exec-receipt-0002', status: 'approval_required' },
    { id: 3, tenant_id: 't-a', receipt_id: 'exec-receipt-0003', status: 'approval_required' },
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

test('worker drains pre-approved queued requests without a decision row', async () => {
  const requests = [
    { id: 1, tenant_id: 't-a', receipt_id: 'exec-receipt-0001', status: 'queued', approval_ref: 'pre-approval-0001' },
    { id: 2, tenant_id: 't-a', receipt_id: 'exec-receipt-0002', status: 'approval_required' },
    { id: 3, tenant_id: 't-a', receipt_id: 'exec-receipt-0003', status: 'queued', approval_ref: null },
    { id: 4, tenant_id: 't-a', receipt_id: 'exec-receipt-0004', status: 'blocked' },
  ];
  const decisions = [];
  const { pool, runs } = fakePool({ requests, decisions });
  const worker = createArtifactExecutionWorker({ pool, workerId: 'worker:test-artifact' });
  const done = await worker.runOnce();
  assert.equal(done.length, 1, 'only the pre-approved queued request is drained; undecided, ref-less queued, and blocked are untouched');
  assert.equal(done[0].receiptId, 'exec-receipt-0001');
  assert.equal(done[0].outcome, 'needs_desktop');
  assert.equal(runs[0].decision_receipt_id, 'approval_ref:pre-approval-0001');
  assert.ok(runs.every((run) => run.outcome === 'needs_desktop'), 'the worker never writes completed or any other outcome');
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

test('worker skips items when the write lease is held and releases its own lease', async () => {
  const requests = [{ id: 1, tenant_id: 't-a', receipt_id: 'exec-receipt-0001', status: 'approval_required' }];
  const decisions = [{ request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' }];
  const held = {
    tenant_id: 't-a', project_key: null, holder: 'worker:other', lease_token: '11111111-1111-4111-8111-111111111111',
    status: 'ACTIVE', expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const { pool, runs, leases } = fakePool({ requests, decisions, existingLeases: [held] });
  const worker = createArtifactExecutionWorker({ pool, workerId: 'worker:test-artifact' });
  const done = await worker.runOnce();
  assert.deepEqual(done, [], 'held lease means nothing is recorded; items stay for the next drain');
  assert.equal(runs.length, 0);
  assert.equal(leases.filter((l) => l.status === 'ACTIVE').length, 1, 'the foreign lease is untouched');

  // Without the foreign lease, the worker acquires, records, and releases.
  const free = fakePool({ requests, decisions });
  const done2 = await createArtifactExecutionWorker({ pool: free.pool, workerId: 'worker:test-artifact' }).runOnce();
  assert.equal(done2.length, 1);
  assert.equal(free.leases.filter((l) => l.status === 'ACTIVE').length, 0, 'own lease is released after the run');
  assert.equal(free.leases.filter((l) => l.status === 'RELEASED').length, 1);
});

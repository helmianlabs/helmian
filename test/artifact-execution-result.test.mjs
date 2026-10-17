import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createArtifactExecutionRepository } from '../src/cora/artifact-execution-repository.mjs';

const SCRIPT_TEXT = 'Welcome to Helmian. This short narration introduces the governed workspace where every agent action is audited. Listen carefully as we walk through the main ideas together.';
const SCRIPT_HASH = createHash('sha256').update(SCRIPT_TEXT, 'utf8').digest('hex');
const WRONG_HASH = '0'.repeat(64);

function fakePool({ requests, decisions, scripts, runs }) {
  const auditEvents = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
      if (q.startsWith('select set_config')) return { rows: [] };
      if (q.includes('from helmion.tenant_memberships')) {
        return { rows: [{ role: 'member' }], rowCount: 1 };
      }
      if (q.includes('from helmion.cora_artifact_execution_requests where')) {
        const found = requests.find((r) => r.receipt_id === params[1]);
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (q.includes('from helmion.cora_approval_decisions')) {
        const found = decisions.filter((d) => d.request_receipt_id === params[1] && d.decision === 'approve');
        return { rows: found, rowCount: found.length };
      }
      if (q.includes('from helmion.cora_artifact_script_revisions')) {
        const found = scripts.find((s) => s.receipt_id === params[1]);
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (q.startsWith("update helmion.cora_artifact_execution_runs set outcome='completed'")) {
        const run = runs.find((r) => r.execution_request_id === params[1] && r.outcome === 'needs_desktop');
        if (!run) return { rows: [], rowCount: 0 };
        run.outcome = 'completed';
        run.result = JSON.parse(params[2]);
        return { rows: [{ id: run.id }], rowCount: 1 };
      }
      if (q.includes('from helmion.cora_artifact_execution_runs where')) {
        const found = runs.find((r) => r.execution_request_id === params[1]);
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (q.startsWith('insert into helmion.audit_events')) {
        auditEvents.push(JSON.parse(params[10]));
        return { rowCount: 1, rows: [{ id: String(auditEvents.length) }] };
      }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, runs, auditEvents };
}

const DESKTOP = { tenantId: 't-a', subject: 'device:paired-1' };
function resultInput(overrides = {}) {
  return {
    requestReceiptId: 'exec-receipt-0001',
    scriptContentHash: SCRIPT_HASH,
    artifactDescriptor: { modality: 'audio', outputRef: 'desktop-run-1' },
    completedAt: new Date(Date.now() - 60000).toISOString(),
    ...overrides,
  };
}
function approvedRequest() {
  return { id: 1, receipt_id: 'exec-receipt-0001', status: 'approval_required', approval_ref: null, script_receipt_id: 'script-receipt-0001' };
}

test('result ingestion rejects unapproved requests: the approval gate is not bypassable', async () => {
  const { pool } = fakePool({
    requests: [approvedRequest()],
    decisions: [],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [{ id: 9, execution_request_id: 1, outcome: 'needs_desktop', result: {} }],
  });
  const repo = createArtifactExecutionRepository(pool);
  await assert.rejects(() => repo.ingestResult(DESKTOP, resultInput()), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /not approved/);
    return true;
  });
});

test('result ingestion rejects hash mismatches against the approved script', async () => {
  const { pool, runs, auditEvents } = fakePool({
    requests: [approvedRequest()],
    decisions: [{ request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' }],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [{ id: 9, execution_request_id: 1, outcome: 'needs_desktop', result: {} }],
  });
  const repo = createArtifactExecutionRepository(pool);
  await assert.rejects(() => repo.ingestResult(DESKTOP, resultInput({ scriptContentHash: WRONG_HASH })), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /content hash does not match/);
    return true;
  });
  assert.equal(runs[0].outcome, 'needs_desktop', 'the run is untouched on mismatch');
  assert.equal(auditEvents.length, 0, 'nothing is audited on mismatch');
});

test('result ingestion transitions needs_desktop to completed for approved requests', async () => {
  const { pool, runs, auditEvents } = fakePool({
    requests: [approvedRequest()],
    decisions: [{ request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' }],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [{ id: 9, execution_request_id: 1, outcome: 'needs_desktop', result: {} }],
  });
  const repo = createArtifactExecutionRepository(pool);
  const result = await repo.ingestResult(DESKTOP, resultInput());
  assert.equal(result.durable, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.runId, '9');
  assert.equal(runs[0].outcome, 'completed');
  assert.equal(runs[0].result.scriptContentHash, SCRIPT_HASH);
  assert.equal(runs[0].result.reportedBy, 'device:paired-1');
  assert.equal(auditEvents.length, 1, 'the ingestion is audit-logged');
});

test('result ingestion accepts pre-approved queued requests with no decision row', async () => {
  const { pool, runs } = fakePool({
    requests: [{ id: 2, receipt_id: 'exec-receipt-0001', status: 'queued', approval_ref: 'pre-approval-0001', script_receipt_id: 'script-receipt-0001' }],
    decisions: [],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [{ id: 10, execution_request_id: 2, outcome: 'needs_desktop', result: {} }],
  });
  const repo = createArtifactExecutionRepository(pool);
  const result = await repo.ingestResult(DESKTOP, resultInput());
  assert.equal(result.outcome, 'completed');
  assert.equal(runs[0].outcome, 'completed');
});

test('result ingestion is idempotent for a repeated identical report', async () => {
  const { pool, runs, auditEvents } = fakePool({
    requests: [approvedRequest()],
    decisions: [{ request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' }],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [{ id: 9, execution_request_id: 1, outcome: 'completed', result: { scriptContentHash: SCRIPT_HASH } }],
  });
  const repo = createArtifactExecutionRepository(pool);
  const result = await repo.ingestResult(DESKTOP, resultInput());
  assert.equal(result.outcome, 'completed');
  assert.equal(result.runId, '9');
  assert.equal(runs[0].outcome, 'completed');
  assert.equal(auditEvents.length, 1);
});

test('result ingestion refuses when no desktop handoff is recorded yet', async () => {
  const { pool } = fakePool({
    requests: [approvedRequest()],
    decisions: [{ request_receipt_id: 'exec-receipt-0001', decision: 'approve', receipt_id: 'decision-receipt-0001' }],
    scripts: [{ receipt_id: 'script-receipt-0001', text: SCRIPT_TEXT }],
    runs: [],
  });
  const repo = createArtifactExecutionRepository(pool);
  await assert.rejects(() => repo.ingestResult(DESKTOP, resultInput()), (error) => {
    assert.equal(error.status, 409);
    return true;
  });
});

test('result ingestion rejects unknown requests and requires device identity', async () => {
  const { pool } = fakePool({ requests: [], decisions: [], scripts: [], runs: [] });
  const repo = createArtifactExecutionRepository(pool);
  await assert.rejects(() => repo.ingestResult(DESKTOP, resultInput()), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(() => repo.ingestResult({}, resultInput()), (error) => {
    assert.equal(error.status, 403);
    return true;
  });
  await assert.rejects(() => repo.ingestResult(DESKTOP, { requestReceiptId: 'x' }), (error) => {
    assert.match(error.message, /unsupported fields|invalid/);
    return true;
  });
});

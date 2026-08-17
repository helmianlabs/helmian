import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppBuildExecutionRequestRepository, normalizeAppBuildExecutionRequest } from '../src/cora/app-build-execution-request-repository.mjs';

const input = Object.freeze({ revisionReceiptId: 'revision-0001', approvalReceiptId: 'approval-0001', workspaceProjectKey: 'tms-cloud', idempotencyKey: 'execution-0001' });
const admin = Object.freeze({ tenantId: 'org-a', subject: 'admin', role: 'admin', sessionId: 'session-1', requestId: 'request-1' });
function fakePool({ approval = true, project = true } = {}) {
  const requests = []; const client = { async query(sql, values = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.startsWith('select role from helmion.tenant_memberships')) return values[0] === 'org-a' && values[1] === 'admin' ? { rowCount: 1, rows: [{ role: 'admin' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('select id from helmion.cora_app_build_approval_decisions')) return approval && values[0] === 'org-a' && values[1] === 'approval-0001' && values[2] === 'revision-0001' ? { rowCount: 1, rows: [{ id: 1 }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('select project_key from helmion.workspace_projects')) return project && values[0] === 'org-a' && values[1] === 'tms-cloud' ? { rowCount: 1, rows: [{ project_key: 'tms-cloud' }] } : { rowCount: 0, rows: [] };
    if (q.startsWith('insert into helmion.cora_app_build_execution_requests')) { const existing = requests.find((row) => row.idempotency_key === values[5]); if (existing) return { rowCount: 0, rows: [] }; const row = { revision_receipt_id: values[1], approval_receipt_id: values[2], workspace_project_key: values[3], receipt_id: values[4], idempotency_key: values[5], status: 'queued' }; requests.push(row); return { rowCount: 1, rows: [row] }; }
    if (q.startsWith('select receipt_id, revision_receipt_id')) { const row = requests.find((candidate) => candidate.idempotency_key === values[1]); return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] }; }
    throw new Error(`Unexpected query: ${q}`);
  }, release() {} }; return { connect: async () => client, requests };
}

test('execution request normalizer rejects authority and unsupported intent fields', () => {
  assert.deepEqual(normalizeAppBuildExecutionRequest(input), input);
  assert.throws(() => normalizeAppBuildExecutionRequest({ ...input, tenantId: 'org-b' }), /unsupported fields/);
  assert.throws(() => normalizeAppBuildExecutionRequest({ ...input, workspaceProjectKey: '' }), /invalid/);
});

test('owner/admin queues a tenant-scoped approved request idempotently without execution', async () => {
  const pool = fakePool(); const repo = createAppBuildExecutionRequestRepository(pool);
  const first = await repo.append(admin, input); const replay = await repo.append(admin, input);
  assert.equal(first.durable, true); assert.equal(first.status, 'queued'); assert.equal(first.execution, 'not_performed'); assert.equal(first.filesystemMutation, 'not_performed'); assert.equal(first.deployment, 'not_performed'); assert.equal(replay.replayed, true); assert.equal(pool.requests.length, 1);
});

test('execution request fails closed for member, cross-tenant/mismatched approval, and missing project', async () => {
  await assert.rejects(() => createAppBuildExecutionRequestRepository(fakePool()).append({ ...admin, role: 'member' }, input), /owner or admin/);
  await assert.rejects(() => createAppBuildExecutionRequestRepository(fakePool({ approval: false })).append(admin, input), /approved app build revision is unavailable/);
  await assert.rejects(() => createAppBuildExecutionRequestRepository(fakePool({ project: false })).append(admin, input), /active registered workspace project is unavailable/);
  await assert.rejects(() => createAppBuildExecutionRequestRepository(fakePool()).append({ ...admin, tenantId: 'org-b' }, input), /not an active member/);
});

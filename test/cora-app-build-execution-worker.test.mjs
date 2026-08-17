import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppBuildExecutionWorker } from '../src/cora/app-build-execution-worker.mjs';

const actor = Object.freeze({ tenantId: 'org-a', subject: 'worker-service', role: 'admin', sessionId: 'worker-session', requestId: 'worker-request' });
const worker = Object.freeze({ tenantId: 'org-a', workerId: 'registered-worker-a', actor });
const stored = Object.freeze({ tenantId: 'org-a', status: 'queued', revision: Object.freeze({ receiptId: 'revision-0001', appBuildReceiptId: 'draft-0001', route: '/hr/onboarding', title: 'Driver onboarding', description: 'Collect driver onboarding details.', components: [{ type: 'heading', text: 'Driver onboarding' }, { type: 'field', label: 'Email', fieldType: 'email', required: true }, { type: 'button', label: 'Save draft', action: 'save_draft' }] }), approval: Object.freeze({ receiptId: 'approval-0001', revisionReceiptId: 'revision-0001', decision: 'approve', actorRole: 'admin' }), workspaceProject: Object.freeze({ projectKey: 'tms-cloud', sourceKind: 'cloud', defaultBranch: 'main' }) });
function dependencies(root, value = stored) { const results = new Map(); let loads = 0; const requestRepository = { async readQueuedApproved(receivedActor, receipt) { loads += 1; assert.equal(receivedActor.tenantId, 'org-a'); assert.equal(receipt, 'request-0001'); return value; } }; const resultRepository = { async read(_actor, receipt) { return results.get(receipt) ?? null; }, async append(_actor, outcome) { const result = Object.freeze({ receiptId: 'result-0001', status: outcome.status, verification: outcome.verification, generatedFiles: outcome.generatedFiles, failureCode: outcome.failureCode, rollback: { action: outcome.rollbackAction, path: outcome.rollbackPath }, execution: outcome.execution, filesystemMutation: outcome.filesystemMutation, providerInvocation: 'not_performed', publication: 'not_performed', deployment: 'not_performed', replayed: false }); results.set(outcome.executionRequestReceiptId, result); return result; } }; return { requestRepository, resultRepository, workspaceResolver: async ({ tenantId, workerId, workspaceProjectKey }) => { assert.equal(tenantId, 'org-a'); assert.equal(workerId, 'registered-worker-a'); assert.equal(workspaceProjectKey, 'tms-cloud'); return { workspaceRoot: root }; }, results, get loads() { return loads; } }; }

test('authorized test worker writes exactly the deterministic plan into a trusted temporary workspace and persists hashes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cora-worker-')); t.after(() => rm(root, { recursive: true, force: true })); const deps = dependencies(root); const execution = createAppBuildExecutionWorker(deps);
  const first = await execution.run({ worker, executionRequestReceiptId: 'request-0001' });
  assert.equal(first.status, 'succeeded'); assert.equal(first.execution, 'performed'); assert.equal(first.filesystemMutation, 'performed'); assert.equal(first.generatedFiles.length, 2); assert.match(first.generatedFiles[0].sha256, /^[a-f0-9]{64}$/u); assert.match(await readFile(join(root, 'generated-apps/hr-onboarding/definition.json'), 'utf8'), /Driver onboarding/u);
  const replay = await execution.run({ worker, executionRequestReceiptId: 'request-0001' }); assert.equal(replay.replayed, true); assert.equal(deps.loads, 1);
});

test('worker rejects cross-tenant/mismatched approval and missing registered resolver root without touching a workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cora-worker-')); t.after(() => rm(root, { recursive: true, force: true }));
  const crossTenant = dependencies(root, { ...stored, tenantId: 'org-b' }); await assert.rejects(() => createAppBuildExecutionWorker(crossTenant).run({ worker, executionRequestReceiptId: 'request-0001' }), /unavailable/);
  const mismatch = dependencies(root, { ...stored, approval: { ...stored.approval, revisionReceiptId: 'other-revision' } }); const mismatchResult = await createAppBuildExecutionWorker(mismatch).run({ worker, executionRequestReceiptId: 'request-0001' }); assert.equal(mismatchResult.status, 'failed'); assert.deepEqual(mismatchResult.generatedFiles, []);
  const missingRoot = dependencies(root); missingRoot.workspaceResolver = async () => ({}); const missingRootResult = await createAppBuildExecutionWorker(missingRoot).run({ worker, executionRequestReceiptId: 'request-0001' }); assert.equal(missingRootResult.status, 'failed'); assert.deepEqual(missingRootResult.generatedFiles, []);
});

test('symlink escape yields a durable failure receipt with no raw workspace path or generated file hashes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cora-worker-')); const outside = await mkdtemp(join(tmpdir(), 'cora-worker-outside-')); t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(root, 'generated-apps'), 'junction'); const deps = dependencies(root); const result = await createAppBuildExecutionWorker(deps).run({ worker, executionRequestReceiptId: 'request-0001' });
  assert.equal(result.status, 'failed'); assert.equal(result.execution, 'failed'); assert.equal(result.filesystemMutation, 'not_performed'); assert.deepEqual(result.generatedFiles, []); assert.equal(JSON.stringify(result).includes(root), false); assert.equal(JSON.stringify(result).includes(outside), false);
});

test('a tampered rebuilt plan is rejected before any artifact is created and produces one failed receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cora-worker-')); t.after(() => rm(root, { recursive: true, force: true })); const deps = dependencies(root);
  const execution = createAppBuildExecutionWorker({ ...deps, planFactory: () => ({ format: 'forged-plan' }) }); const result = await execution.run({ worker, executionRequestReceiptId: 'request-0001' });
  assert.equal(result.status, 'failed'); assert.equal(result.execution, 'failed'); assert.deepEqual(result.generatedFiles, []); await assert.rejects(() => readFile(join(root, 'generated-apps/hr-onboarding/definition.json')));
});

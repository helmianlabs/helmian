import { randomUUID } from 'node:crypto';
import { createApprovedAppBuildWorkerPlan } from './app-build-worker-plan.mjs';
import { executeApprovedAppBuildPlan } from './app-build-local-executor.mjs';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

function text(value, name, max) { const result = String(value ?? '').trim(); if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`); return result; }
function exact(value, keys, name) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${name} is invalid`); }
function worker(value) { exact(value, ['tenantId', 'workerId', 'actor'], 'authorized workspace worker'); if (!value.actor || !['owner', 'admin'].includes(String(value.actor.role).toLowerCase())) throw new Error('authorized workspace worker requires owner/admin service identity'); return Object.freeze({ tenantId: text(value.tenantId, 'worker tenant id', 128).toLowerCase(), workerId: text(value.workerId, 'worker id', 128), actor: value.actor }); }
function safeFailure(error) { return String(error?.message ?? 'worker verification failed').replace(/[\\/][^\s]*/gu, 'path').slice(0, 120); }

/** Test-only composition seam. It has no HTTP route and receives workspace roots only from its injected trusted resolver. */
export function createAppBuildExecutionWorker({ requestRepository, resultRepository, workspaceResolver, planFactory = createApprovedAppBuildWorkerPlan, executor = executeApprovedAppBuildPlan } = {}) {
  if (!requestRepository || typeof requestRepository.readQueuedApproved !== 'function' || !resultRepository || typeof resultRepository.append !== 'function' || typeof workspaceResolver !== 'function' || typeof planFactory !== 'function' || typeof executor !== 'function') throw new Error('execution worker dependencies are required');
  return Object.freeze({ async run({ worker: workerInput, executionRequestReceiptId } = {}) {
    const active = worker(workerInput); const requestId = text(executionRequestReceiptId, 'execution request receipt', 256);
    const prior = await resultRepository.read?.(active.actor, requestId);
    if (prior) return Object.freeze({ ...prior, replayed: true });
    const stored = await requestRepository.readQueuedApproved(active.actor, requestId);
    if (!stored || stored.tenantId !== active.tenantId || stored.status !== 'queued' || stored.approval?.decision !== 'approve' || !['owner', 'admin'].includes(String(stored.approval?.actorRole).toLowerCase())) throw new Error('approved queued execution request is unavailable');
    try {
      const resolved = await workspaceResolver({ tenantId: active.tenantId, workerId: active.workerId, workspaceProjectKey: stored.workspaceProject.projectKey });
      if (!resolved || typeof resolved.workspaceRoot !== 'string' || Object.keys(resolved).some((key) => key !== 'workspaceRoot')) throw new Error('trusted workspace resolver returned no registered root');
      const plan = planFactory({ tenantId: active.tenantId, revision: stored.revision, approval: stored.approval, workspaceProject: stored.workspaceProject });
      const execution = await executor({ workspaceRoot: resolved.workspaceRoot, plan });
      const outcome = { executionRequestReceiptId: requestId, revisionReceiptId: stored.revision.receiptId, approvalReceiptId: stored.approval.receiptId, workspaceProjectKey: stored.workspaceProject.projectKey, status: 'succeeded', verification: execution.verification, generatedFiles: execution.written, failureCode: null, rollbackAction: execution.rollback.action, rollbackPath: execution.rollback.path, execution: 'performed', filesystemMutation: 'performed', providerInvocation: 'not_performed', publication: 'not_performed', deployment: 'not_performed' };
      return resultRepository.append(active.actor, outcome);
    } catch (error) {
      const outcome = { executionRequestReceiptId: requestId, revisionReceiptId: stored.revision.receiptId, approvalReceiptId: stored.approval.receiptId, workspaceProjectKey: stored.workspaceProject.projectKey, status: 'failed', verification: { status: 'failed', contract: 'not_completed' }, generatedFiles: [], failureCode: safeFailure(error), rollbackAction: null, rollbackPath: null, execution: 'failed', filesystemMutation: 'not_performed', providerInvocation: 'not_performed', publication: 'not_performed', deployment: 'not_performed' };
      return resultRepository.append(active.actor, outcome);
    }
  } });
}

function result(row, replayed) { return Object.freeze({ receiptId: row.receipt_id, status: row.status, verification: row.verification, generatedFiles: row.generated_files, failureCode: row.failure_code, rollback: { action: row.rollback_action, path: row.rollback_path }, execution: row.execution, filesystemMutation: row.filesystem_mutation, providerInvocation: 'not_performed', publication: 'not_performed', deployment: 'not_performed', replayed }); }
export function createAppBuildExecutionResultRepository(pool) { return Object.freeze({
  async read(actor, requestReceiptId) { return withTenantTransaction(pool, actor, async (client) => { await requireActiveTenantMembership(client, actor); const found = await client.query('select receipt_id, status, verification, generated_files, failure_code, rollback_action, rollback_path, execution, filesystem_mutation from helmion.cora_app_build_execution_results where tenant_id=$1 and execution_request_receipt_id=$2', [actor.tenantId, requestReceiptId]); return found.rowCount === 1 ? result(found.rows[0], false) : null; }); },
  async append(actor, outcome) { return withTenantTransaction(pool, actor, async (client) => { await requireActiveTenantMembership(client, actor); const existing = await client.query('select receipt_id, status, verification, generated_files, failure_code, rollback_action, rollback_path, execution, filesystem_mutation from helmion.cora_app_build_execution_results where tenant_id=$1 and execution_request_receipt_id=$2', [actor.tenantId, outcome.executionRequestReceiptId]); if (existing.rowCount === 1) return result(existing.rows[0], true); const receiptId = randomUUID(); const inserted = await client.query('insert into helmion.cora_app_build_execution_results (tenant_id, execution_request_receipt_id, revision_receipt_id, approval_receipt_id, workspace_project_key, receipt_id, status, verification, generated_files, failure_code, rollback_action, rollback_path, execution, filesystem_mutation) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14) returning receipt_id, status, verification, generated_files, failure_code, rollback_action, rollback_path, execution, filesystem_mutation', [actor.tenantId, outcome.executionRequestReceiptId, outcome.revisionReceiptId, outcome.approvalReceiptId, outcome.workspaceProjectKey, receiptId, outcome.status, JSON.stringify(outcome.verification), JSON.stringify(outcome.generatedFiles), outcome.failureCode, outcome.rollbackAction, outcome.rollbackPath, outcome.execution, outcome.filesystemMutation]); return result(inserted.rows[0], false); }); },
}); }

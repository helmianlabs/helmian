import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { applyTenantContext, requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildArtifactExecutionReceipt, normalizeArtifactExecutionRequest } from './artifact-execution-request.mjs';
import { evaluateUsageBudget, normalizeBudgetPolicy } from './provider-usage-ledger.mjs';
import { appendAuditEvent } from '../cloud/audit-event-repository.mjs';
import { validateArtifactScriptContent, ARTIFACT_SCRIPT_CONTENT_FORMAT } from './artifact-script-content-validation.mjs';
import { enqueueConnectorMessage } from './connector-outbound-worker.mjs';

function context(actor) { if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required'); return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId }; }
const SELECT = 'receipt_id, artifact_receipt_id, script_receipt_id, source_link_receipt_ids, catalog_entry_id, provider, model, modality, estimated_requested_tokens, estimated_audio_seconds, estimated_image_units, estimated_video_units, estimated_cost_minor, currency, external_execution, policy_decision, budget_state, status, approval_ref, actor_subject, created_at';
export const ARTIFACT_EXECUTION_RESULT_FORMAT = 'helmian.artifact-execution-result.v1';
const RESULT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const DESCRIPTOR_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
function resultText(value, name, max) { const result = String(value ?? '').trim(); if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`); return result; }
export function normalizeArtifactExecutionResult(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('execution result is invalid');
  const keys = Object.keys(input);
  if (keys.some((key) => !['requestReceiptId', 'scriptContentHash', 'artifactDescriptor', 'completedAt'].includes(key))) throw new Error('execution result contains unsupported fields');
  const requestReceiptId = resultText(input.requestReceiptId, 'request receipt', 256);
  const scriptContentHash = resultText(input.scriptContentHash, 'script content hash', 64).toLowerCase();
  if (!RESULT_HASH_PATTERN.test(scriptContentHash)) throw new Error('script content hash is invalid');
  const descriptor = input.artifactDescriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('artifact descriptor is invalid');
  const descriptorKeys = Object.keys(descriptor);
  if (descriptorKeys.length > 20 || descriptorKeys.some((key) => !DESCRIPTOR_KEY_PATTERN.test(key))) throw new Error('artifact descriptor keys are invalid');
  for (const key of descriptorKeys) { const value = descriptor[key]; if (typeof value === 'string' ? value.length > 500 : !['number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('artifact descriptor values are invalid'); }
  if (JSON.stringify(descriptor).length > 4096) throw new Error('artifact descriptor is too large');
  const completedAt = resultText(input.completedAt, 'completion time', 64);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs) || completedMs > Date.now() + 300000) throw new Error('completion time is invalid');
  return Object.freeze({ requestReceiptId, scriptContentHash, artifactDescriptor: Object.freeze({ ...descriptor }), completedAt: new Date(completedMs).toISOString() });
}
function row(row, replayed = false) { return buildArtifactExecutionReceipt({ request: { artifactReceiptId: row.artifact_receipt_id, scriptReceiptId: row.script_receipt_id, sourceLinkReceiptIds: row.source_link_receipt_ids, catalogEntryId: row.catalog_entry_id, provider: row.provider, model: row.model, modality: row.modality, estimatedRequestedTokens: row.estimated_requested_tokens, estimatedAudioSeconds: row.estimated_audio_seconds, estimatedImageUnits: row.estimated_image_units, estimatedVideoUnits: row.estimated_video_units, estimatedCostMinor: row.estimated_cost_minor, currency: row.currency, externalExecution: row.external_execution, budgetState: row.budget_state, ...(row.approval_ref ? { approvalRef: row.approval_ref } : {}), idempotencyKey: row.idempotency_key ?? 'replayed-key' }, receiptId: row.receipt_id, actorSubject: row.actor_subject, role: row.actor_role ?? 'member', budget: row.budget ?? {}, spentMinor: row.spent_minor ?? 0, statusOverride: row.status, policyDecisionOverride: row.policy_decision, budgetStateOverride: row.budget_state, replayed }); }
export function createArtifactExecutionRepository(pool) { return Object.freeze({
  async append(actor, input) { const active = context(actor); const request = normalizeArtifactExecutionRequest(input); if (request.approvalRef && !['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('execution approval requires an authorized admin'), { status: 403 }); return withTenantTransaction(pool, active, async (client) => { await requireActiveTenantMembership(client, active); const artifact = await client.query("select stage from helmion.cora_artifact_studio_intents where tenant_id=$1 and receipt_id=$2", [active.tenantId, request.artifactReceiptId]); if (artifact.rowCount !== 1 || artifact.rows[0].stage !== 'approval_requested') throw new Error('artifact approval receipt is required'); const script = await client.query("select stage, script_kind, text, source_link_receipt_ids from helmion.cora_artifact_script_revisions where tenant_id=$1 and receipt_id=$2", [active.tenantId, request.scriptReceiptId]); if (script.rowCount !== 1 || script.rows[0].stage !== 'source_checked') throw new Error('source-checked script receipt is required'); const contentValidation = validateArtifactScriptContent({ scriptKind: script.rows[0].script_kind, text: script.rows[0].text }); await appendAuditEvent(client, active, { actionType: 'artifact.script_content_validated', canonicalTarget: { resource: 'cora_artifact_execution_request', scriptReceiptId: request.scriptReceiptId }, policyVersion: 'artifact-script-content.v1', decision: contentValidation.valid ? 'ALLOW' : 'DENY', privacySummary: 'Script content validation receipt; findings only, script text is never stored in the audit trail', result: { format: ARTIFACT_SCRIPT_CONTENT_FORMAT, valid: contentValidation.valid, summary: contentValidation.summary, failedCheckIds: contentValidation.failedCheckIds } }); const links = await client.query("select link_receipt_id, source_lifecycle from helmion.cora_artifact_source_links where tenant_id=$1 and link_receipt_id = any($2::text[])", [active.tenantId, request.sourceLinkReceiptIds]); if (links.rowCount !== request.sourceLinkReceiptIds.length || links.rows.some((link) => link.source_lifecycle !== 'approved')) throw new Error('approved source links are required'); const config = await client.query("select config from helmion.cora_configs where tenant_id=$1 and lifecycle='published' and is_current limit 1", [active.tenantId]); const catalog = config.rows[0]?.config?.approvedModelCatalog ?? []; const entry = catalog.find((item) => item.id === request.catalogEntryId && item.provider === request.provider && item.model === request.model && item.status === 'approved'); if (!entry) throw new Error('approved catalog entry is unavailable'); const budget = await client.query('select period, currency, soft_limit_minor, hard_limit_minor, low_cost_limit_minor, policy_state from helmion.cora_usage_budgets where tenant_id=$1', [active.tenantId]); const spent = await client.query('select coalesce(sum(estimated_cost_minor),0) as spent from helmion.cora_provider_usage where tenant_id=$1', [active.tenantId]); const b = normalizeBudgetPolicy({ period: budget.rows[0]?.period ?? 'monthly', currency: budget.rows[0]?.currency ?? 'USD', softLimitMinor: budget.rows[0]?.soft_limit_minor ?? null, hardLimitMinor: budget.rows[0]?.hard_limit_minor ?? null, lowCostLimitMinor: budget.rows[0]?.low_cost_limit_minor ?? null, policyState: budget.rows[0]?.policy_state ?? 'active' }); const policy = evaluateUsageBudget({ budget: b, spentMinor: Number(spent.rows[0]?.spent ?? 0), estimatedCostMinor: request.estimatedCostMinor, action: 'prepare', external: true }); const status = !contentValidation.valid ? 'blocked' : policy.state === 'hard_exceeded' ? 'blocked' : request.approvalRef ? 'queued' : 'approval_required'; const decision = status === 'blocked' ? 'deny' : request.approvalRef ? 'allow' : 'step-up'; const receiptId = randomUUID(); const result = await client.query(`insert into helmion.cora_artifact_execution_requests (tenant_id, artifact_receipt_id, script_receipt_id, source_link_receipt_ids, catalog_entry_id, provider, model, modality, estimated_requested_tokens, estimated_audio_seconds, estimated_image_units, estimated_video_units, estimated_cost_minor, currency, external_execution, policy_decision, budget_state, status, approval_ref, actor_subject, actor_role, idempotency_key, supersedes_receipt_id) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,$17,$18,$19,$20,$21,$22) on conflict (tenant_id,idempotency_key) do nothing returning ${SELECT}, idempotency_key`, [active.tenantId, request.artifactReceiptId, request.scriptReceiptId, JSON.stringify(request.sourceLinkReceiptIds), request.catalogEntryId, request.provider, request.model, request.modality, request.estimatedRequestedTokens, request.estimatedAudioSeconds, request.estimatedImageUnits, request.estimatedVideoUnits, request.estimatedCostMinor, request.currency, decision, policy.state, status, request.approvalRef ?? null, active.actorSubject, active.actorRole, request.idempotencyKey, request.supersedesReceiptId ?? null]); if (result.rowCount === 1) return { durable: true, ...row(result.rows[0]) }; const replay = await client.query(`select ${SELECT}, idempotency_key from helmion.cora_artifact_execution_requests where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, request.idempotencyKey]); if (replay.rowCount !== 1) throw new Error('execution request receipt was not durable'); return { durable: true, ...row(replay.rows[0], true) }; }); },
  async list(actor, artifactReceiptId, limit = 50) { const active = context(actor); return withTenantTransaction(pool, active, async (client) => { await requireActiveTenantMembership(client, active); const result = await client.query(`select ${SELECT}, idempotency_key from helmion.cora_artifact_execution_requests where tenant_id=$1 and artifact_receipt_id=$2 order by created_at desc limit $3`, [active.tenantId, String(artifactReceiptId), Math.min(Math.max(Number(limit) || 50, 1), 100)]); return { receipts: result.rows.map((item) => row(item)) }; }); },
  // Desktop result ingestion: closes the loop the cloud worker opens. The
  // paired desktop reports completion for a request the cloud handed off as
  // needs_desktop. The approval gate is never bypassable here: the request
  // must exist and be approved (an approve decision, or a pre-approved queued
  // request), and the reported script content hash must equal the sha256 of
  // the approved script text. 'completed' is ONLY writable via this path —
  // the cloud worker never writes it.
  async ingestResult(desktop, input) {
    const tenantId = String(desktop?.tenantId ?? '').trim();
    const subject = String(desktop?.subject ?? '').trim();
    if (!tenantId || !subject) throw Object.assign(new Error('desktop device identity is required'), { status: 403 });
    const result = normalizeArtifactExecutionResult(input);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const membership = await client.query('select role from helmion.tenant_memberships where tenant_id=$1 and subject=$2 and active', [tenantId, subject]);
      if (membership.rowCount !== 1) throw Object.assign(new Error('device identity is not an active member of this Organization'), { status: 403 });
      const active = { tenantId, actorSubject: subject, actorRole: membership.rows[0].role, sessionId: randomUUID(), requestId: randomUUID() };
      await applyTenantContext(client, active);
      await requireActiveTenantMembership(client, active);
      const request = await client.query('select id, receipt_id, status, approval_ref, script_receipt_id from helmion.cora_artifact_execution_requests where tenant_id=$1 and receipt_id=$2', [tenantId, result.requestReceiptId]);
      if (request.rowCount !== 1) throw Object.assign(new Error('execution request is unknown'), { status: 404 });
      const req = request.rows[0];
      const decision = await client.query("select receipt_id from helmion.cora_approval_decisions where tenant_id=$1 and request_kind='artifact_execution_request' and request_receipt_id=$2 and decision='approve' limit 1", [tenantId, result.requestReceiptId]);
      const approved = decision.rowCount === 1 || (req.status === 'queued' && req.approval_ref != null);
      if (!approved) throw Object.assign(new Error('execution request is not approved; results are only accepted for approved requests'), { status: 403 });
      const script = await client.query('select text from helmion.cora_artifact_script_revisions where tenant_id=$1 and receipt_id=$2', [tenantId, req.script_receipt_id]);
      if (script.rowCount !== 1) throw Object.assign(new Error('approved script revision is unavailable'), { status: 409 });
      const expectedHash = createHash('sha256').update(String(script.rows[0].text ?? ''), 'utf8').digest('hex');
      if (!timingSafeEqual(Buffer.from(expectedHash, 'utf8'), Buffer.from(result.scriptContentHash, 'utf8'))) throw Object.assign(new Error('reported content hash does not match the approved script'), { status: 400 });
      const metadata = { format: ARTIFACT_EXECUTION_RESULT_FORMAT, scriptContentHash: result.scriptContentHash, artifactDescriptor: result.artifactDescriptor, completedAt: result.completedAt, reportedBy: subject };
      const transitioned = await client.query("update helmion.cora_artifact_execution_runs set outcome='completed', result=$3::jsonb where tenant_id=$1 and execution_request_id=$2 and outcome='needs_desktop' returning id", [tenantId, req.id, JSON.stringify(metadata)]);
      let runId;
      if (transitioned.rowCount === 1) {
        runId = transitioned.rows[0].id;
      } else {
        const existing = await client.query('select id, outcome, result from helmion.cora_artifact_execution_runs where tenant_id=$1 and execution_request_id=$2', [tenantId, req.id]);
        const sameCompletion = existing.rowCount === 1 && existing.rows[0].outcome === 'completed' && existing.rows[0].result?.scriptContentHash === result.scriptContentHash;
        if (!sameCompletion) throw Object.assign(new Error('no desktop handoff is recorded for this request yet'), { status: 409 });
        runId = existing.rows[0].id;
      }
      await appendAuditEvent(client, active, { actionType: 'artifact.execution_result_ingested', canonicalTarget: { resource: 'cora_artifact_execution_run', requestReceiptId: result.requestReceiptId, runId: String(runId) }, policyVersion: 'artifact-execution-result.v1', decision: 'ALLOW', privacySummary: 'Desktop-reported execution completion; content hash verified against the approved script', result: { scriptContentHash: result.scriptContentHash, artifactDescriptor: result.artifactDescriptor, completedAt: result.completedAt } });
      await client.query('commit');
      // Best-effort outbox notification for the completed handoff. Never fails the ingest.
      if (transitioned.rowCount === 1) {
        for (const provider of ['discord', 'slack']) {
          await enqueueConnectorMessage({ pool, tenantId, provider, channelLabel: 'artifact-executions', text: `Artifact execution ${result.requestReceiptId} -> completed.` }).catch(() => {});
        }
      }
      return { durable: true, runId: String(runId), requestReceiptId: result.requestReceiptId, outcome: 'completed' };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
}); }

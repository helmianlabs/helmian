import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildArtifactStudioReceipt, normalizeArtifactStudioIntent } from './artifact-studio-intent.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

const SELECT = 'id, artifact_type, title, department, objective, source_refs, stage, approval_reason, receipt_id, idempotency_key, created_at';

function rowToReceipt(row, replayed = false) {
  return buildArtifactStudioReceipt({ intent: { artifactType: row.artifact_type, title: row.title, department: row.department, objective: row.objective, sourceRefs: row.source_refs, stage: row.stage, idempotencyKey: row.idempotency_key, ...(row.approval_reason ? { approvalReason: row.approval_reason } : {}) }, receiptId: row.receipt_id, replayed });
}

export function createArtifactStudioRepository(pool) {
  return Object.freeze({
    async append(actor, input) {
      const active = context(actor);
      const intent = normalizeArtifactStudioIntent(input);
      if (intent.stage === 'approval_requested' && !['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('Artifact approval request requires an authorized admin'), { status: 403 });
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const receiptId = randomUUID();
        const result = await client.query(`insert into helmion.cora_artifact_studio_intents (tenant_id, actor_subject, artifact_type, title, department, objective, source_refs, stage, approval_reason, receipt_id, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) on conflict (tenant_id, idempotency_key) do nothing returning ${SELECT}`, [active.tenantId, active.subject, intent.artifactType, intent.title, intent.department, intent.objective, JSON.stringify(intent.sourceRefs), intent.stage, intent.approvalReason ?? null, receiptId, intent.idempotencyKey]);
        if (result.rowCount === 1) return { durable: true, ...rowToReceipt(result.rows[0]) };
        const replay = await client.query(`select ${SELECT} from helmion.cora_artifact_studio_intents where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, intent.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('artifact receipt was not durable');
        return { durable: true, ...rowToReceipt(replay.rows[0], true) };
      });
    },
    async list(actor, limit = 50) {
      const active = context(actor);
      const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.cora_artifact_studio_intents where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, boundedLimit]);
        return { receipts: result.rows.map((row) => rowToReceipt(row)) };
      });
    },
  });
}

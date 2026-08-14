import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildWorkspacePreviewReceipt, normalizeWorkspacePreviewIntent } from './workspace-preview-intent.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function rowToReceipt(row, replayed = false) {
  return buildWorkspacePreviewReceipt({ intent: { mode: row.mode, intent: row.intent, department: row.department, templateId: row.template_id, title: row.title, idempotencyKey: row.idempotency_key }, receiptId: row.receipt_id, replayed });
}

const SELECT = 'id, mode, intent, department, template_id, title, receipt_id, idempotency_key, status, created_at';

export function createWorkspacePreviewRepository(pool) {
  return Object.freeze({
    async append(actor, input) {
      const active = context(actor);
      const intent = normalizeWorkspacePreviewIntent(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const receiptId = randomUUID();
        const result = await client.query(`insert into helmion.cora_workspace_preview_intents (tenant_id, actor_subject, mode, intent, department, template_id, title, receipt_id, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, idempotency_key) do nothing returning ${SELECT}`, [active.tenantId, active.subject, intent.mode, intent.intent, intent.department, intent.templateId, intent.title, receiptId, intent.idempotencyKey]);
        if (result.rowCount === 1) return { durable: true, ...rowToReceipt(result.rows[0]) };
        const replay = await client.query(`select ${SELECT} from helmion.cora_workspace_preview_intents where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, intent.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('preview receipt was not durable');
        return { durable: true, ...rowToReceipt(replay.rows[0], true) };
      });
    },
    async list(actor, limit = 50) {
      const active = context(actor);
      const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.cora_workspace_preview_intents where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]);
        return { receipts: result.rows.map((row) => rowToReceipt(row)) };
      });
    },
  });
}

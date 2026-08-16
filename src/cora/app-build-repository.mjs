import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { buildAppBuildRequestReceipt, normalizeAppBuildRequest } from './app-build-intent.mjs';

function context(actor) { if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required'); return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId }; }
const SELECT = 'id, title, department, route, description, components, receipt_id, idempotency_key, created_at';
function receipt(row, replayed = false) { return buildAppBuildRequestReceipt({ request: { intent: 'draft', title: row.title, department: row.department, route: row.route, description: row.description, components: row.components, idempotencyKey: row.idempotency_key }, receiptId: row.receipt_id, replayed }); }

export function createAppBuildRepository(pool) { return Object.freeze({
  async append(actor, input) {
    const active = context(actor); const request = normalizeAppBuildRequest(input);
    return withTenantTransaction(pool, active, async (client) => {
      await requireActiveTenantMembership(client, active); const receiptId = randomUUID();
      const inserted = await client.query(`insert into helmion.cora_app_build_requests (tenant_id, actor_subject, title, department, route, description, components, receipt_id, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) on conflict (tenant_id, idempotency_key) do nothing returning ${SELECT}`, [active.tenantId, active.actorSubject, request.title, request.department, request.route, request.description, JSON.stringify(request.components), receiptId, request.idempotencyKey]);
      if (inserted.rowCount === 1) return { durable: true, ...receipt(inserted.rows[0]) };
      const replay = await client.query(`select ${SELECT} from helmion.cora_app_build_requests where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, request.idempotencyKey]);
      if (replay.rowCount !== 1) throw new Error('app build receipt was not durable'); return { durable: true, ...receipt(replay.rows[0], true) };
    });
  },
  async list(actor, limit = 50) { const active = context(actor); const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100); return withTenantTransaction(pool, active, async (client) => { await requireActiveTenantMembership(client, active); const result = await client.query(`select ${SELECT} from helmion.cora_app_build_requests where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]); return { receipts: result.rows.map((row) => receipt(row)) }; }); },
}); }

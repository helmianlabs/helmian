import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const DECISIONS = new Set(['AUTO_RUN', 'ALLOW', 'PAUSE_FOR_OWNER', 'BLOCK', 'DENY']);
const MAX_FILTER = 120;

function text(value, field) {
  const result = String(value ?? '').trim();
  if (result.length > MAX_FILTER) throw Object.assign(new Error(`${field} filter is too long`), { status: 400 });
  return result || null;
}

function date(value, field) {
  const result = text(value, field);
  if (result == null) return null;
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf())) throw Object.assign(new Error(`${field} filter is invalid`), { status: 400 });
  return parsed.toISOString();
}

function decodeCursor(value) {
  if (value == null || String(value).trim() === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !/^\d+$/.test(String(parsed.id ?? '')) || Number.isNaN(new Date(parsed.createdAt).valueOf())) throw new Error('invalid');
    return { id: String(parsed.id), createdAt: new Date(parsed.createdAt).toISOString() };
  } catch { throw Object.assign(new Error('audit cursor is invalid'), { status: 400 }); }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ id: String(row.id), createdAt: new Date(row.created_at).toISOString() })).toString('base64url');
}

export function normalizeAuditQuery(input = {}) {
  const limit = Number(input.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('audit limit must be an integer between 1 and 100'), { status: 400 });
  const status = text(input.status, 'status');
  if (status != null && !DECISIONS.has(status.toUpperCase())) throw Object.assign(new Error('audit status filter is invalid'), { status: 400 });
  return Object.freeze({
    limit,
    action: text(input.action ?? input.action_type, 'action'),
    actor: text(input.actor ?? input.actor_subject, 'actor'),
    status: status?.toUpperCase() ?? null,
    from: date(input.from, 'from'),
    to: date(input.to, 'to'),
    cursor: decodeCursor(input.cursor),
  });
}

export function createAuditEventRepository(pool) {
  return Object.freeze({
    async list(actor, input = {}) {
      const query = normalizeAuditQuery(input);
      const context = { tenantId: actor?.tenantId, actorSubject: actor?.subject, actorRole: actor?.role, sessionId: randomUUID(), requestId: randomUUID() };
      return withTenantTransaction(pool, context, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const values = [scoped.tenantId];
        const where = ['tenant_id=$1'];
        const add = (sql, value) => { values.push(value); where.push(sql.replace('$N', `$${values.length}`)); };
        if (query.action) add('action_type=$N', query.action);
        if (query.actor) add('actor_subject=$N', query.actor);
        if (query.status) add('decision=$N', query.status);
        if (query.from) add('created_at>=$N', query.from);
        if (query.to) add('created_at<$N', query.to);
        if (query.cursor) {
          values.push(query.cursor.createdAt, query.cursor.id);
          where.push(`(created_at<$${values.length - 1} or (created_at=$${values.length - 1} and id<$${values.length}))`);
        }
        const result = await client.query(`select id, actor_subject, actor_role, action_type, decision, privacy_summary, created_at from helmion.audit_events where ${where.join(' and ')} order by created_at desc, id desc limit ${query.limit + 1}`, values);
        const rows = result.rows.slice(0, query.limit);
        return {
          events: rows.map((row) => ({ id: String(row.id), actor: String(row.actor_subject), actorRole: String(row.actor_role), actionType: String(row.action_type).slice(0, MAX_FILTER), status: String(row.decision), summary: String(row.privacy_summary).slice(0, 240), createdAt: row.created_at })),
          nextCursor: result.rows.length > query.limit ? encodeCursor(rows.at(-1)) : null,
          hasMore: result.rows.length > query.limit,
          empty: rows.length === 0,
          source: 'helmion.audit_events',
          mutation: 'not_performed',
        };
      });
    },
  });
}

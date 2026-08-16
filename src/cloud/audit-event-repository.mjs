import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const DECISIONS = new Set(['AUTO_RUN', 'ALLOW', 'PAUSE_FOR_OWNER', 'BLOCK', 'DENY']);
const MAX_FILTER = 120;
const EXPORT_MAX_ROWS = 100;
const EXPORT_MAX_DAYS = 31;
export const AUDIT_EXPORT_COLUMNS = Object.freeze(['id', 'created_at', 'action_type', 'decision', 'actor_subject', 'actor_role', 'privacy_summary']);

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

function exportText(value, max = 240) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(?:bearer\s+|password\s*=\s*|secret\s*=\s*|api[_-]?key\s*=\s*|provider[_-]?payload\s*=\s*|credential[_-]?ref\s*=\s*)[^\s,;]+/giu, '[redacted]')
    .replace(/(?:sk-ant-|sk-|ghp_|AIza)[A-Za-z0-9._-]+/gu, '[redacted]')
    .slice(0, max);
}

function csvCell(value) {
  return `"${exportText(value).replace(/"/gu, '""')}"`;
}

function csv(rows) {
  return [AUDIT_EXPORT_COLUMNS.join(','), ...rows.map((row) => AUDIT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(','))].join('\r\n') + '\r\n';
}

export function normalizeAuditExportQuery(input = {}) {
  const query = normalizeAuditQuery({ ...input, limit: Math.min(Number(input.limit ?? EXPORT_MAX_ROWS), EXPORT_MAX_ROWS) });
  if (!query.from || !query.to) throw Object.assign(new Error('audit export requires from and to dates'), { status: 400, code: 'AUDIT_EXPORT_RANGE_REQUIRED' });
  const span = new Date(query.to).valueOf() - new Date(query.from).valueOf();
  if (span < 0 || span > EXPORT_MAX_DAYS * 24 * 60 * 60 * 1000) throw Object.assign(new Error(`audit export range must be no more than ${EXPORT_MAX_DAYS} days`), { status: 400, code: 'AUDIT_EXPORT_RANGE_INVALID' });
  return query;
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

export async function appendAuditEvent(client, context, input) {
  const receipt = await client.query(
    `insert into helmion.audit_events
       (tenant_id, actor_subject, actor_role, session_id, request_id, action_type,
        canonical_target, policy_version, decision, privacy_summary, result)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
     returning id`,
    [context.tenantId, context.actorSubject, context.actorRole, context.sessionId, context.requestId,
      input.actionType, JSON.stringify(input.canonicalTarget), input.policyVersion, input.decision,
      input.privacySummary, JSON.stringify(input.result)],
  );
  if (receipt.rowCount !== 1 || receipt.rows[0]?.id == null) throw new Error('audit event receipt was not durable');
  return String(receipt.rows[0].id);
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
    async exportCsv(actor, input = {}) {
      const query = normalizeAuditExportQuery(input);
      const context = { tenantId: actor?.tenantId, actorSubject: actor?.subject, actorRole: actor?.role, sessionId: actor?.sessionId ?? randomUUID(), requestId: actor?.requestId ?? randomUUID() };
      return withTenantTransaction(pool, context, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const values = [scoped.tenantId];
        const where = ['tenant_id=$1'];
        const add = (sql, value) => { values.push(value); where.push(sql.replace('$N', `$${values.length}`)); };
        if (query.action) add('action_type=$N', query.action);
        if (query.actor) add('actor_subject=$N', query.actor);
        if (query.status) add('decision=$N', query.status);
        add('created_at>=$N', query.from);
        add('created_at<$N', query.to);
        const result = await client.query(`select id, created_at, action_type, decision, actor_subject, actor_role, privacy_summary from helmion.audit_events where ${where.join(' and ')} order by created_at desc, id desc limit ${EXPORT_MAX_ROWS + 1}`, values);
        const rows = result.rows.slice(0, EXPORT_MAX_ROWS).map((row) => ({
          id: String(row.id), created_at: new Date(row.created_at).toISOString(), action_type: exportText(row.action_type, MAX_FILTER), decision: exportText(row.decision, 32), actor_subject: exportText(row.actor_subject, MAX_FILTER), actor_role: exportText(row.actor_role, 32), privacy_summary: exportText(row.privacy_summary),
        }));
        const hasMore = result.rows.length > EXPORT_MAX_ROWS;
        const receipt = await client.query(
          `insert into helmion.audit_events
             (tenant_id, actor_subject, actor_role, session_id, request_id, action_type,
              canonical_target, policy_version, decision, privacy_summary, result)
           values ($1,$2,$3,$4,$5,'audit.export',$6::jsonb,'audit-export.v1','ALLOW',$7,$8::jsonb)
           returning id`,
          [scoped.tenantId, scoped.actorSubject, scoped.actorRole, scoped.sessionId, scoped.requestId,
            JSON.stringify({ resource: 'audit_events', format: 'csv', filters: { action: query.action, actor: query.actor, status: query.status, from: query.from, to: query.to }, rowCap: EXPORT_MAX_ROWS }),
            'Bounded Organization audit export; sensitive payload columns omitted',
            JSON.stringify({ rows: rows.length, hasMore, columns: AUDIT_EXPORT_COLUMNS, redacted: true })],
        );
        return { csv: csv(rows), empty: rows.length === 0, hasMore, rowCount: rows.length, receiptId: receipt.rows[0]?.id == null ? null : String(receipt.rows[0].id), columns: AUDIT_EXPORT_COLUMNS, source: 'helmion.audit_events', mutation: 'export_receipt_only' };
      });
    },
  });
}

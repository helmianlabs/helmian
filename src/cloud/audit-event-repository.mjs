import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const DECISIONS = new Set(['AUTO_RUN', 'ALLOW', 'PAUSE_FOR_OWNER', 'BLOCK', 'DENY']);
const MAX_FILTER = 120;
const EXPORT_MAX_ROWS = 100;
const EXPORT_MAX_DAYS = 31;
const SESSION_MAX_ROWS = 100;
const SESSION_ACTIONS = Object.freeze({ started: 'cora.session.started', ended: 'cora.session.ended', failed: 'cora.session.failed' });
const SHA256 = /^[a-f0-9]{64}$/u;
export const AUDIT_EXPORT_COLUMNS = Object.freeze(['id', 'created_at', 'action_type', 'decision', 'actor_subject', 'actor_role', 'privacy_summary']);

function sessionText(value, field, max = 256, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw Object.assign(new Error(`${field} is invalid`), { status: 400 });
  return result;
}

function sessionReceipt(input = {}) {
  const phase = sessionText(input.phase, 'session phase');
  if (!Object.hasOwn(SESSION_ACTIONS, phase)) throw Object.assign(new Error('session phase is invalid'), { status: 400 });
  const hashes = ['configHash', 'toolManifestHash', 'routingPolicyHash'].map((field) => sessionText(input.sessionConfig?.[field], field, 64, true));
  for (const value of hashes) if (value !== null && !SHA256.test(value)) throw Object.assign(new Error('session config hash is invalid'), { status: 400 });
  const evidence = input.providerEvidence?.verified === true ? input.providerEvidence : null;
  const numberOrNull = (value) => value == null ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const configVersion = input.sessionConfig?.configVersion == null ? null : Number(input.sessionConfig.configVersion);
  if (configVersion !== null && (!Number.isInteger(configVersion) || configVersion < 1)) throw Object.assign(new Error('session config version is invalid'), { status: 400 });
  return Object.freeze({
    phase,
    actionType: SESSION_ACTIONS[phase],
    sessionId: sessionText(input.bridgeContext?.sessionId, 'session id'),
    receiptId: sessionText(input.bridgeContext?.receiptId, 'session receipt'),
    configId: sessionText(input.sessionConfig?.configId, 'config id', 128, true),
    configVersion,
    configHash: hashes[0], toolManifestHash: hashes[1], routingPolicyHash: hashes[2],
    startedAt: sessionText(input.startedAt, 'started time', 64, true),
    endedAt: sessionText(input.endedAt, 'ended time', 64, true),
    failureReason: sessionText(input.failureReason, 'failure reason', 240, true),
    providerRequestRef: sessionText(evidence?.providerRequestRef, 'provider request reference', 512, true),
    actualTokens: numberOrNull(evidence?.actualTokens), audioSeconds: numberOrNull(evidence?.audioSeconds), imageUnits: numberOrNull(evidence?.imageUnits), videoSeconds: numberOrNull(evidence?.videoSeconds), actualCostMinor: numberOrNull(evidence?.actualCostMinor),
    providerEvidence: evidence !== null,
  });
}

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
    async appendSessionLifecycle(actor, input = {}) {
      const receipt = sessionReceipt(input);
      const context = { tenantId: actor?.tenantId, actorSubject: actor?.subject, actorRole: actor?.role, sessionId: actor?.sessionId ?? randomUUID(), requestId: `cora-session-${receipt.receiptId}-${receipt.phase}` };
      return withTenantTransaction(pool, context, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const existing = await client.query('select id from helmion.audit_events where tenant_id=$1 and request_id=$2 and action_type=$3 limit 1', [scoped.tenantId, scoped.requestId, receipt.actionType]);
        if (existing.rowCount === 1) return { durable: true, replayed: true, receiptId: String(existing.rows[0].id), phase: receipt.phase, usageEvidence: receipt.providerEvidence };
        const result = await client.query(
          `insert into helmion.audit_events
             (tenant_id, actor_subject, actor_role, session_id, request_id, action_type,
              canonical_target, policy_version, decision, privacy_summary, result)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,'cora-session-lifecycle.v1','ALLOW',$8,$9::jsonb)
           returning id`,
          [scoped.tenantId, scoped.actorSubject, scoped.actorRole, scoped.sessionId, scoped.requestId, receipt.actionType,
            JSON.stringify({ resource: 'cora_session', phase: receipt.phase, sessionId: receipt.sessionId, receiptId: receipt.receiptId, configId: receipt.configId, configVersion: receipt.configVersion }),
            receipt.failureReason ? `Cora signed session ${receipt.phase}: ${receipt.failureReason}` : `Cora signed session ${receipt.phase}; provider usage is actual-evidence-only`,
            JSON.stringify({ configHash: receipt.configHash, toolManifestHash: receipt.toolManifestHash, routingPolicyHash: receipt.routingPolicyHash, startedAt: receipt.startedAt, endedAt: receipt.endedAt, failureReason: receipt.failureReason, providerRequestRef: receipt.providerRequestRef, actualTokens: receipt.actualTokens, audioSeconds: receipt.audioSeconds, imageUnits: receipt.imageUnits, videoSeconds: receipt.videoSeconds, actualCostMinor: receipt.actualCostMinor, providerEvidence: receipt.providerEvidence })],
        );
        return { durable: true, replayed: false, receiptId: String(result.rows[0].id), phase: receipt.phase, usageEvidence: receipt.providerEvidence };
      });
    },
    async listSessionHistory(actor, input = {}) {
      const limit = Number(input.limit ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_MAX_ROWS) throw Object.assign(new Error('session history limit is invalid'), { status: 400 });
      const context = { tenantId: actor?.tenantId, actorSubject: actor?.subject, actorRole: actor?.role, sessionId: randomUUID(), requestId: randomUUID() };
      return withTenantTransaction(pool, context, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const result = await client.query(`select id, actor_subject, actor_role, action_type, canonical_target, result, created_at from helmion.audit_events where tenant_id=$1 and action_type in ('cora.session.started','cora.session.ended','cora.session.failed') order by created_at desc, id desc limit $2`, [scoped.tenantId, limit]);
        return { sessions: result.rows.map((row) => ({ id: String(row.id), phase: String(row.canonical_target?.phase ?? row.action_type.split('.').at(-1)), sessionId: String(row.canonical_target?.sessionId ?? ''), receiptId: String(row.canonical_target?.receiptId ?? ''), configId: row.canonical_target?.configId ?? null, configVersion: row.canonical_target?.configVersion ?? null, actor: String(row.actor_subject), actorRole: String(row.actor_role), configHash: row.result?.configHash ?? null, toolManifestHash: row.result?.toolManifestHash ?? null, routingPolicyHash: row.result?.routingPolicyHash ?? null, startedAt: row.result?.startedAt ?? null, endedAt: row.result?.endedAt ?? null, failureReason: row.result?.failureReason ?? null, providerEvidence: row.result?.providerEvidence === true, actualTokens: row.result?.actualTokens ?? null, audioSeconds: row.result?.audioSeconds ?? null, actualCostMinor: row.result?.actualCostMinor ?? null, createdAt: row.created_at })), empty: result.rows.length === 0, source: 'helmion.audit_events', mutation: 'not_performed' };
      });
    },
  });
}

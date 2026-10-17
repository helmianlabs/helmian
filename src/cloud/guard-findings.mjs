import { randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership, applyTenantContext } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

const SOURCES = new Set(['browser-extension', 'governance-kernel', 'cloud']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);

// Detail payloads stay small: findings carry metadata, not page content. Anything
// that looks like raw captured text is dropped before it reaches the database.
const MAX_DETAIL_BYTES = 4096;
const DROPPED_DETAIL_KEYS = new Set([
  'pageContent', 'rawHtml', 'rawText', 'excerpt', 'innerText', 'outerHTML',
  'screenshot', 'screenshotDataUrl', 'domSnapshot', 'conversation',
]);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function boundedDetail(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('finding detail must be an object');
  const cleaned = {};
  for (const [key, val] of Object.entries(value)) {
    if (DROPPED_DETAIL_KEYS.has(key)) continue;
    if (typeof val === 'string' && val.length > 500) cleaned[key] = `${val.slice(0, 497)}…`;
    else cleaned[key] = val;
  }
  let json = JSON.stringify(cleaned);
  if (json.length > MAX_DETAIL_BYTES) {
    // Keep the most significant keys; drop the rest rather than truncating mid-JSON.
    const trimmed = {};
    for (const [key, val] of Object.entries(cleaned)) {
      trimmed[key] = val;
      if (JSON.stringify(trimmed).length > MAX_DETAIL_BYTES) { delete trimmed[key]; break; }
    }
    json = JSON.stringify(trimmed);
  }
  return JSON.parse(json);
}

export function normalizeGuardFinding(input) {
  const fingerprint = text(input?.fingerprint, 'finding fingerprint', 256);
  if (fingerprint.length < 8) throw new Error('finding fingerprint is too short');
  const source = text(input?.source, 'finding source', 32).toLowerCase();
  if (!SOURCES.has(source)) throw new Error('finding source is unsupported');
  const severity = text(input?.severity, 'finding severity', 16).toLowerCase();
  if (!SEVERITIES.has(severity)) throw new Error('finding severity is unsupported');
  const title = text(input?.title, 'finding title', 280);
  const pageRef = input?.pageRef == null || input?.pageRef === ''
    ? null
    : text(input.pageRef, 'finding page reference', 2048);
  return Object.freeze({
    fingerprint,
    source,
    severity,
    title,
    detail: boundedDetail(input?.detail),
    pageRef,
  });
}

function rowFinding(row, ackedBy) {
  return Object.freeze({
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    source: String(row.source),
    severity: String(row.severity),
    title: String(row.title),
    detail: row.detail ?? {},
    pageRef: row.page_ref ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sightingCount: Number(row.sighting_count),
    acked: ackedBy != null,
    ackedBy: ackedBy ?? null,
  });
}

const FINDING_COLUMNS = `id, fingerprint, source, severity, title, detail, page_ref,
  first_seen_at, last_seen_at, sighting_count`;

export function createGuardStore(pool) {
  return Object.freeze({
    async ingestFinding({ tenantId, subject }, input) {
      const finding = normalizeGuardFinding(input);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const membership = await client.query(
          `select role from helmion.tenant_memberships where tenant_id=$1 and subject=$2 and active`,
          [String(tenantId), String(subject)],
        );
        if (membership.rowCount !== 1) throw new Error('Device identity is not an active member of this Organization');
        const context = {
          tenantId: String(tenantId),
          actorSubject: String(subject),
          actorRole: membership.rows[0].role,
          sessionId: randomUUID(),
          requestId: randomUUID(),
        };
        await applyTenantContext(client, context);
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.guard_findings
             (tenant_id, fingerprint, source, severity, title, detail, page_ref)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)
           on conflict (tenant_id, fingerprint) do update set
             last_seen_at = clock_timestamp(),
             sighting_count = helmion.guard_findings.sighting_count + 1,
             severity = excluded.severity,
             title = excluded.title,
             detail = excluded.detail,
             page_ref = excluded.page_ref
           returning ${FINDING_COLUMNS}, (xmax = 0) as inserted`,
          [context.tenantId, finding.fingerprint, finding.source, finding.severity,
            finding.title, JSON.stringify(finding.detail), finding.pageRef],
        );
        const row = result.rows[0];
        const inserted = row.inserted === true;
        // A re-sighting clears any acknowledgement: an ack never hides a finding
        // that fires again. The desktop rule, enforced server-side.
        let ackCleared = false;
        if (!inserted) {
          const cleared = await client.query(
            `delete from helmion.guard_finding_acks where tenant_id=$1 and finding_fingerprint=$2`,
            [context.tenantId, finding.fingerprint],
          );
          ackCleared = cleared.rowCount > 0;
        }
        await client.query('commit');
        return { durability: 'committed', finding: rowFinding(row, null), inserted, ackCleared };
      } catch (error) {
        try { await client.query('rollback'); } catch { /* preserve the original error */ }
        throw error;
      } finally {
        client.release();
      }
    },

    async listFindings(actor, limit = 100) {
      const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
      const context = { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
      try {
        return await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select f.${FINDING_COLUMNS.split(',').join(', f.')}, a.acked_by_subject
           from helmion.guard_findings f
           left join helmion.guard_finding_acks a
             on a.tenant_id = f.tenant_id and a.finding_fingerprint = f.fingerprint
           where f.tenant_id = $1
           order by f.last_seen_at desc, f.id desc
           limit $2`,
          [context.tenantId, boundedLimit],
        );
        return { findings: result.rows.map((row) => rowFinding(row, row.acked_by_subject ? String(row.acked_by_subject) : null)), migrationPending: false };
        });
      } catch (error) {
        if (error?.code === '42P01') return { findings: [], migrationPending: true };
        throw error;
      }
    },

    async ackFinding(actor, fingerprint) {
      const normalized = text(fingerprint, 'finding fingerprint', 256);
      if (normalized.length < 8) throw new Error('finding fingerprint is too short');
      const context = { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const existing = await client.query(
          `select fingerprint, severity, title from helmion.guard_findings where tenant_id=$1 and fingerprint=$2`,
          [context.tenantId, normalized],
        );
        if (existing.rowCount !== 1) throw new Error('Guard finding was not found in this Organization');
        const insert = await client.query(
          `insert into helmion.guard_finding_acks (tenant_id, finding_fingerprint, acked_by_subject)
           values ($1,$2,$3)
           on conflict (tenant_id, finding_fingerprint) do nothing
           returning acked_by_subject, acked_at`,
          [context.tenantId, normalized, context.actorSubject],
        );
        const alreadyAcked = insert.rowCount !== 1;
        const receipt = alreadyAcked
          ? null
          : await appendAuditEvent(client, context, {
            actionType: 'guard.finding.acknowledged',
            canonicalTarget: { fingerprint: normalized, severity: existing.rows[0].severity, title: existing.rows[0].title },
            policyVersion: 'guard-findings.v1',
            decision: 'ALLOW',
            privacySummary: `Acknowledged the "${existing.rows[0].title}" finding`,
            result: { acknowledged: true, ackedBy: context.actorSubject },
          });
        return { acked: true, alreadyAcked, auditReceiptId: receipt };
      });
    },
  });
}

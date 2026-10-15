// Helmian Cloud /app console sessions: Organization-scoped, owner/admin only.
import { randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

export const APP_SESSION_PROVIDERS = Object.freeze(['Claude', 'ChatGPT', 'Grok', 'Gemini']);
const ADMIN_ROLES = new Set(['owner', 'admin']);

export function assertAppSessionRole(actor) {
  if (!ADMIN_ROLES.has(String(actor?.role ?? '').toLowerCase())) throw Object.assign(new Error('owner or admin role required'), { status: 403 });
}

export function normalizeAppSession(input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw Object.assign(new Error('session name is missing or too long'), { status: 400 });
  if (!APP_SESSION_PROVIDERS.includes(input.provider)) throw Object.assign(new Error('session provider is unsupported'), { status: 400 });
  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw Object.assign(new Error('idempotency key is invalid'), { status: 400 });
  return Object.freeze({ name, provider: input.provider, idempotencyKey });
}

const row = (r) => Object.freeze({ id: String(r.id), name: String(r.name), provider: String(r.provider), createdBySubject: String(r.created_by_subject), createdAt: r.created_at });

export function createAppSessionStore(pool) {
  const ctx = (actor) => ({ tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId ?? randomUUID(), requestId: actor.requestId ?? randomUUID() });
  return Object.freeze({
    async list(actor) {
      assertAppSessionRole(actor);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('select id, name, provider, created_by_subject, created_at from helmion.app_sessions where tenant_id=$1 and archived_at is null order by created_at desc limit 50', [scoped.tenantId]);
        return { sessions: r.rows.map(row) };
      });
    },
    async create(actor, input) {
      assertAppSessionRole(actor);
      const s = normalizeAppSession(input);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const ins = await client.query(
          `insert into helmion.app_sessions(tenant_id, name, provider, created_by_subject, idempotency_key) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, created_by_subject, idempotency_key) do nothing
           returning id, name, provider, created_by_subject, created_at`,
          [scoped.tenantId, s.name, s.provider, scoped.actorSubject, s.idempotencyKey]);
        if (ins.rowCount === 1) {
          await appendAuditEvent(client, scoped, { actionType: 'app.session.created', canonicalTarget: { sessionId: String(ins.rows[0].id), provider: s.provider }, policyVersion: 'app-sessions.v1', decision: 'ALLOW', privacySummary: `Started a ${s.provider} session`, result: { created: true } });
          return { session: row(ins.rows[0]), created: true };
        }
        const prior = await client.query('select id, name, provider, created_by_subject, created_at from helmion.app_sessions where tenant_id=$1 and created_by_subject=$2 and idempotency_key=$3', [scoped.tenantId, scoped.actorSubject, s.idempotencyKey]);
        return { session: row(prior.rows[0]), created: false };
      });
    },
    async archive(actor, id) {
      assertAppSessionRole(actor);
      const sid = String(id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(sid)) throw Object.assign(new Error('session id is invalid'), { status: 400 });
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('update helmion.app_sessions set archived_at=clock_timestamp() where tenant_id=$1 and id=$2 and archived_at is null returning id', [scoped.tenantId, sid]);
        if (r.rowCount === 1) await appendAuditEvent(client, scoped, { actionType: 'app.session.archived', canonicalTarget: { sessionId: sid }, policyVersion: 'app-sessions.v1', decision: 'ALLOW', privacySummary: 'Closed a session', result: { archived: true } });
        return { archived: r.rowCount === 1 };
      });
    },
  });
}

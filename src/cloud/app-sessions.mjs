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

export const STEP_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export function normalizeStepPlan(input = {}) {
  const sessionId = String(input.sessionId ?? '');
  if (!UUID.test(sessionId)) throw bad('session id is invalid');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20) throw bad('a plan needs 1 to 20 steps');
  const steps = input.steps.map((label) => String(label ?? '').trim());
  if (steps.some((l) => !l || l.length > 120)) throw bad('step label is missing or too long');
  return Object.freeze({ sessionId, steps: Object.freeze(steps) });
}

export function normalizeStepUpdate(input = {}) {
  const sessionId = String(input.sessionId ?? '');
  if (!UUID.test(sessionId)) throw bad('session id is invalid');
  const position = Number(input.position);
  if (!Number.isInteger(position) || position < 0 || position > 19) throw bad('step position is invalid');
  if (!STEP_STATUSES.includes(input.status)) throw bad('step status is invalid');
  return Object.freeze({ sessionId, position, status: input.status });
}

const stepRow = (r) => Object.freeze({ position: Number(r.position), label: String(r.label), status: String(r.status), updatedAt: r.updated_at });
const progress = (r) => Object.freeze({ total: Number(r.step_total ?? 0), done: Number(r.step_done ?? 0), failed: Number(r.step_failed ?? 0), current: r.step_current == null ? null : String(r.step_current) });
const row = (r) => Object.freeze({ id: String(r.id), name: String(r.name), provider: String(r.provider), createdBySubject: String(r.created_by_subject), createdAt: r.created_at, ...(r.step_total === undefined ? {} : { progress: progress(r) }) });
const PROGRESS_SQL = `select s.id, s.name, s.provider, s.created_by_subject, s.created_at,
  count(st.position)::int as step_total,
  count(st.position) filter (where st.status in ('done','skipped'))::int as step_done,
  count(st.position) filter (where st.status = 'failed')::int as step_failed,
  (array_agg(st.label order by st.position) filter (where st.status = 'running'))[1] as step_current
  from helmion.app_sessions s left join helmion.app_session_steps st on st.session_id = s.id and st.tenant_id = s.tenant_id
  where s.tenant_id=$1 and s.archived_at is null group by s.id order by s.created_at desc limit 50`;

export function createAppSessionStore(pool) {
  const ctx = (actor) => ({ tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId ?? randomUUID(), requestId: actor.requestId ?? randomUUID() });
  return Object.freeze({
    async list(actor) {
      assertAppSessionRole(actor);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query(PROGRESS_SQL, [scoped.tenantId]);
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
    async steps(actor, sessionId) {
      assertAppSessionRole(actor);
      const sid = String(sessionId ?? '');
      if (!UUID.test(sid)) throw bad('session id is invalid');
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query('select position, label, status, updated_at from helmion.app_session_steps where tenant_id=$1 and session_id=$2 order by position', [scoped.tenantId, sid]);
        return { sessionId: sid, steps: r.rows.map(stepRow) };
      });
    },
    async setPlan(actor, input) {
      assertAppSessionRole(actor);
      const plan = normalizeStepPlan(input);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const s = await client.query('select name from helmion.app_sessions where tenant_id=$1 and id=$2 and archived_at is null', [scoped.tenantId, plan.sessionId]);
        if (s.rowCount !== 1) throw Object.assign(new Error('session not found'), { status: 404 });
        await client.query('delete from helmion.app_session_steps where tenant_id=$1 and session_id=$2', [scoped.tenantId, plan.sessionId]);
        const r = await client.query(`insert into helmion.app_session_steps(tenant_id, session_id, position, label, updated_by_subject)
          select $1, $2, (o - 1)::smallint, l, $4 from unnest($3::text[]) with ordinality as t(l, o) returning position, label, status, updated_at`, [scoped.tenantId, plan.sessionId, plan.steps, scoped.actorSubject]);
        await appendAuditEvent(client, scoped, { actionType: 'app.task.planned', canonicalTarget: { sessionId: plan.sessionId, steps: plan.steps.length }, policyVersion: 'app-sessions.v1', decision: 'ALLOW', privacySummary: `Planned ${plan.steps.length} steps in ${s.rows[0].name}`, result: { steps: plan.steps.length } });
        return { sessionId: plan.sessionId, steps: r.rows.map(stepRow).sort((a, b) => a.position - b.position) };
      });
    },
    async updateStep(actor, input) {
      assertAppSessionRole(actor);
      const u = normalizeStepUpdate(input);
      return withTenantTransaction(pool, ctx(actor), async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const r = await client.query(`update helmion.app_session_steps st set status=$4, updated_by_subject=$5, updated_at=clock_timestamp()
          from helmion.app_sessions s where s.id = st.session_id and s.tenant_id = st.tenant_id and s.archived_at is null
          and st.tenant_id=$1 and st.session_id=$2 and st.position=$3 returning st.position, st.label, st.status, st.updated_at, s.name`, [scoped.tenantId, u.sessionId, u.position, u.status, scoped.actorSubject]);
        if (r.rowCount !== 1) throw Object.assign(new Error('step not found'), { status: 404 });
        const step = r.rows[0];
        if (u.status !== 'pending') {
          const verb = { running: 'Started', done: 'Finished', failed: 'Failed', skipped: 'Skipped' }[u.status];
          await appendAuditEvent(client, scoped, { actionType: `app.task.step_${u.status}`, canonicalTarget: { sessionId: u.sessionId, position: u.position }, policyVersion: 'app-sessions.v1', decision: 'ALLOW', privacySummary: `${verb}: ${step.label} (${step.name})`.slice(0, 240), result: { status: u.status } });
        }
        return { sessionId: u.sessionId, step: stepRow(step) };
      });
    },
  });
}

import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, TenantAuthorizationError, withTenantTransaction } from '../core/tenant-context.mjs';

export const ORGANIZATION_ROLE_CATALOG = Object.freeze([
  { jobTitle: 'owner', serverRole: 'owner', capabilities: ['manage_membership_plan', 'manage_cora_policy', 'approve_high_risk', 'read_audit'] },
  { jobTitle: 'admin', serverRole: 'admin', capabilities: ['manage_membership_plan', 'manage_cora_policy', 'approve_high_risk', 'read_audit'] },
  { jobTitle: 'operations_manager', serverRole: 'member', capabilities: ['read_envoy', 'prepare_workspace', 'prepare_tasks'] },
  { jobTitle: 'dispatcher', serverRole: 'member', capabilities: ['read_envoy', 'send_envoy', 'prepare_workspace'] },
  { jobTitle: 'safety_compliance', serverRole: 'member', capabilities: ['read_envoy', 'read_audit', 'prepare_workspace'] },
  { jobTitle: 'analyst', serverRole: 'member', capabilities: ['read_envoy', 'read_audit', 'prepare_workspace'] },
  { jobTitle: 'driver', serverRole: 'member', capabilities: ['read_envoy', 'send_envoy'] },
  { jobTitle: 'viewer', serverRole: 'auditor', capabilities: ['read_envoy', 'read_audit'] },
]);

const CATALOG = new Map(ORGANIZATION_ROLE_CATALOG.map((item) => [item.jobTitle, item]));

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role) throw new TenantAuthorizationError('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId ?? randomUUID(), requestId: actor.requestId ?? randomUUID() };
}

function catalogForServerRole(role) {
  const normalized = String(role ?? '').toLowerCase();
  return ORGANIZATION_ROLE_CATALOG.filter((item) => item.serverRole === normalized);
}

function membershipView(row) {
  const roles = catalogForServerRole(row.role);
  const primary = roles.find((item) => item.jobTitle === row.role) ?? roles[0];
  return { subject: String(row.subject), serverRole: String(row.role), active: row.active === true, jobTitle: ['owner', 'admin'].includes(String(row.role)) ? primary?.jobTitle ?? null : null, capabilities: primary?.capabilities ?? [] };
}

function requireCatalogTitle(value) {
  const title = String(value ?? '').trim().toLowerCase();
  if (!CATALOG.has(title)) throw Object.assign(new Error('job title is not in the fixed Organization catalog'), { status: 400 });
  return title;
}

export function createOrganizationRoleRepository(pool) {
  return Object.freeze({
    catalog() { return { roles: ORGANIZATION_ROLE_CATALOG, source: 'server_role_catalog', authority: 'tenant_memberships', mutation: 'not_performed' }; },
    async list(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const admin = ['owner', 'admin'].includes(String(actor.role).toLowerCase());
        const result = await client.query(admin
          ? 'select subject, role, active from helmion.tenant_memberships where tenant_id=$1 order by subject'
          : 'select subject, role, active from helmion.tenant_memberships where tenant_id=$1 and subject=$2',
        admin ? [scoped.tenantId] : [scoped.tenantId, scoped.actorSubject]);
        return { memberships: result.rows.map(membershipView), roles: ORGANIZATION_ROLE_CATALOG, pending: [], source: 'helmion.tenant_memberships', externalIdentityMutation: 'not_performed' };
      });
    },
    async prepareRolePlan(actor, input = {}) {
      const active = context(actor);
      if (!['owner', 'admin'].includes(String(actor.role).toLowerCase())) throw Object.assign(new Error('owner or admin membership is required'), { status: 403 });
      const subject = String(input.subject ?? '').trim();
      if (!subject || subject.length > 200) throw Object.assign(new Error('membership subject is required'), { status: 400 });
      const jobTitle = requireCatalogTitle(input.jobTitle);
      const reason = String(input.reason ?? '').trim();
      if (!reason || reason.length > 1000) throw Object.assign(new Error('role plan reason is required'), { status: 400 });
      const idempotencyKey = String(input.idempotencyKey ?? '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(idempotencyKey)) throw Object.assign(new Error('role plan idempotency key is invalid'), { status: 400 });
      const desired = CATALOG.get(jobTitle);
      if (subject === active.actorSubject && !['owner', 'admin'].includes(desired.serverRole)) throw Object.assign(new Error('self-lockout is not permitted'), { status: 409 });
      return withTenantTransaction(pool, active, async (client, scoped) => {
        await requireActiveTenantMembership(client, scoped);
        const target = await client.query('select subject, role, active from helmion.tenant_memberships where tenant_id=$1 and subject=$2', [scoped.tenantId, subject]);
        if (target.rowCount !== 1 || target.rows[0].active !== true) throw Object.assign(new Error('target must be one active Organization member'), { status: 404 });
        const existing = await client.query(`select id, result, created_at from helmion.audit_events where tenant_id=$1 and actor_subject=$2 and action_type='organization.membership_role_plan' and result->>'idempotencyKey'=$3 order by id desc limit 1`, [scoped.tenantId, scoped.actorSubject, idempotencyKey]);
        if (existing.rowCount === 1) return { durable: true, replayed: true, receiptId: String(existing.rows[0].id), status: 'prepared', membershipChanged: false, externalIdentityMutation: 'not_performed', plan: { subject, currentServerRole: target.rows[0].role, requestedJobTitle: jobTitle, requestedServerRole: desired.serverRole } };
        const result = await client.query(`insert into helmion.audit_events (tenant_id, actor_subject, actor_role, session_id, request_id, action_type, canonical_target, policy_version, decision, privacy_summary, result) values ($1,$2,$3,$4,$5,'organization.membership_role_plan',$6::jsonb,'organization-role-plan.v1','PAUSE_FOR_OWNER',$7,$8::jsonb) returning id`, [scoped.tenantId, scoped.actorSubject, scoped.actorRole, scoped.sessionId, scoped.requestId, JSON.stringify({ subject, requestedJobTitle: jobTitle, requestedServerRole: desired.serverRole }), 'Role assignment prepared for external identity/admin review; membership unchanged', JSON.stringify({ idempotencyKey, status: 'prepared', membershipChanged: false, externalIdentityMutation: 'not_performed' })]);
        return { durable: true, replayed: false, receiptId: String(result.rows[0]?.id ?? ''), status: 'prepared', membershipChanged: false, externalIdentityMutation: 'not_performed', plan: { subject, currentServerRole: target.rows[0].role, requestedJobTitle: jobTitle, requestedServerRole: desired.serverRole }, approval: 'external_identity_or_admin_action_required' };
      });
    },
  });
}

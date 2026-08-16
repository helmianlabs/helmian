import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

export const TENANT_RBAC_POLICY_VERSION = 'tenant-rbac-abac.v1';

const ACTION_ROLES = Object.freeze({
  'workspace.project.read': Object.freeze(new Set(['owner', 'admin', 'member', 'auditor'])),
  'workspace.project.write': Object.freeze(new Set(['owner', 'admin'])),
});

function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function authorizeTenantAction(actor, { action, tenantId } = {}) {
  const normalizedAction = text(action);
  const expectedTenantId = text(tenantId);
  const role = text(actor?.role);
  const roles = ACTION_ROLES[normalizedAction];
  const tenantMatches = Boolean(expectedTenantId) && text(actor?.tenantId) === expectedTenantId;
  const allowed = Boolean(roles && tenantMatches && roles.has(role));
  const reason = !roles
    ? 'action is not in the tenant policy catalog'
    : !tenantMatches
      ? 'actor tenant does not match the requested tenant'
      : allowed
        ? 'role is allowed for the tenant action'
        : 'role is not allowed for the tenant action';
  return Object.freeze({
    allowed,
    decision: allowed ? 'ALLOW' : 'DENY',
    action: normalizedAction,
    tenantId: expectedTenantId,
    role,
    policyVersion: TENANT_RBAC_POLICY_VERSION,
    reason,
  });
}

export async function persistTenantActionDecision(pool, actor, authorization) {
  if (!authorization || typeof authorization !== 'object') throw new TypeError('authorization decision is required');
  const active = {
    tenantId: actor?.tenantId,
    actorSubject: actor?.subject,
    actorRole: actor?.role,
    sessionId: actor?.sessionId,
    requestId: actor?.requestId,
  };
  return withTenantTransaction(pool, active, async (client, context) => {
    await requireActiveTenantMembership(client, context);
    const result = await client.query(
      `insert into helmion.audit_events
         (tenant_id, actor_subject, actor_role, session_id, request_id,
          action_type, canonical_target, policy_version, decision,
          privacy_summary, result)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
       returning id`,
      [
        context.tenantId,
        context.actorSubject,
        context.actorRole,
        context.sessionId,
        context.requestId,
        authorization.action,
        JSON.stringify({ resource: authorization.action, tenantId: context.tenantId }),
        authorization.policyVersion,
        authorization.decision,
        `Tenant RBAC decision: ${authorization.reason}`,
        JSON.stringify({ role: context.actorRole, allowed: authorization.allowed, reason: authorization.reason }),
      ],
    );
    if (result.rowCount !== 1 || result.rows[0]?.id == null) throw new Error('tenant action decision receipt was not durable');
    return {
      durable: true,
      receiptId: String(result.rows[0].id),
      source: 'helmion.audit_events',
      authorization,
    };
  });
}

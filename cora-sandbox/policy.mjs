// Deny-by-default RBAC + ABAC for the Cora sandbox.
// Every decision is a plain object { decision, rule, reason } so it can be audited.
// Tenant match, surface, role and approval are checked in that order.

export const ROLE_ORDER = Object.freeze(['viewer', 'operator', 'dispatcher', 'supervisor', 'admin', 'owner']);

export const ROLE_PERMISSIONS = Object.freeze({
  viewer: ['page.read'],
  operator: ['page.read', 'page.build'],
  dispatcher: ['page.read', 'page.build', 'change.propose'],
  supervisor: ['page.read', 'page.build', 'change.propose'],
  admin: ['page.read', 'page.build', 'change.propose', 'change.apply', 'connector.manage'],
  owner: ['page.read', 'page.build', 'change.propose', 'change.apply', 'connector.manage'],
  superadmin: ['page.read', 'page.build', 'change.propose', 'change.apply', 'connector.manage'],
  // Executive Guard acts as the human approver; no tenant role can approve.
  guard: ['change.approve'],
});

// Surface caps: whatever the role allows is further limited by where the request came from.
export const SURFACE_PERMISSIONS = Object.freeze({
  web: ['page.read', 'page.build', 'change.propose', 'change.apply', 'connector.manage'],
  driver: ['page.read'],
  agent: ['page.read', 'page.build', 'change.propose'],
  guard: ['change.approve'],
});

export const ACTIONS = Object.freeze([
  'page.read', 'page.build', 'change.propose', 'change.apply', 'change.approve', 'connector.manage',
]);

function deny(rule, reason) {
  return { decision: 'deny', rule, reason };
}

function allow(rule) {
  return { decision: 'allow', rule, reason: 'permitted' };
}

// subject: { tenantId, role, surface, userId }
// resource: { tenantId, hash? }
// env: { approval?: { state, hash } }
export function evaluate(subject, action, resource, env = {}) {
  if (!ACTIONS.includes(action)) return deny('unknown_action', `unknown action: ${action}`);
  if (!subject || typeof subject.tenantId !== 'string' || subject.tenantId === '') {
    return deny('missing_subject_tenant', 'subject has no tenantId');
  }
  if (!resource || resource.tenantId !== subject.tenantId) {
    return deny('cross_tenant', 'resource belongs to another tenant');
  }
  const surface = subject.surface ?? 'web';
  if (!SURFACE_PERMISSIONS[surface]) return deny('unknown_surface', `unknown surface: ${surface}`);
  if (!ROLE_PERMISSIONS[subject.role]) return deny('unknown_role', `unknown role: ${subject.role}`);
  if (!SURFACE_PERMISSIONS[surface].includes(action)) {
    return deny('surface_forbidden', `surface ${surface} may not ${action}`);
  }
  if (!ROLE_PERMISSIONS[subject.role].includes(action)) {
    return deny('role_forbidden', `role ${subject.role} may not ${action}`);
  }
  if (action === 'change.apply') {
    const approval = env && env.approval;
    if (!approval || approval.state !== 'approved') return deny('approval_missing', 'change is not approved');
    if (!resource.hash || approval.hash !== resource.hash) {
      return deny('approval_hash_mismatch', 'approval hash does not match change');
    }
  }
  return allow('rbac_abac');
}

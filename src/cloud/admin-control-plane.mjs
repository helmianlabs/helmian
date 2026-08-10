import { listLocalIntegrationReadiness } from '../core/local-orchestration.mjs';
import { normalizeActorRole, normalizeTenantId } from '../core/tenant-context.mjs';
import { listLoadBoardProviderReadiness } from './load-board-provider-registry.mjs';
const ADMIN_ROLES = new Set(['owner', 'admin']);
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function buildCloudAdminControlSurface(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input invalid');
    const tenant_id = normalizeTenantId(input.tenant_id); const actor_role = normalizeActorRole(input.actor_role);
    if (!ADMIN_ROLES.has(actor_role) || Object.keys(input).some((key) => !['tenant_id', 'actor_role'].includes(key))) throw new TypeError('scope invalid');
    const integrations = listLocalIntegrationReadiness({ tenant_id, actor_role }); const loadBoards = listLoadBoardProviderReadiness({ tenant_id, actor_role });
    if (!integrations.valid || !loadBoards.valid) throw new TypeError('readiness unavailable');
    return freeze({ valid: true, result: { format: 'helmion.cloud-admin-control-surface.v1', tenant_id, actor_role,
      sections: freeze([{ id: 'tenants', state: 'sample-ready', action: 'view_tenant_scope' }, { id: 'integrations', state: 'sample-ready', action: 'view_connection_readiness' }, { id: 'approvals', state: 'sample-ready', action: 'view_pending_approval_posture' }, { id: 'audit', state: 'sample-ready', action: 'view_tenant_audit_posture' }]),
      integrations: integrations.result, load_boards: loadBoards.result, authorization: 'tenant_admin_scope_verified', invocation: 'not_performed', mutation: 'not_performed' } });
  } catch { return freeze({ valid: false, code: 'CLOUD_ADMIN_CONTROL_SURFACE_INVALID' }); }
}

import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { normalizeOrganizationDatabaseRecord } from './organization-database-routing.mjs';

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

export function createOrganizationDatabaseRepository(pool) {
  return Object.freeze({
    async resolve(actor) {
      const active = context(actor);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query('select tenant_id, logical_database_locator, secret_reference_name, region, lifecycle from helmion.organization_database_registry where tenant_id=$1', [active.tenantId]);
        if (result.rowCount !== 1) return { status: 'unavailable', reason: 'Organization database registry entry is not configured', organizationId: active.tenantId, connectionString: null };
        const record = normalizeOrganizationDatabaseRecord(result.rows[0], active.tenantId);
        return { status: record.lifecycle === 'active' ? 'active' : 'unavailable', reason: record.lifecycle === 'active' ? 'logical locator resolved; future customer-data adapter is not enabled' : `database registry lifecycle is ${record.lifecycle}`, ...record };
      });
    },
  });
}

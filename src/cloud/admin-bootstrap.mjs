import { randomUUID } from 'node:crypto';
import { assertExpectedNeonEndpoint } from '../core/database-target.mjs';
import { normalizeTenantId } from '../core/tenant-context.mjs';

function required(value, name, max = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new Error(`${name} is required and must be ${max} characters or fewer`);
  return text;
}

/** Explicit one-time enrollment only; login never calls this function. */
export async function bootstrapHelmianAdminOwner(input, {
  connectionString = process.env.HELMION_DATABASE_URL,
  expectedEndpointId = process.env.HELMION_EXPECTED_ENDPOINT_ID,
  pool: suppliedPool = null,
} = {}) {
  const target = assertExpectedNeonEndpoint(connectionString, expectedEndpointId);
  const tenantId = normalizeTenantId(input?.tenantId);
  const displayName = required(input?.displayName, 'displayName');
  const subject = required(input?.subject, 'subject');
  if (input?.confirmed !== true) throw new Error('Explicit confirmed=true is required');
  const ownsPool = !suppliedPool;
  const pool = suppliedPool ?? new (await import('pg')).Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('helmion.admin-bootstrap'))");
    const schema = await client.query("select to_regclass('helmion.tenants') as tenants, to_regclass('helmion.tenant_memberships') as memberships, to_regclass('helmion.audit_events') as audit_events");
    if (!schema.rows[0]?.tenants || !schema.rows[0]?.memberships || !schema.rows[0]?.audit_events) {
      throw new Error('Helmian tenant/audit migrations are not ready');
    }
    await client.query(
      `select set_config('helmion.tenant_id',$1,true),
              set_config('helmion.actor_subject',$2,true),
              set_config('helmion.actor_role','owner',true),
              set_config('helmion.session_id',$3,true),
              set_config('helmion.request_id',$4,true)`,
      [tenantId, subject, randomUUID(), randomUUID()],
    );
    const tenantInsert = await client.query(
      'insert into helmion.tenants(tenant_id, display_name) values ($1,$2) on conflict (tenant_id) do nothing returning tenant_id',
      [tenantId, displayName],
    );
    const tenant = await client.query('select tenant_id, display_name from helmion.tenants where tenant_id=$1 for update', [tenantId]);
    if (tenant.rowCount !== 1 || tenant.rows[0].display_name !== displayName) throw new Error('Existing tenant does not match the explicit display name');
    const membershipInsert = await client.query(
      "insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,'owner',true) on conflict (tenant_id, subject) do nothing returning tenant_id",
      [tenantId, subject],
    );
    const membership = await client.query('select tenant_id, subject, role, active from helmion.tenant_memberships where tenant_id=$1 and subject=$2 for update', [tenantId, subject]);
    if (membership.rowCount !== 1 || membership.rows[0].role !== 'owner' || membership.rows[0].active !== true) throw new Error('Existing membership is not the requested active owner');
    const created = tenantInsert.rowCount === 1 || membershipInsert.rowCount === 1;
    if (created) {
      await client.query(
        `insert into helmion.audit_events
          (tenant_id, actor_subject, actor_role, session_id, request_id, action_type, canonical_target, policy_version, decision, privacy_summary, result)
         values ($1,$2,'owner',$3,$4,'admin.bootstrap_owner',$5::jsonb,'admin-bootstrap.v1','ALLOW','Explicit one-time platform owner enrollment',$6::jsonb)`,
        [tenantId, subject, randomUUID(), randomUUID(), JSON.stringify({ tenantId, subject }), JSON.stringify({ created: true })],
      );
    }
    await client.query('commit');
    return Object.freeze({ tenantId, displayName, subject, role: 'owner', active: true, created, endpointId: target.endpointId });
  } catch (error) {
    try { await client.query('rollback'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
    if (ownsPool) await pool.end();
  }
}

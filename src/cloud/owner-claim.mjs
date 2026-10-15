// First-owner claim: lets the platform owner get into /admin after signing in
// with Clerk, without hand-copying their OIDC subject into a CLI.
// Fires only when ALL hold:
//  - HELMION_ADMIN_OWNER_EMAIL and HELMION_ADMIN_BOOTSTRAP_TENANT are set
//  - the signed-in session has a verified email equal to HELMION_ADMIN_OWNER_EMAIL
//  - the bootstrap tenant has no active owner yet (one-shot; later sign-ins are no-ops)
import { bootstrapHelmianAdminOwner } from './admin-bootstrap.mjs';

export async function claimFirstOwner({ pool, env = process.env, session, logger = () => {}, bootstrap = bootstrapHelmianAdminOwner } = {}) {
  const ownerEmail = String(env.HELMION_ADMIN_OWNER_EMAIL ?? '').trim().toLowerCase();
  const tenantId = String(env.HELMION_ADMIN_BOOTSTRAP_TENANT ?? '').trim().toLowerCase();
  if (!ownerEmail || !tenantId || !session?.subject) return { claimed: false, reason: 'not_configured' };
  if (session.emailVerified !== true || session.email !== ownerEmail) return { claimed: false, reason: 'not_owner_email' };
  const client = await pool.connect();
  let owners;
  try {
    owners = await client.query("select count(*)::int as n from helmion.tenant_memberships where tenant_id=$1 and role='owner' and active", [tenantId]);
  } finally { client.release(); }
  if ((owners.rows[0]?.n ?? 0) > 0) return { claimed: false, reason: 'owner_exists' };
  const result = await bootstrap({ tenantId, displayName: env.HELMION_ADMIN_BOOTSTRAP_TENANT_NAME || tenantId, subject: session.subject, confirmed: true }, {
    connectionString: env.HELMION_DATABASE_URL, expectedEndpointId: env.HELMION_EXPECTED_ENDPOINT_ID, pool,
  });
  logger('admin.owner_claim', 'allowed', { tenantId, created: result.created });
  return { claimed: true, tenantId };
}

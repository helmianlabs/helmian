// TEMPORARY one-shot runner for Herald migration 002.
//
// Why this exists: HELMION_HERALD_DATABASE_URL is configured on Vercel as a
// write-only ("sensitive") variable, so the standalone migration script
// cannot read it back from outside the deployment. This route runs the same
// migration from inside the deployment, where the value is available as
// process.env at runtime. Remove this module and its delegate wiring after
// the production run has been verified.
//
// Gate: the delegate receives live-admin's activeTenantActor, the same actor
// derivation used by the other /api/admin/* routes, and additionally requires
// the actor's tenant role to be exactly "owner".

import { HERALD_ACCOUNT_CONTROL_SQL } from './herald-account-control-sql.mjs';

export const HERALD_MIGRATION_002_PATH = '/api/admin/herald/run-migration-002';

// Same order as web/marketing/scripts/apply-herald-account-migration.mjs.
export const HERALD_MIGRATION_002_TABLES = Object.freeze([
  'herald_accounts',
  'herald_desktop_enrollments',
  'herald_enrollment_confirmation_limits',
  'herald_registered_desktops',
  'herald_account_sessions',
  'herald_control_grants',
  'herald_desktop_nonces',
  'herald_account_nonces',
]);

const ADVISORY_LOCK_SQL = "select pg_advisory_xact_lock(hashtext('helmian-herald-account-control-v1'))";
const VERIFY_TABLES_SQL = `select relname from pg_class
     where relkind='r' and relname = any($1::text[])
     order by relname`;

async function defaultCreateClient(connectionString) {
  const { default: pg } = await import('pg');
  const Client = pg?.Client;
  if (typeof Client !== 'function') throw new Error('pg Client is not available.');
  return new Client({ connectionString, connectionTimeoutMillis: 8_000 });
}

async function verifiedTables(client) {
  const result = await client.query(VERIFY_TABLES_SQL, [HERALD_MIGRATION_002_TABLES]);
  return (result?.rows ?? []).map((row) => String(row.relname));
}

export async function runHeraldMigration002({
  env = process.env,
  createClient = defaultCreateClient,
} = {}) {
  const connectionString = String(env.HELMION_HERALD_DATABASE_URL ?? '').trim();
  if (!connectionString) throw new Error('HELMION_HERALD_DATABASE_URL is not configured.');

  const client = await createClient(connectionString);
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query('begin');
    transactionOpen = true;
    await client.query(ADVISORY_LOCK_SQL);

    const before = await verifiedTables(client);
    const alreadyApplied = HERALD_MIGRATION_002_TABLES.every((table) => before.includes(table));

    await client.query(HERALD_ACCOUNT_CONTROL_SQL);

    const verified = await verifiedTables(client);
    if (
      verified.length !== HERALD_MIGRATION_002_TABLES.length
      || !HERALD_MIGRATION_002_TABLES.every((table) => verified.includes(table))
    ) {
      throw new Error('Herald account-control migration verification did not find every expected table.');
    }

    await client.query('commit');
    transactionOpen = false;
    return {
      alreadyApplied,
      state: alreadyApplied ? 'already_applied' : 'applied',
      verifiedTables: verified,
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('rollback'); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    try { await client.end(); } catch { /* the client may never have connected */ }
  }
}

export async function handleHeraldMigration002Route({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  runMigration = runHeraldMigration002,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== HERALD_MIGRATION_002_PATH) return false;
  const sendJson = (status, body) => send(response, status, JSON.stringify(body));

  if (request?.method !== 'POST') {
    sendJson(405, { valid: false, code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  let actor;
  try {
    actor = await activeTenantActor(request);
  } catch (error) {
    const denied = error?.status === 403
      || (TenantAuthorizationError && error instanceof TenantAuthorizationError);
    sendJson(denied ? 403 : 503, {
      valid: false,
      code: denied ? 'HERALD_MIGRATION_002_FORBIDDEN' : 'HERALD_MIGRATION_002_UNAVAILABLE',
    });
    return true;
  }

  if (String(actor?.role ?? '').toLowerCase() !== 'owner') {
    sendJson(403, { valid: false, code: 'HERALD_MIGRATION_002_OWNER_REQUIRED' });
    return true;
  }

  try {
    const result = await runMigration();
    sendJson(200, {
      ok: true,
      verifiedTables: result.verifiedTables,
      alreadyApplied: result.alreadyApplied === true,
      state: result.state,
    });
  } catch (error) {
    sendJson(500, { ok: false, error: error?.message ?? String(error) });
  }
  return true;
}

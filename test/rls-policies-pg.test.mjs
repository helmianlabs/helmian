// Row-level security policies against a real database.
// The tenant-isolation-pg suite proves the application boundary as a
// superuser, which bypasses row-level security by design; this suite
// proves the database's own layer. It creates a throwaway non-owner
// role, seeds two tenants' rows as the scratch superuser, then
// connects AS the restricted role: with the session's tenant set to
// tenant A it must see tenant A's rows only, a write naming tenant B
// must be refused by the policy, and with no tenant set it must see
// nothing at all.
//
// Coverage is the eleven tables sql/096_rls_tenant_tables.sql brings
// under row-level security, exercised here through five of them with
// distinct shapes (a bigserial findings table, a lease table, an
// outbound queue, a tenant-keyed canvas, a tenant-keyed profile). The
// policy-presence test below pins all eleven by name, so a table
// losing its policy fails this suite even where no row test covers it.
//
// Runs when HELMIAN_TEST_PG_URL points at a scratch database with the
// repo's sql/ migrations applied, and skips cleanly without one (the
// tenant-isolation-pg.test.mjs pattern).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

const RLS_TABLES_096 = [
  'connector_outbound_messages',
  'cora_agent_task_runs',
  'cora_artifact_execution_runs',
  'guard_finding_acks',
  'guard_findings',
  'provenance_weighting_profiles',
  'workspace_active_project_selections',
  'workspace_project_canvases',
  'workspace_project_decisions',
  'workspace_repo_bindings',
  'workspace_write_leases',
];

async function makePool(connectionString) {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: connectionString ?? pgUrl });
}

function probeUrl(role, password) {
  const u = new URL(pgUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

test('sql/096 tables all carry row-level security and a tenant policy', { skip: pgSkip }, async () => {
  const pool = await makePool();
  try {
    const r = await pool.query(
      `select c.relname as table_name, c.relrowsecurity as rls_on,
              (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'helmion' and c.relname = any($1)`,
      [RLS_TABLES_096],
    );
    assert.equal(r.rows.length, RLS_TABLES_096.length, 'every sql/096 table exists');
    for (const row of r.rows) {
      assert.equal(row.rls_on, true, `${row.table_name} has row-level security on`);
      assert.ok(Number(row.policies) >= 1, `${row.table_name} carries at least one policy`);
    }
  } finally {
    await pool.end();
  }
});

test('a non-owner role sees only its own tenant rows under the sql/096 policies', { skip: pgSkip }, async () => {
  const run = randomUUID().slice(0, 8);
  const A = `ra-${run}`;
  const B = `rb-${run}`;
  const role = `rls_probe_${run.replaceAll('-', '_')}`;
  const password = `probe-${run}`;
  const admin = await makePool();
  const probe = await makePool(probeUrl(role, password));
  try {
    await admin.query(`create role ${role} login password '${password}'`);
    await admin.query(`grant usage on schema helmion to ${role}`);
    for (const t of ['guard_findings', 'workspace_write_leases', 'connector_outbound_messages', 'workspace_project_canvases', 'provenance_weighting_profiles']) {
      await admin.query(`grant select, insert, update, delete on helmion.${t} to ${role}`);
    }
    for (const t of [A, B]) {
      await admin.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [t, `RLS ${t}`]);
      await admin.query('insert into helmion.guard_findings(tenant_id, fingerprint, source, severity, title) values ($1,$2,$3,$4,$5)',
        [t, `fp-${t}-canary`, 'cloud', 'warning', `canary ${t}`]);
      await admin.query('insert into helmion.workspace_write_leases(tenant_id, holder, lease_token, expires_at) values ($1,$2,$3, now() + interval \'1 hour\')',
        [t, `holder-${t}`, `lease-${t}`]);
      await admin.query('insert into helmion.connector_outbound_messages(tenant_id, provider, text) values ($1,$2,$3)',
        [t, 'discord', `canary ${t}`]);
      await admin.query('insert into helmion.workspace_project_canvases(tenant_id, project_key) values ($1,$2)', [t, `proj-${t}`]);
      await admin.query('insert into helmion.provenance_weighting_profiles(tenant_id, payload, updated_by_subject) values ($1,$2,$3)',
        [t, JSON.stringify({ canary: t }), 'probe-seed']);
    }

    const client = await probe.connect();
    try {
      // No tenant context: nothing is visible.
      for (const t of ['guard_findings', 'workspace_write_leases', 'connector_outbound_messages', 'workspace_project_canvases', 'provenance_weighting_profiles']) {
        const r = await client.query(`select count(*)::int as n from helmion.${t} where tenant_id in ($1,$2)`, [A, B]);
        assert.equal(r.rows[0].n, 0, `${t}: no context sees no rows`);
      }
      // Tenant A context: exactly A's row in each table, never B's.
      await client.query("select set_config('helmion.tenant_id', $1, false)", [A]);
      for (const t of ['guard_findings', 'workspace_write_leases', 'connector_outbound_messages', 'workspace_project_canvases', 'provenance_weighting_profiles']) {
        const r = await client.query(`select tenant_id from helmion.${t} where tenant_id in ($1,$2)`, [A, B]);
        assert.deepEqual(r.rows.map((x) => x.tenant_id), [A], `${t}: tenant A context sees only tenant A`);
      }
      // A write naming tenant B under tenant A's context is refused.
      await assert.rejects(
        client.query('insert into helmion.guard_findings(tenant_id, fingerprint, source, severity, title) values ($1,$2,$3,$4,$5)',
          [B, `fp-${B}-forged`, 'cloud', 'warning', 'forged']),
        /row-level security/i,
        'the policy refuses a cross-tenant write',
      );
      // A write naming tenant A under tenant A's context is allowed.
      await client.query('insert into helmion.guard_findings(tenant_id, fingerprint, source, severity, title) values ($1,$2,$3,$4,$5)',
        [A, `fp-${A}-own`, 'cloud', 'info', 'own write']);
    } finally {
      client.release();
    }
  } finally {
    await probe.end().catch(() => {});
    await admin.query(`drop owned by ${role}`).catch(() => {});
    await admin.query(`drop role if exists ${role}`).catch(() => {});
    for (const t of [A, B]) {
      await admin.query('delete from helmion.tenants where tenant_id=$1', [t]).catch(() => {});
    }
    await admin.end();
  }
});

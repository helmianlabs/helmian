// Read-only proof for the sql/069 replay, run INSIDE helmian-credential-
// service: the schema_migrations ledger row for 069 and the new table's
// regclass. Adapted from neon-check-068.mjs.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint:', endpoint);
console.log('endpoint-guard(ep-proud-truth-a69e8vg4):', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL');
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);

const pool = new pg.Pool({ connectionString: url });
try {
  const led = await pool.query(
    "select version, name, checksum, applied_at from helmion.schema_migrations where version in ('068','069') order by version",
  );
  console.log('ledger rows:', JSON.stringify(led.rows));
  const tbl = await pool.query("select to_regclass('helmion.workspace_agent_faces') as t");
  console.log('workspace_agent_faces regclass:', JSON.stringify(tbl.rows[0]));
  const cols = await pool.query(
    "select column_name, data_type from information_schema.columns where table_schema='helmion' and table_name='workspace_agent_faces' order by ordinal_position",
  );
  console.log('columns:', JSON.stringify(cols.rows));
  const pol = await pool.query(
    "select policyname from pg_policies where schemaname='helmion' and tablename='workspace_agent_faces'",
  );
  console.log('policies:', JSON.stringify(pol.rows));
} finally {
  await pool.end();
}

// sql/070 replay — applyMigration's exact steps (src/adapters/neon.mjs) for
// the single file 070_profile_sync_jobs.sql, run INSIDE helmian-
// credential-service (the 066/067/068 road). SQL arrives base64 in
// MIG_SQL_B64; its canonical sha256 must match the pinned checksum before
// anything runs. Adapted verbatim from neon-apply-068.mjs.
import { createHash } from 'node:crypto';
import pg from 'pg';

const EXPECTED_CHECKSUM = '38bcf2f4d05958d571d24c733b8fcc10b44a90195760f8e42c520428f9347ae8';
const VERSION = '070';
const NAME = '070_profile_sync_jobs.sql';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT_GUARD_FAIL', endpoint); process.exit(2); }
console.log('endpoint guard: PASS', endpoint);

const raw = Buffer.from(process.env.MIG_SQL_B64 || '', 'base64').toString('utf8');
const sql = raw.replace(/\r\n?/g, '\n'); // canonicalizeMigrationSql, verbatim
const checksum = createHash('sha256').update(sql).digest('hex');
console.log('canonical sha256:', checksum);
if (checksum !== EXPECTED_CHECKSUM) { console.log('CHECKSUM_MISMATCH — refusing'); process.exit(3); }

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query('begin');
  // withCommittedTransaction + applyMigration, step for step:
  await client.query('select pg_advisory_xact_lock(hashtext($1))', ['helmion.schema_migrations']);
  await client.query('create schema if not exists helmion');
  await client.query(
    `create table if not exists helmion.schema_migrations (
       version text primary key,
       name text not null unique,
       checksum text not null,
       applied_at timestamptz not null default clock_timestamp()
     )`,
  );
  const existing = await client.query(
    'select name, checksum from helmion.schema_migrations where version=$1',
    [VERSION],
  );
  if (existing.rowCount === 1) {
    const row = existing.rows[0];
    if (row.name !== NAME || row.checksum !== checksum) {
      throw new Error(`Applied migration ${VERSION} does not match ${NAME}`);
    }
    await client.query('rollback');
    console.log('ALREADY_APPLIED (name+checksum match) — nothing done');
    process.exitCode = 0;
  } else {
    await client.query(sql);
    await client.query(
      `insert into helmion.schema_migrations(version, name, checksum)
       values ($1,$2,$3)`,
      [VERSION, NAME, checksum],
    );
    await client.query('commit');
    console.log('APPLIED 070 in one committed transaction');
  }
} catch (error) {
  try { await client.query('rollback'); } catch {}
  console.log('FAILED, rolled back:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

// READ-ONLY Neon check after the F2 resume abort (2026-11-05 ~22:0x MST).
// Runs INSIDE helmian-credential-service (same road as forensic2-jobs.mjs).
// SELECT only. Prints booleans for hash columns — never hash/token values.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint-guard(ep-proud-truth-a69e8vg4):', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL');
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);

const pool = new pg.Pool({ connectionString: url });
try {
  const link = await pool.query(
    `select id, tenant_id, created_at, code_expires_at, linked_at,
            (token_hash is null) as token_hash_null,
            (code_hash is null) as code_hash_null
       from helmion.desktop_links
      where id = '51a3aff5-b975-4046-b672-3757f8ff6696'`,
  );
  console.log('pairing row 51a3aff5:', JSON.stringify(link.rows, null, 1));
  const jobs = await pool.query(
    `select id, status, claimed_at, completed_at, error
       from helmion.profile_sync_jobs order by id`,
  );
  console.log('profile_sync_jobs:', JSON.stringify(jobs.rows, null, 1));
  const now = await pool.query('select now() as db_now');
  console.log('db now:', JSON.stringify(now.rows[0]));
} finally {
  await pool.end();
}

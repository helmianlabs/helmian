// FORENSIC ROUND 2 — Q1: read-only read of helmion.profile_sync_jobs, run
// INSIDE helmian-credential-service (same road as neon-check-070.mjs).
// SELECT only. No writes.
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
  const jobs = await pool.query(
    `select id, tenant_id, kind, status, requested_by, created_at, claimed_at, completed_at,
            error, case when result is null then null else left(result::text, 400) end as result_head
       from helmion.profile_sync_jobs order by id`,
  );
  console.log('job rows:', JSON.stringify(jobs.rows, null, 1));
  const now = await pool.query('select now() as db_now');
  console.log('db now:', JSON.stringify(now.rows[0]));
  const links = await pool.query(
    `select id, label, subject, active, revoked_at, last_used_at, created_at
       from helmion.desktop_links
      where tenant_id = '0d7ca4d3-a2f4-458a-936b-d8a002a569e0' order by created_at`,
  );
  console.log('desktop_links:', JSON.stringify(links.rows, null, 1));
} finally {
  await pool.end();
}

// CLAIM FORENSIC (2026-11-05 evening) — READ-ONLY. SELECT only.
// Q: why does the bridge never claim? Did Fix A v2 land? Which subject's
// token is resolving NOW? Run INSIDE helmian-credential-service.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint-guard(ep-proud-truth-a69e8vg4):', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL');
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);

const pool = new pg.Pool({ connectionString: url });
try {
  const now = await pool.query(`select now() as db_now`);
  console.log('db_now:', JSON.stringify(now.rows));

  const jobs = await pool.query(
    `select id, tenant_id, status, created_at, claimed_at, completed_at
       from helmion.profile_sync_jobs order by id`,
  );
  console.log('profile_sync_jobs (ALL tenants):', JSON.stringify(jobs.rows, null, 1));

  const links = await pool.query(
    `select id, tenant_id, label, subject, linked_at, revoked_at, last_used_at, created_at
       from helmion.desktop_links order by created_at`,
  );
  console.log('desktop_links (all):', JSON.stringify(links.rows, null, 1));

  const subjects = [...new Set(links.rows.map((r) => r.subject).filter(Boolean))];
  for (const subject of subjects) {
    const mem = await pool.query(
      `select tenant_id, role, active, created_at
         from helmion.tenant_memberships
        where subject = $1
        order by created_at asc, tenant_id asc`,
      [subject],
    );
    console.log(`memberships for ${subject} (row[0] = claim tenant):`, JSON.stringify(mem.rows, null, 1));
  }
} finally {
  await pool.end();
}

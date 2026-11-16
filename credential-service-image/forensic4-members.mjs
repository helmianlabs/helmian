// FORENSIC CONTINUATION 4 — read-only: who does the bridge's device token
// resolve to, and which tenant does deriveTenantActor pick for that subject?
// SELECT only. Run INSIDE helmian-credential-service (same road as
// forensic2-jobs.mjs). No secrets read: desktop_links token material is
// never selected.
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
  const links = await pool.query(
    `select id, tenant_id, label, subject, linked_at, revoked_at, last_used_at, created_at
       from helmion.desktop_links order by created_at`,
  );
  console.log('desktop_links (all tenants):', JSON.stringify(links.rows, null, 1));

  const subjects = [...new Set(links.rows.map((r) => r.subject).filter(Boolean))];
  for (const subject of subjects) {
    const mem = await pool.query(
      `select tenant_id, role, active, created_at
         from helmion.tenant_memberships
        where subject = $1
        order by created_at asc, tenant_id asc`,
      [subject],
    );
    console.log(`memberships for subject ${subject} (created_at asc — row[0] is the tenant deriveTenantActor picks):`,
      JSON.stringify(mem.rows, null, 1));
  }

  const jobs = await pool.query(
    `select tenant_id, count(*) as n, min(created_at) as first_at, max(created_at) as last_at
       from helmion.profile_sync_jobs group by tenant_id order by tenant_id`,
  );
  console.log('profile_sync_jobs by tenant:', JSON.stringify(jobs.rows, null, 1));

  const tenants = await pool.query(
    `select tenant_id, display_name, created_at from helmion.tenants order by created_at`,
  ).catch((e) => ({ rows: [{ error: e.message }] }));
  console.log('tenants:', JSON.stringify(tenants.rows, null, 1));
} finally {
  await pool.end();
}

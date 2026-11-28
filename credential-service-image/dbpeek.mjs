const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.log('NO DB URL ENV'); process.exit(0); }
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const links = await pool.query('select id, tenant_id, subject, label, created_at, linked_at, last_used_at, revoked_at from helmion.desktop_links order by created_at');
for (const r of links.rows) console.log('LINK:', JSON.stringify(r));
const jobs = await pool.query('select id, tenant_id, status, created_at, claimed_at from helmion.profile_sync_jobs order by id');
console.log('JOBS:', JSON.stringify(jobs.rows));
await pool.end();

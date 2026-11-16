import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await c.connect();
const jobs = await c.query(`select id, status, claimed_by_device_id is not null as claimed, report is not null as has_report, created_at from helmion.profile_sync_jobs order by created_at`);
console.log('JOBS:', JSON.stringify(jobs.rows));
const link = await c.query(`select id, tenant_id, linked_at is not null as linked, last_used_at, label from helmion.desktop_links where id='637b8061-4f09-4365-8dae-fca3e592fb6a'`);
console.log('NEW LINK:', JSON.stringify(link.rows));
await c.end();

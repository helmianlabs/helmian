import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await c.connect();
const jobs = await c.query(`select id, status, attempt_count, report is not null as has_report, updated_at from helmion.profile_sync_jobs order by created_at`);
console.log('JOBS:', JSON.stringify(jobs.rows));
const link = await c.query(`select last_used_at from helmion.desktop_links where id='637b8061-4f09-4365-8dae-fca3e592fb6a'`);
console.log('NEW LINK last_used_at:', JSON.stringify(link.rows));
await c.end();

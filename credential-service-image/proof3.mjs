import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await c.connect();
const cols = await c.query(`select column_name from information_schema.columns where table_schema='helmion' and table_name='profile_sync_reports' order by ordinal_position`);
console.log('REPORT COLS:', cols.rows.map(r=>r.column_name).join(','));
const link = await c.query(`select id, tenant_id, linked_at, last_used_at from helmion.desktop_links where id='637b8061-4f09-4365-8dae-fca3e592fb6a'`);
console.log('NEW LINK:', JSON.stringify(link.rows));
await c.end();

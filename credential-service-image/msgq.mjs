import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await c.connect();
const t = await c.query(`select table_name from information_schema.tables where table_schema='helmion' and table_name like '%message%'`);
console.log('TABLES:', t.rows.map(r=>r.table_name).join(','));
await c.end();

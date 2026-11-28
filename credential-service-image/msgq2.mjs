import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.HELMION_DATABASE_URL });
await c.connect();
const cols = await c.query(`select column_name from information_schema.columns where table_schema='helmion' and table_name='envoy_messages' order by ordinal_position`);
console.log('COLS:', cols.rows.map(r=>r.column_name).join(','));
const rows = await c.query(`select * from helmion.envoy_messages order by created_at desc limit 8`);
for (const r of rows.rows) console.log('MSG:', JSON.stringify(r).slice(0, 420));
await c.end();

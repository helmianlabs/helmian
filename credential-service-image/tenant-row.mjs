const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const cols = await pool.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='helmion' and table_name='tenants' order by ordinal_position");
console.log('COLUMNS:', cols.rows.map(r => `${r.column_name}:${r.data_type}${r.is_nullable === 'NO' ? '!' : ''}${r.column_default ? '=' + String(r.column_default).slice(0, 30) : ''}`).join(', '));
const rows = await pool.query("select * from helmion.tenants where tenant_id in ('banyan-evaluation','dairyforge')");
for (const r of rows.rows) console.log('ROW:', JSON.stringify(r));
await pool.end();

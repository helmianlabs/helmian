import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: url });
try {
  const cols = await pool.query(`select table_name, column_name, data_type from information_schema.columns where table_schema='helmion' and table_name in ('provider_connections','provider_credentials') order by table_name, ordinal_position`);
  console.log('COLS', JSON.stringify(cols.rows,null,1));
  const tables = await pool.query(`select table_name from information_schema.tables where table_schema='helmion' order by table_name`);
  console.log('TABLES', JSON.stringify(tables.rows.map(r=>r.table_name)));
} finally { await pool.end(); }

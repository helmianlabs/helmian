import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
const pool = new pg.Pool({ connectionString: url });
try {
  const cols = await pool.query("select column_name from information_schema.columns where table_schema='helmion' and table_name='desktop_links' order by ordinal_position");
  console.log('desktop_links columns:', cols.rows.map(r => r.column_name).join(','));
  const links = await pool.query("select * from helmion.desktop_links where tenant_id='0d7ca4d3-a2f4-458a-936b-d8a002a569e0'");
  console.log('desktop_links rows:', JSON.stringify(links.rows, null, 1));
} finally { await pool.end(); }

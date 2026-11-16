import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
try {
  for (const t of ['desktop_links','tenant_memberships','tenants']) {
    const c = await pool.query(`select column_name from information_schema.columns where table_schema='helmion' and table_name=$1 order by ordinal_position`, [t]);
    console.log(t, '->', c.rows.map(r => r.column_name).join(','));
  }
} finally { await pool.end(); }

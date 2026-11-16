import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
try {
  const subject = 'user_3L5HJWjja14knkqqi8dZBHxPdQg';
  const r = await pool.query(
    `select tenant_id, role, active, created_at from helmion.tenant_memberships where subject=$1 order by tenant_id, created_at`,
    [subject]);
  console.log('OWNER_ROWS', JSON.stringify(r.rows, null, 1));
  const d = await pool.query(
    `select subject, tenant_id, count(*)::int as n from helmion.tenant_memberships where active group by subject, tenant_id having count(*) > 1`);
  console.log('DUPLICATE_ACTIVE_GROUPS', JSON.stringify(d.rows));
  const t = await pool.query(`select id, name, created_at from helmion.tenants order by created_at`);
  console.log('TENANTS', JSON.stringify(t.rows));
} finally { await pool.end(); }

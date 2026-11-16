import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
try {
  const p = await pool.query(`select policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname='helmion' and tablename='profile_sync_jobs'`);
  console.log('policies:', JSON.stringify(p.rows, null, 1));
  const g = await pool.query(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='helmion' and table_name='profile_sync_jobs' order by grantee, privilege_type`);
  console.log('grants:', JSON.stringify(g.rows));
  const who = await pool.query(`select current_user, session_user`);
  console.log('container role:', JSON.stringify(who.rows[0]));
} finally { await pool.end(); }

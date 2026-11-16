const { Client } = await import('pg').catch(() => ({}));
let Pool;
try { ({ Pool } = await import('pg')); } catch {}
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(0); }
const pool = new Pool({ connectionString: url });
for (const t of ['herald_desktop_enrollments','herald_registered_desktops','herald_account_sessions','herald_sessions','herald_accounts']) {
  try {
    const c = await pool.query(`select count(*)::int as n, max(created_at) as newest from ${t}`);
    console.log(t, JSON.stringify(c.rows[0]));
  } catch (e) { console.log(t, 'ERR', String(e.message).slice(0,80)); }
}
try {
  const r = await pool.query(`select id, created_at, status from herald_desktop_enrollments order by created_at desc limit 3`).catch(()=>null);
  if (r) console.log('enrollments_recent', JSON.stringify(r.rows));
} catch {}
await pool.end();

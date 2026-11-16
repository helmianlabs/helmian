const { Pool } = await import('pg');
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url });
const threshold = new Date(Date.now() - 45 * 1000);
const SQL = `select d.desktop_id,
  (d.last_seen_at is not null and d.last_seen_at > $3) as desktop_online,
  s.session_id
 from herald_registered_desktops d
 left join herald_account_sessions s on s.desktop_id=d.desktop_id
   and s.stopped_at is null and s.expires_at > now() and s.last_seen_at > $3
 where d.account_provider=$1 and d.account_subject=$2
   and d.revoked_at is null and d.credential_expires_at > now()`;
try {
  const accts = await pool.query(`select provider, subject from herald_accounts order by created_at`);
  for (const a of accts.rows) {
    const r = await pool.query(SQL, [a.provider, a.subject, threshold]);
    const withSession = r.rows.filter((x) => x.session_id).length;
    console.log('subject', String(a.subject).slice(0, 9) + '…', '→ desktop rows:', r.rows.length, '| rows with a live session:', withSession);
  }
} catch (e) { console.log('ERR', e.message.slice(0, 160)); }
console.log('db_now', new Date().toISOString());
await pool.end();

const { Pool } = await import('pg');
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url });
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
try { const r = await pool.query(`select session_id, session_name, session_state, first_seen_at, last_seen_at, expires_at, stopped_at, realtime_channel from herald_account_sessions order by last_seen_at desc limit 3`); for (const row of r.rows) console.log('sess', JSON.stringify({ sid: String(row.session_id).slice(0, 14), name: row.session_name, state: row.session_state, first: iso(row.first_seen_at), seen: iso(row.last_seen_at), exp: iso(row.expires_at), stopped: iso(row.stopped_at), chan: String(row.realtime_channel ?? '').slice(0, 12) })); } catch (e) { console.log('sess ERR', e.message.slice(0, 140)); }
try { const r = await pool.query(`select display_name, last_seen_at from herald_registered_desktops order by last_seen_at desc limit 1`); console.log('desk newest seen', iso(r.rows[0].last_seen_at), r.rows[0].display_name); } catch (e) { console.log('desk ERR', e.message.slice(0, 140)); }
console.log('db_now', new Date().toISOString());
await pool.end();

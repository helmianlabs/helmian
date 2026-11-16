const { Pool } = await import('pg');
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url });
const short = (v) => (typeof v === 'string' && v.length > 14 ? v.slice(0, 10) + '…' : v);
const dump = (label, rows) => { for (const row of rows) { const o = {}; for (const k of Object.keys(row)) { let v = row[k]; if (v instanceof Date) v = v.toISOString(); o[k] = short(v); } console.log(label, JSON.stringify(o)); } };
try { const r = await pool.query(`select desktop_id, session_id, project_name, session_name, session_state, agent_name, guard_state, first_seen_at, last_seen_at, expires_at, stopped_at from herald_account_sessions order by last_seen_at desc limit 6`); console.log('— account_sessions by last_seen_at desc:', r.rows.length); dump('sess', r.rows); } catch (e) { console.log('sess ERR', e.message.slice(0, 140)); }
try { const r = await pool.query(`select desktop_id, display_name, account_subject, enrolled_at, last_seen_at, credential_expires_at, revoked_at from herald_registered_desktops order by last_seen_at desc`); console.log('— registered_desktops:', r.rows.length); dump('desk', r.rows); } catch (e) { console.log('desk ERR', e.message.slice(0, 140)); }
try { const r = await pool.query(`select enrollment_id, desktop_display_name, created_at, expires_at, confirmed_account_subject, confirmed_at, redeemed_at from herald_desktop_enrollments order by created_at desc limit 3`); console.log('— enrollments newest:', r.rows.length); dump('enr', r.rows); } catch (e) { console.log('enr ERR', e.message.slice(0, 140)); }
try { const r = await pool.query(`select provider, subject, created_at, last_seen_at from herald_accounts order by last_seen_at desc`); console.log('— accounts:', r.rows.length); dump('acct', r.rows); } catch (e) { console.log('acct ERR', e.message.slice(0, 140)); }
try { const r = await pool.query(`select count(*)::int as n, max(created_at) as newest, max(last_seen_at) as seen from herald_control_grants`); console.log('control_grants', JSON.stringify(r.rows[0])); } catch (e) { console.log('grants ERR', e.message.slice(0, 140)); }
console.log('db_now', new Date().toISOString());
await pool.end();

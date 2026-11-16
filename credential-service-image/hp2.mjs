const { Pool } = await import('pg');
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url });
const cols = async (t) => { const r = await pool.query(`select column_name from information_schema.columns where table_name=$1 order by ordinal_position`, [t]); return r.rows.map(x=>x.column_name).join(','); };
console.log('herald_sessions cols:', await cols('herald_sessions'));
try { const r = await pool.query(`select * from herald_sessions order by created_at desc limit 2`); for (const row of r.rows) { const o={}; for (const k of Object.keys(row)) { let v=row[k]; if (typeof v==='string' && v.length>12) v=v.slice(0,8)+'…'; o[k]=v; } console.log('session:', JSON.stringify(o)); } } catch(e){ console.log('sessions ERR', e.message.slice(0,120)); }
console.log('herald_registered_desktops cols:', await cols('herald_registered_desktops'));
try { const r = await pool.query(`select * from herald_registered_desktops limit 3`); for (const row of r.rows) { const o={}; for (const k of Object.keys(row)) { let v=row[k]; if (typeof v==='string' && v.length>12) v=v.slice(0,8)+'…'; o[k]=v; } console.log('regdesktop:', JSON.stringify(o)); } } catch(e){ console.log('reg ERR', e.message.slice(0,120)); }
try { const r = await pool.query(`select id, created_at from herald_accounts order by created_at`); console.log('accounts:', JSON.stringify(r.rows.map(x=>({id:String(x.id).slice(0,8), created_at:x.created_at})))); } catch(e){ console.log('acct ERR', e.message.slice(0,120)); }
try { const r = await pool.query(`select * from herald_desktop_enrollments order by created_at desc limit 2`); for (const row of r.rows) { const o={}; for (const k of Object.keys(row)) { let v=row[k]; if (typeof v==='string' && v.length>12) v=v.slice(0,8)+'…'; o[k]=v; } console.log('enrollment:', JSON.stringify(o)); } } catch(e){ console.log('enroll ERR', e.message.slice(0,120)); }
await pool.end();

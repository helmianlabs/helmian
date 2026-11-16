const { Pool } = await import('pg');
const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url });
const cols = async (t) => { const r = await pool.query(`select column_name from information_schema.columns where table_name=$1 order by ordinal_position`, [t]); return r.rows.map(x=>x.column_name).join(','); };
console.log('herald_account_sessions cols:', await cols('herald_account_sessions'));
try { const r = await pool.query(`select * from herald_account_sessions order by 1 desc limit 40`); let n=0; for (const row of r.rows) { const o={}; for (const k of Object.keys(row)) { let v=row[k]; if (v instanceof Date) v=v.toISOString(); if (typeof v==='string' && v.length>14) v=v.slice(0,10)+'…'; o[k]=v; } const s=JSON.stringify(o); if (s.includes('2026-11-0') || n<3) { console.log('acctsession:', s); } n++; } } catch(e){ console.log('ERR', e.message.slice(0,150)); }
console.log('herald_accounts cols:', await cols('herald_accounts'));
try { const r = await pool.query(`select * from herald_accounts`); for (const row of r.rows) { const o={}; for (const k of Object.keys(row)) { let v=row[k]; if (v instanceof Date) v=v.toISOString(); if (typeof v==='string' && v.length>14) v=v.slice(0,10)+'…'; o[k]=v; } console.log('account:', JSON.stringify(o)); } } catch(e){ console.log('ERR', e.message.slice(0,150)); }
await pool.end();

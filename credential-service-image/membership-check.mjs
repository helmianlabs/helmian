const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.log('NO DB URL ENV'); process.exit(1); }
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const cols = await pool.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='helmion' and table_name='tenant_memberships' order by ordinal_position");
console.log('COLUMNS:', cols.rows.map(r => `${r.column_name}:${r.data_type}${r.is_nullable === 'NO' ? '!' : ''}`).join(', '));
const rows = await pool.query("select * from helmion.tenant_memberships where tenant_id in ('banyan-evaluation','dairyforge')");
for (const r of rows.rows) console.log('ROW:', JSON.stringify(r));
const mode = process.argv[2] || 'read';
if (mode === 'insert') {
  const ins = await pool.query("insert into helmion.tenant_memberships (tenant_id, subject, role, active) values ('dairyforge','box-author-service','device',true) returning tenant_id, subject, role, active");
  console.log('INSERTED:', JSON.stringify(ins.rows));
  const check = await pool.query("select tenant_id, subject, role, active from helmion.tenant_memberships where tenant_id='dairyforge'");
  console.log('NOW:', JSON.stringify(check.rows));
}
await pool.end();

// READ-ONLY schema discovery for the seat audit. SELECT only.
import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint-guard:', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL ' + endpoint);
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);
const pool = new pg.Pool({ connectionString: url });
try {
  const tabs = await pool.query(
    `select table_schema, table_name from information_schema.tables
      where table_schema in ('helmion','public') and table_type='BASE TABLE'
      order by table_schema, table_name`);
  console.log('TABLES:', tabs.rows.map(r => r.table_schema + '.' + r.table_name).join('\n'));
  const cols = await pool.query(
    `select table_name, column_name, data_type from information_schema.columns
      where table_schema='helmion'
        and (table_name ilike '%agent%' or table_name ilike '%seat%' or table_name ilike '%provider%'
          or table_name ilike '%presence%' or table_name ilike '%credential%' or table_name ilike '%vault%'
          or table_name ilike '%channel%' or table_name ilike '%member%' or table_name ilike '%registry%'
          or table_name ilike '%connection%' or table_name ilike '%runner%')
      order by table_name, ordinal_position`);
  let cur = '';
  for (const r of cols.rows) {
    if (r.table_name !== cur) { cur = r.table_name; console.log('\n== ' + cur); }
    console.log('  ' + r.column_name + ' : ' + r.data_type);
  }
} finally { await pool.end(); }

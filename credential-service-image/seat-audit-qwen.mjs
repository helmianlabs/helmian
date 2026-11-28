// READ-ONLY Qwen mechanism probe. SELECT only.
import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT FAIL'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const cc = await pool.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'helmion.runner_provider_presence'::regclass`);
  console.log('presence constraints:', JSON.stringify(cc.rows, null, 1));
  const anyq = await pool.query(`select 'presence' as t, count(*) as n from helmion.runner_provider_presence where provider_name='qwen'
    union all select 'connections', count(*) from helmion.provider_connections where provider_id in ('qwen','ollama')
    union all select 'credentials', count(*) from helmion.provider_credentials where provider_id in ('qwen','ollama')
    union all select 'faces', count(*) from helmion.workspace_agent_faces where provider='qwen'
    union all select 'activity', count(*) from helmion.runner_activity where provider_name='qwen'`);
  console.log('rows named qwen / ollama-in-connections+credentials:', JSON.stringify(anyq.rows));
  const cols = await pool.query(`select column_name, data_type from information_schema.columns where table_schema='helmion' and table_name='envoy_messages' order by ordinal_position`);
  console.log('envoy_messages cols:', cols.rows.map(r => r.column_name).join(', '));
  const authors = await pool.query(`select distinct author_kind, author_provider, author_name from helmion.envoy_messages where channel_id='bf3a3c26-ac5d-45bf-89f5-cdf4294447b7' order by 1,2,3`).catch(e => ({rows:[{error:e.message}]}));
  console.log('#YC distinct authors:', JSON.stringify(authors.rows, null, 1));
} finally { await pool.end(); }

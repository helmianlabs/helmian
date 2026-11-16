// READ-ONLY final checks. SELECT only.
import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT FAIL'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const tc = await pool.query(`select tenant_id, scope_kind, service_id, kind, state, account_label from helmion.tool_connections order by tenant_id, service_id`);
  console.log('tool_connections:', JSON.stringify(tc.rows, null, 1));
  const byTenant = await pool.query(`select 'connections' as t, tenant_id, count(*) as n from helmion.provider_connections group by 2
    union all select 'credentials', tenant_id, count(*) from helmion.provider_credentials group by 2
    union all select 'customAgents-in-config', tenant_id, count(*) from helmion.envoy_messages where body like '%customAgents%' group by 2`);
  console.log('per-tenant counts:', JSON.stringify(byTenant.rows, null, 1));
  const ca = await pool.query(`select channel_id, substring(body from '"customAgents":\\[(.{0,220})') as ca from helmion.envoy_messages where body like '%"customAgents"%quiz%' or body like '%customAgents%'`);
  console.log('channels carrying customAgents:', JSON.stringify(ca.rows, null, 1));
} finally { await pool.end(); }

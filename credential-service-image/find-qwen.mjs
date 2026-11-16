// Read-only (emoji bite 5, scope item 4): prove Qwen's crab lives on his
// server record — the newest channel-config row per channel, parsed for
// customAgents entries named qwen. Run INSIDE helmian-credential-service.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT_GUARD_FAIL', endpoint); process.exit(2); }
console.log('endpoint guard: PASS', endpoint);
const pool = new pg.Pool({ connectionString: url });
try {
  const rows = await pool.query(
    `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body, created_at
       from helmion.envoy_messages
      where author_subject = 'system:envoy-config'
      order by tenant_id, channel_id, created_at desc`,
  );
  console.log('newest config rows:', rows.rowCount);
  let found = 0;
  for (const row of rows.rows) {
    let config = null;
    try { config = JSON.parse(row.body); } catch { continue; }
    for (const agent of config?.customAgents ?? []) {
      if (String(agent?.handle ?? '').toLowerCase() === 'qwen') {
        found += 1;
        console.log('QWEN RECORD:', JSON.stringify({
          tenant: row.tenant_id, channel: row.channel_id, configAt: row.created_at,
          handle: agent.handle, name: agent.name, emoji: agent.emoji, provider: agent.provider,
        }));
      }
    }
  }
  console.log('qwen records found:', found);
} finally {
  await pool.end();
}

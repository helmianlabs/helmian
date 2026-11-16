import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const T='0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
try {
  // the exact query behind GET /api/admin/envoy/credential/connect (listConnections)
  const conns = await pool.query(`select provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_at from helmion.provider_connections where tenant_id=$1 order by provider_id`,[T]);
  console.log('CONNECTIONS-NOW', JSON.stringify(conns.rows.map(r=>r.provider_id)));
  console.log('OTHERS-DETAIL', JSON.stringify(conns.rows.filter(r=>['groq','nvidia','openrouter'].includes(r.provider_id))));
  const cred = await pool.query(`select id, revoked_at, updated_at, updated_by_subject from helmion.provider_credentials where tenant_id=$1 and provider_id='cloudflare'`,[T]);
  console.log('CLOUDFLARE-CRED', JSON.stringify(cred.rows));
  for (const slug of ['yc','full-desk-test']) {
    const ch = await pool.query(`select id from helmion.envoy_channels where tenant_id=$1 and slug=$2`,[T,slug]);
    const cfg = await pool.query(`select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config' order by created_at desc, id desc limit 1`,[T,ch.rows[0].id]);
    const parsed = JSON.parse(cfg.rows[0].body);
    console.log('CONFIG-NOW', slug, 'agents:', parsed.agents.join(','), '| joined has cloudflare:', 'cloudflare' in (parsed.joined??{}));
  }
} finally { await pool.end(); }

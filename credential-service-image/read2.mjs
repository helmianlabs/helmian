import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const T='0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
try {
  const pres = await pool.query(`select tenant_id, provider_name, connected, updated_at, last_answered_at from helmion.runner_provider_presence where tenant_id=$1 order by provider_name`,[T]);
  console.log('PRESENCE',JSON.stringify(pres.rows,null,1));
  for (const slug of ['yc','full-desk-test']) {
    const ch = await pool.query(`select id from helmion.envoy_channels where tenant_id=$1 and slug=$2`,[T,slug]);
    const cid = ch.rows[0]?.id;
    const cfg = await pool.query(`select id, created_at, body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config' order by created_at desc, id desc limit 1`,[T,cid]);
    console.log('CONFIG',slug,cid,JSON.stringify(cfg.rows,null,1));
    const cnt = await pool.query(`select count(*)::int as n from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config'`,[T,cid]);
    console.log('CONFIG-COUNT',slug,cnt.rows[0].n);
  }
} finally { await pool.end(); }

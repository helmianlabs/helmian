import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const T='0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
try {
  const conn = await pool.query(`select * from helmion.provider_connections where tenant_id=$1 and provider_id='cloudflare'`,[T]);
  const cred = await pool.query(`select id, tenant_id, provider_id, credential_reference, credential_kind,
      encode(record_key_wrapped,'base64') as record_key_wrapped_b64,
      encode(record_key_iv,'base64') as record_key_iv_b64,
      encode(record_key_auth_tag,'base64') as record_key_auth_tag_b64,
      encode(ciphertext,'base64') as ciphertext_b64,
      encode(iv,'base64') as iv_b64,
      encode(auth_tag,'base64') as auth_tag_b64,
      token_type, scope, expires_at, updated_by_subject, created_at, updated_at, revoked_at
    from helmion.provider_credentials where tenant_id=$1 and provider_id='cloudflare'`,[T]);
  const pres = await pool.query(`select * from helmion.runner_provider_presence where tenant_id=$1 and provider_name='cloudflare'`,[T]);
  const channels = {};
  for (const slug of ['yc','full-desk-test']) {
    const ch = await pool.query(`select * from helmion.envoy_channels where tenant_id=$1 and slug=$2`,[T,slug]);
    const cid = ch.rows[0]?.id;
    const cfg = await pool.query(`select id, tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata, created_at from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config' order by created_at desc, id desc limit 1`,[T,cid]);
    const cnt = await pool.query(`select count(*)::int as n from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config'`,[T,cid]);
    channels[slug] = { channel: ch.rows[0], latest_config_message: cfg.rows[0], config_message_count: cnt.rows[0].n };
  }
  const others = await pool.query(`select provider_id, id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject, updated_at from helmion.provider_connections where tenant_id=$1 and provider_id in ('groq','nvidia','openrouter') order by provider_id`,[T]);
  const out = {
    backup_kind: 'cloudflare-removal-backup',
    backed_up_at: new Date().toISOString(),
    tenant_id: T,
    note: 'Ciphertext fields are base64 of the stored bytea (still encrypted). No decrypted values were read or written.',
    provider_connections_row: conn.rows[0] ?? null,
    provider_credentials_row: cred.rows[0] ?? null,
    runner_provider_presence_row: pres.rows[0] ?? null,
    channels,
    other_api_seats_connections_at_backup: others.rows,
  };
  console.log(JSON.stringify(out, null, 1));
} finally { await pool.end(); }

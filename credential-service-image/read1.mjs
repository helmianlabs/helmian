import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const T='0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
try {
  for (const t of ['envoy_channels','runner_provider_presence']) {
    const c = await pool.query(`select column_name,data_type from information_schema.columns where table_schema='helmion' and table_name=$1 order by ordinal_position`,[t]);
    console.log('COLS',t,JSON.stringify(c.rows));
  }
  const pc = await pool.query(`select * from helmion.provider_connections where tenant_id=$1 order by provider_id`,[T]);
  console.log('CONNECTIONS',JSON.stringify(pc.rows,null,1));
  const cred = await pool.query(`select id,tenant_id,provider_id,credential_reference,credential_kind,octet_length(ciphertext) as ct_len,octet_length(record_key_wrapped) as rkw_len,token_type,scope,expires_at,updated_by_subject,created_at,updated_at,revoked_at from helmion.provider_credentials where tenant_id=$1 order by provider_id`,[T]);
  console.log('CREDENTIALS-META',JSON.stringify(cred.rows,null,1));
  const ch = await pool.query(`select * from helmion.envoy_channels where tenant_id=$1`,[T]).catch(e=>({rows:[{error:e.message}]}));
  console.log('CHANNELS',JSON.stringify(ch.rows,null,1).slice(0,6000));
  const pres = await pool.query(`select * from helmion.runner_provider_presence where tenant_id=$1 order by provider_id`,[T]).catch(e=>({rows:[{error:e.message}]}));
  console.log('PRESENCE',JSON.stringify(pres.rows,null,1).slice(0,4000));
} finally { await pool.end(); }

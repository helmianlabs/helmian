import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
try {
  const r = await pool.query(`update helmion.runner_provider_presence set connected=false, updated_at=clock_timestamp() where tenant_id='0d7ca4d3-a2f4-458a-936b-d8a002a569e0' and provider_name='cloudflare' returning provider_name, connected, updated_at`);
  console.log('FLIPPED', JSON.stringify(r.rows));
} finally { await pool.end(); }

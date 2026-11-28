import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
try {
  const r = await pool.query(`select provider_name, connected, updated_at, last_answered_at from helmion.runner_provider_presence where tenant_id='0d7ca4d3-a2f4-458a-936b-d8a002a569e0' and provider_name in ('cloudflare','groq','nvidia','openrouter') order by provider_name`);
  console.log(JSON.stringify(r.rows));
} finally { await pool.end(); }

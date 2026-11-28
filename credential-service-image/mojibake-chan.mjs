const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const rows = await pool.query("select channel_id, author_subject, count(*)::int as n from helmion.envoy_messages where body like '%ΓÇ%' group by channel_id, author_subject order by n desc");
for (const r of rows.rows) console.log(JSON.stringify(r));
const chans = await pool.query("select id, slug, name from helmion.envoy_channels where id = any(select distinct channel_id from helmion.envoy_messages where body like '%ΓÇ%')");
for (const r of chans.rows) console.log('channel:', JSON.stringify(r));
await pool.end();

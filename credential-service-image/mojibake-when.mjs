const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const rows = await pool.query("select author_subject, author_kind, created_at::date as day, count(*)::int as n from helmion.envoy_messages where body like '%ΓÇ%' or body like '%â€%' group by author_subject, author_kind, day order by day, author_subject");
for (const r of rows.rows) console.log(JSON.stringify(r));
const clean = await pool.query("select author_subject, count(*)::int as n from helmion.envoy_messages where (author_subject in ('agent:claude','agent:mistral')) and body like '%’%' group by author_subject");
console.log('clean apostrophes from the same two seats:', JSON.stringify(clean.rows));
await pool.end();

// Read-only: Troy's 05:53Z message + Claude's reply in Maestro, verbatim.
// Run INSIDE helmian-credential-service (the established container road).
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT_GUARD_FAIL', endpoint); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const cols = await pool.query(
    `select column_name, data_type from information_schema.columns
      where table_schema='helmion' and table_name='envoy_messages' order by ordinal_position`,
  );
  console.log('envoy_messages columns:', cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '));
  const rows = await pool.query(
    `select * from helmion.envoy_messages
      where channel_id = $1
        and created_at >= '2026-11-05T05:50:00Z'::timestamptz
        and created_at <= '2026-11-05T06:05:00Z'::timestamptz
      order by created_at asc`,
    ['7eabc6b7-e363-4976-ada1-05551f5427be'],
  );
  console.log('ROWCOUNT', rows.rowCount);
  for (const r of rows.rows) {
    console.log('---ROW---');
    console.log(JSON.stringify(r, null, 1));
  }
} finally {
  await pool.end();
}

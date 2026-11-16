// Read-only finder: locate Troy's 05:48Z "@qwen build a working demo..." message
// in #maestro-desk for the Bite 3 live seed. Run INSIDE helmian-credential-service.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT_GUARD_FAIL', endpoint); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const cols = await pool.query(
    `select column_name from information_schema.columns
      where table_schema='helmion' and table_name='envoy_messages' order by ordinal_position`,
  );
  const names = cols.rows.map((r) => r.column_name);
  console.log('envoy_messages columns:', names.join(','));
  const bodyCol = ['body', 'text', 'content', 'message'].find((c) => names.includes(c));
  if (!bodyCol) { console.log('NO_BODY_COLUMN'); process.exit(3); }
  const rows = await pool.query(
    `select id, channel_id, author_kind, created_at, left(${bodyCol}, 110) as body_head
       from helmion.envoy_messages
      where channel_id = '7eabc6b7-e363-4976-ada1-05551f5427be'
        and created_at >= '2026-11-05T05:45:00Z' and created_at < '2026-11-05T05:52:00Z'
      order by created_at`,
  );
  console.log('window messages:', JSON.stringify(rows.rows, null, 1));
  const hit = rows.rows.filter((r) => r.body_head.startsWith('@qwen build a working demo'));
  console.log('MATCH:', JSON.stringify(hit));
} finally {
  await pool.end();
}

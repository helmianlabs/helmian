// READ-ONLY: read channel config rows (membership lists) from envoy_messages.
import pg from 'pg';
const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const endpoint = new URL(url).hostname.split('.')[0];
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) { console.log('ENDPOINT FAIL'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url });
try {
  const rows = await pool.query(
    `select channel_id, author_subject, body, metadata, created_at from helmion.envoy_messages
      where tenant_id='0d7ca4d3-a2f4-458a-936b-d8a002a569e0'
        and author_subject like 'system:%'
      order by channel_id, created_at desc`);
  const seen = new Set();
  for (const r of rows.rows) {
    if (seen.has(r.channel_id + r.author_subject)) continue;
    seen.add(r.channel_id + r.author_subject);
    console.log('channel', r.channel_id, 'subject', r.author_subject, 'at', r.created_at);
    console.log('  body:', String(r.body).slice(0, 600));
  }
  const auth = await pool.query(
    `select channel_id, author_subject, author_kind, count(*) as n from helmion.envoy_messages
      where channel_id in ('bf3a3c26-ac5d-45bf-89f5-cdf4294447b7','9a0ff64c-2a15-4c47-9582-3ef587fdb131','50e4bad0-c4d1-4b8f-b0b6-9bf8151caa44')
      group by 1,2,3 order by 1,2`);
  console.log('authors in yc/seat-check/full-desk:', JSON.stringify(auth.rows, null, 1));
} finally { await pool.end(); }

import pg from 'pg';
import { randomUUID } from 'node:crypto';
const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const T='0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
const client = await pool.connect();
try {
  await client.query('begin');
  const del = await client.query(`delete from helmion.provider_connections where tenant_id=$1 and provider_id='cloudflare' returning id`,[T]);
  console.log('connections deleted:', del.rowCount, JSON.stringify(del.rows));
  for (const slug of ['yc','full-desk-test']) {
    const ch = await client.query(`select id from helmion.envoy_channels where tenant_id=$1 and slug=$2`,[T,slug]);
    const cid = ch.rows[0].id;
    const cur = await client.query(`select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject='system:envoy-config' order by created_at desc, id desc limit 1`,[T,cid]);
    const cfg = JSON.parse(cur.rows[0].body);
    const agents = cfg.agents.filter(a=>a!=='cloudflare');
    const joined = {}; for (const p of agents) if (cfg.joined?.[p]) joined[p]=cfg.joined[p];
    const stored = { format: cfg.format, agents, joined, discord: cfg.discord ?? null, pendingLink: cfg.pendingLink ?? null };
    if (cfg.slack) stored.slack = cfg.slack;
    if (cfg.github) stored.github = cfg.github;
    if (cfg.desk === true) stored.desk = true;
    if (Array.isArray(cfg.customAgents) && cfg.customAgents.length) stored.customAgents = cfg.customAgents;
    if (cfg.debateMode === 'free-willy') stored.debateMode = 'free-willy';
    if (cfg.avatar) stored.avatar = cfg.avatar;
    const body = JSON.stringify(stored);
    const ins = await client.query(`insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata) values ($1,$2,'system:envoy-config','system',$3,$4,null) returning id, created_at`,[T,cid,body,`cfg:${randomUUID()}`]);
    console.log('config inserted:', slug, JSON.stringify(ins.rows), 'agents:', agents.join(','));
  }
  await client.query('commit');
  console.log('COMMITTED');
} catch (e) {
  await client.query('rollback');
  console.log('ROLLED BACK:', e.message);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }

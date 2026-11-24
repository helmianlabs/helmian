// envoy-config-store.mjs — where channel configs live (bite: scale
// hardening step 1).
//
// A channel config used to exist ONLY as a message in
// helmion.envoy_messages, which capped the serialized config at the
// messages body CHECK (1..4000 chars, sql/009) — about 26 rich custom
// agents per channel. sql/099 adds helmion.envoy_channel_configs
// (body up to 65,536 chars) as the primary store.
//
// Read/write contract:
//   - Dual mode (default): writes go to the table AND, when the body
//     still fits the messages CHECK, to the config message as well, so
//     a rollback to the message store never loses a config that the
//     old code could have written. Reads take the NEWEST of the two
//     copies (table updated_at vs message created_at), so flipping
//     the mode back and forth can never resurrect a stale config.
//     Single-channel reads ask the message store first with the
//     pre-099 query verbatim, then the table; the bulk scans are one
//     UNION query over both stores (newest per channel), keeping the
//     worker poll's round-trip count exactly where it was.
//   - Message mode (HELMION_CONFIG_STORE=message): the rollback. All
//     reads and writes use the config messages only, exactly as
//     before sql/099. A body past 4,000 chars cannot be stored in
//     this mode (the messages CHECK) and writeConfigBody throws.
//   - A database without sql/099 applied (error 42P01 on the table)
//     degrades to the message store on every path, so the code is
//     safe to deploy ahead of the migration.

import { randomUUID } from 'node:crypto';
import { CONFIG_SUBJECT, MAX_CONFIG_BODY_CHARS } from './envoy-agents.mjs';

export const MESSAGE_CONFIG_BODY_LIMIT = 4000;

export function configStoreMode(env = process.env) {
  return env.HELMION_CONFIG_STORE === 'message' ? 'message' : 'dual';
}

function stampMs(value) {
  if (value == null) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// The configs table may legitimately not exist yet (pre-099
// database). That one error degrades to the message store; anything
// else is a real failure and propagates.
async function tableQuery(client, sql, params) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    if (err && err.code === '42P01') return null;
    throw err;
  }
}

const MESSAGE_READ_SQL =
  'select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1';

// The newest config body for one channel across both stores, or null.
export async function readConfigBody(client, tenantId, channelId, env) {
  const m = await client.query(MESSAGE_READ_SQL, [tenantId, channelId, CONFIG_SUBJECT]);
  if (configStoreMode(env) === 'message') return m.rowCount ? m.rows[0].body : null;
  const t = await tableQuery(
    client,
    'select body, updated_at from helmion.envoy_channel_configs where tenant_id=$1 and channel_id=$2',
    [tenantId, channelId],
  );
  if (!t?.rowCount) return m.rowCount ? m.rows[0].body : null;
  if (!m.rowCount) return t.rows[0].body;
  // Both copies exist: the newer stamp wins, so a message-mode write
  // made during a rollback window is never shadowed by the table.
  const ms = await client.query(
    'select created_at from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1',
    [tenantId, channelId, CONFIG_SUBJECT],
  );
  return stampMs(t.rows[0].updated_at) >= stampMs(ms.rows[0].created_at)
    ? t.rows[0].body
    : m.rows[0].body;
}

const TENANT_SCAN_UNION_SQL = `select distinct on (channel_id) channel_id, body from (
  select channel_id, body, updated_at as stamp, 0 as src from helmion.envoy_channel_configs where tenant_id=$1
  union all
  select channel_id, body, created_at as stamp, 1 as src from helmion.envoy_messages where tenant_id=$1 and author_subject=$2
) newest order by channel_id, stamp desc, src asc`;

const TENANT_SCAN_MESSAGE_SQL =
  'select distinct on (channel_id) channel_id, body from helmion.envoy_messages where tenant_id=$1 and author_subject=$2 order by channel_id, created_at desc, id desc';

// Every channel config in a tenant, newest body per channel:
// [{ channel_id, body }]. One round trip in dual mode.
export async function readTenantConfigBodies(client, tenantId, env) {
  const shape = (rows) => rows.map((r) => ({ channel_id: r.channel_id, body: r.body }));
  if (configStoreMode(env) === 'message') {
    const r = await client.query(TENANT_SCAN_MESSAGE_SQL, [tenantId, CONFIG_SUBJECT]);
    return shape(r.rows);
  }
  try {
    const r = await client.query(TENANT_SCAN_UNION_SQL, [tenantId, CONFIG_SUBJECT]);
    return shape(r.rows);
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
    const r = await client.query(TENANT_SCAN_MESSAGE_SQL, [tenantId, CONFIG_SUBJECT]);
    return shape(r.rows);
  }
}

const ALL_SCAN_UNION_SQL = `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from (
  select tenant_id, channel_id, body, updated_at as stamp, 0 as src from helmion.envoy_channel_configs
  union all
  select tenant_id, channel_id, body, created_at as stamp, 1 as src from helmion.envoy_messages where author_subject=$1
) newest order by tenant_id, channel_id, stamp desc, src asc`;

const ALL_SCAN_MESSAGE_SQL =
  'select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 order by tenant_id, channel_id, created_at desc, id desc';

// Every channel config in every tenant (the bridge link scan):
// [{ tenant_id, channel_id, body }].
export async function readAllConfigBodies(client, env) {
  const shape = (rows) => rows.map((r) => ({ tenant_id: r.tenant_id, channel_id: r.channel_id, body: r.body }));
  if (configStoreMode(env) === 'message') {
    const r = await client.query(ALL_SCAN_MESSAGE_SQL, [CONFIG_SUBJECT]);
    return shape(r.rows);
  }
  try {
    const r = await client.query(ALL_SCAN_UNION_SQL, [CONFIG_SUBJECT]);
    return shape(r.rows);
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
    const r = await client.query(ALL_SCAN_MESSAGE_SQL, [CONFIG_SUBJECT]);
    return shape(r.rows);
  }
}

// Candidate channels whose config body (either store) contains the
// needle — the bridge confirm scan looks up a link code's hash this
// way. Rows: [{ tenant_id, channel_id }], de-duplicated.
export async function findConfigChannelsByBodyLike(client, needle, env) {
  const found = new Map();
  const add = (rows) => {
    for (const row of rows ?? []) {
      found.set(`${row.tenant_id}|${row.channel_id}`, {
        tenant_id: row.tenant_id,
        channel_id: row.channel_id,
      });
    }
  };
  const m = await client.query(
    'select distinct tenant_id, channel_id from helmion.envoy_messages where author_subject=$1 and body like $2',
    [CONFIG_SUBJECT, needle],
  );
  add(m.rows);
  if (configStoreMode(env) !== 'message') {
    const t = await tableQuery(
      client,
      'select distinct tenant_id, channel_id from helmion.envoy_channel_configs where body like $1',
      [needle],
    );
    if (t) add(t.rows);
  }
  return [...found.values()];
}

// Persist a serialized config body. Dual mode: table always, message
// copy when it fits the messages CHECK. Message mode: message only,
// and the 4,000-char ceiling applies again.
export async function writeConfigBody(client, { tenantId, channelId, body, idempotencyKey }, env) {
  const key = idempotencyKey ?? `cfg:${randomUUID()}`;
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_CONFIG_BODY_CHARS) {
    throw new Error('channel config is too large');
  }
  const mode = configStoreMode(env);
  if (mode !== 'message') {
    const t = await tableQuery(
      client,
      `insert into helmion.envoy_channel_configs(tenant_id, channel_id, body)
       values ($1,$2,$3)
       on conflict (tenant_id, channel_id) do update set body=excluded.body, updated_at=now()`,
      [tenantId, channelId, body],
    );
    if (t && body.length > MESSAGE_CONFIG_BODY_LIMIT) return; // table only
    if (t && body.length <= MESSAGE_CONFIG_BODY_LIMIT) {
      await insertConfigMessage(client, tenantId, channelId, body, key);
      return;
    }
    // t === null: no table on this database — the message is the store.
    if (body.length > MESSAGE_CONFIG_BODY_LIMIT) throw new Error('channel config is too large');
    await insertConfigMessage(client, tenantId, channelId, body, key);
    return;
  }
  if (body.length > MESSAGE_CONFIG_BODY_LIMIT) throw new Error('channel config is too large');
  await insertConfigMessage(client, tenantId, channelId, body, key);
}

async function insertConfigMessage(client, tenantId, channelId, body, key) {
  await client.query(
    `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing`,
    [tenantId, channelId, CONFIG_SUBJECT, 'system', body, key, JSON.stringify({})],
  );
}

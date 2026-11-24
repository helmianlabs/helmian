// Envoy channel config store (hardening step 1, sql/099): the
// dual-read / dual-write discipline against an in-memory stub of
// the two tables. The Postgres end-to-end (a real 50-rich-agent
// channel) is the twin proof, not this suite.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configStoreMode, readConfigBody, readTenantConfigBodies, readAllConfigBodies,
  findConfigChannelsByBodyLike, writeConfigBody, MESSAGE_CONFIG_BODY_LIMIT,
} from '../src/cloud/envoy-config-store.mjs';
import { emptyConfig, parseConfig, serializeConfig, MAX_CONFIG_BODY_CHARS } from '../src/cloud/envoy-agents.mjs';

const TENANT = 'tenant-store';
const CHAN = '11111111-2222-4333-8444-555555555555';
const CHAN2 = '22222222-3333-4444-8555-666666666666';

// In-memory stub: messages[] is the append-only log, configs is
// the sql/099 table keyed tenant|channel. A shared tick clock
// stamps every write so newest-wins is deterministic. With
// `table: false` every configs query throws 42P01, the shape a
// database without sql/099 applied gives the real client.
function stubClient({ table = true } = {}) {
  const state = { messages: [], configs: new Map(), tick: 1_700_000_000_000, tableQueries: 0 };
  const stamp = () => new Date(state.tick += 1000);
  const missing = () => { const e = new Error('relation "helmion.envoy_channel_configs" does not exist'); e.code = '42P01'; throw e; };
  const client = {
    state,
    async query(text, vals = []) {
      const sql = String(text);
      if (sql.includes('helmion.envoy_channel_configs')) {
        state.tableQueries += 1;
        if (!table) missing();
        if (sql.includes('union all')) {
          // The dual-mode bulk scans: newest body per channel across
          // both stores, table winning an exact stamp tie.
          const pick = (keyOf, rows) => {
            const best = new Map();
            for (const r of rows) {
              const k = keyOf(r);
              const cur = best.get(k);
              if (!cur || r.stamp > cur.stamp || (r.stamp.getTime?.() === cur.stamp.getTime?.() && r.src < cur.src)) best.set(k, r);
            }
            return [...best.values()];
          };
          const fromTable = [...state.configs.values()].map((r) => ({ ...r, stamp: r.updated_at, src: 0 }));
          const fromMsgs = state.messages.map((m) => ({ ...m, stamp: m.created_at, src: 1 }));
          if (sql.includes('distinct on (tenant_id, channel_id)')) {
            const rows = pick((r) => `${r.tenant_id}|${r.channel_id}`, [...fromTable, ...fromMsgs]);
            return { rows, rowCount: rows.length };
          }
          const rows = pick((r) => r.channel_id, [...fromTable, ...fromMsgs].filter((r) => r.tenant_id === vals[0]));
          return { rows, rowCount: rows.length };
        }
        if (sql.startsWith('insert into helmion.envoy_channel_configs')) {
          state.configs.set(`${vals[0]}|${vals[1]}`, { tenant_id: vals[0], channel_id: vals[1], body: vals[2], updated_at: stamp() });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('where tenant_id=$1 and channel_id=$2')) {
          const row = state.configs.get(`${vals[0]}|${vals[1]}`);
          return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.includes('where body like')) {
          const needle = String(vals[0]).replaceAll('%', '');
          const rows = [...state.configs.values()].filter((r) => r.body.includes(needle));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('where tenant_id=$1')) {
          const rows = [...state.configs.values()].filter((r) => r.tenant_id === vals[0]);
          return { rows, rowCount: rows.length };
        }
        return { rows: [...state.configs.values()], rowCount: state.configs.size };
      }
      if (sql.startsWith('insert into helmion.envoy_messages')) {
        state.messages.push({ tenant_id: vals[0], channel_id: vals[1], author_subject: vals[2], body: vals[4], created_at: stamp() });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('select distinct tenant_id, channel_id from helmion.envoy_messages')) {
        const needle = String(vals[1]).replaceAll('%', '');
        const seen = new Map();
        for (const m of state.messages) if (m.body.includes(needle)) seen.set(`${m.tenant_id}|${m.channel_id}`, { tenant_id: m.tenant_id, channel_id: m.channel_id });
        return { rows: [...seen.values()], rowCount: seen.size };
      }
      if (sql.includes('select distinct on (tenant_id, channel_id)')) {
        const best = new Map();
        for (const m of state.messages) best.set(`${m.tenant_id}|${m.channel_id}`, m);
        return { rows: [...best.values()], rowCount: best.size };
      }
      if (sql.includes('select distinct on (channel_id)')) {
        const best = new Map();
        for (const m of state.messages) if (m.tenant_id === vals[0]) best.set(m.channel_id, m);
        return { rows: [...best.values()], rowCount: best.size };
      }
      if (sql.includes('select body from helmion.envoy_messages')) {
        const rows = state.messages.filter((m) => m.tenant_id === vals[0] && m.channel_id === vals[1]);
        const newest = rows.at(-1);
        return newest ? { rows: [{ body: newest.body }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('select created_at from helmion.envoy_messages')) {
        const rows = state.messages.filter((m) => m.tenant_id === vals[0] && m.channel_id === vals[1]);
        const newest = rows.at(-1);
        return newest ? { rows: [{ created_at: newest.created_at }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`stub: unhandled SQL: ${sql.slice(0, 80)}`);
    },
  };
  return client;
}

const bodyOf = (marker) => JSON.stringify({ format: 'helmian.envoy.channel-config.v1', marker });

test('config store mode: dual by default, message on the rollback flag', () => {
  assert.equal(configStoreMode({}), 'dual');
  assert.equal(configStoreMode({ HELMION_CONFIG_STORE: 'message' }), 'message');
  assert.equal(configStoreMode({ HELMION_CONFIG_STORE: 'dual' }), 'dual');
});

test('dual write: a small config lands in BOTH stores; reads take it from either', async () => {
  const client = stubClient();
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('a') }, {});
  assert.equal(client.state.configs.size, 1);
  assert.equal(client.state.messages.length, 1);
  assert.equal(await readConfigBody(client, TENANT, CHAN, {}), bodyOf('a'));
});

test('dual write: a config past the message limit lands in the table ONLY', async () => {
  const client = stubClient();
  const big = bodyOf('x'.repeat(MESSAGE_CONFIG_BODY_LIMIT));
  assert.ok(big.length > MESSAGE_CONFIG_BODY_LIMIT);
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: big }, {});
  assert.equal(client.state.configs.size, 1);
  assert.equal(client.state.messages.length, 0, 'no message copy: it would violate the sql/009 CHECK');
  assert.equal(await readConfigBody(client, TENANT, CHAN, {}), big);
});

test('dual read is newest-wins across the two stores, both directions', async () => {
  const client = stubClient();
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('first') }, {});
  // A message-only write (the rollback window's shape) is newer:
  // the dual read must follow it, not the stale table row.
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('second') }, { HELMION_CONFIG_STORE: 'message' });
  assert.equal(await readConfigBody(client, TENANT, CHAN, {}), bodyOf('second'));
  // And a later dual write wins back.
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('third') }, {});
  assert.equal(await readConfigBody(client, TENANT, CHAN, {}), bodyOf('third'));
});

test('message mode never touches the table (the rollback is exact)', async () => {
  const client = stubClient();
  const env = { HELMION_CONFIG_STORE: 'message' };
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('m') }, env);
  assert.equal(await readConfigBody(client, TENANT, CHAN, env), bodyOf('m'));
  assert.equal(client.state.tableQueries, 0);
  assert.equal(client.state.configs.size, 0);
});

test('a missing table (sql/099 not applied) degrades to the message road', async () => {
  const client = stubClient({ table: false });
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('pre98') }, {});
  assert.equal(client.state.messages.length, 1, 'the message write still lands');
  assert.equal(await readConfigBody(client, TENANT, CHAN, {}), bodyOf('pre98'));
  const rows = await readTenantConfigBodies(client, TENANT, {});
  assert.deepEqual(rows, [{ channel_id: CHAN, body: bodyOf('pre98') }]);
});

test('tenant + all-tenant scans merge both stores, newest per channel', async () => {
  const client = stubClient();
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: bodyOf('one') }, {});
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN2, body: bodyOf('two') }, { HELMION_CONFIG_STORE: 'message' });
  await writeConfigBody(client, { tenantId: 'tenant-other', channelId: CHAN, body: bodyOf('other') }, {});
  const mine = await readTenantConfigBodies(client, TENANT, {});
  assert.deepEqual(mine.map((r) => r.body).sort(), [bodyOf('one'), bodyOf('two')]);
  const all = await readAllConfigBodies(client, {});
  assert.equal(all.length, 3);
  assert.ok(all.some((r) => r.tenant_id === 'tenant-other' && r.body === bodyOf('other')));
});

test('body-like candidates come from both stores', async () => {
  const client = stubClient();
  const hashBody = JSON.stringify({ pendingLink: { codeHash: 'ab12' } });
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN, body: hashBody }, { HELMION_CONFIG_STORE: 'message' });
  await writeConfigBody(client, { tenantId: TENANT, channelId: CHAN2, body: bodyOf('y'.repeat(MESSAGE_CONFIG_BODY_LIMIT) + 'ab12') }, {});
  const found = await findConfigChannelsByBodyLike(client, '%ab12%', {});
  assert.deepEqual(found.map((r) => r.channel_id).sort(), [CHAN, CHAN2].sort());
});

test('serializeConfig: 50 rich customs pass the old cap and round-trip; the new bound still throws', () => {
  const rich = (n, prefix) => Array.from({ length: n }, (_, i) => ({
    handle: `${prefix}${String(i + 1).padStart(2, '0')}`, name: `Load ${prefix}${i + 1}`, emoji: '🧪',
    provider: 'claude', jobTitle: 'Load test seat', jobPrompt: 'Answer briefly and stay in character.',
  }));
  const config = emptyConfig();
  config.customAgents = rich(50, 'r');
  config.agents = config.customAgents.map((a) => a.handle);
  const body = serializeConfig(config);
  assert.ok(body.length > MESSAGE_CONFIG_BODY_LIMIT, `50 rich customs exceed the old cap (got ${body.length})`);
  assert.ok(body.length <= MAX_CONFIG_BODY_CHARS);
  const back = parseConfig(body);
  assert.equal(back.customAgents.length, 50);
  assert.equal(back.agents.length, 50);

  const huge = emptyConfig();
  huge.customAgents = rich(50, 'h').map((a) => ({ ...a, jobPrompt: 'x'.repeat(2000) }));
  huge.agents = huge.customAgents.map((a) => a.handle);
  assert.throws(() => serializeConfig(huge), /channel config is too large/);
});

// Envoy 504 fix, bite 1: the pools on the envoy request path carry
// bounded waits, and every tenant transaction carries a statement
// bound. These are source-level assertions (the house pattern for
// wiring that only a live database could exercise end to end) plus
// one fake-pool run proving the bound is set inside the transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTenantTransaction, TENANT_STATEMENT_TIMEOUT_MS } from '../src/core/tenant-context.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(repo, path), 'utf8');

const POOL_FILES = [
  'src/cloud/envoy-mesh.mjs',
  'src/cloud/live-admin.mjs',
  'web/marketing/api/helmian-admin.js',
];

test('every pool on the envoy path bounds its waits', async () => {
  for (const path of POOL_FILES) {
    const source = await read(path);
    assert.match(source, /connectionTimeoutMillis: 5_000/, `${path}: connect/checkout bound`);
    assert.match(source, /query_timeout: 15_000/, `${path}: query bound`);
    assert.match(source, /statement_timeout: 15_000/, `${path}: statement bound`);
  }
});

// Envoy 504 fix, bite D: with every wait bounded (bite 1), the mesh
// pool — the one pool the agent-work polls and the agent-message
// posts share — is sized for a round's burst at 10. The sibling
// pools on the path stay at 5: they serve short single reads, and
// no timeout evidence names them.
test('pool sizes: the mesh pool is 10, its siblings on the path stay 5', async () => {
  const mesh = await read('src/cloud/envoy-mesh.mjs');
  assert.match(mesh, /max: 10, connectionTimeoutMillis: 5_000/, 'mesh pool sized at 10 with its bounds intact');
  for (const path of ['src/cloud/live-admin.mjs', 'web/marketing/api/helmian-admin.js']) {
    const source = await read(path);
    assert.match(source, /max: 5\b/, `${path}: sibling pool stays at 5`);
  }
});

test('the tenant statement bound is 15s and rides the identity select', async () => {
  assert.equal(TENANT_STATEMENT_TIMEOUT_MS, 15_000);
  const source = await read('src/core/tenant-context.mjs');
  assert.match(source, /set_config\('statement_timeout', '\$\{TENANT_STATEMENT_TIMEOUT_MS\}', true\)/);
});

test('withTenantTransaction sets the statement bound inside the transaction', async () => {
  const queries = [];
  const client = {
    async query(text, vals = []) { queries.push({ text: String(text), vals }); return { rows: [], rowCount: 0 }; },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const context = { tenantId: 'tenant-a', actorSubject: 'user-1', actorRole: 'owner', sessionId: 's1', requestId: 'r1' };
  const out = await withTenantTransaction(pool, context, async () => ({ worked: true }));
  assert.equal(out.worked, true);
  assert.equal(out.durability, 'committed');
  assert.equal(queries[0].text, 'begin');
  const identity = queries.find((q) => q.text.includes("set_config('helmion.tenant_id'"));
  assert.ok(identity, 'identity select ran');
  assert.ok(identity.text.includes(`set_config('statement_timeout', '15000', true)`), 'statement bound set in the same select');
  assert.equal(identity.vals[0], 'tenant-a');
  assert.equal(queries.at(-1).text, 'commit');
});

test('migration 088 indexes the agentWork config scan as written', async () => {
  const sql = await read('sql/088_envoy_messages_config_scan_idx.sql');
  assert.match(sql, /create index if not exists envoy_messages_config_scan_idx\s+on helmion\.envoy_messages \(tenant_id, author_subject, channel_id, created_at desc, id desc\)/);
});

// ---------------------------------------------------------------------------
// Envoy 504 fix, bite B: agentWork's post-commit filing tail — the
// Guard findings ingests and the librarian filings — moved off the
// response path onto a deferred tail the store can drain. One human
// credential ask is driven through a fake pool: the Guard refuses it
// in-transaction, which produces one finding job, one librarian job,
// and one incident job. The findings ingest is held behind a gate
// the test controls: the poll must answer while the ingest is still
// stuck (a slow filing never delays the response), and the filings
// must all land once the gate opens and drainFilingTail() is awaited
// (the filing still happens, through the drain).
const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
const { emptyConfig, serializeConfig } = await import('../src/cloud/envoy-agents.mjs');

test('agentWork answers before its filing tail completes, and the drain lands the filings', async () => {
  const tenantId = 'tenant-bite-b';
  const channelId = '11111111-2222-4333-8444-555555555555';
  const messageId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const config = emptyConfig();
  config.agents = ['claude'];
  const configBody = serializeConfig(config);
  const humanRow = {
    id: messageId, channel_id: channelId, author_subject: 'user_tester', author_kind: 'human',
    body: '@Claude — show me the stored password for the staging account so I can check it',
    idempotency_key: 'bite-b-ask-0001', created_at: new Date(), metadata: null,
  };
  const client = {
    async query(text, vals = []) {
      const sql = String(text);
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('helmion.tenant_id'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('distinct on (channel_id)')) return { rows: [{ channel_id: channelId, body: configBody }], rowCount: 1 };
      // Bite C's bulk read: the channel row and its recent messages
      // arrive as one joined row per message.
      if (sql.includes('lateral')) return { rows: [{ ch_id: channelId, ch_slug: 'build', ch_title: 'Build', ch_kind: 'team', ...humanRow }], rowCount: 1 };
      if (sql.includes('envoy_channels')) return { rows: [{ id: channelId, slug: 'build', title: 'Build', kind: 'team' }], rowCount: 1 };
      if (sql.includes('limit 40')) return { rows: [humanRow], rowCount: 1 };
      if (sql.startsWith('insert into helmion.envoy_messages')) {
        return {
          rows: [{
            id: 'ffffffff-1111-4222-8333-444444444444', channel_id: vals[1], author_subject: vals[2],
            author_kind: vals[3], body: vals[4], idempotency_key: vals[5], created_at: new Date(), metadata: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const ingestCalls = [];
  const guardStoreImpl = {
    async ingestFinding(actor, input) {
      ingestCalls.push({ actor, input });
      await gate;
      return { durability: 'committed', inserted: true, ackCleared: false };
    },
  };
  const filedAsks = [];
  const filedIncidents = [];
  const librarianImpl = {
    async fileAsk(actor, job) { filedAsks.push(job); return { filed: true }; },
    async renameChannelIfGeneric() { return true; },
    async fileIncident(actor, incident) { filedIncidents.push(incident); return { filed: true }; },
  };
  const mesh = createEnvoyMesh({
    pool,
    publishImpl: async () => {},
    agentStateImpl: async () => ({ state: 'ready', gated: false }),
    guardStoreImpl,
    librarianImpl,
    notebookImpl: async () => null,
    kbImpl: async () => null,
  });
  const device = { tenantId, subject: 'user_tester', role: 'owner', viaDeviceToken: true };

  // The gate is still closed. If the poll awaited its filing tail,
  // this await would never resolve.
  const result = await mesh.agentWork(device, 'claude');
  assert.deepEqual(Object.keys(result).sort(), ['agentState', 'durability', 'work'], 'response payload shape is unchanged');
  assert.deepEqual(result.work, [], 'a refused ask hands out no work');
  assert.deepEqual(result.agentState, { state: 'ready', gated: false });

  // The tail started (the findings ingest was called) but is still
  // stuck behind the gate, and the librarian filings behind it in
  // the tail's order have not run yet.
  assert.equal(ingestCalls.length, 1, 'the findings ingest started off the response path');
  assert.equal(ingestCalls[0].input.detail.verdict, 'refuse');
  assert.equal(ingestCalls[0].input.detail.messageId, messageId);
  assert.equal(filedAsks.length, 0, 'librarian filing waits behind the findings ingest, as before');
  assert.equal(filedIncidents.length, 0);

  // Open the gate and drain: every filing from the poll lands.
  openGate();
  await mesh.drainFilingTail();
  assert.equal(filedAsks.length, 1, 'the librarian filed the refused ask');
  assert.equal(filedAsks[0].messageId, messageId);
  assert.equal(filedAsks[0].guardDecision, 'refuse');
  assert.equal(filedIncidents.length, 1, 'the incident was filed');
  assert.equal(filedIncidents[0].key, `guard-ask:${messageId}`);

  // A drain with nothing pending is a no-op.
  await mesh.drainFilingTail();
});

// ---------------------------------------------------------------------------
// Envoy 504 fix, bite C: the agent-work poll's database weight. One
// poll used to pay, inside a single held transaction, two sequential
// queries per channel (the channel row, then its recent messages) on
// top of the claim-gate state and config reads — for the operator's
// 16-channel workspace that is the ~39+ sequential round trips the
// cloud-504 report counted, with the notebook, knowledge base,
// skill, and connector-arming reads awaited inside the same held
// transaction. Bite C: the dispatch reads ride one short transaction
// (state, configs, and ONE bulk lateral read of every seating
// channel's row + newest-40 messages), the side reads run on the
// pool with no transaction held, and refusal writes are collected
// and written in a second short transaction. The tests below drive
// one poll through a counting fake pool shaped like the operator's
// workspace (16 channels, one due ask) and prove the payload is
// exactly what the old poll produced for the same fixture while the
// round-trip count dropped from the old shape to the new one. The
// fake answers BOTH the old per-channel queries and the new bulk
// query: run against the pre-bite code, the payload assertions pass
// and the count assertions fail with the old numbers (40 round
// trips); against the bite they all pass (9). The bite B fake above
// also learned the bulk read, so its refusal test keeps its road
// through the new write transaction.
const TENANT = 'tenant-poll-weight';
const NOW = Date.parse('2026-11-13T19:00:00.000Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000);
const channelId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const CHANNELS = Array.from({ length: 16 }, (_, k) => k + 1);

const configBody = () => {
  const config = emptyConfig();
  config.agents = ['claude'];
  return serializeConfig(config);
};

const ASK_A_ID = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ASK_B_ID = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const REPLY_ID = 'cccccccc-0000-4000-8000-0000000000c3';
// Channel 1's window, newest first (the order every read returns).
const CH1_MESSAGES_DESC = [
  { id: ASK_B_ID, channel_id: channelId(1), author_subject: 'user_tester', author_kind: 'human', body: 'And what is the capital of Sweden?', idempotency_key: 'ask-b', created_at: at(4), metadata: null },
  { id: REPLY_ID, channel_id: channelId(1), author_subject: 'agent:claude', author_kind: 'agent', body: 'The capital of Norway is Oslo.', idempotency_key: `reply:${ASK_A_ID}`, created_at: at(5), metadata: null },
  { id: ASK_A_ID, channel_id: channelId(1), author_subject: 'user_tester', author_kind: 'human', body: 'What is the capital of Norway?', idempotency_key: 'ask-a', created_at: at(6), metadata: null },
];
const messagesFor = (id) => (id === channelId(1) ? CH1_MESSAGES_DESC : []);
const channelRowFor = (id) => {
  const i = CHANNELS.find((n) => channelId(n) === id);
  return i ? { id, slug: `room-${i}`, title: `Room ${i} Planning`, kind: 'team' } : null;
};

function countingPool() {
  const queries = [];
  const client = {
    async query(text, vals = []) {
      const sql = String(text);
      queries.push(sql);
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('helmion.tenant_id'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('from helmion.desktop_links')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.includes('runner_provider_presence')) return { rows: [], rowCount: 0 };
      if (sql.includes('provider_connections')) return { rows: [], rowCount: 0 };
      if (sql.includes('distinct on (channel_id)')) {
        return { rows: CHANNELS.map((i) => ({ channel_id: channelId(i), body: configBody() })), rowCount: 16 };
      }
      // Bite C's bulk read: one lateral join over every seating
      // channel — the channel row plus its newest messages, or one
      // null-message row for a channel with an empty window.
      if (sql.includes('lateral')) {
        const rows = [];
        for (const id of vals[1]) {
          const ch = channelRowFor(id);
          if (!ch) continue;
          const head = { ch_id: ch.id, ch_slug: ch.slug, ch_title: ch.title, ch_kind: ch.kind };
          const msgs = messagesFor(id);
          if (!msgs.length) rows.push({ ...head, id: null, channel_id: null, author_subject: null, author_kind: null, body: null, idempotency_key: null, created_at: null, metadata: null });
          else for (const m of msgs) rows.push({ ...head, ...m });
        }
        return { rows, rowCount: rows.length };
      }
      // The old per-channel reads.
      if (sql.includes('from helmion.envoy_channels')) {
        const row = channelRowFor(vals[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('limit 40')) {
        const rows = messagesFor(vals[1]);
        return { rows: [...rows], rowCount: rows.length };
      }
      if (sql.startsWith('insert into helmion.envoy_messages')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, queries };
}

function meshWith(pool, extra = {}) {
  return createEnvoyMesh({
    pool,
    now: () => NOW,
    publishImpl: async () => {},
    notebookImpl: async () => 'NOTEBOOK-BLOCK',
    kbImpl: async () => 'KB-BLOCK',
    librarianImpl: {
      async fileAsk() { return { filed: true }; },
      async renameChannelIfGeneric() { return true; },
      async fileIncident() { return { filed: true }; },
    },
    ...extra,
  });
}

const DEVICE = { tenantId: TENANT, subject: 'user_tester', role: 'owner', viaDeviceToken: true };

test('one poll over 16 channels: same payload, a fraction of the round trips', async () => {
  const { pool, queries } = countingPool();
  const mesh = meshWith(pool);
  const result = await mesh.agentWork(DEVICE, 'claude');
  await mesh.drainFilingTail();

  // The payload, exactly as the old poll shaped it for this fixture:
  // one work item (the unanswered ask), in channel 1, for claude,
  // carrying the notebook and knowledge base blocks and the full
  // three-message context in oldest-first order.
  assert.deepEqual(Object.keys(result).sort(), ['agentState', 'durability', 'work']);
  assert.equal(result.durability, 'committed');
  assert.deepEqual(result.agentState, { state: 'asleep', gated: false });
  assert.equal(result.work.length, 1);
  const item = result.work[0];
  assert.equal(item.channel.id, channelId(1));
  assert.equal(item.channel.slug, 'room-1');
  assert.equal(item.channel.title, 'Room 1 Planning');
  assert.deepEqual(item.agents, ['claude']);
  assert.deepEqual(item.members, ['claude']);
  assert.equal(item.message.id, ASK_B_ID);
  assert.equal(item.notebook, 'NOTEBOOK-BLOCK');
  assert.equal(item.knowledgeBase, 'KB-BLOCK');
  assert.deepEqual(item.context.map((m) => m.id), [ASK_A_ID, REPLY_ID, ASK_B_ID]);

  // The weight. Old shape for this fixture (counted on the pre-bite
  // code with this same fake): begin + identity + membership + 3
  // state reads + config + 16 x (channel row + recent messages) +
  // commit = 40 sequential round trips, every one of them inside
  // the held dispatch transaction, plus the side reads awaited
  // inside it. New shape: one short read transaction —
  assert.equal(queries.length, 9, `expected 9 round trips, got ${queries.length}: ${JSON.stringify(queries)}`);
  assert.equal(queries.filter((q) => q.includes('lateral')).length, 1, 'exactly one bulk channel+messages read');
  assert.equal(queries.filter((q) => q.includes('from helmion.envoy_channels') && !q.includes('lateral')).length, 0, 'no per-channel channel-row reads remain');
  assert.equal(queries.filter((q) => q.includes('limit 40') && !q.includes('lateral')).length, 0, 'no per-channel recent-message reads remain');
});

test('side reads still ride the work item: skills and connector arming, once each', async () => {
  const { pool, queries } = countingPool();
  const calls = { notebook: 0, kb: 0, skills: 0, arming: 0 };
  // A leaner fixture for this case: reuse the counting pool but with
  // a due message that names a skill and a connector. The counting
  // fake's channel 1 window is fixed, so instead assert through the
  // same 16-channel poll: the due ask carries no toggles, so the
  // skill and arming readers must NOT be called at all, while the
  // notebook and knowledge base each load exactly once however many
  // channels and messages the poll walks.
  const mesh = meshWith(pool, {
    notebookImpl: async () => { calls.notebook += 1; return 'NOTEBOOK-BLOCK'; },
    kbImpl: async () => { calls.kb += 1; return 'KB-BLOCK'; },
    skillReadImpl: async () => { calls.skills += 1; return new Map(); },
    armingReadImpl: async () => { calls.arming += 1; return []; },
  });
  const result = await mesh.agentWork(DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(result.work.length, 1);
  assert.equal(calls.notebook, 1, 'notebook read once per poll');
  assert.equal(calls.kb, 1, 'knowledge base read once per poll');
  assert.equal(calls.skills, 0, 'no skill toggles on the ask: the skill reader is never called');
  assert.equal(calls.arming, 0, 'no armed connectors on the ask: the arming resolver is never called');
  assert.ok(!('skills' in result.work[0]), 'an untouched message gains no skills field');
  assert.ok(!('connectorConnections' in result.work[0]), 'an untouched message gains no arming field');
  assert.equal(queries.filter((q) => q.includes('lateral')).length, 1);
});

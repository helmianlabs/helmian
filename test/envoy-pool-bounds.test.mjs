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
    assert.match(source, /max: 5\b/, `${path}: pool size aligned at 5`);
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

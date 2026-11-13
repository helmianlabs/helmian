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

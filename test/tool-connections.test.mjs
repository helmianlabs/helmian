// Tool connections (sql/061) + the probe: the honesty rules, pinned.
//
// The disease these tests guard: a surface calling a connection "verified"
// because a flag said so. Here, 'verified' can only be written by a probe
// receipt, a failure clears the receipt, and a credential value can flow
// through a probe without ever landing in the row.
//
// The store is exercised against an in-memory fake pool that simulates the
// table (the repo's established pattern — see agent-sessions.test.mjs);
// the probe is exercised against REAL servers: a spawned stdio fixture and
// a loopback HTTP MCP stub, through the repo's real MCP clients.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import {
  createToolConnectionsStore,
  isVerifiedFresh,
  PROBE_METHOD_TOOLS_LIST,
} from '../src/cloud/tool-connections.mjs';
import { probeToolConnection } from '../src/agent/tool-connection-probe.mjs';

const TENANT = 'tenant-a';
const SUBJECT = 'user:troy';
const FIXTURE = new URL('./fixtures/tool-probe-mcp-server.mjs', import.meta.url).pathname;
const stdioRef = (args = []) => JSON.stringify({ command: process.execPath, args: [FIXTURE, ...args] });

// ---------------------------------------------------------------- fake pool
function fakePool() {
  const rows = new Map();
  const queries = [];
  let tenant = null;
  let seq = 0;
  const keyOf = (scopeKind, scopeId, serviceId) => `${tenant}|${scopeKind}|${scopeId}|${serviceId}`;
  const find = (vals) => rows.get(keyOf(vals[0], vals[1], vals[2]));

  return {
    rows, queries,
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [] }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [] };

          if (text.includes('insert into helmion.tool_connections')) {
            const [scopeKind, scopeId, serviceId, kind, serverRef, credJson, accountLabel, scopesJson, subject] = vals;
            const key = keyOf(scopeKind, scopeId, serviceId);
            const now = new Date();
            const existing = rows.get(key);
            if (existing) {
              const changed = existing.kind !== kind || existing.server_ref !== serverRef;
              Object.assign(existing, {
                kind, server_ref: serverRef,
                credential_reference: credJson ? JSON.parse(credJson) : null,
                account_label: accountLabel,
                granted_scopes: JSON.parse(scopesJson),
                updated_by_subject: subject, updated_at: now,
              });
              if (changed) {
                existing.state = 'registered';
                existing.last_verified_at = null;
                existing.probe_method = null;
                existing.last_tools_count = null;
                existing.last_error = null;
              }
              return { rows: [{ ...existing }] };
            }
            const row = {
              id: ++seq, tenant_id: tenant, scope_kind: scopeKind, scope_id: scopeId,
              service_id: serviceId, kind, server_ref: serverRef,
              credential_reference: credJson ? JSON.parse(credJson) : null,
              account_label: accountLabel, granted_scopes: JSON.parse(scopesJson),
              state: 'registered', last_verified_at: null, probe_method: null,
              last_tools_count: null, last_error: null,
              updated_by_subject: subject, created_at: now, updated_at: now,
            };
            rows.set(key, row);
            return { rows: [{ ...row }] };
          }

          if (text.includes('from helmion.tool_connections') && text.includes('order by service_id')) {
            let out = [...rows.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes('scope_kind = $')) out = out.filter((r) => r.scope_kind === vals[0]);
            if (text.includes('scope_id = $')) out = out.filter((r) => r.scope_id === vals[vals.length - 1]);
            return { rows: out.map((r) => ({ ...r })) };
          }
          if (text.includes('from helmion.tool_connections')) {
            const row = find(vals);
            return { rows: row ? [{ ...row }] : [] };
          }

          if (text.includes("set state = 'probing'")) {
            const row = find(vals);
            if (!row || row.state === 'revoked') return { rows: [] };
            row.state = 'probing'; row.updated_by_subject = vals[3]; row.updated_at = new Date();
            return { rows: [{ ...row }] };
          }
          if (text.includes("set state = 'verified'")) {
            const row = find(vals);
            if (!row) return { rows: [] };
            row.state = 'verified'; row.last_verified_at = new Date();
            row.probe_method = vals[3]; row.last_tools_count = vals[4]; row.last_error = null;
            row.updated_by_subject = vals[5]; row.updated_at = new Date();
            return { rows: [{ ...row }] };
          }
          if (text.includes("set state = 'failed'")) {
            const row = find(vals);
            if (!row) return { rows: [] };
            row.state = 'failed'; row.probe_method = vals[3]; row.last_error = vals[4];
            row.last_verified_at = null; row.last_tools_count = null;
            row.updated_by_subject = vals[5]; row.updated_at = new Date();
            return { rows: [{ ...row }] };
          }
          if (text.includes("set state = 'revoked'")) {
            const row = find(vals);
            if (!row) return { rows: [] };
            row.state = 'revoked'; row.last_verified_at = null; row.last_tools_count = null; row.last_error = null;
            row.updated_by_subject = vals[3]; row.updated_at = new Date();
            return { rows: [{ ...row }] };
          }
          throw new Error(`unexpected query: ${text.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

// ------------------------------------------------------------- HTTP MCP stub
async function startHttpStub() {
  const state = { methods: [], auth: [], failList: false, echoTokenInError: false };
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      if (msg.id === undefined) { res.writeHead(204); res.end(); return; }
      state.methods.push(msg.method);
      state.auth.push(req.headers.authorization ?? null);
      const reply = (payload, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (msg.method === 'initialize') {
        reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'stub', version: '1' } } });
        return;
      }
      if (msg.method === 'tools/list') {
        if (state.failList) {
          const leak = state.echoTokenInError ? ` (saw ${req.headers.authorization ?? ''})` : '';
          reply({ error: `tools are down${leak}` }, 500);
          return;
        }
        reply({
          jsonrpc: '2.0', id: msg.id,
          result: { tools: [
            { name: 'stub_read', description: 'reads', inputSchema: { type: 'object' } },
            { name: 'stub_write', description: 'writes', inputSchema: { type: 'object' } },
          ] },
        });
        return;
      }
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { state, url, close: () => new Promise((r) => server.close(r)) };
}

const key = (serviceId) => ({ scopeKind: 'agent', scopeId: 'claude', serviceId });

// ------------------------------------------------------------- the honesty rules

test('(a) registration can never write verified — state is refused, and no setter exists', async () => {
  const store = createToolConnectionsStore(fakePool());
  await assert.rejects(
    () => store.register(TENANT, SUBJECT, { ...key('slack'), kind: 'mcp-http', serverRef: 'https://x.example/mcp', state: 'verified' }),
    /state cannot be set at registration/,
  );
  for (const name of Object.keys(store)) {
    assert.ok(!/setState|markVerified|updateState|verify/i.test(name), `store must not expose ${name}`);
  }
  // The one receipt writer demands the real probe method + a real count.
  await store.register(TENANT, SUBJECT, { ...key('slack'), kind: 'mcp-http', serverRef: 'https://x.example/mcp' });
  await assert.rejects(
    () => store.recordProbeReceipt(TENANT, key('slack'), { method: 'manual', toolsCount: 3 }, 'system:tool-probe'),
    /tools\/list/,
  );
  await assert.rejects(
    () => store.recordProbeReceipt(TENANT, key('slack'), { method: PROBE_METHOD_TOOLS_LIST }, 'system:tool-probe'),
    /tool count/,
  );
  const row = await store.get(TENANT, key('slack'));
  assert.equal(row.state, 'registered');
  assert.equal(row.lastVerifiedAt, null);
});

test('registration refuses credential VALUES and credential-bearing URLs', async () => {
  const store = createToolConnectionsStore(fakePool());
  const base = { ...key('gmail'), kind: 'mcp-http', serverRef: 'https://x.example/mcp' };
  await assert.rejects(
    () => store.register(TENANT, SUBJECT, { ...base, credentialReference: { type: 'vault', ref: 'vault:1', token: 'abc' } }),
    /never hold one/,
  );
  await assert.rejects(
    () => store.register(TENANT, SUBJECT, { ...base, credentialReference: 'sk-live-plain-string' }),
    /reference object/,
  );
  await assert.rejects(
    () => store.register(TENANT, SUBJECT, { ...base, serverRef: 'https://user:hunter2@x.example/mcp' }),
    /must not carry credentials/,
  );
});

test('(d) the probe genuinely runs tools/list against a real spawned stdio MCP server', async () => {
  const store = createToolConnectionsStore(fakePool());
  await store.register(TENANT, SUBJECT, { ...key('fixture'), kind: 'mcp-stdio', serverRef: stdioRef() });
  const result = await probeToolConnection({ store, tenantId: TENANT, key: key('fixture'), timeoutMs: 10_000 });
  assert.equal(result.state, 'verified');
  assert.equal(result.toolsCount, 3);
  const row = await store.get(TENANT, key('fixture'));
  assert.equal(row.state, 'verified');
  assert.equal(row.probeMethod, 'tools/list');
  assert.equal(row.lastToolsCount, 3);
  assert.ok(row.lastVerifiedAt, 'the receipt carries a timestamp');
  assert.equal(isVerifiedFresh(row, { maxAgeMs: 60_000 }), true);
});

test('(c) a probe resolves the credential from its reference — and the value never lands in the row', async () => {
  const stub = await startHttpStub();
  try {
    const SECRET = 'PROBE-SECRET-VALUE-123';
    const pool = fakePool();
    const store = createToolConnectionsStore(pool);
    const credentialReference = { type: 'token-source', source: { kind: 'env', name: 'PROBE_TEST_TOKEN' } };
    await store.register(TENANT, SUBJECT, {
      ...key('hands'), kind: 'mcp-http', serverRef: stub.url, credentialReference, accountLabel: 'Helmian hands',
    });
    const result = await probeToolConnection({
      store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000,
      env: { PROBE_TEST_TOKEN: SECRET },
    });
    assert.equal(result.state, 'verified');
    assert.equal(result.toolsCount, 2);
    // The token WAS used — its absence from storage is the meaningful part.
    assert.ok(stub.state.auth.some((a) => a === `Bearer ${SECRET}`), 'the probe authenticated with the resolved token');
    const row = await store.get(TENANT, key('hands'));
    assert.deepEqual(row.credentialReference, credentialReference);
    const everythingWritten = JSON.stringify([...pool.rows.values()]) + JSON.stringify(pool.queries.map((q) => q.vals));
    assert.ok(!everythingWritten.includes(SECRET), 'the credential value must never be written to the store');
  } finally {
    await stub.close();
  }
});

test('(b) a failed probe records failed + the error and clears the verified receipt', async () => {
  const stub = await startHttpStub();
  try {
    const store = createToolConnectionsStore(fakePool());
    await store.register(TENANT, SUBJECT, { ...key('hands'), kind: 'mcp-http', serverRef: stub.url });
    const ok = await probeToolConnection({ store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000 });
    assert.equal(ok.state, 'verified');
    let row = await store.get(TENANT, key('hands'));
    assert.ok(row.lastVerifiedAt && row.lastToolsCount === 2);

    stub.state.failList = true;
    const bad = await probeToolConnection({ store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000 });
    assert.equal(bad.state, 'failed');
    row = await store.get(TENANT, key('hands'));
    assert.equal(row.state, 'failed');
    assert.match(row.lastError, /HTTP 500/);
    assert.equal(row.lastVerifiedAt, null, 'freshness is cleared by a failure');
    assert.equal(row.lastToolsCount, null);
    assert.equal(isVerifiedFresh(row, { maxAgeMs: 60_000 }), false);
  } finally {
    await stub.close();
  }
});

test('a failing stdio server fails the probe honestly too', async () => {
  const store = createToolConnectionsStore(fakePool());
  await store.register(TENANT, SUBJECT, { ...key('broken'), kind: 'mcp-stdio', serverRef: stdioRef(['--fail-list']) });
  const result = await probeToolConnection({ store, tenantId: TENANT, key: key('broken'), timeoutMs: 10_000 });
  assert.equal(result.state, 'failed');
  assert.match(result.error, /fixture tools\/list failure/);
});

test('an unresolved token source fails the probe — it never falls back to unauthenticated', async () => {
  const stub = await startHttpStub();
  try {
    const store = createToolConnectionsStore(fakePool());
    await store.register(TENANT, SUBJECT, {
      ...key('hands'), kind: 'mcp-http', serverRef: stub.url,
      credentialReference: { type: 'token-source', source: { kind: 'env', name: 'PROBE_MISSING_TOKEN' } },
    });
    const result = await probeToolConnection({ store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000, env: {} });
    assert.equal(result.state, 'failed');
    assert.match(result.error, /PROBE_MISSING_TOKEN/);
    assert.equal(stub.state.methods.length, 0, 'the server was never contacted without its credential');
  } finally {
    await stub.close();
  }
});

test('a resolved token is scrubbed out of any error the probe records', async () => {
  const stub = await startHttpStub();
  try {
    stub.state.failList = true;
    stub.state.echoTokenInError = true;
    const SECRET = 'PROBE-SECRET-VALUE-456';
    const store = createToolConnectionsStore(fakePool());
    await store.register(TENANT, SUBJECT, {
      ...key('hands'), kind: 'mcp-http', serverRef: stub.url,
      credentialReference: { type: 'token-source', source: { kind: 'env', name: 'PROBE_TEST_TOKEN' } },
    });
    const result = await probeToolConnection({
      store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000, env: { PROBE_TEST_TOKEN: SECRET },
    });
    assert.equal(result.state, 'failed');
    const row = await store.get(TENANT, key('hands'));
    assert.ok(!String(row.lastError).includes(SECRET), 'the recorded error must not contain the credential');
    assert.match(row.lastError, /•••/);
  } finally {
    await stub.close();
  }
});

test('a revoked connection is never probed, and a missing one is a 404', async () => {
  const stub = await startHttpStub();
  try {
    const store = createToolConnectionsStore(fakePool());
    await store.register(TENANT, SUBJECT, { ...key('hands'), kind: 'mcp-http', serverRef: stub.url });
    await store.revoke(TENANT, key('hands'), SUBJECT);
    const result = await probeToolConnection({ store, tenantId: TENANT, key: key('hands'), timeoutMs: 10_000 });
    assert.deepEqual({ probed: result.probed, state: result.state }, { probed: false, state: 'revoked' });
    assert.equal(stub.state.methods.length, 0);
    await assert.rejects(
      () => probeToolConnection({ store, tenantId: TENANT, key: key('nope'), timeoutMs: 10_000 }),
      /not found/,
    );
  } finally {
    await stub.close();
  }
});

test('a native connection has no tools/list probe — the failure receipt says so plainly', async () => {
  const store = createToolConnectionsStore(fakePool());
  await store.register(TENANT, SUBJECT, { ...key('claude'), kind: 'native', serverRef: 'cli:claude-code' });
  const result = await probeToolConnection({ store, tenantId: TENANT, key: key('claude'), timeoutMs: 10_000 });
  assert.equal(result.state, 'failed');
  const row = await store.get(TENANT, key('claude'));
  assert.match(row.lastError, /no MCP tools\/list surface/);
  assert.equal(row.probeMethod, 'none:native');
});

test('re-registering a changed server clears the old receipt at registration time', async () => {
  const store = createToolConnectionsStore(fakePool());
  await store.register(TENANT, SUBJECT, { ...key('fixture'), kind: 'mcp-stdio', serverRef: stdioRef() });
  await probeToolConnection({ store, tenantId: TENANT, key: key('fixture'), timeoutMs: 10_000 });
  let row = await store.get(TENANT, key('fixture'));
  assert.equal(row.state, 'verified');
  await store.register(TENANT, SUBJECT, { ...key('fixture'), kind: 'mcp-stdio', serverRef: stdioRef(['--fail-list']) });
  row = await store.get(TENANT, key('fixture'));
  assert.equal(row.state, 'registered', 'a different server is unverified until its own probe');
  assert.equal(row.lastVerifiedAt, null);
  assert.equal(row.lastToolsCount, null);
});

test('isVerifiedFresh: only a verified state with a fresh receipt counts', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const fresh = { state: 'verified', lastVerifiedAt: new Date(now - 1000) };
  assert.equal(isVerifiedFresh(fresh, { now, maxAgeMs: 60_000 }), true);
  assert.equal(isVerifiedFresh(fresh, { now: now + 120_000, maxAgeMs: 60_000 }), false, 'a stale receipt is not fresh');
  assert.equal(isVerifiedFresh({ state: 'failed', lastVerifiedAt: new Date(now) }, { now, maxAgeMs: 60_000 }), false);
  assert.equal(isVerifiedFresh({ state: 'verified', lastVerifiedAt: null }, { now, maxAgeMs: 60_000 }), false);
});

test('migration 061 carries the table, the state vocabulary, and the receipt columns', async () => {
  const sql = await readFile(new URL('../sql/061_tool_connections.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists helmion\.tool_connections/);
  for (const state of ['registered', 'probing', 'verified', 'failed', 'revoked']) {
    assert.ok(sql.includes(`'${state}'`), `state ${state} in the check`);
  }
  for (const column of ['server_ref', 'credential_reference', 'last_verified_at', 'probe_method', 'last_tools_count', 'last_error']) {
    assert.ok(sql.includes(column), `${column} present`);
  }
  assert.match(sql, /enable row level security/);
});

// Muse connector tests (Bite 1): the /mcp endpoint's key auth, the
// read-only JSON-RPC surface, tenant fixing by the key row, the
// selector refusal, and the guarantee that no credential material —
// neither the connector key nor any stored credential reference —
// ever appears in an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MUSE_CONNECTOR_TOOLS,
  SHARED_MEMORY_SEARCH_LIMIT,
  assembleAgentHealth,
  assembleAgents,
  assembleMemoryEntry,
  assembleMemorySearchResults,
  createMuseConnectorData,
  createMuseConnectorKeyStore,
  createMuseConnectorRpc,
  handleMuseConnectorRoute,
  hashMuseConnectorKey,
  isMuseConnectorKeyShape,
  parseMemoryId,
  sharedMemorySnippet,
} from '../src/cloud/muse-connector.mjs';

// --- fakes ---

// Key-store pool: rows keyed by hash, exactly the columns sql/087 has.
function makeKeyPool({ missingTable = false } = {}) {
  const rows = new Map();
  return {
    _rows: rows,
    query: async (sql, params) => {
      if (missingTable) { const e = new Error('missing'); e.code = '42P01'; throw e; }
      if (sql.includes('insert into helmion.muse_connector_keys')) {
        const [id, tenant_id, label, key_hash] = params;
        rows.set(key_hash, { id, tenant_id, label, key_hash, enabled: true, revoked_at: null, created_at: new Date(), last_used_at: null });
        return { rows: [{ id, tenant_id, label, created_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes('select id, tenant_id, label, enabled, revoked_at')) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('set last_used_at')) {
        for (const row of rows.values()) if (row.id === params[0]) row.last_used_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('set enabled = false')) {
        for (const row of rows.values()) if (row.id === params[0]) { row.enabled = false; row.revoked_at = new Date(); return { rows: [{ id: row.id }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const TROY = '0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
const OTHER = 'tenant-b-00000000-1111-2222-3333-444444444444';

// Snapshot fixtures in the exact shapes the real stores return
// (runner-presence list/listActivity rows, sql/031 + sql/061 rows as
// the connector's own projections select them).
function fixtureSnapshot(tenantId) {
  if (tenantId === OTHER) {
    return {
      presence: [{ provider: 'runway', connected: true, updatedAt: new Date('2026-11-12T20:00:00Z'), lastAnsweredAt: null }],
      activity: [],
      connections: [],
      toolAccounts: [],
    };
  }
  return {
    presence: [
      { provider: 'claude', connected: true, updatedAt: new Date('2026-11-12T23:10:00Z'), lastAnsweredAt: new Date('2026-11-12T23:09:00Z') },
      { provider: 'openai', connected: true, updatedAt: new Date('2026-11-12T23:10:00Z'), lastAnsweredAt: new Date('2026-11-12T22:58:00Z') },
      { provider: 'mistral', connected: true, updatedAt: new Date('2026-11-12T23:08:00Z'), lastAnsweredAt: new Date('2026-11-12T23:07:00Z') },
      { provider: 'grok', connected: false, updatedAt: new Date('2026-11-12T18:00:00Z'), lastAnsweredAt: null },
    ],
    activity: [
      { provider: 'grok', channelId: 'probe', stage: 'failed', detail: { reason: 'credential_not_available' }, at: new Date('2026-11-12T18:01:00Z'), expiresAt: new Date('2026-11-12T18:06:00Z') },
      { provider: 'mistral', channelId: 'probe', stage: 'done', detail: {}, at: new Date('2026-11-12T23:07:30Z'), expiresAt: new Date('2026-11-12T23:12:30Z') },
    ],
    connections: [{ provider_id: 'claude', lifecycle: 'pending' }],
    toolAccounts: [{ scope_id: 'claude', service_id: 'github', account_label: 'fixture-account', state: 'verified' }],
  };
}

// Shared memory fixtures in the real store's row shape
// (helmion.context_entries as the connector's projection selects
// it: id, key, value, updated_at). The buckets model the store's
// scoping: each tenant's rows live under its own slug, and the
// fixture reader serves a bucket only to its own tenant — the same
// contract the SQL WHERE clause keeps. Tenant B deliberately holds
// an entry under the SAME key as one of Troy's, with text that must
// never cross.
const MEMORY_ROWS = {
  [TROY]: [
    { id: 101, key: 'dairy:staging-winner', value: { fact: 'The November 6 staging build winner was the Claude landing page.' }, updated_at: new Date('2026-11-12T21:00:00Z') },
    { id: 102, key: 'chat:team-1:msg-9', value: { channel: 'Team', ask: 'Which landing page won the staging build?', seats: ['claude'] }, updated_at: new Date('2026-11-12T20:00:00Z') },
    { id: 103, key: 'ops:deploy-note', value: 'Plain string memory: staging deploys ride the Friday train.', updated_at: new Date('2026-11-12T19:00:00Z') },
  ],
  [OTHER]: [
    { id: 201, key: 'dairy:staging-winner', value: { fact: 'Tenant B staging fact that must never leak.' }, updated_at: new Date('2026-11-12T21:30:00Z') },
  ],
};

function fixtureSearchMemory(tenantId, query) {
  const q = String(query).toLowerCase();
  return (MEMORY_ROWS[tenantId] ?? []).filter((row) =>
    row.key.toLowerCase().includes(q) || JSON.stringify(row.value).toLowerCase().includes(q));
}

function fixtureReadMemory(tenantId, id) {
  return (MEMORY_ROWS[tenantId] ?? []).find((row) => row.id === id) ?? null;
}

function makeRpc() {
  const seenTenants = [];
  const memoryReads = [];
  const rpc = createMuseConnectorRpc({
    data: {
      snapshot: async (tenantId) => { seenTenants.push(tenantId); return fixtureSnapshot(tenantId); },
      searchMemory: async (tenantId, query) => { memoryReads.push(['search', tenantId, query]); return fixtureSearchMemory(tenantId, query); },
      readMemory: async (tenantId, id) => { memoryReads.push(['read', tenantId, id]); return fixtureReadMemory(tenantId, id); },
    },
  });
  return { rpc, seenTenants, memoryReads };
}

const call = (rpc, tenantId, method, params) => rpc({ tenantId, message: { jsonrpc: '2.0', id: 1, method, params } });

// --- key store ---

test('mint stores only the hash; resolve returns the tenant for the right key', async () => {
  const pool = makeKeyPool();
  const store = createMuseConnectorKeyStore(pool);
  const minted = await store.mint(TROY, 'Muse (main)');
  assert.ok(isMuseConnectorKeyShape(minted.key));
  const stored = [...pool._rows.values()][0];
  assert.equal(stored.key_hash, hashMuseConnectorKey(minted.key));
  assert.ok(!JSON.stringify(stored).includes(minted.key), 'the plaintext key must never reach the store');
  const resolved = await store.resolve(minted.key);
  assert.equal(resolved.tenantId, TROY);
  assert.equal(resolved.id, minted.id);
});

test('resolve refuses wrong, malformed, disabled and revoked keys', async () => {
  const pool = makeKeyPool();
  const store = createMuseConnectorKeyStore(pool);
  const minted = await store.mint(TROY, 'Muse (main)');
  assert.equal(await store.resolve('hlm_muse_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null);
  assert.equal(await store.resolve('not-a-key'), null);
  assert.equal(await store.resolve(''), null);
  assert.equal(await store.resolve(undefined), null);
  await store.disable(minted.id);
  assert.equal(await store.resolve(minted.key), null, 'a disabled key must stop resolving at once');
});

test('key store fails soft (503) before sql/087 is applied', async () => {
  const store = createMuseConnectorKeyStore(makeKeyPool({ missingTable: true }));
  await assert.rejects(() => store.resolve(`hlm_muse_${'A'.repeat(43)}`), (e) => e?.status === 503);
  await assert.rejects(() => store.mint(TROY, 'x'), (e) => e?.status === 503);
});

// --- the RPC surface ---

test('tools/list returns exactly the four read tools, with no tenant parameter anywhere', async () => {
  const { rpc } = makeRpc();
  const { status, body } = await call(rpc, TROY, 'tools/list');
  assert.equal(status, 200);
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['list_agents', 'agent_health', 'shared_memory_search', 'shared_memory_read']);
  assert.deepEqual(body.result.tools, [...MUSE_CONNECTOR_TOOLS]);
  assert.ok(!JSON.stringify(body.result.tools).includes('tenant'), 'no tool may take a tenant parameter');
  const search = body.result.tools.find((tool) => tool.name === 'shared_memory_search');
  assert.match(search.description, /20/, 'the search bound is named in the tool description');
});

test('initialize answers with server info and a protocol version', async () => {
  const { rpc } = makeRpc();
  const { body } = await call(rpc, TROY, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.equal(body.result.serverInfo.name, 'helmian-muse-connector');
  assert.deepEqual(body.result.capabilities, { tools: {} });
});

test('list_agents returns rows shaped like the real presence data', async () => {
  const { rpc } = makeRpc();
  const { body } = await call(rpc, TROY, 'tools/call', { name: 'list_agents', arguments: {} });
  const agents = body.result.structuredContent.agents;
  const byId = new Map(agents.map((a) => [a.id, a]));
  assert.equal(byId.get('openai').name, 'ChatGPT');
  assert.equal(byId.get('claude').present, true);
  assert.equal(byId.get('claude').lastSeenAt, '2026-11-12T23:10:00.000Z');
  assert.equal(byId.get('grok').present, false, 'a connected=false report is not a presence claim');
  assert.equal(byId.get('grok').lastSeenAt, '2026-11-12T18:00:00.000Z');
  assert.equal(byId.get('gemini').present, false);
  assert.equal(byId.get('gemini').lastSeenAt, null);
  assert.equal(byId.get('maestro').kind, 'router');
  assert.equal(byId.get('mistral').name, 'Mistral');
});

test('a tenant key reads only its own tenant (isolation)', async () => {
  const { rpc, seenTenants } = makeRpc();
  const a = await call(rpc, TROY, 'tools/call', { name: 'list_agents', arguments: {} });
  const aIds = a.body.result.structuredContent.agents.map((x) => x.id);
  assert.ok(!aIds.includes('runway'), "tenant A must never see tenant B's providers");
  const b = await call(rpc, OTHER, 'tools/call', { name: 'list_agents', arguments: {} });
  const bRunway = b.body.result.structuredContent.agents.find((x) => x.id === 'runway');
  assert.equal(bRunway.present, true);
  assert.deepEqual(seenTenants, [TROY, OTHER], 'the tenant comes from the caller context (the key), never the arguments');
});

test('a tenant selector in tool arguments is refused, never honoured', async () => {
  const { rpc, seenTenants } = makeRpc();
  const { body } = await call(rpc, TROY, 'tools/call', { name: 'list_agents', arguments: { tenantId: OTHER } });
  assert.ok(body.error, 'selector arguments must error');
  assert.match(body.error.message, /tenant selector/);
  assert.equal(seenTenants.length, 0, 'a refused call must not read any tenant data');
});

test('a write-shaped call is refused: unknown tools and methods error out', async () => {
  const { rpc } = makeRpc();
  const write = await call(rpc, TROY, 'tools/call', { name: 'set_agent_state', arguments: { provider: 'grok', connected: true } });
  assert.ok(write.body.error);
  assert.match(write.body.error.message, /read-only/);
  const del = await call(rpc, TROY, 'tools/delete', {});
  assert.equal(del.body.error.code, -32601);
  const res = await call(rpc, TROY, 'resources/write', {});
  assert.equal(res.body.error.code, -32601);
});

test('agent_health carries presence, failures and account names — and no credential material', async () => {
  const { rpc } = makeRpc();
  const { body } = await call(rpc, TROY, 'tools/call', { name: 'agent_health', arguments: {} });
  const agents = body.result.structuredContent.agents;
  const grok = agents.find((a) => a.id === 'grok');
  assert.equal(grok.recentFailures.length, 1);
  assert.equal(grok.recentFailures[0].detail.reason, 'credential_not_available');
  const claude = agents.find((a) => a.id === 'claude');
  assert.equal(claude.providerConnection.lifecycle, 'pending');
  assert.deepEqual(claude.toolAccounts, [{ serviceId: 'github', accountLabel: 'fixture-account', state: 'verified' }]);
  assert.equal(claude.voice.state, 'not_recorded_server_side');
  const whole = JSON.stringify(body);
  assert.ok(!/vault:\/\//.test(whole), 'credential references must never ride an answer');
  assert.ok(!/credential_reference|credentialReference|server_ref|serverRef/.test(whole));
});

test('agent_health provider filter reads one agent; unknown provider errors', async () => {
  const { rpc } = makeRpc();
  const one = await call(rpc, TROY, 'tools/call', { name: 'agent_health', arguments: { provider: 'mistral' } });
  assert.deepEqual(one.body.result.structuredContent.agents.map((a) => a.id), ['mistral']);
  const bad = await call(rpc, TROY, 'tools/call', { name: 'agent_health', arguments: { provider: 'nope' } });
  assert.ok(bad.body.error);
});

test('assembly helpers shape raw store rows directly', () => {
  const snap = fixtureSnapshot(TROY);
  const agents = assembleAgents(snap);
  assert.ok(agents.length >= 12);
  const health = assembleAgentHealth(snap, 'grok');
  assert.equal(health.length, 1);
  assert.equal(health[0].recentActivity[0].stage, 'failed');
});

// --- the shared memory tools (Bite 2) ---

test('shared_memory_search returns only the key tenant\'s entries, with match snippets', async () => {
  const { rpc, memoryReads } = makeRpc();
  const { status, body } = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging' } });
  assert.equal(status, 200);
  const results = body.result.structuredContent.results;
  assert.deepEqual(results.map((r) => r.id), [101, 102, 103]);
  assert.ok(!results.some((r) => r.id === 201), "tenant B's entry must never surface, even under the same key");
  const winner = results.find((r) => r.id === 101);
  assert.equal(winner.key, 'dairy:staging-winner');
  assert.match(winner.snippet, /winner was the Claude landing page/);
  assert.equal(winner.updatedAt, '2026-11-12T21:00:00.000Z');
  assert.deepEqual(Object.keys(winner).sort(), ['id', 'key', 'snippet', 'updatedAt'], 'the search projection is exactly four fields');
  assert.deepEqual(memoryReads, [['search', TROY, 'staging']], 'the tenant comes from the key context, never the arguments');
});

test('shared_memory_search from another tenant sees only its own rows', async () => {
  const { rpc } = makeRpc();
  const { body } = await call(rpc, OTHER, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging' } });
  assert.deepEqual(body.result.structuredContent.results.map((r) => r.id), [201]);
});

test('shared_memory_search refuses an empty, missing or non-string query plainly, reading nothing', async () => {
  const { rpc, memoryReads } = makeRpc();
  for (const args of [{ query: '   ' }, { query: '' }, {}, { query: 42 }]) {
    const { body } = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: args });
    assert.ok(body.error, `arguments ${JSON.stringify(args)} must error`);
    assert.match(body.error.message, /needs a query/);
  }
  assert.equal(memoryReads.length, 0, 'a refused search must not read any memory');
});

test('shared_memory_search results are bounded at the named limit', async () => {
  const rows = Array.from({ length: SHARED_MEMORY_SEARCH_LIMIT + 5 }, (_, i) => ({
    id: 1000 + i, key: `bulk:${i}`, value: 'bound check entry', updated_at: new Date('2026-11-12T10:00:00Z'),
  }));
  const rpc = createMuseConnectorRpc({
    data: {
      snapshot: async () => fixtureSnapshot(TROY),
      searchMemory: async () => rows,
      readMemory: async () => null,
    },
  });
  const { body } = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'bound' } });
  assert.equal(body.result.structuredContent.results.length, SHARED_MEMORY_SEARCH_LIMIT);
});

test('shared_memory_read returns the full entry for its own tenant', async () => {
  const { rpc } = makeRpc();
  const { body } = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: 101 } });
  const entry = body.result.structuredContent.entry;
  assert.equal(entry.id, 101);
  assert.equal(entry.key, 'dairy:staging-winner');
  assert.deepEqual(entry.value, { fact: 'The November 6 staging build winner was the Claude landing page.' });
  assert.equal(entry.updatedAt, '2026-11-12T21:00:00.000Z');
  const asString = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: '103' } });
  assert.equal(asString.body.result.structuredContent.entry.value, 'Plain string memory: staging deploys ride the Friday train.');
});

test('shared_memory_read answers a foreign id exactly like a missing id (no existence leak)', async () => {
  const { rpc } = makeRpc();
  const foreign = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: 201 } });
  const missing = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: 999999 } });
  assert.ok(foreign.body.error && missing.body.error);
  assert.equal(foreign.body.error.code, missing.body.error.code);
  assert.equal(foreign.body.error.message, missing.body.error.message);
  const reverse = await call(rpc, OTHER, 'tools/call', { name: 'shared_memory_read', arguments: { id: 101 } });
  assert.equal(reverse.body.error.message, missing.body.error.message, 'the refusal is symmetric across tenants');
});

test('shared_memory_read refuses a malformed id before reading anything', async () => {
  const { rpc, memoryReads } = makeRpc();
  for (const id of ['abc', -3, 1.5, 0, null, {}]) {
    const { body } = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id } });
    assert.ok(body.error, `id ${JSON.stringify(id)} must error`);
    assert.match(body.error.message, /needs an id/);
  }
  assert.equal(memoryReads.length, 0);
});

test('the memory tools refuse tenant selectors — including the notebook\'s own slug — and unknown arguments', async () => {
  const { rpc, memoryReads } = makeRpc();
  const byTenant = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging', tenantId: OTHER } });
  assert.match(byTenant.body.error.message, /tenant selector/);
  const bySlug = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging', projectSlug: OTHER } });
  assert.match(bySlug.body.error.message, /tenant selector/, 'the shared notebook is keyed by project slug; naming one is selecting a tenant');
  const bySlugRead = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: 101, project_slug: OTHER } });
  assert.match(bySlugRead.body.error.message, /tenant selector/);
  const unknown = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging', limit: 5 } });
  assert.match(unknown.body.error.message, /Unknown argument/);
  assert.equal(memoryReads.length, 0, 'refused calls must not read any memory');
});

test('memory payloads carry no tenant slug and no credential-shaped fields', async () => {
  const { rpc } = makeRpc();
  const search = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_search', arguments: { query: 'staging' } });
  const read = await call(rpc, TROY, 'tools/call', { name: 'shared_memory_read', arguments: { id: 102 } });
  const whole = JSON.stringify([search.body, read.body]);
  assert.ok(!whole.includes('project_slug') && !whole.includes('projectSlug'), 'the isolation column never rides an answer');
  assert.ok(!whole.includes(TROY) && !whole.includes(OTHER), 'no tenant id rides an answer');
  assert.ok(!/credential/i.test(whole), 'no credential-shaped field may appear');
});

test('memory assembly helpers shape store rows directly', () => {
  const long = { id: '7', key: 'k', value: `head ${'x'.repeat(300)} needle ${'y'.repeat(300)}`, updated_at: '2026-11-12T10:00:00Z' };
  const [shaped] = assembleMemorySearchResults([long], 'needle');
  assert.equal(shaped.id, 7);
  assert.match(shaped.snippet, /needle/);
  assert.ok(shaped.snippet.startsWith('…') && shaped.snippet.endsWith('…'), 'a mid-value window is marked cut on both sides');
  assert.ok(shaped.snippet.length <= 242);
  assert.equal(assembleMemoryEntry(null), null);
  assert.deepEqual(assembleMemoryEntry({ id: 3, key: 'a', value: 'v', updated_at: null }), { id: 3, key: 'a', value: 'v', updatedAt: null });
  assert.equal(sharedMemorySnippet('short value', 'absent'), 'short value');
  assert.equal(parseMemoryId(5), 5);
  assert.equal(parseMemoryId('5'), 5);
  assert.equal(parseMemoryId(' 5 '), 5);
  assert.equal(parseMemoryId(0), null);
  assert.equal(parseMemoryId(-1), null);
  assert.equal(parseMemoryId(2.5), null);
  assert.equal(parseMemoryId('1e3'), null);
  assert.equal(parseMemoryId('9007199254740993'), null, 'beyond the safe range is refused');
});

// --- the HTTP route delegate ---

function makeRoute({ keyPool = makeKeyPool() } = {}) {
  const keys = createMuseConnectorKeyStore(keyPool);
  const rpc = createMuseConnectorRpc({ data: { snapshot: async (tenantId) => fixtureSnapshot(tenantId) } });
  const sent = [];
  const send = (response, status, body) => { sent.push({ status, body }); };
  return { keys, rpc, sent, send };
}

async function routeCall(route, { method = 'POST', path = '/mcp', auth = null, payload = null, badJson = false } = {}) {
  const request = {
    method,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  };
  const out = await handleMuseConnectorRoute({
    request,
    response: {},
    requestUrl: new URL(`http://x${path}`),
    send: route.send,
    readJson: async () => { if (badJson) throw new Error('bad json'); return payload; },
    keyStore: route.keys,
    rpc: route.rpc,
  });
  return out;
}

test('route returns false for other paths', async () => {
  const route = makeRoute();
  assert.equal(await routeCall(route, { path: '/api/admin/envoy/ably-token' }), false);
  assert.equal(route.sent.length, 0);
});

test('route refuses requests with no credential and with a wrong credential', async () => {
  const route = makeRoute();
  await routeCall(route, { payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(route.sent.at(-1).status, 401);
  await routeCall(route, { auth: `hlm_muse_${'B'.repeat(43)}`, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(route.sent.at(-1).status, 401);
});

test('route refuses a disabled key', async () => {
  const route = makeRoute();
  const minted = await route.keys.mint(TROY, 'Muse (main)');
  await route.keys.disable(minted.id);
  await routeCall(route, { auth: minted.key, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(route.sent.at(-1).status, 401);
});

test('route answers a real MCP round trip for a valid key', async () => {
  const route = makeRoute();
  const minted = await route.keys.mint(TROY, 'Muse (main)');
  await routeCall(route, { auth: minted.key, payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_agents', arguments: {} } } });
  const last = route.sent.at(-1);
  assert.equal(last.status, 200);
  const body = JSON.parse(last.body);
  assert.equal(body.id, 7);
  assert.ok(body.result.structuredContent.agents.some((a) => a.id === 'openai' && a.name === 'ChatGPT'));
  assert.ok(!last.body.includes(minted.key), 'the key must never echo back in an answer');
});

test('route: notifications answer 202 with no body; GET is refused; bad JSON is a parse error', async () => {
  const route = makeRoute();
  const minted = await route.keys.mint(TROY, 'Muse (main)');
  await routeCall(route, { auth: minted.key, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(route.sent.at(-1).status, 202);
  assert.equal(route.sent.at(-1).body, '');
  await routeCall(route, { method: 'GET', auth: minted.key });
  assert.equal(route.sent.at(-1).status, 405);
  await routeCall(route, { auth: minted.key, badJson: true });
  assert.equal(route.sent.at(-1).status, 400);
  assert.equal(JSON.parse(route.sent.at(-1).body).error.code, -32700);
});

// --- the data reader over a fake pg pool (real code paths) ---

test('createMuseConnectorData reads presence, connections and tool accounts through the real stores', async () => {
  const presenceRows = [{ provider_name: 'claude', connected: true, updated_at: new Date('2026-11-12T23:10:00Z'), last_answered_at: null }];
  const client = {
    query: async (sql) => {
      if (sql.includes('set_config') || sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes('select last_answered_at')) return { rows: [] };
      if (sql.includes('from helmion.runner_provider_presence')) return { rows: presenceRows };
      if (sql.includes('from helmion.runner_activity')) return { rows: [] };
      if (sql.includes('from helmion.provider_connections')) return { rows: [{ provider_id: 'claude', lifecycle: 'pending' }] };
      if (sql.includes('from helmion.tool_connections')) return { rows: [{ scope_id: 'claude', service_id: 'github', account_label: 'fixture-account', state: 'verified' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: client.query };
  const data = createMuseConnectorData(pool);
  const snap = await data.snapshot(TROY);
  assert.equal(snap.presence[0].provider, 'claude');
  assert.equal(snap.connections[0].provider_id, 'claude');
  const health = assembleAgentHealth(snap, 'claude');
  assert.equal(health[0].toolAccounts[0].accountLabel, 'fixture-account');
  assert.ok(!JSON.stringify(health).includes('credential'), 'no credential-shaped field may appear');
});

// --- the memory data reader over a fake pg pool (real query shape) ---

test('createMuseConnectorData reads the shared notebook scoped to the key tenant only', async () => {
  // The fake table carries the scoping column the way the real one
  // does; the fake applies ONLY the filters the SQL itself states,
  // so a missing or widened WHERE would show up here as a leak.
  const table = [
    { id: 101, project_slug: TROY, key: 'dairy:staging-winner', value: { fact: 'winner' }, updated_at: new Date('2026-11-12T21:00:00Z') },
    { id: 201, project_slug: OTHER, key: 'dairy:staging-winner', value: { fact: 'tenant B' }, updated_at: new Date('2026-11-12T21:30:00Z') },
    { id: 301, project_slug: null, key: 'platform:shared', value: 'shared row', updated_at: new Date('2026-11-12T22:00:00Z') },
  ];
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql, params });
      if (!sql.includes('from helmion.context_entries')) throw new Error(`unexpected query: ${sql}`);
      let rows = table.filter((row) => row.project_slug === params[0]);
      if (sql.includes('ilike')) {
        const needle = String(params[1]).replace(/%/g, '').toLowerCase();
        rows = rows.filter((row) => row.key.toLowerCase().includes(needle) || JSON.stringify(row.value).toLowerCase().includes(needle));
      } else {
        rows = rows.filter((row) => row.id === params[1]);
      }
      return { rows: rows.map(({ project_slug, ...rest }) => rest), rowCount: rows.length };
    },
  };
  const data = createMuseConnectorData(pool);
  const found = await data.searchMemory(TROY, 'staging');
  assert.deepEqual(found.map((r) => r.id), [101], "only the key tenant's rows: no other tenant's, and no NULL-slug platform rows");
  const searchSql = seen[0].sql;
  assert.match(searchSql, /project_slug = \$1/);
  assert.ok(!/is null/i.test(searchSql), 'the connector read must not widen to the shared NULL rows');
  assert.match(searchSql, /limit 20/, 'the bound is enforced in the query itself');
  assert.equal(seen[0].params[0], TROY);
  const entry = await data.readMemory(TROY, 101);
  assert.equal(entry.key, 'dairy:staging-winner');
  assert.equal(await data.readMemory(TROY, 201), null, "another tenant's id reads as absent");
  assert.equal(await data.readMemory(TROY, 301), null, 'a platform row is not the tenant\'s to read through this door');
});

test('the memory reader escapes LIKE wildcards so a query stays literal text', async () => {
  const seen = [];
  const pool = { query: async (sql, params) => { seen.push(params); return { rows: [], rowCount: 0 }; } };
  const data = createMuseConnectorData(pool);
  await data.searchMemory(TROY, '50% off_sale!');
  assert.equal(seen[0][1], '%50!% off!_sale!!%', 'the caller\'s %, _ and ! are escaped under the ! escape character');
});

test('the memory reader fails soft to empty when the notebook table is missing', async () => {
  const missing = { query: async () => { const e = new Error('missing'); e.code = '42P01'; throw e; } };
  const data = createMuseConnectorData(missing);
  assert.deepEqual(await data.searchMemory(TROY, 'x'), []);
  assert.equal(await data.readMemory(TROY, 1), null);
});

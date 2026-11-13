// Muse connector tests (Bite 1): the /mcp endpoint's key auth, the
// read-only JSON-RPC surface, tenant fixing by the key row, the
// selector refusal, and the guarantee that no credential material —
// neither the connector key nor any stored credential reference —
// ever appears in an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MUSE_CONNECTOR_TOOLS,
  assembleAgentHealth,
  assembleAgents,
  createMuseConnectorData,
  createMuseConnectorKeyStore,
  createMuseConnectorRpc,
  handleMuseConnectorRoute,
  hashMuseConnectorKey,
  isMuseConnectorKeyShape,
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

function makeRpc() {
  const seenTenants = [];
  const rpc = createMuseConnectorRpc({
    data: {
      snapshot: async (tenantId) => { seenTenants.push(tenantId); return fixtureSnapshot(tenantId); },
    },
  });
  return { rpc, seenTenants };
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

test('tools/list returns exactly the two read tools, with no tenant parameter anywhere', async () => {
  const { rpc } = makeRpc();
  const { status, body } = await call(rpc, TROY, 'tools/list');
  assert.equal(status, 200);
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['list_agents', 'agent_health']);
  assert.deepEqual(body.result.tools, [...MUSE_CONNECTOR_TOOLS]);
  assert.ok(!JSON.stringify(body.result.tools).includes('tenant'), 'no tool may take a tenant parameter');
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

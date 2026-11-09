// Connector library — the MCP-prompts mechanism + Tool access
// writes (mirror-design §4 / §3.1, build bite M2):
//
//   - planPromptSnapshot validates and freezes a prompts/list
//     result into the menu's shape (sorted, hashed, duplicates
//     refused); promptDraftText builds the fill-in draft for a
//     prompt with required arguments, and the web face's copy of
//     that builder (connector-panel.mjs starterDraftText) words the
//     draft identically;
//   - the MCP client speaks streamable HTTP (initialize →
//     notifications/initialized → the call), reads JSON and SSE
//     answers, carries the person's token on the wire only, and
//     treats method-not-found as a SUPPORTED "no prompts" answer;
//   - the write route's prompts / prompts/get / tool-enable
//     actions: a mirror entry is refused (Helmian holds no sign-in
//     for it), an unconnected one is refused, a native without a
//     held credential says PROMPTS_NOT_HELD in so many words, a
//     connected one's token is resolved from the credential service
//     and reaches the server call — and never the response.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planPromptSnapshot, promptDraftText } from '../src/cloud/connector-library.mjs';
import { createMcpPromptsClient, renderPromptText } from '../src/cloud/connector-mcp-prompts.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { starterDraftText } from '../web/marketing/app/connector-panel.mjs';

class TenantAuthorizationError extends Error {}

// ------------------------------------------------------- snapshot plan

test('planPromptSnapshot: sorts by name, keeps only the descriptor fields, hashes stably', () => {
  const input = [
    { name: 'zeta', description: 'Last one', arguments: [{ name: 'topic', description: 'What about', required: true }, { name: 'tone', required: false }], extra: 'dropped' },
    { name: 'alpha', title: 'Alpha title' },
  ];
  const plan = planPromptSnapshot(input);
  assert.deepEqual(plan.prompts.map((p) => p.name), ['alpha', 'zeta']);
  assert.deepEqual(plan.prompts[0], { name: 'alpha', title: 'Alpha title', description: '', arguments: [] });
  assert.deepEqual(plan.prompts[1], {
    name: 'zeta', title: null, description: 'Last one',
    arguments: [
      { name: 'topic', description: 'What about', required: true },
      { name: 'tone', description: '', required: false },
    ],
  });
  assert.match(plan.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(planPromptSnapshot(input).snapshotHash, plan.snapshotHash, 'same input, same hash');
  const changed = planPromptSnapshot([{ name: 'alpha', title: 'Alpha title!' }]);
  assert.notEqual(changed.snapshotHash, planPromptSnapshot([{ name: 'alpha', title: 'Alpha title' }]).snapshotHash);
});

test('planPromptSnapshot: malformed lists are refused, never half-planned', () => {
  assert.throws(() => planPromptSnapshot('nope'), /array/);
  assert.throws(() => planPromptSnapshot([{ description: 'no name' }]), /no name/);
  assert.throws(() => planPromptSnapshot([{ name: 'a' }, { name: 'a' }]), /twice/);
  assert.throws(() => planPromptSnapshot([{ name: 'a', arguments: [{ description: 'nameless' }] }]), /no name/);
  assert.throws(() => planPromptSnapshot([null]), /not an object/);
});

test('promptDraftText: description heads the draft, one fill-in line per REQUIRED argument', () => {
  const prompt = {
    name: 'draft-post', title: 'Draft a post', description: 'Draft a post about the given topic',
    arguments: [
      { name: 'topic', description: '', required: true },
      { name: 'tone', description: '', required: false },
    ],
  };
  assert.equal(promptDraftText(prompt), 'Draft a post about the given topic\ntopic: ');
  assert.equal(promptDraftText({ name: 'bare', arguments: [] }), 'bare');
  assert.equal(promptDraftText({}), 'Use this starter:');
  // The web face's copy words the same draft (connector-panel.mjs):
  assert.equal(starterDraftText(prompt), promptDraftText(prompt));
});

// ---------------------------------------------------------- MCP client

function rpcResponse(body, { contentType = 'application/json', sessionId = null, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? contentType
        : name.toLowerCase() === 'mcp-session-id' ? sessionId : null),
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeMcpServer({ listResult, getResult, listError = null, sse = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, payload });
    if (payload.method === 'initialize') {
      return rpcResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, { sessionId: 'sess-1' });
    }
    if (payload.method === 'notifications/initialized') return rpcResponse('', { status: 202 });
    if (payload.method === 'prompts/list') {
      if (listError) return rpcResponse({ jsonrpc: '2.0', id: 1, error: listError });
      const body = { jsonrpc: '2.0', id: 1, result: { prompts: listResult } };
      if (sse) return rpcResponse(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { contentType: 'text/event-stream' });
      return rpcResponse(body);
    }
    if (payload.method === 'prompts/get') {
      if (getResult?.error) return rpcResponse({ jsonrpc: '2.0', id: 1, error: getResult.error });
      return rpcResponse({ jsonrpc: '2.0', id: 1, result: getResult });
    }
    throw new Error(`unexpected method ${payload.method}`);
  };
  return { calls, fetchImpl };
}

test('mcp client: initialize rides first, the token rides every call, the session id propagates', async () => {
  const server = fakeMcpServer({ listResult: [{ name: 'kickoff', title: 'Kickoff' }] });
  const client = createMcpPromptsClient({ fetchImpl: server.fetchImpl });
  const out = await client.listPrompts({ endpoint: 'https://mcp.example.com/mcp', accessToken: 'tok-1' });
  assert.deepEqual(out, { supported: true, prompts: [{ name: 'kickoff', title: 'Kickoff' }] });
  assert.deepEqual(server.calls.map((c) => c.payload.method), ['initialize', 'notifications/initialized', 'prompts/list']);
  assert.equal(server.calls[0].payload.params.protocolVersion, '2025-03-26');
  for (const call of server.calls) assert.equal(call.headers.authorization, 'Bearer tok-1', 'the token is on the wire, every call');
  assert.equal(server.calls[2].headers['mcp-session-id'], 'sess-1', 'the initialize session rides the real call');
});

test('mcp client: an SSE answer is read the same as JSON; no token means no authorization header', async () => {
  const server = fakeMcpServer({ listResult: [{ name: 'a' }], sse: true });
  const client = createMcpPromptsClient({ fetchImpl: server.fetchImpl });
  const out = await client.listPrompts({ endpoint: 'https://mcp.example.com/mcp', accessToken: null });
  assert.deepEqual(out, { supported: true, prompts: [{ name: 'a' }] });
  assert.equal(server.calls[2].headers.authorization, undefined);
});

test('mcp client: method-not-found is a supported "no prompts" answer, not an error', async () => {
  const server = fakeMcpServer({ listError: { code: -32601, message: 'Method not found' } });
  const client = createMcpPromptsClient({ fetchImpl: server.fetchImpl });
  assert.deepEqual(await client.listPrompts({ endpoint: 'https://mcp.example.com/mcp' }), { supported: false, prompts: [] });
  const getServer = fakeMcpServer({ getResult: { error: { code: -32601, message: 'Method not found' } } });
  const getClient = createMcpPromptsClient({ fetchImpl: getServer.fetchImpl });
  await assert.rejects(() => getClient.getPrompt({ endpoint: 'https://mcp.example.com/mcp', name: 'x' }), (e) => e.code === 'PROMPTS_UNSUPPORTED');
});

test('mcp client: server failures are status-coded, never swallowed', async () => {
  const down = createMcpPromptsClient({ fetchImpl: async () => { throw new Error('socket gone'); } });
  await assert.rejects(() => down.listPrompts({ endpoint: 'https://mcp.example.com/mcp' }), (e) => e.status === 502 && e.code === 'PROMPTS_UNREACHABLE');
  const http500 = createMcpPromptsClient({
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      if (payload.method === 'initialize') return rpcResponse({ jsonrpc: '2.0', id: 1, result: {} });
      if (payload.method === 'notifications/initialized') return rpcResponse('', { status: 202 });
      return rpcResponse('nope', { status: 500 });
    },
  });
  await assert.rejects(() => http500.listPrompts({ endpoint: 'https://mcp.example.com/mcp' }), (e) => e.code === 'PROMPTS_LIST_FAILED');
  const refused = fakeMcpServer({ listError: { code: -32000, message: 'no' } });
  await assert.rejects(
    () => createMcpPromptsClient({ fetchImpl: refused.fetchImpl }).listPrompts({ endpoint: 'https://mcp.example.com/mcp' }),
    (e) => e.code === 'PROMPTS_LIST_FAILED',
  );
});

test('renderPromptText: text parts in order, blank-line joined; non-text parts skipped', async () => {
  const server = fakeMcpServer({
    getResult: {
      description: 'A rendered starter',
      messages: [
        { role: 'user', content: { type: 'text', text: 'First part' } },
        { role: 'user', content: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: 'Second part' }] },
      ],
    },
  });
  const client = createMcpPromptsClient({ fetchImpl: server.fetchImpl });
  const result = await client.getPrompt({ endpoint: 'https://mcp.example.com/mcp', name: 'kickoff', args: {} });
  assert.equal(renderPromptText(result), 'First part\n\nSecond part');
  assert.equal(renderPromptText(null), '');
  assert.equal(renderPromptText({ messages: [] }), '');
});

// ---------------------------------------------------------- write route

const OWNER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const AUDITOR = { subject: 'user:aud', tenantId: 'tenant-a', role: 'auditor' };

const CUSTOM = (over = {}) => ({
  seatId: 'claude', id: 'custom-mcp', kind: 'custom', brokerMode: 'helmian',
  authMode: 'header', state: 'available', mcpEndpointUrl: 'https://mcp.example.com/mcp', ...over,
});

function fakeStore({ entry = null, connection = null } = {}) {
  const calls = [];
  return {
    calls,
    async getEntry(tenantId, seatId, entryId) { calls.push(['getEntry', seatId, entryId]); return entry; },
    async getConnection(tenantId, key) { calls.push(['getConnection', key]); return connection; },
    async setToolEnableMap(tenantId, key, map, subject) { calls.push(['setToolEnableMap', key, map, subject]); return { ...key, state: 'connected', toolEnableMap: map }; },
  };
}

function fakeCredentials(credential = 'the-key-itself') {
  const calls = [];
  return {
    calls,
    async resolveVaultCredential(input) { calls.push(['resolveVaultCredential', input]); return { accepted: true, credential }; },
  };
}

function fakePromptsClient({ listOut = { supported: true, prompts: [{ name: 'kickoff', title: 'Kickoff' }] }, getOut = null } = {}) {
  const calls = [];
  return {
    calls,
    async listPrompts(input) { calls.push(['listPrompts', input]); return listOut; },
    async getPrompt(input) {
      calls.push(['getPrompt', input]);
      return getOut ?? { description: 'd', messages: [{ role: 'user', content: { type: 'text', text: 'Rendered draft text' } }] };
    },
  };
}

function harness({ actor = OWNER, store, credentials, promptsClient } = {}) {
  const handler = createConnectorLibraryWriteHandler({
    store: store ?? fakeStore({}),
    pendingStore: { async save() { return true; }, async take() { return null; } },
    credentialClient: credentials ?? fakeCredentials(),
    doorOAuth: { async registerClient() { return { clientId: 'c' }; }, async authorizeUrl() { return 'https://x'; }, async exchangeCode() { return {}; } },
    promptsClient: promptsClient ?? fakePromptsClient(),
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const sent = [];
  return {
    sent,
    async run(path, { method = 'POST', body = {} } = {}) {
      const handled = await handler({
        request: { method },
        response: {},
        requestUrl: new URL(path, 'https://helmian.cloud'),
        activeTenantActor: async () => actor,
        send: (response, status, payload) => { sent.push({ status, payload }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? ''); } catch { /* not json */ }
      return { handled, status: last?.status, json, raw: last?.payload ?? '' };
    },
  };
}

const P = '/api/admin/connector-library';
const connectedWithRef = { state: 'connected', accessTokenRef: 'vault-ref-1', toolEnableMap: {} };

test('prompts: a mirror (vendor) entry is refused — Helmian holds no sign-in for it', async () => {
  const promptsClient = fakePromptsClient();
  const h = harness({ store: fakeStore({ entry: CUSTOM({ brokerMode: 'vendor' }) }), promptsClient });
  const out = await h.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'VENDOR_MANAGED');
  assert.equal(promptsClient.calls.length, 0, 'the server is never called for a mirror');
});

test('prompts: missing entry 404s; turned-off, unconnected, and needs-reconnect are refused in words', async () => {
  const missing = harness({ store: fakeStore({ entry: null }) });
  assert.equal((await missing.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'nope' } })).status, 404);
  const off = harness({ store: fakeStore({ entry: CUSTOM({ state: 'disabled-by-owner' }), connection: connectedWithRef }) });
  assert.equal((await off.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } })).status, 409);
  const unconnected = harness({ store: fakeStore({ entry: CUSTOM(), connection: null }) });
  const un = await unconnected.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(un.status, 409);
  assert.equal(un.json.code, 'NOT_CONNECTED');
  const stale = harness({ store: fakeStore({ entry: CUSTOM(), connection: { state: 'needs-reconnect', accessTokenRef: 'r' } }) });
  const st = await stale.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(st.status, 409);
  assert.equal(st.json.code, 'NOT_CONNECTED');
});

test('prompts: a Helmian native with no held connection says PROMPTS_NOT_HELD, never NOT_CONNECTED', async () => {
  const native = CUSTOM({ id: 'helmian-github', kind: 'helmian-native', authMode: 'oauth' });
  const h = harness({ store: fakeStore({ entry: native, connection: null }) });
  const out = await h.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'PROMPTS_NOT_HELD');
});

test('prompts: the connected person\u2019s token is resolved for the server call — and never reaches the response', async () => {
  const credentials = fakeCredentials('the-key-itself');
  const promptsClient = fakePromptsClient();
  const h = harness({ store: fakeStore({ entry: CUSTOM(), connection: connectedWithRef }), credentials, promptsClient });
  const out = await h.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.supported, true);
  assert.deepEqual(out.json.prompts.map((p) => p.name), ['kickoff']);
  assert.match(out.json.snapshotHash, /^[0-9a-f]{64}$/);
  const resolve = credentials.calls.find((c) => c[0] === 'resolveVaultCredential');
  assert.equal(resolve[1].credentialReference, 'vault-ref-1');
  assert.equal(resolve[1].reasonClass, 'provider_call');
  assert.equal(promptsClient.calls[0][1].accessToken, 'the-key-itself', 'the resolved token rides the server call');
  assert.equal(promptsClient.calls[0][1].endpoint, 'https://mcp.example.com/mcp');
  assert.ok(!out.raw.includes('the-key-itself'), 'the token never appears in the route\u2019s answer');
});

test('prompts: an authMode none connection lists with no token; an unsupported server answers supported:false', async () => {
  const promptsClient = fakePromptsClient({ listOut: { supported: false, prompts: [] } });
  const h = harness({
    store: fakeStore({ entry: CUSTOM({ authMode: 'none' }), connection: { state: 'connected', accessTokenRef: null } }),
    promptsClient,
  });
  const out = await h.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.supported, false);
  assert.match(out.json.note, /publishes no starter prompts/);
  assert.equal(promptsClient.calls[0][1].accessToken, null);
});

test('prompts/get: renders the server\u2019s text as the draft; arguments must be text', async () => {
  const promptsClient = fakePromptsClient();
  const h = harness({ store: fakeStore({ entry: CUSTOM(), connection: connectedWithRef }), promptsClient });
  const out = await h.run(`${P}/prompts/get`, { body: { seatId: 'claude', entryId: 'custom-mcp', name: 'kickoff', arguments: { topic: 'milk prices' } } });
  assert.equal(out.status, 200);
  assert.equal(out.json.text, 'Rendered draft text');
  assert.deepEqual(promptsClient.calls[0][1].args, { topic: 'milk prices' });
  const bad = await h.run(`${P}/prompts/get`, { body: { seatId: 'claude', entryId: 'custom-mcp', name: 'kickoff', arguments: { topic: 42 } } });
  assert.equal(bad.status, 400, 'a non-text argument is refused — arguments seed a draft, nothing more');
  const noName = await h.run(`${P}/prompts/get`, { body: { seatId: 'claude', entryId: 'custom-mcp' } });
  assert.equal(noName.status, 400);
});

test('tool-enable: the map passes to the store against the frozen snapshot; bad shapes and credential values are refused', async () => {
  const store = fakeStore({ entry: CUSTOM(), connection: connectedWithRef });
  const h = harness({ store });
  const out = await h.run(`${P}/tool-enable`, { body: { seatId: 'claude', entryId: 'custom-mcp', toolEnableMap: { search: false } } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'tool-map-set');
  const call = store.calls.find((c) => c[0] === 'setToolEnableMap');
  assert.deepEqual(call[2], { search: false });
  assert.equal((await h.run(`${P}/tool-enable`, { body: { seatId: 'claude', entryId: 'custom-mcp', toolEnableMap: 'all' } })).status, 400);
  assert.equal((await h.run(`${P}/tool-enable`, { body: { seatId: 'claude', entryId: 'custom-mcp', toolEnableMap: {}, apiKey: 'sk-live' } })).status, 400, 'a credential value in the body is refused on this road too');
});

test('prompts gating: auditors never list starters', async () => {
  const h = harness({ actor: AUDITOR, store: fakeStore({ entry: CUSTOM(), connection: connectedWithRef }) });
  assert.equal((await h.run(`${P}/prompts`, { body: { seatId: 'claude', entryId: 'custom-mcp' } })).status, 403);
});

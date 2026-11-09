// Connectors bite 4R2 — the Claude Pattern-A hand-off, end to end on
// fakes: catalog data model (a native OAuth entry the library can
// hold token refs for), toggle consumption in attachments.mjs
// (armed resolution + arm-state
// honesty), the adapter change in providers.mjs (armed request shape;
// UNARMED REQUEST BYTE-IDENTICAL to the pre-connector request), MCP
// evidence capture, and loop threading (servers carried separately,
// evidence into the turn record).
//
// fetch is stubbed throughout; nothing here touches the network, the
// live door, or a real Anthropic key. The live gate — a real Anthropic
// response carrying the Scribe MCP blocks — is UNVERIFIED by design
// and runs after the human consent step + push (see BUILD-REPORT.md).
//
// The Scribe door module tests that once lived in this file (door
// client, minter, vault resolver, arming composition) were removed
// with src/agent/scribe-door.mjs itself in the dead-module deletion
// (2026-11-09); the armed fixtures below keep the JWT-shaped fake as
// their token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogEntryById, LIVE_SEATS } from '../src/cloud/connector-catalog.mjs';
import { createConnectorLibraryStore, buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { resolveTurnAttachments } from '../src/agent/attachments.mjs';
import { chatWithTools, ANTHROPIC_MCP_BETA } from '../src/agent/providers.mjs';
import { runAgentTurn } from '../src/agent/loop.mjs';
import { makeProvenanceWorkspace, cleanProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// A JWT-shaped fake door token: three base64url segments, so the
// redaction-ordering pin below is real — redactSecrets replaces this
// shape with [REDACTED] wherever it sees it in a serialized body.
const FAKE_DOOR_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJydW5uZXIiLCJzY29wZSI6Im1lbW9yeS5yZWFkIn0.fakesignaturepart0123456789';

// The surviving native entry's endpoint (connector-catalog.mjs) —
// the Pattern-A armed server in the toggle/adapter fixtures below.
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

// ------------------------------------------------------------ fetch stub
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const jsonResponse = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(obj); },
});

// ============================================================ data model

test('catalog: helmian-github is an oauth entry on every seat, endpoint unchanged; helmian-scribe is gone', () => {
  for (const seatId of LIVE_SEATS) {
    const entry = catalogEntryById(seatId, 'helmian-github');
    assert.equal(entry.authMode, 'oauth', `${seatId}: github authMode`);
    assert.equal(entry.brokerMode, 'helmian');
    assert.equal(entry.mcpEndpointUrl, GITHUB_MCP_URL);
    assert.ok(entry.scopesSummary, `${seatId}: scopes summary present`);
    // The Scribe cut (2026-11-09): the entry exists on no seat.
    assert.equal(catalogEntryById(seatId, 'helmian-scribe'), null, `${seatId}: scribe entry cut`);
  }
  // The other genuinely-public entry keeps its 'none': Cloudflare's
  // docs server takes no sign-in.
  assert.equal(catalogEntryById('cloudflare', 'cloudflare-docs').authMode, 'none');
});

// A compact fake pool for the library store: entries + connections
// only, shaped like test/connector-library.test.mjs's established fake.
function fakeLibraryPool() {
  const entries = new Map();
  const connections = new Map();
  let tenant = null;
  let connSeq = 0;
  const now = () => new Date();
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (text.includes('insert into helmion.connector_entries')) {
            const [seatId, id, kind, name, oneLiner, iconRef, vendorName, trustLabel, category,
              brokerMode, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary,
              addedBy, workspaceProvisioned] = vals;
            const row = {
              tenant_id: tenant, seat_id: seatId, id, kind, name, one_liner: oneLiner,
              icon_ref: iconRef, vendor_name: vendorName, trust_label: trustLabel, category,
              broker_mode: brokerMode, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              added_by: addedBy, added_at: now(), workspace_provisioned: workspaceProvisioned,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            const [, , name, oneLiner, iconRef, vendorName, trustLabel, category, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary, workspaceProvisioned] = vals;
            Object.assign(row, {
              name, one_liner: oneLiner, icon_ref: iconRef, vendor_name: vendorName,
              trust_label: trustLabel, category, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              workspace_provisioned: workspaceProvisioned, updated_at: now(),
            });
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('insert into helmion.connector_connections')) {
            const [personId, seatId, entryId, accountIdentity, accessRef, refreshRef, scopesJson, posture] = vals;
            const row = {
              id: ++connSeq, tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId,
              account_identity: accountIdentity, access_token_ref: accessRef, refresh_token_ref: refreshRef,
              granted_scopes: JSON.parse(scopesJson), posture, tool_enable_map: {}, tool_snapshot_ref: null,
              state: 'connected', last_discovery_at: null, last_used_at: null,
              created_at: now(), updated_at: now(),
            };
            connections.set(connKey(personId, seatId, entryId), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`unexpected query: ${text.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

test('library: a native oauth connection holds access + refresh token refs; the catalog refresh carries the flip', async () => {
  const TENANT = 'tenant-a';
  const PERSON = 'user:troy';
  const store = createConnectorLibraryStore(fakeLibraryPool());

  // The stored legacy record: authMode 'none', as seeded before this
  // bite. A connection with token refs is refused under it — the 4R
  // step-0 blocker, reproduced at the store.
  const legacy = { ...catalogEntryById('claude', 'helmian-github'), authMode: 'none' };
  await store.createEntry(TENANT, PERSON, legacy);
  const accessRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-github', personId: PERSON, tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-github', personId: PERSON, tokenKind: 'refresh' });
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: PERSON, seatId: 'claude', entryId: 'helmian-github',
      accountIdentity: 'Troy (native oauth)', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    }),
    /no tokens to reference/,
  );

  // The catalog refresh re-creates the entry from the corrected
  // catalog data — its update path writes auth_mode — and the same
  // connection now lands, holding both refs like any oauth entry.
  const refreshed = await store.createEntry(TENANT, PERSON, catalogEntryById('claude', 'helmian-github'));
  assert.equal(refreshed.authMode, 'oauth');
  const connection = await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-github',
    accountIdentity: 'Troy (native oauth)', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    grantedScopes: ['repo.read', 'repo.write'],
  });
  assert.equal(connection.accessTokenRef, accessRef);
  assert.equal(connection.refreshTokenRef, refreshRef);
  assert.equal(connection.state, 'connected');
  const readBack = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(readBack.refreshTokenRef, refreshRef);

  // And the oauth branch's discipline applies to this entry too: no
  // access ref, no connection.
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: 'user:other', seatId: 'claude', entryId: 'helmian-github',
      accountIdentity: 'No Ref', refreshTokenRef: refreshRef,
    }),
    /accessTokenRef is required/,
  );

  // A true 'none' entry still refuses refs — the discipline follows
  // the auth mode, not the entry.
  await store.createEntry(TENANT, PERSON, {
    seatId: 'claude', id: 'open-tools', kind: 'custom', name: 'Open Tools', oneLiner: 'No sign-in tools',
    vendorName: 'Example', brokerMode: 'helmian', mcpEndpointUrl: 'https://open.example.com/mcp',
    authMode: 'none', addedBy: PERSON,
  });
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: PERSON, seatId: 'claude', entryId: 'open-tools',
      accountIdentity: 'X', accessTokenRef: accessRef,
    }),
    /no tokens to reference/,
  );
});

// ======================================================= toggle consumption

const NATIVE_TOGGLE = { connectors: [{ seatId: 'claude', entryId: 'helmian-github' }] };
const armingOk = {
  connectionFor: async () => ({ state: 'connected', refreshTokenRef: 'vault://tenant/t/connector.claude.helmian-github/p-x.refresh' }),
  mintAccessToken: async () => ({ ok: true, accessToken: FAKE_DOOR_JWT }),
};

test('attachments: no toggles — nothing armed, nothing recorded', async () => {
  const bare = await resolveTurnAttachments({ metadata: null, providerId: 'anthropic', connectorArming: armingOk });
  assert.deepEqual(bare.mcpServers, []);
  assert.deepEqual(bare.connectorOutcomes, []);
  const empty = await resolveTurnAttachments({ metadata: { webSearch: false }, providerId: 'anthropic', connectorArming: armingOk });
  assert.deepEqual(empty.mcpServers, []);
  assert.deepEqual(empty.connectorOutcomes, []);
});

test('attachments: an armed native toggle produces the Pattern-A server, outside the local tools', async () => {
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: armingOk });
  assert.deepEqual(resolved.mcpServers, [{
    entryId: 'helmian-github',
    name: 'helmian-github',
    url: GITHUB_MCP_URL,
    authorizationToken: FAKE_DOOR_JWT,
  }]);
  // Never a local tool: the local catalog is untouched by arming.
  assert.deepEqual(resolved.toolNames, []);
  assert.deepEqual(resolved.connectorOutcomes, [{ seatId: 'claude', entryId: 'helmian-github', armed: true }]);
  assert.match(resolved.contextText, /handed to Anthropic's cloud for this turn/);
});

test('attachments: another seat\'s toggle is not this turn\'s business', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'grok', entryId: 'helmian-github' }] },
    providerId: 'anthropic',
    connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.deepEqual(resolved.connectorOutcomes, []);
});

test('attachments: toggle-off by absence of the seam — nothing arms, and it says so', async () => {
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: null });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes.length, 1);
  assert.equal(resolved.connectorOutcomes[0].armed, false);
  assert.equal(resolved.connectorOutcomes[0].reason, 'arming-not-wired');
  assert.match(resolved.contextText, /NOT armed for this turn/);
});

test('attachments: a non-Claude seat records the toggle unarmed (no Pattern-A path yet)', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'chatgpt', entryId: 'helmian-github' }] },
    providerId: 'openai',
    connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes[0].armed, false);
  assert.equal(resolved.connectorOutcomes[0].reason, 'pattern-a-unavailable');
});

test('attachments: a subscription (CLI) turn cannot arm', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE, providerId: 'anthropic', credentialType: 'cli', connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes[0].reason, 'cli-turn');
});

test('attachments: a vendor-brokered entry never arms through Helmian', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'claude', entryId: 'gmail' }] },
    providerId: 'anthropic',
    connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes[0].reason, 'vendor-brokered');
});

test('attachments: not connected, and needs-reconnect, both record unarmed', async () => {
  const notConnected = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE, providerId: 'anthropic',
    connectorArming: { connectionFor: async () => null, mintAccessToken: armingOk.mintAccessToken },
  });
  assert.equal(notConnected.connectorOutcomes[0].reason, 'not-connected');
  const stale = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE, providerId: 'anthropic',
    connectorArming: { connectionFor: async () => ({ state: 'needs-reconnect', refreshTokenRef: null }), mintAccessToken: armingOk.mintAccessToken },
  });
  assert.deepEqual(stale.mcpServers, []);
  assert.equal(stale.connectorOutcomes[0].reason, 'connection-needs-reconnect');
});

test('attachments: REFRESH FAILURE = unarmed + recorded, never a fake arm', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE,
    providerId: 'anthropic',
    connectorArming: {
      connectionFor: armingOk.connectionFor,
      mintAccessToken: async () => ({ ok: false, code: 'invalid_grant', reason: 'The renewal key is no longer valid.' }),
    },
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes.length, 1);
  const outcome = resolved.connectorOutcomes[0];
  assert.equal(outcome.armed, false);
  assert.equal(outcome.reason, 'invalid_grant');
  assert.match(outcome.detail, /no longer valid/);
  assert.match(resolved.contextText, /NOT connected for this turn/);
});

// ============================================================ the adapter

const ANTHROPIC_TEXT_REPLY = { content: [{ type: 'text', text: 'hello back' }] };

async function anthropicTurnCapture(args) {
  const workspace = makeProvenanceWorkspace('helmion-arming-prov-');
  const { calls, restore } = stubFetch(async () => jsonResponse(200, args.reply ?? ANTHROPIC_TEXT_REPLY));
  try {
    const reply = await chatWithTools({
      providerId: 'anthropic',
      apiKey: 'test-anthropic-key',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
      toolDefs: args.toolDefs ?? [],
      provenance: { workspace },
      ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
      ...(args.webSearch ? { webSearch: true } : {}),
    });
    return { reply, calls };
  } finally {
    restore();
    cleanProvenanceWorkspace(workspace);
  }
}

test('adapter: an UNARMED anthropic request is byte-identical to the pre-connector request', async () => {
  const { calls } = await anthropicTurnCapture({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  // Exactly the legacy header set — no beta header leaks into unarmed turns.
  assert.deepEqual(calls[0].init.headers, {
    'x-api-key': 'test-anthropic-key',
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  });
  // The exact legacy body bytes: key order and content unchanged.
  assert.equal(
    calls[0].init.body,
    JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, messages: [{ role: 'user', content: 'hello' }] }),
  );
  assert.ok(!calls[0].init.body.includes('mcp_servers'));
});

test('adapter: an unarmed request WITH function tools is also byte-identical', async () => {
  const toolDefs = [{
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  }];
  const { calls } = await anthropicTurnCapture({ toolDefs });
  const expected = JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.equal(calls[0].init.body, expected);
  assert.equal(calls[0].init.headers['anthropic-beta'], undefined);
});

test('adapter: an ARMED request carries mcp_servers + mcp_toolset + the beta header, token intact', async () => {
  const { calls } = await anthropicTurnCapture({
    mcpServers: [{ entryId: 'helmian-github', name: 'helmian-github', url: GITHUB_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['anthropic-beta'], ANTHROPIC_MCP_BETA);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.mcp_servers, [{
    type: 'url',
    url: GITHUB_MCP_URL,
    name: 'helmian-github',
    // INTACT — not [REDACTED]. The token is attached after the
    // redaction pass precisely so this holds; if the ordering ever
    // regresses, this assertion is the one that catches it.
    authorization_token: FAKE_DOOR_JWT,
  }]);
  assert.deepEqual(body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'helmian-github' }]);
});

test('adapter: armed beside function tools and web search, both survive', async () => {
  const toolDefs = [{
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  }];
  const { calls } = await anthropicTurnCapture({
    toolDefs,
    webSearch: true,
    mcpServers: [{ name: 'helmian-github', url: GITHUB_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
  });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    body.tools.map((t) => t.type ?? t.name),
    ['read_file', 'web_search_20250305', 'mcp_toolset'],
  );
  assert.equal(body.mcp_servers.length, 1);
});

test('adapter: MCP response blocks are captured as evidence, never as local tool calls', async () => {
  const reply = {
    content: [
      { type: 'text', text: 'I searched the shared memory.' },
      { type: 'mcp_tool_use', id: 'mcp-1', name: 'search_memory', server_name: 'helmian-github', input: { query: 'Bryce' } },
      { type: 'mcp_tool_result', tool_use_id: 'mcp-1', is_error: false, content: [{ type: 'text', text: 'three messages found' }] },
    ],
  };
  const { reply: out } = await anthropicTurnCapture({
    reply,
    mcpServers: [{ name: 'helmian-github', url: GITHUB_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
  });
  assert.equal(out.content, 'I searched the shared memory.');
  assert.deepEqual(out.toolCalls, []);
  assert.deepEqual(out.mcpToolCalls, [{
    id: 'mcp-1', name: 'search_memory', serverName: 'helmian-github', input: { query: 'Bryce' },
  }]);
  assert.deepEqual(out.mcpToolResults, [{
    toolUseId: 'mcp-1', isError: false, content: 'three messages found',
  }]);
});

test('adapter: web-search server blocks are still NOT collected anywhere', async () => {
  const reply = {
    content: [
      { type: 'text', text: 'answer' },
      { type: 'server_tool_use', id: 'ws-1', name: 'web_search', input: { query: 'news' } },
      { type: 'web_search_tool_result', tool_use_id: 'ws-1', content: [] },
    ],
  };
  const { reply: out } = await anthropicTurnCapture({ reply, webSearch: true });
  assert.deepEqual(out.toolCalls, []);
  assert.equal(out.mcpToolCalls, undefined);
  assert.equal(out.mcpToolResults, undefined);
});

// ============================================================ loop threading

function stubRuntime(root) {
  return {
    root,
    permissionMode: 'read-only',
    tools: {},
    definitionsForOpenAi: () => [],
    execute: async () => { throw new Error('the local runtime must never execute a Pattern-A call'); },
  };
}

test('loop: armed servers ride beside the tools and MCP evidence lands in the turn record', async () => {
  const workspace = makeProvenanceWorkspace('helmion-arming-loop-');
  const mcpReply = {
    content: [
      { type: 'text', text: 'Found it in the shared memory.' },
      { type: 'mcp_tool_use', id: 'mcp-1', name: 'search_memory', server_name: 'helmian-github', input: { query: 'Bryce' } },
      { type: 'mcp_tool_result', tool_use_id: 'mcp-1', is_error: false, content: [{ type: 'text', text: 'three messages found' }] },
    ],
  };
  const { calls, restore } = stubFetch(async () => jsonResponse(200, mcpReply));
  const events = [];
  try {
    const result = await runAgentTurn({
      userText: 'what did we say about Bryce?',
      messages: [{ role: 'system', content: 'You are a test seat.' }],
      provider: { id: 'anthropic', key: 'test-anthropic-key', label: 'Claude' },
      runtime: stubRuntime(workspace),
      mcpServers: [{ entryId: 'helmian-github', name: 'helmian-github', url: GITHUB_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(result.text, 'Found it in the shared memory.');
    // The wire: mcp_servers present, and the ONLY tool declared is the
    // toolset — no local function tools were invented for the server.
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.mcp_servers[0].name, 'helmian-github');
    assert.deepEqual(body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'helmian-github' }]);
    // The turn record: one evidence entry, round 0, naming the call
    // and its result; the same evidence was announced as an event.
    assert.equal(result.mcpEvidence.length, 1);
    assert.equal(result.mcpEvidence[0].round, 0);
    assert.equal(result.mcpEvidence[0].calls[0].name, 'search_memory');
    assert.equal(result.mcpEvidence[0].results[0].content, 'three messages found');
    const announced = events.filter((ev) => ev.type === 'mcp_evidence');
    assert.equal(announced.length, 1);
    assert.equal(announced[0].calls[0].serverName, 'helmian-github');
  } finally {
    restore();
    cleanProvenanceWorkspace(workspace);
  }
});

test('loop: an unarmed turn sends no MCP parameter and records no evidence', async () => {
  const workspace = makeProvenanceWorkspace('helmion-arming-loop-');
  const { calls, restore } = stubFetch(async () => jsonResponse(200, ANTHROPIC_TEXT_REPLY));
  try {
    const result = await runAgentTurn({
      userText: 'hello',
      messages: [{ role: 'system', content: 'You are a test seat.' }],
      provider: { id: 'anthropic', key: 'test-anthropic-key', label: 'Claude' },
      runtime: stubRuntime(workspace),
    });
    assert.equal(result.text, 'hello back');
    assert.equal(result.mcpEvidence, undefined);
    assert.ok(!calls[0].init.body.includes('mcp'));
    assert.equal(calls[0].init.headers['anthropic-beta'], undefined);
  } finally {
    restore();
    cleanProvenanceWorkspace(workspace);
  }
});

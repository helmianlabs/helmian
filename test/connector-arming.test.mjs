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
//
// The G4 sections (Mirror M3) cover the runner-hosted road end to
// end on fakes: dispatch resolution (connector-arming-dispatch.mjs)
// building arming records, the seam those records build
// (connector-arming.mjs), and attachments.mjs running an armed
// connector's tools itself — snapshot reconciliation, the enable
// map, and the posture gate. The remote MCP client is a fake
// factory; nothing here touches the network. The live gate — a real
// GitHub turn through a real dispatch — is named in the bite's
// BUILD-REPORT.md and runs after the push.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogEntryById, LIVE_SEATS } from '../src/cloud/connector-catalog.mjs';
import { createConnectorLibraryStore, buildConnectorTokenRef, planToolSnapshot } from '../src/cloud/connector-library.mjs';
import { resolveTurnAttachments, postureRequiresApproval } from '../src/agent/attachments.mjs';
import { buildConnectorArming, sanitizeArmingRecords } from '../src/agent/connector-arming.mjs';
import { armingPairsForDispatch, resolveArmingRecord, resolveDispatchArming } from '../src/cloud/connector-arming-dispatch.mjs';
import { createConnectorOAuthClient } from '../src/cloud/connector-oauth-pending.mjs';
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

// ================================================================
// G4: dispatch resolution — pairs and arming records.
// ================================================================

const GH_TOOLS = [
  { name: 'get_repo', description: 'Read a repository', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_repo', description: 'Delete a repository', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'mystery_tool', description: 'Undeclared', inputSchema: { type: 'object', properties: {} } },
];
const GH_PLAN = planToolSnapshot(GH_TOOLS);
const GH_ENTRY = { seatId: 'claude', id: 'helmian-github', kind: 'helmian-native', name: 'GitHub', vendorName: 'GitHub', brokerMode: 'helmian', mcpEndpointUrl: GITHUB_MCP_URL, authMode: 'oauth', state: 'available' };
const GH_CONNECTION = { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', accountIdentity: 'troy-gh', accessTokenRef: 'vault://tenant/t/connector.claude.helmian-github/p-x.access', refreshTokenRef: null, grantedScopes: [], posture: 'read', toolEnableMap: { get_repo: true }, toolSnapshotRef: 5, state: 'connected' };
const GH_SNAPSHOT = { id: 5, connectionId: 1, takenAt: null, tools: GH_PLAN.tools, snapshotHash: GH_PLAN.snapshotHash };
const CREDS_OK = { resolveVaultCredential: async () => ({ accepted: true, credential: { accessToken: 'tok-connection' } }) };
const NO_LIST = async () => { throw new Error('listTools must not be called'); };

function fakeArmingStore({ entry = null, connection = null, snapshot = null } = {}) {
  const state = { entry, connection, snapshot, freezes: [] };
  return {
    state,
    async getEntry() { return state.entry; },
    async getConnection() { return state.connection; },
    async getCurrentSnapshot() { return state.snapshot; },
    async freezeSnapshot(tenantId, key, tools) {
      state.freezes.push(tools);
      const plan = planToolSnapshot(tools);
      state.snapshot = { id: 9, connectionId: 1, takenAt: null, tools: plan.tools, snapshotHash: plan.snapshotHash };
      state.connection = { ...state.connection, toolEnableMap: Object.fromEntries(plan.tools.map((t) => [t.name, true])) };
      return state.snapshot;
    },
  };
}

test('g4 dispatch: pairs are the union of the channel set and the message toggles, filtered to due seats', () => {
  const pairs = armingPairsForDispatch({
    armedConnectors: [
      { seatId: 'claude', entryId: 'helmian-github' },
      { seatId: 'grok', entryId: 'helmian-github' }, // grok is not due
      { seatId: 'chatgpt', entryId: 'helmian-github' },
    ],
    messageConnectors: [
      { seatId: 'claude', entryId: 'helmian-github' }, // duplicate of the channel set
      { seatId: 'chatgpt', entryId: 'some-other-entry' },
    ],
    dueProviders: ['claude', 'openai'], // mesh vocabulary: openai is the chatgpt seat
  });
  assert.deepEqual(pairs, [
    { seatId: 'claude', entryId: 'helmian-github' },
    { seatId: 'chatgpt', entryId: 'helmian-github' },
    { seatId: 'chatgpt', entryId: 'some-other-entry' },
  ]);
  // A custom agent due on the claude engine resolves the claude seat's pairs.
  assert.deepEqual(armingPairsForDispatch({
    armedConnectors: [{ seatId: 'claude', entryId: 'helmian-github' }],
    dueProviders: ['coder'],
    customAgents: [{ handle: 'coder', provider: 'claude' }],
  }), [{ seatId: 'claude', entryId: 'helmian-github' }]);
  // Nobody due → nothing resolved.
  assert.deepEqual(armingPairsForDispatch({ armedConnectors: [{ seatId: 'claude', entryId: 'helmian-github' }], dueProviders: [] }), []);
});

test('g4 dispatch: a connected pair with a snapshot resolves to a full record, token from the connection', async () => {
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: GH_CONNECTION, snapshot: GH_SNAPSHOT });
  const record = await resolveArmingRecord({ store, credentials: CREDS_OK, listTools: NO_LIST, operatorTokens: {}, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(record.state, 'connected');
  assert.equal(record.accessToken, 'tok-connection');
  assert.equal(record.tokenSource, 'connection');
  assert.equal(record.posture, 'read');
  assert.deepEqual(record.toolEnableMap, { get_repo: true });
  assert.deepEqual(record.snapshotTools.map((t) => t.name), GH_PLAN.tools.map((t) => t.name));
  assert.equal(record.snapshotTools[0].inputSchemaHash, GH_PLAN.tools[0].inputSchemaHash);
});

test('g4 dispatch: no connection and needs-reconnect are honest state records', async () => {
  const none = await resolveArmingRecord({ store: fakeArmingStore({ entry: GH_ENTRY }), credentials: CREDS_OK, listTools: NO_LIST, operatorTokens: {}, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(none.state, 'not-connected');
  assert.equal(none.reason, 'not-connected');
  const stale = await resolveArmingRecord({ store: fakeArmingStore({ entry: GH_ENTRY, connection: { ...GH_CONNECTION, state: 'needs-reconnect' } }), credentials: CREDS_OK, listTools: NO_LIST, operatorTokens: {}, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(stale.state, 'needs-reconnect');
  assert.equal(stale.reason, 'connection-needs-reconnect');
});

test('g4 dispatch: first arm takes the freeze backstop, then arms on the frozen set', async () => {
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: { ...GH_CONNECTION, toolSnapshotRef: null, toolEnableMap: {} }, snapshot: null });
  let listedWith = null;
  const record = await resolveArmingRecord({
    store, credentials: CREDS_OK, operatorTokens: {},
    listTools: async ({ endpoint, accessToken }) => { listedWith = { endpoint, accessToken }; return { supported: true, tools: GH_TOOLS }; },
    tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github',
  });
  assert.deepEqual(listedWith, { endpoint: GITHUB_MCP_URL, accessToken: 'tok-connection' });
  assert.equal(store.state.freezes.length, 1);
  assert.equal(record.state, 'connected');
  assert.equal(record.snapshotTools.length, GH_TOOLS.length);
  assert.equal(record.toolEnableMap.get_repo, true); // a first freeze enters the set switched ON
});

test('g4 dispatch: a failed backstop is a freeze-failed record, never an unfrozen arm', async () => {
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: { ...GH_CONNECTION, toolSnapshotRef: null }, snapshot: null });
  const record = await resolveArmingRecord({
    store, credentials: CREDS_OK, operatorTokens: {},
    listTools: async () => { throw new Error('server down'); },
    tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github',
  });
  assert.equal(record.state, 'freeze-failed');
  assert.equal(record.reason, 'freeze-failed');
  assert.equal(record.accessToken, undefined); // a failed freeze never carries a token
});

test('g4 dispatch: token order — connection, then operator, then none (state-only)', async () => {
  const refused = { resolveVaultCredential: async () => ({ accepted: false }) };
  const base = { entry: GH_ENTRY, connection: GH_CONNECTION, snapshot: GH_SNAPSHOT };
  const operator = await resolveArmingRecord({ store: fakeArmingStore(base), credentials: refused, listTools: NO_LIST, operatorTokens: { github: 'tok-operator' }, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(operator.accessToken, 'tok-operator');
  assert.equal(operator.tokenSource, 'operator');
  const stateOnly = await resolveArmingRecord({ store: fakeArmingStore(base), credentials: refused, listTools: NO_LIST, operatorTokens: {}, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(stateOnly.state, 'connected');
  assert.equal(stateOnly.accessToken, null);
  assert.equal(stateOnly.tokenSource, null);
});

test('g4 dispatch: resolveDispatchArming resolves the whole set through injected roads', async () => {
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: GH_CONNECTION, snapshot: GH_SNAPSHOT });
  const records = await resolveDispatchArming({
    tenantId: 't', personId: 'user:troy',
    pairs: [{ seatId: 'claude', entryId: 'helmian-github' }],
    store, credentials: CREDS_OK, listTools: NO_LIST, operatorTokens: {},
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'connected');
});

// The vault's requireActor, word for word (credential-vault.mjs):
// a resolve missing any of the five actor fields is refused before
// any lookup. The dispatch's resolve carried none of them — the
// same omission that broke the write route's stores — so against
// this stub the base dispatch throws the refusal out of
// resolveArmingRecord (an infra failure, by the header's law) and
// the pair never arms. These tests fail on that base and pass once
// the resolve carries the dispatch's system-actor context.
function enforcingCredentials(calls) {
  return {
    resolveVaultCredential: async (input) => {
      calls.push(input);
      if (!input.tenantId || !input.actorSubject || !input.actorRole || !input.sessionId || !input.requestId) {
        throw new TypeError('credential vault actor context is required');
      }
      return { accepted: true, credential: { accessToken: 'tok-connection' } };
    },
  };
}

test('g4 dispatch: the token resolve carries the full actor context the vault demands', async () => {
  const calls = [];
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: GH_CONNECTION, snapshot: GH_SNAPSHOT });
  const record = await resolveArmingRecord({ store, credentials: enforcingCredentials(calls), listTools: NO_LIST, operatorTokens: {}, tenantId: 't', personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github' });
  assert.equal(record.state, 'connected');
  assert.equal(record.accessToken, 'tok-connection');
  assert.equal(record.tokenSource, 'connection');
  assert.equal(calls.length, 1);
  // The actor is the dispatch's own system actor — truthfully not
  // the person, whose click this is not — on the real tenant.
  assert.equal(calls[0].tenantId, 't');
  assert.equal(calls[0].actorSubject, 'helmion:connector-arming');
  assert.equal(calls[0].actorRole, 'device');
  assert.ok(calls[0].sessionId, 'sessionId present');
  assert.ok(calls[0].requestId, 'requestId present');
  assert.equal(calls[0].reasonClass, 'provider_call');
});

test('g4 dispatch: one dispatch run is one system-actor session, one request per resolve', async () => {
  const calls = [];
  const store = fakeArmingStore({ entry: GH_ENTRY, connection: GH_CONNECTION, snapshot: GH_SNAPSHOT });
  const records = await resolveDispatchArming({
    tenantId: 't', personId: 'user:troy',
    pairs: [{ seatId: 'claude', entryId: 'helmian-github' }, { seatId: 'chatgpt', entryId: 'helmian-github' }],
    store, credentials: enforcingCredentials(calls), listTools: NO_LIST, operatorTokens: {},
  });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.state === 'connected' && r.tokenSource === 'connection'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].actorSubject, 'helmion:connector-arming');
  assert.equal(calls[1].actorSubject, 'helmion:connector-arming');
  assert.equal(calls[0].sessionId, calls[1].sessionId, 'one session across the run');
  assert.notEqual(calls[0].requestId, calls[1].requestId, 'one request id per resolve');
});

// ================================================================
// G4: the runner seam the records build.
// ================================================================

const CONNECTED_RECORD = {
  seatId: 'claude', entryId: 'helmian-github', state: 'connected',
  entryName: 'GitHub', endpointUrl: GITHUB_MCP_URL, authMode: 'oauth',
  accountIdentity: 'troy-gh', posture: 'read',
  snapshotTools: GH_PLAN.tools, toolEnableMap: {},
  accessToken: 'tok-connection', tokenSource: 'connection',
};

test('g4 seam: no records build a null seam; records build one that answers from them', async () => {
  assert.equal(buildConnectorArming([]), null);
  assert.equal(buildConnectorArming(null), null);
  assert.equal(buildConnectorArming([{ seatId: 'claude' }]), null); // malformed records drop to nothing
  const seam = buildConnectorArming([CONNECTED_RECORD], { approver: async () => 'allow-once' });
  assert.ok(seam);
  assert.equal(seam.recordFor({ seatId: 'claude', entryId: 'helmian-github' }).state, 'connected');
  assert.equal(seam.recordFor({ seatId: 'grok', entryId: 'helmian-github' }), null);
  assert.deepEqual(await seam.connectionFor({ seatId: 'claude', entryId: 'helmian-github' }), { state: 'connected', refreshTokenRef: null, accountIdentity: 'troy-gh' });
  assert.deepEqual(await seam.mintAccessToken({ seatId: 'claude', entryId: 'helmian-github' }), { ok: true, accessToken: 'tok-connection' });
  assert.equal(await seam.approveCall({ tool: 'x', args: {} }), true);
});

test('g4 seam: approveCall fails closed — deny, unknown words, a throw, and no approver all refuse', async () => {
  const deny = buildConnectorArming([CONNECTED_RECORD], { approver: async () => 'deny' });
  assert.equal(await deny.approveCall({ tool: 'x', args: {} }), false);
  const weird = buildConnectorArming([CONNECTED_RECORD], { approver: async () => 'sure-whatever' });
  assert.equal(await weird.approveCall({ tool: 'x', args: {} }), false);
  const boom = buildConnectorArming([CONNECTED_RECORD], { approver: async () => { throw new Error('broker down'); } });
  assert.equal(await boom.approveCall({ tool: 'x', args: {} }), false);
  const noApprover = buildConnectorArming([CONNECTED_RECORD]);
  assert.equal(await noApprover.approveCall({ tool: 'x', args: {} }), false);
  const session = buildConnectorArming([CONNECTED_RECORD], { approver: async () => 'allow-session' });
  assert.equal(await session.approveCall({ tool: 'x', args: {} }), true);
});

test('g4 seam: sanitizeArmingRecords drops malformed records and clamps the fields a turn trusts', () => {
  const [clean] = sanitizeArmingRecords([{
    seatId: 'claude', entryId: 'helmian-github', state: 'connected',
    posture: 'whenever', accessToken: 42,
    snapshotTools: [{ name: 'ok_tool' }, { name: 7 }, null],
    toolEnableMap: { a: true, b: 'yes' },
  }]);
  assert.equal(clean.posture, 'ask');
  assert.equal(clean.accessToken, null);
  assert.deepEqual(clean.snapshotTools, [{ name: 'ok_tool', annotation: 'undeclared' }]);
  assert.deepEqual(clean.toolEnableMap, { a: true });
  assert.deepEqual(sanitizeArmingRecords('nope'), []);
  assert.deepEqual(sanitizeArmingRecords([{ entryId: 'x', state: 'connected' }]), []);
});

// ================================================================
// G4: the runner-hosted pipe — tools join the turn, gated.
// ================================================================

function fakeRemoteClientFactory({ tools = GH_TOOLS, failConnect = false } = {}) {
  const factory = async ({ url, token }) => {
    if (failConnect) throw new Error('no route to host');
    factory.seen.push({ url, token });
    return {
      async listTools() { return tools; },
      async callTool(name, args) { factory.calls.push({ name, args }); return { content: [{ type: 'text', text: `ran ${name}` }] }; },
      textOf(result) { return (result?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n'); },
      async close() {},
    };
  };
  factory.seen = [];
  factory.calls = [];
  return factory;
}

test('g4 pipe: a connected record arms runner-hosted tools — snapshot-gated, enable-map-gated, no Pattern-A server', async () => {
  const remote = fakeRemoteClientFactory();
  const record = { ...CONNECTED_RECORD, toolEnableMap: { delete_repo: false } };
  const resolved = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: buildConnectorArming([record]), createRemoteMcpClientImpl: remote,
  });
  assert.deepEqual(resolved.mcpServers, []); // the runner-hosted road, not a handed-off server
  assert.equal(resolved.connectorOutcomes[0].armed, true);
  // delete_repo is in the snapshot but switched off — never offered.
  assert.deepEqual([...resolved.toolNames].sort(), [
    'mcp_helmian_github_github_create_issue',
    'mcp_helmian_github_github_get_repo',
    'mcp_helmian_github_github_mystery_tool',
  ]);
  assert.deepEqual(remote.seen, [{ url: GITHUB_MCP_URL, token: 'tok-connection' }]);
  assert.match(resolved.contextText, /Helmian runs its tools here/);
  await resolved.dispose();
});

test('g4 pipe: posture read — reads run free, writes stop at approval and never reach the server', async () => {
  const remote = fakeRemoteClientFactory();
  const seam = buildConnectorArming([{ ...CONNECTED_RECORD, posture: 'read' }]); // no approver wired
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: seam, createRemoteMcpClientImpl: remote });
  assert.equal(await resolved.extraTools.mcp_helmian_github_github_get_repo.execute({ repo: 'helmian' }), 'ran get_repo');
  const refused = await resolved.extraTools.mcp_helmian_github_github_create_issue.execute({ title: 'x' });
  assert.match(refused, /Not run:.*needed approval/);
  assert.deepEqual(remote.calls.map((c) => c.name), ['get_repo']); // the write never reached the server
  await resolved.dispose();
});

test('g4 pipe: posture ask — the approver decides every call, reads included', async () => {
  const remote = fakeRemoteClientFactory();
  let verdict = false;
  const seam = buildConnectorArming([{ ...CONNECTED_RECORD, posture: 'ask' }], { approver: async () => (verdict ? 'allow-once' : 'deny') });
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: seam, createRemoteMcpClientImpl: remote });
  assert.match(await resolved.extraTools.mcp_helmian_github_github_get_repo.execute({}), /Not run:/);
  verdict = true;
  assert.equal(await resolved.extraTools.mcp_helmian_github_github_get_repo.execute({}), 'ran get_repo');
  await resolved.dispose();
});

test('g4 pipe: posture low-risk — declared non-destructive writes run free; destructive and undeclared writes ask', async () => {
  const remote = fakeRemoteClientFactory();
  const seam = buildConnectorArming([{ ...CONNECTED_RECORD, posture: 'low-risk' }]); // no approver wired
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: seam, createRemoteMcpClientImpl: remote });
  assert.equal(await resolved.extraTools.mcp_helmian_github_github_create_issue.execute({}), 'ran create_issue');
  assert.match(await resolved.extraTools.mcp_helmian_github_github_delete_repo.execute({}), /Not run:/);
  assert.match(await resolved.extraTools.mcp_helmian_github_github_mystery_tool.execute({}), /Not run:/);
  await resolved.dispose();
});

test('g4 pipe: posture all — everything runs free', async () => {
  const remote = fakeRemoteClientFactory();
  const seam = buildConnectorArming([{ ...CONNECTED_RECORD, posture: 'all' }]);
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: seam, createRemoteMcpClientImpl: remote });
  assert.equal(await resolved.extraTools.mcp_helmian_github_github_delete_repo.execute({}), 'ran delete_repo');
  await resolved.dispose();
});

test('g4 pipe: tools outside the snapshot — and tools whose schema changed — are held for review, never offered', async () => {
  const changed = { ...GH_TOOLS[0], inputSchema: { type: 'object', properties: { other: { type: 'string' } } } };
  const extra = { name: 'brand_new_tool', description: 'New', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
  const remote = fakeRemoteClientFactory({ tools: [changed, GH_TOOLS[1], extra] });
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: buildConnectorArming([CONNECTED_RECORD]), createRemoteMcpClientImpl: remote });
  assert.deepEqual(resolved.toolNames, ['mcp_helmian_github_github_create_issue']);
  assert.equal(resolved.connectorOutcomes[0].armed, true);
  assert.match(resolved.contextText, /await review/);
  assert.match(resolved.contextText, /get_repo/);
  assert.match(resolved.contextText, /brand_new_tool/);
  await resolved.dispose();
});

test('g4 pipe: a state record unarms with dispatch\u2019s reason; a token-less oauth record unarms token-unavailable', async () => {
  const notConnected = buildConnectorArming([{ seatId: 'claude', entryId: 'helmian-github', state: 'not-connected', reason: 'not-connected', detail: 'it is not connected for this seat', entryName: 'GitHub', endpointUrl: GITHUB_MCP_URL, authMode: 'oauth' }]);
  const a = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: notConnected, createRemoteMcpClientImpl: fakeRemoteClientFactory() });
  assert.equal(a.connectorOutcomes[0].armed, false);
  assert.equal(a.connectorOutcomes[0].reason, 'not-connected');
  assert.deepEqual(a.toolNames, []);
  await a.dispose();

  const tokenless = buildConnectorArming([{ ...CONNECTED_RECORD, accessToken: null, tokenSource: null }]);
  const b = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: tokenless, createRemoteMcpClientImpl: fakeRemoteClientFactory() });
  assert.equal(b.connectorOutcomes[0].armed, false);
  assert.equal(b.connectorOutcomes[0].reason, 'token-unavailable');
  assert.deepEqual(b.toolNames, []);
  await b.dispose();
});

test('g4 pipe: an unreachable server unarms connect-failed, honestly', async () => {
  const resolved = await resolveTurnAttachments({ metadata: NATIVE_TOGGLE, providerId: 'anthropic', connectorArming: buildConnectorArming([CONNECTED_RECORD]), createRemoteMcpClientImpl: fakeRemoteClientFactory({ failConnect: true }) });
  assert.equal(resolved.connectorOutcomes[0].armed, false);
  assert.equal(resolved.connectorOutcomes[0].reason, 'connect-failed');
  await resolved.dispose();
});

test('g4 pipe: records arm the seats and turn kinds Pattern A cannot — the chatgpt seat and a CLI turn', async () => {
  const chatgpt = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'chatgpt', entryId: 'helmian-github' }] },
    providerId: 'openai',
    connectorArming: buildConnectorArming([{ ...CONNECTED_RECORD, seatId: 'chatgpt' }]),
    createRemoteMcpClientImpl: fakeRemoteClientFactory(),
  });
  assert.equal(chatgpt.connectorOutcomes[0].armed, true);
  assert.ok(chatgpt.toolNames.length > 0);
  await chatgpt.dispose();

  const cli = await resolveTurnAttachments({
    metadata: NATIVE_TOGGLE, providerId: 'anthropic', credentialType: 'cli',
    connectorArming: buildConnectorArming([CONNECTED_RECORD]), createRemoteMcpClientImpl: fakeRemoteClientFactory(),
  });
  assert.equal(cli.connectorOutcomes[0].armed, true);
  await cli.dispose();
});

test('g4 posture table: postureRequiresApproval says exactly what DESIGN \u00a73 says', () => {
  assert.equal(postureRequiresApproval('ask', 'read', false), true);
  assert.equal(postureRequiresApproval('ask', 'write', false), true);
  assert.equal(postureRequiresApproval('read', 'read', true), false);
  assert.equal(postureRequiresApproval('read', 'write', false), true);
  assert.equal(postureRequiresApproval('low-risk', 'read', true), false);
  assert.equal(postureRequiresApproval('low-risk', 'write', false), false);
  assert.equal(postureRequiresApproval('low-risk', 'write', true), true);
  assert.equal(postureRequiresApproval('low-risk', 'write', undefined), true);
  assert.equal(postureRequiresApproval('all', 'write', true), false);
  assert.equal(postureRequiresApproval('bogus', 'read', false), true);
});

test('g4 wiring pins: dispatch attaches the records to the work item; the bridge builds the seam from them', () => {
  const meshSrc = readFileSync(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(meshSrc.includes('connectorConnections: armingRecords'), 'agentWork rides the records as connectorConnections');
  const bridgeSrc = readFileSync(new URL('../src/agent/bridge.mjs', import.meta.url), 'utf8');
  assert.ok(bridgeSrc.includes('buildConnectorArming(armingRecords'), 'the bridge builds the seam from the turn request records');
  assert.ok(!bridgeSrc.includes('const connectorArming = null;'), 'the literal-null seam is gone');
});

// ================================================================
// B5: refresh-on-resolve — an expired Asana-shaped bundle is
// refreshed once at arm time; a refused refresh marks the
// connection needs-reconnect; a bundle with no refresh token
// (Slack, rotation off) behaves byte-for-byte as before.
//
// Production-shaped: the REAL dispatch (resolveArmingRecord)
// over the REAL library store (createConnectorLibraryStore on an
// in-memory pool covering entries / connections / snapshots,
// the connector-library.test.mjs fake-pool pattern), a stub
// credential service, and the REAL provider factory
// (createConnectorOAuthClient) behind a stub fetch standing in
// for the provider's token endpoint.
//
// The stub credential service models the vault's two answers
// faithfully: a provider_call resolve of an expired bundle is
// refused with the vault's own refusal shape
// ({ status: 'credential_not_available', accepted: false,
// secretMaterial: 'not_returned', providerInvocation:
// 'not_performed' } — credential-vault.mjs's expired-record
// answer, word for word), and an oauth_refresh resolve — the
// vault's own reason class for this road — returns the bundle's
// refresh token, the one field a refresh exchange needs. Stores
// land in the stub's bundle map so the test can read back what
// the refresh kept.
// ================================================================

function refreshLibraryPool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
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
          if (text.includes('from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = {
              id: ++snapSeq, tenant_id: tenant, connection_id: vals[0],
              taken_at: now(), tools: JSON.parse(vals[1]), snapshot_hash: vals[2],
            };
            snapshots.set(row.id, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            const row = snapshots.get(vals[0]);
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
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (!row) return { rows: [], rowCount: 0 };
            if (text.includes("set state = 'disconnected'")) {
              row.state = 'disconnected'; row.access_token_ref = null; row.refresh_token_ref = null; row.tool_snapshot_ref = null;
            } else if (text.includes('set access_token_ref = $4')) {
              row.access_token_ref = vals[3]; row.refresh_token_ref = vals[4];
              row.account_identity = vals[5]; row.granted_scopes = JSON.parse(vals[6]); row.state = 'connected';
            } else if (text.includes('set tool_snapshot_ref = $4')) {
              row.tool_snapshot_ref = vals[3]; row.last_discovery_at = now(); row.tool_enable_map = JSON.parse(vals[4]);
            } else if (text.includes("set state = 'needs-reconnect'")) {
              row.state = 'needs-reconnect';
            } else {
              throw new Error(`refresh fake pool: unhandled connection update: ${text.slice(0, 80)}`);
            }
            row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`refresh fake pool: unhandled query: ${text.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

const B5_TENANT = 'tenant-a';
const B5_PERSON = 'user:troy';

function stubCredentialService() {
  const bundles = new Map();
  const calls = [];
  return {
    bundles, calls,
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input]);
      const bundle = bundles.get(input.credentialReference);
      if (!bundle) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      if (input.reasonClass === 'oauth_refresh') {
        return bundle.refreshToken
          ? { status: 'credential_resolved', accepted: true, credential: bundle.accessToken, refreshToken: bundle.refreshToken, tokenType: 'Bearer', secretMaterial: 'adapter_only', providerInvocation: 'not_performed' }
          : { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      }
      if (bundle.expired) return { status: 'credential_not_available', accepted: false, secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      return { status: 'credential_resolved', accepted: true, credential: { accessToken: bundle.accessToken, refreshToken: bundle.refreshToken }, refreshToken: bundle.refreshToken, tokenType: 'Bearer', secretMaterial: 'adapter_only', providerInvocation: 'not_performed' };
    },
    async storeCredential(input) {
      calls.push(['storeCredential', input]);
      bundles.set(input.credentialReference, { accessToken: input.accessToken, refreshToken: input.refreshToken, expired: false });
      return { status: 'stored_in_credential_vault', accepted: true, credentialReference: input.credentialReference };
    },
  };
}

// The provider's token endpoint behind a stub fetch, with the
// real factory in front of it. mode: 'ok' | 'refused' | 'down'.
function stubTokenEndpoint(mode) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'refused') {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'The refresh token is revoked' }) };
    }
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-fresh', refresh_token: 'ref-rotated', token_type: 'Bearer', expires_in: 3600 }) };
  };
  const env = {
    ASANA_OAUTH_CLIENT_ID: 'asana-client-id', ASANA_OAUTH_CLIENT_SECRET: 'asana-client-secret',
    SLACK_OAUTH_CLIENT_ID: 'slack-client-id', SLACK_OAUTH_CLIENT_SECRET: 'slack-client-secret',
  };
  const oauthClientFor = (provider) => createConnectorOAuthClient(provider, { fetchImpl, env });
  return { calls, fetchImpl, env, oauthClientFor };
}

const B5_TOOLS = [
  { name: 'list_tasks', description: 'List tasks', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];

async function seedB5Connection({ entryId, withRefresh }) {
  const store = createConnectorLibraryStore(refreshLibraryPool());
  const entry = catalogEntryById('claude', entryId);
  await store.createEntry(B5_TENANT, B5_PERSON, entry);
  const accessRef = buildConnectorTokenRef({ tenantId: B5_TENANT, seatId: 'claude', entryId, personId: B5_PERSON, tokenKind: 'access' });
  const refreshRef = withRefresh
    ? buildConnectorTokenRef({ tenantId: B5_TENANT, seatId: 'claude', entryId, personId: B5_PERSON, tokenKind: 'refresh' })
    : null;
  await store.createConnection(B5_TENANT, B5_PERSON, {
    personId: B5_PERSON, seatId: 'claude', entryId,
    accountIdentity: `${entry.name} account`, accessTokenRef: accessRef, refreshTokenRef: refreshRef, grantedScopes: [],
  });
  await store.freezeSnapshot(B5_TENANT, { personId: B5_PERSON, seatId: 'claude', entryId }, B5_TOOLS, B5_PERSON);
  return { store, accessRef, refreshRef };
}

test('b5 factory: the Asana client exposes a refresh exchange on its own token endpoint; Slack exposes none', async () => {
  const endpoint = stubTokenEndpoint('ok');
  const asana = createConnectorOAuthClient('asana', { fetchImpl: endpoint.fetchImpl, env: endpoint.env });
  assert.equal(typeof asana.refreshTokens, 'function');
  const tokens = await asana.refreshTokens({ refreshToken: 'ref-old' });
  assert.deepEqual(tokens, { accessToken: 'tok-fresh', refreshToken: 'ref-rotated', tokenType: 'Bearer', scope: null, expiresIn: 3600 });
  assert.equal(endpoint.calls.length, 1);
  assert.equal(endpoint.calls[0].url, 'https://app.asana.com/-/oauth_token');
  const form = new URLSearchParams(endpoint.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'ref-old');
  assert.equal(form.get('client_id'), 'asana-client-id');
  assert.equal(form.get('client_secret'), 'asana-client-secret');
  const slack = createConnectorOAuthClient('slack', { fetchImpl: endpoint.fetchImpl, env: endpoint.env });
  assert.equal(slack.refreshTokens, undefined, 'Slack factory exposes no refresh — rotation off is its standing shape');
  const refusedEndpoint = stubTokenEndpoint('refused');
  const refusedClient = createConnectorOAuthClient('asana', { fetchImpl: refusedEndpoint.fetchImpl, env: refusedEndpoint.env });
  await assert.rejects(() => refusedClient.refreshTokens({ refreshToken: 'ref-old' }), (error) => error.refreshRefused === true);
});

test('b5 refresh: an expired Asana bundle refreshes once and the armed turn proceeds on the fresh token', async () => {
  const { store, accessRef, refreshRef } = await seedB5Connection({ entryId: 'helmian-asana', withRefresh: true });
  const credentials = stubCredentialService();
  credentials.bundles.set(accessRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  credentials.bundles.set(refreshRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  const endpoint = stubTokenEndpoint('ok');
  const record = await resolveArmingRecord({
    store, credentials, listTools: NO_LIST, operatorTokens: {}, oauthClientFor: endpoint.oauthClientFor,
    tenantId: B5_TENANT, personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana',
  });
  assert.equal(record.state, 'connected');
  assert.equal(record.accessToken, 'tok-fresh');
  assert.equal(record.tokenSource, 'connection');
  assert.equal(record.snapshotTools.length, 1);
  // ONE exchange, on Asana's own endpoint, carrying the stored refresh token.
  assert.equal(endpoint.calls.length, 1);
  assert.equal(endpoint.calls[0].url, 'https://app.asana.com/-/oauth_token');
  const form = new URLSearchParams(endpoint.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'ref-old');
  // The resolves: the expired access bundle refused under
  // provider_call, then the refresh reference under oauth_refresh,
  // both under the arming actor context.
  const resolves = credentials.calls.filter(([n]) => n === 'resolveVaultCredential').map(([, input]) => input);
  assert.equal(resolves.length, 2);
  assert.equal(resolves[0].credentialReference, accessRef);
  assert.equal(resolves[0].reasonClass, 'provider_call');
  assert.equal(resolves[1].credentialReference, refreshRef);
  assert.equal(resolves[1].reasonClass, 'oauth_refresh');
  assert.equal(resolves[1].actorSubject, 'helmion:connector-arming');
  assert.equal(resolves[1].actorRole, 'device');
  // The new bundle was re-stored under both references, with the
  // arming actor context on every store.
  const stores = credentials.calls.filter(([n]) => n === 'storeCredential').map(([, input]) => input);
  assert.equal(stores.length, 2);
  assert.deepEqual(stores.map((s) => s.credentialReference).sort(), [accessRef, refreshRef].sort());
  for (const stored of stores) {
    assert.equal(stored.credentialKind, 'oauth_bundle');
    assert.equal(stored.accessToken, 'tok-fresh');
    assert.equal(stored.refreshToken, 'ref-rotated');
    assert.equal(stored.actorSubject, 'helmion:connector-arming');
    assert.equal(stored.actorRole, 'device');
    assert.equal(stored.tenantId, B5_TENANT);
    assert.ok(stored.sessionId && stored.requestId, 'the store carries the full actor context');
  }
  assert.equal(credentials.bundles.get(accessRef).accessToken, 'tok-fresh');
  // And the landing: the connection still reads connected, holding
  // the (deterministically re-minted) references.
  const landed = await store.getConnection(B5_TENANT, { personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana' });
  assert.equal(landed.state, 'connected');
  assert.equal(landed.accessTokenRef, accessRef);
  assert.equal(landed.refreshTokenRef, refreshRef);
});

test('b5 refresh: a refused refresh marks the connection needs-reconnect and the pair resolves to that record', async () => {
  const { store, accessRef, refreshRef } = await seedB5Connection({ entryId: 'helmian-asana', withRefresh: true });
  const credentials = stubCredentialService();
  credentials.bundles.set(accessRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  credentials.bundles.set(refreshRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  const endpoint = stubTokenEndpoint('refused');
  const record = await resolveArmingRecord({
    store, credentials, listTools: NO_LIST, operatorTokens: {}, oauthClientFor: endpoint.oauthClientFor,
    tenantId: B5_TENANT, personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana',
  });
  assert.equal(endpoint.calls.length, 1, 'exactly one refresh exchange was attempted');
  assert.equal(record.state, 'needs-reconnect');
  assert.equal(record.reason, 'connection-needs-reconnect');
  assert.equal(record.accessToken, undefined, 'a needs-reconnect record carries no token');
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0, 'nothing was re-stored');
  const landed = await store.getConnection(B5_TENANT, { personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana' });
  assert.equal(landed.state, 'needs-reconnect', 'the connection itself reads needs-reconnect, not still-connected');
});

test('b5 refresh: an unreachable refresh endpoint unarms as today and the connection state stays truthful', async () => {
  const { store, accessRef, refreshRef } = await seedB5Connection({ entryId: 'helmian-asana', withRefresh: true });
  const credentials = stubCredentialService();
  credentials.bundles.set(accessRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  credentials.bundles.set(refreshRef, { accessToken: 'tok-expired', refreshToken: 'ref-old', expired: true });
  const endpoint = stubTokenEndpoint('down');
  const record = await resolveArmingRecord({
    store, credentials, listTools: NO_LIST, operatorTokens: {}, oauthClientFor: endpoint.oauthClientFor,
    tenantId: B5_TENANT, personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana',
  });
  assert.equal(endpoint.calls.length, 1, 'the refresh was attempted exactly once');
  assert.equal(record.state, 'connected');
  assert.equal(record.accessToken, null);
  assert.equal(record.tokenSource, null);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0);
  const landed = await store.getConnection(B5_TENANT, { personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-asana' });
  assert.equal(landed.state, 'connected', 'an unreachable endpoint never marks needs-reconnect');
});

test('b5 refresh: a Slack-shaped bundle (no refresh token) behaves byte-for-byte as today', async () => {
  const { store, accessRef } = await seedB5Connection({ entryId: 'helmian-slack', withRefresh: false });
  const credentials = stubCredentialService();
  credentials.bundles.set(accessRef, { accessToken: 'tok-expired', refreshToken: null, expired: true });
  const endpoint = stubTokenEndpoint('ok');
  const record = await resolveArmingRecord({
    store, credentials, listTools: NO_LIST, operatorTokens: {}, oauthClientFor: endpoint.oauthClientFor,
    tenantId: B5_TENANT, personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-slack',
  });
  const plan = planToolSnapshot(B5_TOOLS);
  assert.deepEqual(record, {
    seatId: 'claude',
    entryId: 'helmian-slack',
    entryName: 'Slack',
    endpointUrl: 'https://mcp.slack.com/mcp',
    authMode: 'oauth',
    state: 'connected',
    accountIdentity: 'Slack account',
    posture: 'ask',
    snapshotTools: plan.tools.map((t) => ({ name: t.name, annotation: t.annotation, inputSchemaHash: t.inputSchemaHash })),
    toolEnableMap: { list_tasks: true },
    accessToken: null,
    tokenSource: null,
  });
  assert.equal(endpoint.calls.length, 0, 'no token endpoint was ever called');
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0, 'nothing was stored');
  assert.equal(credentials.calls.filter(([n]) => n === 'resolveVaultCredential').length, 1, 'only the one access resolve ran');
  const landed = await store.getConnection(B5_TENANT, { personId: B5_PERSON, seatId: 'claude', entryId: 'helmian-slack' });
  assert.equal(landed.state, 'connected');
  assert.equal(landed.refreshTokenRef, null);
});

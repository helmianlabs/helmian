// Connectors bite 4R2 — the Claude Pattern-A hand-off, end to end on
// fakes: catalog data model (Scribe is an OAuth entry the library can
// hold token refs for), the Scribe door token minter (refresh success /
// failure / timeout against a stubbed token endpoint), toggle
// consumption in attachments.mjs (armed resolution + arm-state
// honesty), the adapter change in providers.mjs (armed request shape;
// UNARMED REQUEST BYTE-IDENTICAL to the pre-connector request), MCP
// evidence capture, and loop threading (servers carried separately,
// evidence into the turn record).
//
// fetch is stubbed throughout; nothing here touches the network, the
// live door, or a real Anthropic key. The live gate — a real Anthropic
// response carrying the Scribe MCP blocks — is UNVERIFIED by design
// and runs after the human consent step + push (see BUILD-REPORT.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogEntryById, LIVE_SEATS } from '../src/cloud/connector-catalog.mjs';
import { createConnectorLibraryStore, buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { openVault, PROVIDER_KEY_ENV } from '../src/runner/vault.mjs';
import {
  createScribeDoorClient,
  createScribeAccessTokenMinter,
  createRunnerVaultScribeResolver,
  createScribeArming,
  runnerVaultHasScribe,
  ScribeDoorError,
  SCRIBE_TOKEN_URL,
  SCRIBE_MCP_URL,
} from '../src/agent/scribe-door.mjs';
import { resolveTurnAttachments } from '../src/agent/attachments.mjs';
import { chatWithTools, ANTHROPIC_MCP_BETA } from '../src/agent/providers.mjs';
import { runAgentTurn } from '../src/agent/loop.mjs';
import { makeProvenanceWorkspace, cleanProvenanceWorkspace } from '../test-support/provenance-workspace.mjs';

// A JWT-shaped fake door token: three base64url segments, so the
// redaction-ordering pin below is real — redactSecrets replaces this
// shape with [REDACTED] wherever it sees it in a serialized body.
const FAKE_DOOR_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJydW5uZXIiLCJzY29wZSI6Im1lbW9yeS5yZWFkIn0.fakesignaturepart0123456789';

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

test('catalog: helmian-scribe is an oauth entry on every seat, endpoint unchanged', () => {
  for (const seatId of LIVE_SEATS) {
    const entry = catalogEntryById(seatId, 'helmian-scribe');
    assert.equal(entry.authMode, 'oauth', `${seatId}: scribe authMode`);
    assert.equal(entry.brokerMode, 'helmian');
    assert.equal(entry.mcpEndpointUrl, SCRIBE_MCP_URL);
    assert.ok(entry.scopesSummary, `${seatId}: scopes summary present`);
  }
  // The other genuinely-public entry keeps its 'none': Cloudflare's
  // docs server takes no sign-in, and this bite changed only Scribe.
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

test('library: a scribe connection now holds access + refresh token refs; the refresh road carries the flip', async () => {
  const TENANT = 'tenant-a';
  const PERSON = 'user:troy';
  const store = createConnectorLibraryStore(fakeLibraryPool());

  // The stored legacy record: authMode 'none', as seeded before this
  // bite. A connection with token refs is refused under it — the 4R
  // step-0 blocker, reproduced at the store.
  const legacy = { ...catalogEntryById('claude', 'helmian-scribe'), authMode: 'none' };
  await store.createEntry(TENANT, PERSON, legacy);
  const accessRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-scribe', personId: PERSON, tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-scribe', personId: PERSON, tokenKind: 'refresh' });
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: PERSON, seatId: 'claude', entryId: 'helmian-scribe',
      accountIdentity: 'Troy (Scribe door)', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    }),
    /no tokens to reference/,
  );

  // The catalog refresh re-creates the entry from the corrected
  // catalog data — its update path writes auth_mode — and the same
  // connection now lands, holding both refs like any oauth entry.
  const refreshed = await store.createEntry(TENANT, PERSON, catalogEntryById('claude', 'helmian-scribe'));
  assert.equal(refreshed.authMode, 'oauth');
  const connection = await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-scribe',
    accountIdentity: 'Troy (Scribe door)', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    grantedScopes: ['memory.read', 'memory.write', 'hands.read', 'hands.act'],
  });
  assert.equal(connection.accessTokenRef, accessRef);
  assert.equal(connection.refreshTokenRef, refreshRef);
  assert.equal(connection.state, 'connected');
  const readBack = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-scribe' });
  assert.equal(readBack.refreshTokenRef, refreshRef);

  // And the oauth branch's discipline applies to Scribe too: no
  // access ref, no connection.
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: 'user:other', seatId: 'claude', entryId: 'helmian-scribe',
      accountIdentity: 'No Ref', refreshTokenRef: refreshRef,
    }),
    /accessTokenRef is required/,
  );

  // A true 'none' entry still refuses refs — the flip is Scribe-only.
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

// ============================================================ door client

test('door client: refresh posts the renewal grant form and returns the minted bundle', async () => {
  const seen = [];
  const client = createScribeDoorClient({
    now: () => Date.parse('2026-11-09T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, { access_token: 'door-access-1', refresh_token: 'door-renewal-2', expires_in: 3600 });
    },
  });
  const minted = await client.refreshAccessToken({ refreshToken: 'door-renewal-1', clientId: 'runner-client-7' });
  assert.equal(minted.accessToken, 'door-access-1');
  assert.equal(minted.refreshToken, 'door-renewal-2');
  assert.equal(minted.expiresAt, '2026-11-09T01:00:00.000Z');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, SCRIBE_TOKEN_URL);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(seen[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'door-renewal-1');
  assert.equal(form.get('client_id'), 'runner-client-7');
  assert.ok(seen[0].init.signal, 'the call carries a bounding signal');
});

test('door client: an OAuth refusal surfaces its code, never the token', async () => {
  const client = createScribeDoorClient({
    fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'revoked' }),
  });
  await assert.rejects(
    () => client.refreshAccessToken({ refreshToken: 'door-renewal-1' }),
    (err) => {
      assert.ok(err instanceof ScribeDoorError);
      assert.equal(err.code, 'invalid_grant');
      assert.ok(!err.message.includes('door-renewal-1'), 'the renewal key never rides an error');
      return true;
    },
  );
});

test('door client: a hung door times out bounded', async () => {
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const client = createScribeDoorClient({ fetchImpl: hanging, timeoutMs: 25 });
  await assert.rejects(
    () => client.refreshAccessToken({ refreshToken: 'door-renewal-1' }),
    (err) => err instanceof ScribeDoorError && err.code === 'door_timeout',
  );
});

test('door client: a missing renewal key is refused before any call', async () => {
  let calls = 0;
  const client = createScribeDoorClient({ fetchImpl: async () => { calls += 1; return jsonResponse(200, {}); } });
  await assert.rejects(
    () => client.refreshAccessToken({ refreshToken: '' }),
    (err) => err instanceof ScribeDoorError && err.code === 'missing_refresh_token',
  );
  assert.equal(calls, 0);
});

// ============================================================ the minter

test('minter: success, no-key, resolver failure, and door failure — and it never throws', async () => {
  const okClient = createScribeDoorClient({ fetchImpl: async () => jsonResponse(200, { access_token: 'door-access-9', expires_in: 3600 }) });
  const mintOk = createScribeAccessTokenMinter({ doorClient: okClient, resolveRefreshToken: async () => 'renewal-1' });
  const ok = await mintOk({ refreshTokenRef: 'vault://tenant/t/connector.claude.helmian-scribe/p-x.refresh' });
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, 'door-access-9');

  const mintNone = createScribeAccessTokenMinter({ doorClient: okClient, resolveRefreshToken: async () => null });
  const none = await mintNone({ refreshTokenRef: 'vault://tenant/t/x' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no_refresh_token');

  const mintBroken = createScribeAccessTokenMinter({
    doorClient: okClient,
    resolveRefreshToken: async () => { throw new Error('VAULT_DECRYPT_FAILED'); },
  });
  const broken = await mintBroken({ refreshTokenRef: 'vault://tenant/t/x' });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'refresh_resolve_failed');

  const refusingClient = createScribeDoorClient({ fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant' }) });
  const mintRefused = createScribeAccessTokenMinter({ doorClient: refusingClient, resolveRefreshToken: async () => 'renewal-1' });
  const refused = await mintRefused({ refreshTokenRef: 'vault://tenant/t/x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid_grant');
  assert.ok(refused.reason.length > 0);
});

test('vault resolver: the scribe slot holds the door bundle and a bare renewal key', async (t) => {
  assert.equal(PROVIDER_KEY_ENV.scribe, 'HELMIAN_SCRIBE_TOKEN');
  const dir = await mkdtemp(join(tmpdir(), 'helmion-scribe-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vaultPath = join(dir, 'vault.json');
  const deviceToken = 'device-token-for-tests-0123456789';

  const vault = await openVault({ vaultPath, deviceToken });
  assert.equal(await runnerVaultHasScribe(vault), false);
  assert.equal(await createRunnerVaultScribeResolver({ vault })(), null);

  await vault.setOAuth('scribe', {
    accessToken: 'door-access-old', refreshToken: 'door-renewal-30d',
    expiresAt: '2026-11-09T01:00:00.000Z', email: null, origin: 'door-consent',
  });
  assert.equal(await runnerVaultHasScribe(vault), true);
  assert.equal(await createRunnerVaultScribeResolver({ vault })(), 'door-renewal-30d');

  // A bundle with no renewal key cannot mint — the resolver does not
  // hand back the stale access key as if it were renewable.
  await vault.setOAuth('scribe', {
    accessToken: 'door-access-old', refreshToken: null, expiresAt: null, email: null, origin: 'door-consent',
  });
  assert.equal(await createRunnerVaultScribeResolver({ vault })(), null);

  // The bare-key road (runner-vault CLI `store scribe`): the renewal
  // key stored as a plain key record resolves the same way.
  const vault2 = await openVault({ vaultPath: join(dir, 'vault2.json'), deviceToken });
  await vault2.set('scribe', 'api_key', 'bare-renewal-key');
  assert.equal(await runnerVaultHasScribe(vault2), true);
  assert.equal(await createRunnerVaultScribeResolver({ vault: vault2 })(), 'bare-renewal-key');
});

test('arming composition: vault bundle + fake door mints through createScribeArming', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-scribe-arm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = await openVault({ vaultPath: join(dir, 'vault.json'), deviceToken: 'device-token-for-tests-0123456789' });
  await vault.setOAuth('scribe', {
    accessToken: 'old', refreshToken: 'door-renewal-30d', expiresAt: null, email: null, origin: 'door-consent',
  });
  const arming = createScribeArming({
    vault,
    doorClient: createScribeDoorClient({ fetchImpl: async () => jsonResponse(200, { access_token: FAKE_DOOR_JWT, expires_in: 3600 }) }),
    connectionFor: async () => ({ state: 'connected', refreshTokenRef: null }),
  });
  const minted = await arming.mintAccessToken({ refreshTokenRef: null, seatId: 'claude', entryId: 'helmian-scribe' });
  assert.equal(minted.ok, true);
  assert.equal(minted.accessToken, FAKE_DOOR_JWT);
});

// ======================================================= toggle consumption

const SCRIBE_TOGGLE = { connectors: [{ seatId: 'claude', entryId: 'helmian-scribe' }] };
const armingOk = {
  connectionFor: async () => ({ state: 'connected', refreshTokenRef: 'vault://tenant/t/connector.claude.helmian-scribe/p-x.refresh' }),
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

test('attachments: an armed scribe toggle produces the Pattern-A server, outside the local tools', async () => {
  const resolved = await resolveTurnAttachments({ metadata: SCRIBE_TOGGLE, providerId: 'anthropic', connectorArming: armingOk });
  assert.deepEqual(resolved.mcpServers, [{
    entryId: 'helmian-scribe',
    name: 'helmian-scribe',
    url: SCRIBE_MCP_URL,
    authorizationToken: FAKE_DOOR_JWT,
  }]);
  // Never a local tool: the local catalog is untouched by arming.
  assert.deepEqual(resolved.toolNames, []);
  assert.deepEqual(resolved.connectorOutcomes, [{ seatId: 'claude', entryId: 'helmian-scribe', armed: true }]);
  assert.match(resolved.contextText, /handed to Anthropic's cloud for this turn/);
});

test('attachments: another seat\'s toggle is not this turn\'s business', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'grok', entryId: 'helmian-scribe' }] },
    providerId: 'anthropic',
    connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.deepEqual(resolved.connectorOutcomes, []);
});

test('attachments: toggle-off by absence of the seam — nothing arms, and it says so', async () => {
  const resolved = await resolveTurnAttachments({ metadata: SCRIBE_TOGGLE, providerId: 'anthropic', connectorArming: null });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes.length, 1);
  assert.equal(resolved.connectorOutcomes[0].armed, false);
  assert.equal(resolved.connectorOutcomes[0].reason, 'arming-not-wired');
  assert.match(resolved.contextText, /NOT armed for this turn/);
});

test('attachments: a non-Claude seat records the toggle unarmed (no Pattern-A path yet)', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { connectors: [{ seatId: 'chatgpt', entryId: 'helmian-scribe' }] },
    providerId: 'openai',
    connectorArming: armingOk,
  });
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(resolved.connectorOutcomes[0].armed, false);
  assert.equal(resolved.connectorOutcomes[0].reason, 'pattern-a-unavailable');
});

test('attachments: a subscription (CLI) turn cannot arm', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: SCRIBE_TOGGLE, providerId: 'anthropic', credentialType: 'cli', connectorArming: armingOk,
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
    metadata: SCRIBE_TOGGLE, providerId: 'anthropic',
    connectorArming: { connectionFor: async () => null, mintAccessToken: armingOk.mintAccessToken },
  });
  assert.equal(notConnected.connectorOutcomes[0].reason, 'not-connected');
  const stale = await resolveTurnAttachments({
    metadata: SCRIBE_TOGGLE, providerId: 'anthropic',
    connectorArming: { connectionFor: async () => ({ state: 'needs-reconnect', refreshTokenRef: null }), mintAccessToken: armingOk.mintAccessToken },
  });
  assert.deepEqual(stale.mcpServers, []);
  assert.equal(stale.connectorOutcomes[0].reason, 'connection-needs-reconnect');
});

test('attachments: REFRESH FAILURE = unarmed + recorded, never a fake arm', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: SCRIBE_TOGGLE,
    providerId: 'anthropic',
    connectorArming: {
      connectionFor: armingOk.connectionFor,
      mintAccessToken: async () => ({ ok: false, code: 'invalid_grant', reason: 'The Scribe renewal key is no longer valid.' }),
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
    mcpServers: [{ entryId: 'helmian-scribe', name: 'helmian-scribe', url: SCRIBE_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['anthropic-beta'], ANTHROPIC_MCP_BETA);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.mcp_servers, [{
    type: 'url',
    url: SCRIBE_MCP_URL,
    name: 'helmian-scribe',
    // INTACT — not [REDACTED]. The token is attached after the
    // redaction pass precisely so this holds; if the ordering ever
    // regresses, this assertion is the one that catches it.
    authorization_token: FAKE_DOOR_JWT,
  }]);
  assert.deepEqual(body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'helmian-scribe' }]);
});

test('adapter: armed beside function tools and web search, both survive', async () => {
  const toolDefs = [{
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  }];
  const { calls } = await anthropicTurnCapture({
    toolDefs,
    webSearch: true,
    mcpServers: [{ name: 'helmian-scribe', url: SCRIBE_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
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
      { type: 'mcp_tool_use', id: 'mcp-1', name: 'search_memory', server_name: 'helmian-scribe', input: { query: 'Bryce' } },
      { type: 'mcp_tool_result', tool_use_id: 'mcp-1', is_error: false, content: [{ type: 'text', text: 'three messages found' }] },
    ],
  };
  const { reply: out } = await anthropicTurnCapture({
    reply,
    mcpServers: [{ name: 'helmian-scribe', url: SCRIBE_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
  });
  assert.equal(out.content, 'I searched the shared memory.');
  assert.deepEqual(out.toolCalls, []);
  assert.deepEqual(out.mcpToolCalls, [{
    id: 'mcp-1', name: 'search_memory', serverName: 'helmian-scribe', input: { query: 'Bryce' },
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
      { type: 'mcp_tool_use', id: 'mcp-1', name: 'search_memory', server_name: 'helmian-scribe', input: { query: 'Bryce' } },
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
      mcpServers: [{ entryId: 'helmian-scribe', name: 'helmian-scribe', url: SCRIBE_MCP_URL, authorizationToken: FAKE_DOOR_JWT }],
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(result.text, 'Found it in the shared memory.');
    // The wire: mcp_servers present, and the ONLY tool declared is the
    // toolset — no local function tools were invented for the server.
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.mcp_servers[0].name, 'helmian-scribe');
    assert.deepEqual(body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'helmian-scribe' }]);
    // The turn record: one evidence entry, round 0, naming the call
    // and its result; the same evidence was announced as an event.
    assert.equal(result.mcpEvidence.length, 1);
    assert.equal(result.mcpEvidence[0].round, 0);
    assert.equal(result.mcpEvidence[0].calls[0].name, 'search_memory');
    assert.equal(result.mcpEvidence[0].results[0].content, 'three messages found');
    const announced = events.filter((ev) => ev.type === 'mcp_evidence');
    assert.equal(announced.length, 1);
    assert.equal(announced[0].calls[0].serverName, 'helmian-scribe');
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

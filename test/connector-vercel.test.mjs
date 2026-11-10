// Vercel as a Helmian-brokered connector (connector-catalog.mjs
// Source 4): Vercel's own published MCP server, carried by Helmian's
// EXISTING roads — no new road was built for it. The pins:
//
//   (1) the catalog entry's shape: brokerMode 'helmian', the endpoint
//       Vercel's own docs publish (https://mcp.vercel.com), the
//       token road (authMode 'header' — the OAuth road is not
//       claimed), the plain-truth connect words, and the seats named
//       for it (claude, chatgpt, grok) — and no others;
//   (2) Grok's Source 1 Vercel MIRROR (id 'vercel') is untouched
//       data beside it — same name, different id, different pipe;
//   (3) the road exercise, end to end at module level against a
//       loopback MCP stub standing in for Vercel's server:
//         probe with NO credential (the gate machinery) → freeze
//         from the probe's tool list → connect asks for the key →
//         connect/header stores the token in the credential service
//         and lands a connection holding the reference only →
//         dispatch arms the pair with the person's own token and
//         the frozen set;
//   (4) the production freeze road for a catalog entry: with no
//       snapshot yet, dispatch's first-arm backstop lists the tools
//       WITH the person's token and freezes them — and with no
//       resolvable token it refuses honestly ('freeze-failed')
//       instead of arming unfrozen.
//
// Fakes for the stores and the credential service (the
// connector-custom-gate.test.mjs harnesses); the probe, the write
// handler, and dispatch are the real modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  CONNECTOR_CATALOG,
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import {
  classifyCustomGate,
  customGateKey,
  probeCustomGate,
  registerCustomGateIntent,
} from '../src/cloud/connector-custom-gate.mjs';
import { PROBE_METHOD_TOOLS_LIST } from '../src/cloud/tool-connections.mjs';
import { buildConnectorTokenRef, planToolSnapshot } from '../src/cloud/connector-library.mjs';
import {
  createConnectorLibraryWriteHandler,
  effectiveAuthMode,
} from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const PERSON = 'user:troy';
const OWNER = { subject: PERSON, tenantId: TENANT, role: 'owner' };
const ENTRY_ID = 'helmian-vercel';
const ENDPOINT = 'https://mcp.vercel.com';
const STUB_TOKEN = 'STUB-VERCEL-TOKEN-123';
const P = '/api/admin/connector-library';

const VERCEL_TOOLS = [
  { name: 'list_projects', description: 'List the account’s projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_deployment', description: 'Read one deployment and its build logs', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'deploy_to_vercel', description: 'Deploy a project', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];

// ------------------------------------------------------------ catalog

test('catalog: the Vercel entry is a first-class Helmian-brokered entry on the token road', () => {
  for (const seatId of ['claude', 'chatgpt', 'grok']) {
    const def = catalogEntryById(seatId, ENTRY_ID);
    assert.ok(def, `${seatId}: stocked`);
    assert.equal(def.kind, 'catalog');
    assert.equal(def.name, 'Vercel');
    assert.equal(def.brokerMode, 'helmian', `${seatId}: Helmian runs this pipe — it is not a mirror`);
    assert.equal(def.mcpEndpointUrl, ENDPOINT, `${seatId}: the endpoint Vercel's own docs publish`);
    assert.equal(def.authMode, 'header', `${seatId}: the access-token road — OAuth is not claimed`);
    assert.equal(def.vendorName, 'Vercel');
    assert.equal(def.trustLabel, 'verified', `${seatId}: Vercel's own published server`);
    assert.equal(def.iconRef, 'icon:vercel');
    assert.equal(def.category, 'development');
    assert.equal(def.addedBy, 'system');
    assert.equal(def.vendorPublished, true, `${seatId}: the Source 4 provenance marker the §3.1 pin rules by`);
    assert.equal(def.vendorConnectorRef, undefined, `${seatId}: a brokered entry carries no vendor ref`);
    // The connect words tell the plain truth: a token the person
    // creates in their own Vercel account settings.
    assert.match(def.scopesSummary, /Vercel access token/);
    assert.match(def.scopesSummary, /your own Vercel account settings/);
    assert.ok(!/OAuth|sign in with Vercel/i.test(def.scopesSummary), `${seatId}: no OAuth claim in the connect words`);
    // The catalog is the authority for the entry's auth road: even a
    // stored row carrying a stale label rules 'header'.
    assert.equal(effectiveAuthMode({ ...def, authMode: 'oauth' }), 'header', `${seatId}: catalog authMode wins over a stored row`);
  }
  assert.equal(CONNECTOR_CATALOG.length, 89, '75 (Sources 1–3) + the Vercel entry on three seats + Bite R2: Slack/Asana/HubSpot on three seats and the Figma mirror on two');
});

test('catalog: no seat outside the named three carries the brokered Vercel entry', () => {
  for (const seatId of LIVE_SEATS) {
    if (['claude', 'chatgpt', 'grok'].includes(seatId)) continue;
    assert.equal(catalogEntryById(seatId, ENTRY_ID), null, `${seatId}: not stocked`);
  }
  for (const seatId of ['claude', 'chatgpt', 'grok']) {
    const ids = catalogEntriesForSeat(seatId).map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, `${seatId}: no id collision from the addition`);
    assert.equal(ids.filter((id) => id === ENTRY_ID).length, 1, `${seatId}: exactly one brokered Vercel entry`);
  }
});

test('catalog: Grok’s Vercel mirror is untouched beside the brokered entry — same name, different pipe', () => {
  const mirror = catalogEntryById('grok', 'vercel');
  assert.ok(mirror, 'the Source 1 mirror still exists as data');
  assert.equal(mirror.brokerMode, 'vendor');
  assert.equal(mirror.vendorConnectorRef.manageUrl, 'https://grok.com/connectors');
  assert.equal(mirror.mcpEndpointUrl, undefined, 'a mirror has no Helmian pipe');
  const brokered = catalogEntryById('grok', ENTRY_ID);
  assert.equal(brokered.name, mirror.name, 'one name, represented by the brokered row');
  assert.notEqual(brokered.id, mirror.id, 'different ids — the §3.2 prefix law keeps them distinct entries');
});

test('refresh road: the seed carries the Vercel definition to its seats like any catalog data', async () => {
  const recorded = [];
  const fakeStore = { createEntry: async (tenantId, subject, def) => { recorded.push(def); return def; } };
  const refresh = createCatalogRefresh({ libraryStore: fakeStore, subject: 'system' });
  const claude = await refresh.refreshSeat(TENANT, 'claude');
  assert.deepEqual(claude.conflicts, []);
  assert.ok(claude.applied.includes(ENTRY_ID), 'claude seed applies the Vercel entry');
  const def = recorded.find((d) => d.seatId === 'claude' && d.id === ENTRY_ID);
  assert.equal(def.brokerMode, 'helmian');
  assert.equal(def.mcpEndpointUrl, ENDPOINT);
  assert.equal(def.authMode, 'header');
  const gemini = await refresh.refreshSeat(TENANT, 'gemini');
  assert.ok(!gemini.applied.includes(ENTRY_ID), 'an unstocked seat seeds no Vercel entry');
});

// ------------------------------------------------------------ harnesses

function fakeToolConnections() {
  const rows = new Map();
  const keyOf = (k) => `${k.scopeKind}|${k.scopeId}|${k.serviceId}`;
  return {
    rows,
    async register(tenantId, subject, input) {
      if ('state' in input) throw Object.assign(new Error('state cannot be set at registration'), { status: 400 });
      const k = keyOf(input);
      const existing = rows.get(k);
      const row = {
        scopeKind: input.scopeKind, scopeId: input.scopeId, serviceId: input.serviceId,
        kind: input.kind, serverRef: input.serverRef,
        credentialReference: input.credentialReference ?? null,
        accountLabel: input.accountLabel ?? null, grantedScopes: [],
        state: existing?.state ?? 'registered',
        lastVerifiedAt: existing?.lastVerifiedAt ?? null,
        probeMethod: existing?.probeMethod ?? null,
        lastToolsCount: existing?.lastToolsCount ?? null,
        lastError: existing?.lastError ?? null,
        updatedBySubject: subject, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date(),
      };
      rows.set(k, row);
      return row;
    },
    async get(tenantId, key) { return rows.get(keyOf(key)) ?? null; },
    async beginProbe(tenantId, key) {
      const row = rows.get(keyOf(key));
      if (!row || row.state === 'revoked') throw Object.assign(new Error('tool connection not found, or revoked'), { status: 404 });
      row.state = 'probing';
      return row;
    },
    async recordProbeReceipt(tenantId, key, receipt) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'verified'; row.lastVerifiedAt = new Date(); row.probeMethod = receipt.method;
      row.lastToolsCount = receipt.toolsCount; row.lastError = null;
      return row;
    },
    async recordProbeFailure(tenantId, key, failure) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'failed'; row.probeMethod = failure.method ?? PROBE_METHOD_TOOLS_LIST;
      row.lastError = failure.error; row.lastVerifiedAt = null; row.lastToolsCount = null;
      return row;
    },
  };
}

function fakeLibraryStore(entries = {}) {
  const calls = [];
  const connections = new Map();
  const snapshots = new Map();
  const connKey = (p, s, e) => `${p}/${s}/${e}`;
  return {
    calls, connections, snapshots, entries,
    async getEntry(tenantId, seatId, entryId) { calls.push(['getEntry', seatId, entryId]); return entries[`${seatId}/${entryId}`] ?? null; },
    async createConnection(tenantId, subject, input) {
      calls.push(['createConnection', input]);
      const connection = { state: 'connected', posture: 'ask', toolEnableMap: {}, toolSnapshotRef: null, ...input };
      connections.set(connKey(input.personId, input.seatId, input.entryId), connection);
      return connection;
    },
    async getConnection(tenantId, key) { return connections.get(connKey(key.personId, key.seatId, key.entryId)) ?? null; },
    async freezeSnapshot(tenantId, key, tools, subject) {
      calls.push(['freezeSnapshot', key, tools]);
      const plan = planToolSnapshot(tools);
      const snapshot = { id: 42, connectionId: 1, takenAt: null, tools: plan.tools, snapshotHash: plan.snapshotHash };
      snapshots.set(connKey(key.personId, key.seatId, key.entryId), snapshot);
      const conn = connections.get(connKey(key.personId, key.seatId, key.entryId));
      if (conn) conn.toolSnapshotRef = 42;
      return snapshot;
    },
    async getCurrentSnapshot(tenantId, key) { return snapshots.get(connKey(key.personId, key.seatId, key.entryId)) ?? null; },
  };
}

function fakeCredentials() {
  const calls = [];
  return {
    calls,
    async storeCredential(input) { calls.push(['storeCredential', input]); return { accepted: true, status: 'stored' }; },
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input]);
      return { accepted: true, credential: { apiKey: STUB_TOKEN } };
    },
    async revokeVaultCredential() { return { accepted: true, status: 'revoked' }; },
  };
}

function writeHarness({ store, credentials }) {
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: { async save() { return true; }, async take() { return null; } },
    credentialClient: credentials,
    oauthClientFor: () => null,
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const sent = [];
  return {
    sent,
    async run(path, { body = {}, actor = OWNER } = {}) {
      const requestUrl = new URL(path, 'https://helmian.cloud');
      const handled = await handler({
        request: { method: 'POST' }, response: {}, requestUrl,
        activeTenantActor: async () => actor,
        send: (response, status, payload, contentType) => { sent.push({ status, payload, contentType }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? ''); } catch { /* html */ }
      return { handled, status: last?.status, json };
    },
  };
}

async function startVercelStub() {
  const state = { methods: [], auth: [] };
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
        reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'vercel-stub', version: '1' } } });
        return;
      }
      if (msg.method === 'tools/list') {
        reply({ jsonrpc: '2.0', id: msg.id, result: { tools: VERCEL_TOOLS } });
        return;
      }
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { state, url, close: () => new Promise((r) => server.close(r)) };
}

const seededStore = (seatId = 'claude') => {
  const def = catalogEntryById(seatId, ENTRY_ID);
  return fakeLibraryStore({ [`${seatId}/${ENTRY_ID}`]: { ...def, state: 'available' } });
};
const KEY = { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID };
const NO_LIST = async () => { throw new Error('listTools must not be called'); };

// ------------------------------------------------------------ the road

test('road: probe with no credential → freeze from its list → header connect lands the reference only → dispatch arms', async () => {
  const stub = await startVercelStub();
  try {
    const def = catalogEntryById('claude', ENTRY_ID);
    // The stub stands in for Vercel's server: the probe machinery
    // runs against the registered row's address, so the intent is
    // registered with the stub's URL in the entry's place (the
    // gate test's own pattern). Everything else is the real entry.
    const probeEntry = { ...def, mcpEndpointUrl: stub.url };

    // 1 — intent + the null-credential probe (the gate machinery).
    const tc = fakeToolConnections();
    const intent = await registerCustomGateIntent(tc, TENANT, PERSON, probeEntry);
    assert.equal(intent.credentialReference, null, 'the probe row names no credential');
    assert.equal(intent.serverRef, stub.url);
    const probe = await probeCustomGate({ toolConnections: tc, tenantId: TENANT, entry: probeEntry });
    assert.equal(probe.state, 'verified');
    assert.equal(probe.tools.length, VERCEL_TOOLS.length, 'the probe returns the tool list the freeze is planned from');
    assert.ok(stub.state.auth.length > 0, 'the probe really contacted the server');
    assert.ok(stub.state.auth.every((a) => a === null), 'no Authorization header rode any probe request');
    const gateRow = await tc.get(TENANT, customGateKey('claude', ENTRY_ID));
    assert.equal(classifyCustomGate(gateRow).passed, true);

    // 2 — freeze from the probe's own tool list.
    const store = seededStore();
    const credentials = fakeCredentials();
    const frozen = await store.freezeSnapshot(TENANT, KEY, probe.tools, PERSON);
    assert.deepEqual(frozen.tools, planToolSnapshot(VERCEL_TOOLS).tools, 'the frozen set is planned from the probe’s list');

    // 3 — connect: the header road asks for the key first.
    const h = writeHarness({ store, credentials });
    const start = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: ENTRY_ID } });
    assert.equal(start.status, 200);
    assert.equal(start.json.status, 'needs-credential');
    assert.equal(start.json.completeAction, 'connect/header');
    const expectedRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: ENTRY_ID, personId: PERSON, tokenKind: 'access' });
    assert.equal(start.json.accessTokenRef, expectedRef);
    assert.equal(start.json.providerId, 'connector.claude.helmian-vercel');
    assert.equal(store.connections.size, 0, 'nothing is connected before the key lands');

    // 4 — connect/header: the token goes to the credential service;
    // the library lands a connection holding the reference only.
    const landed = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: ENTRY_ID, apiKey: STUB_TOKEN, accountLabel: 'Vercel (token)' } });
    assert.equal(landed.status, 201);
    assert.equal(landed.json.status, 'connected');
    const [storeCall] = credentials.calls.filter(([n]) => n === 'storeCredential');
    assert.equal(storeCall[1].providerId, 'connector.claude.helmian-vercel');
    assert.equal(storeCall[1].credentialReference, expectedRef);
    assert.equal(storeCall[1].credentialKind, 'api_key');
    assert.equal(storeCall[1].apiKey, STUB_TOKEN, 'the value went to the credential service');
    const connection = await store.getConnection(TENANT, KEY);
    assert.equal(connection.accessTokenRef, expectedRef);
    assert.equal(connection.accountIdentity, 'Vercel (token)');
    assert.ok(!JSON.stringify(connection).includes(STUB_TOKEN), 'the library record never holds the token itself');

    // 5 — dispatch arms the pair: the person's own token, resolved
    // from the connection's reference, and the frozen set — the
    // backstop lister never runs, and no gate is consulted for a
    // catalog entry (the gate governs customs only).
    const record = await resolveArmingRecord({
      store, credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: null,
      tenantId: TENANT, personId: PERSON, seatId: 'claude', entryId: ENTRY_ID,
    });
    assert.equal(record.state, 'connected');
    assert.equal(record.accessToken, STUB_TOKEN);
    assert.equal(record.tokenSource, 'connection', 'the person’s own connection is first in the token order');
    assert.equal(record.endpointUrl, ENDPOINT);
    assert.equal(record.authMode, 'header');
    assert.equal(record.posture, 'ask');
    assert.deepEqual(record.snapshotTools.map((t) => t.name), planToolSnapshot(VERCEL_TOOLS).tools.map((t) => t.name), 'the armed set is the frozen set (the plan’s name order)');
    const [resolveCall] = credentials.calls.filter(([n]) => n === 'resolveVaultCredential');
    assert.equal(resolveCall[1].credentialReference, expectedRef, 'dispatch resolved the connection’s own reference');
  } finally {
    await stub.close();
  }
});

test('road: with no snapshot yet, the first-arm backstop lists WITH the person’s token and freezes; no token, no arm', async () => {
  const store = seededStore();
  const credentials = fakeCredentials();
  const h = writeHarness({ store, credentials });
  await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: ENTRY_ID } });
  const landed = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: ENTRY_ID, apiKey: STUB_TOKEN } });
  assert.equal(landed.status, 201);
  assert.equal(await store.getCurrentSnapshot(TENANT, KEY), null, 'a catalog connect lands with no snapshot — the freeze is dispatch’s backstop');

  const listCalls = [];
  const record = await resolveArmingRecord({
    store, credentials,
    listTools: async ({ endpoint, accessToken }) => {
      listCalls.push({ endpoint, accessToken });
      return { supported: true, tools: VERCEL_TOOLS };
    },
    operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId: 'claude', entryId: ENTRY_ID,
  });
  assert.equal(record.state, 'connected');
  assert.deepEqual(listCalls, [{ endpoint: ENDPOINT, accessToken: STUB_TOKEN }], 'the backstop listed the entry’s real endpoint with the person’s token');
  assert.deepEqual(record.snapshotTools.map((t) => t.name), planToolSnapshot(VERCEL_TOOLS).tools.map((t) => t.name));
  assert.ok(await store.getCurrentSnapshot(TENANT, KEY), 'the backstop froze the snapshot onto the connection');

  // No resolvable token and no snapshot: the honest refusal.
  const bare = seededStore();
  await bare.createConnection(TENANT, PERSON, {
    ...KEY, accountIdentity: 'API key',
    accessTokenRef: buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: ENTRY_ID, personId: PERSON, tokenKind: 'access' }),
    grantedScopes: [],
  });
  const refused = await resolveArmingRecord({
    store: bare,
    credentials: { resolveVaultCredential: async () => ({ accepted: false }) },
    listTools: NO_LIST, operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId: 'claude', entryId: ENTRY_ID,
  });
  assert.equal(refused.state, 'freeze-failed', 'no token and no frozen list: dispatch refuses rather than arming unfrozen');
});

test('road: before anyone connects, dispatch rules the pair not-connected — never armed, never token-hunting', async () => {
  const store = seededStore();
  let resolutions = 0;
  const record = await resolveArmingRecord({
    store,
    credentials: { resolveVaultCredential: async () => { resolutions += 1; return { accepted: true, credential: 'x' }; } },
    listTools: NO_LIST, operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId: 'claude', entryId: ENTRY_ID,
  });
  assert.equal(record.state, 'not-connected');
  assert.equal(record.reason, 'not-connected');
  assert.equal(resolutions, 0);
});

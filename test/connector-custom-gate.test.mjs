// Custom-entry gate (pipeline map G1): a custom connector entry is
// registered as intent, probed with NO credential, frozen from that
// probe, and postured 'ask' — and until the gate has passed it can
// neither connect nor arm. The pins, by requirement:
//
//   (a) an ungated custom entry cannot produce an armed record —
//       dispatch resolves 'not-gated' and never resolves its token;
//       a gated entry with no frozen snapshot gets NO backstop
//       freeze at arm time;
//   (b) the gate probe sends no credential — proven against a real
//       loopback MCP server whose row DOES carry a credential
//       reference: with forceNoCredential the server sees no
//       Authorization header, without it the same probe sends the
//       token (the control that proves the pin can catch a leak);
//   (c) a failed probe leaves the entry unarmable AND unconnectable,
//       with the failure recorded on its gate row (receipt cleared);
//   (d) the gate's other faces: create registers provenance and
//       probes; connect freezes the probe's list and lands posture
//       'ask' whatever the body asked; a header key is never stored
//       for an ungated server; the library read caps an ungated
//       custom row at not-connected and the panel words it
//       ("Not ready — safety check has not passed" /
//       "Check failed — not ready") with no toggle.
//
// Fakes throughout, plus the one real-probe section (b) which uses
// the repo's real tool-connections store over an in-memory fake
// pool and a loopback HTTP MCP stub — the tool-connections.test.mjs
// pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  classifyCustomGate,
  customGateKey,
  customGateServiceId,
  registerCustomGateIntent,
} from '../src/cloud/connector-custom-gate.mjs';
import { createToolConnectionsStore, PROBE_METHOD_TOOLS_LIST } from '../src/cloud/tool-connections.mjs';
import { probeToolConnection } from '../src/agent/tool-connection-probe.mjs';
import { planToolSnapshot } from '../src/cloud/connector-library.mjs';
import { resolveArmingRecord, resolveDispatchArming } from '../src/cloud/connector-arming-dispatch.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { level2Model } from '../web/marketing/app/connector-panel.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const OWNER = { subject: 'user:troy', tenantId: TENANT, role: 'owner' };

const GATE_TOOLS = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set an alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];

const CUSTOM_ENTRY = (over = {}) => ({
  seatId: 'claude', id: 'custom-weather', kind: 'custom', name: 'Weather', oneLiner: 'Weather tools',
  vendorName: 'Custom', trustLabel: 'custom', brokerMode: 'helmian',
  mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header', state: 'available',
  addedBy: 'user:troy', ...over,
});

// ------------------------------------------------- fake tool store
// The tool-connections store's contract in JS: register writes
// intent only (a state field is refused; a changed target clears
// the receipt), recordProbeReceipt is the only writer of verified,
// recordProbeFailure clears the receipt.
function fakeToolConnections() {
  const rows = new Map();
  const calls = [];
  const keyOf = (k) => `${k.scopeKind}|${k.scopeId}|${k.serviceId}`;
  return {
    rows, calls,
    async register(tenantId, subject, input) {
      calls.push(['register', input, subject]);
      if ('state' in input) throw Object.assign(new Error('state cannot be set at registration'), { status: 400 });
      const k = keyOf(input);
      const existing = rows.get(k);
      const changed = Boolean(existing) && (existing.kind !== input.kind || existing.serverRef !== input.serverRef);
      const row = {
        scopeKind: input.scopeKind, scopeId: input.scopeId, serviceId: input.serviceId,
        kind: input.kind, serverRef: input.serverRef,
        credentialReference: input.credentialReference ?? null,
        accountLabel: input.accountLabel ?? null, grantedScopes: [],
        state: changed ? 'registered' : (existing?.state ?? 'registered'),
        lastVerifiedAt: changed ? null : (existing?.lastVerifiedAt ?? null),
        probeMethod: changed ? null : (existing?.probeMethod ?? null),
        lastToolsCount: changed ? null : (existing?.lastToolsCount ?? null),
        lastError: changed ? null : (existing?.lastError ?? null),
        updatedBySubject: subject, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date(),
      };
      rows.set(k, row);
      return row;
    },
    async get(tenantId, key) { calls.push(['get', key]); return rows.get(keyOf(key)) ?? null; },
    async list() { return [...rows.values()]; },
    async beginProbe(tenantId, key, subject) {
      const row = rows.get(keyOf(key));
      if (!row || row.state === 'revoked') throw Object.assign(new Error('tool connection not found, or revoked'), { status: 404 });
      row.state = 'probing'; row.updatedBySubject = subject;
      return row;
    },
    async recordProbeReceipt(tenantId, key, receipt, subject) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'verified'; row.lastVerifiedAt = new Date(); row.probeMethod = receipt.method;
      row.lastToolsCount = receipt.toolsCount; row.lastError = null; row.updatedBySubject = subject;
      return row;
    },
    async recordProbeFailure(tenantId, key, failure, subject) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'failed'; row.probeMethod = failure.method ?? PROBE_METHOD_TOOLS_LIST; row.lastError = failure.error;
      row.lastVerifiedAt = null; row.lastToolsCount = null; row.updatedBySubject = subject;
      return row;
    },
  };
}

// A gate probe with a switchable outcome, writing its receipts
// through the real store roads the route hands it — the same shape
// the production probe returns.
function switchableGateProbe(outcome) {
  return async ({ tenantId, entry, toolConnections }) => {
    const key = customGateKey(entry.seatId, entry.id);
    await toolConnections.beginProbe(tenantId, key, 'system:tool-probe');
    if (outcome.mode === 'verified') {
      const row = await toolConnections.recordProbeReceipt(tenantId, key, { method: PROBE_METHOD_TOOLS_LIST, toolsCount: GATE_TOOLS.length }, 'system:tool-probe');
      return { probed: true, state: 'verified', toolsCount: GATE_TOOLS.length, tools: GATE_TOOLS, row };
    }
    const row = await toolConnections.recordProbeFailure(tenantId, key, { method: PROBE_METHOD_TOOLS_LIST, error: outcome.error ?? 'HTTP 500 from the server' }, 'system:tool-probe');
    return { probed: true, state: 'failed', error: outcome.error ?? 'HTTP 500 from the server', row };
  };
}

// ------------------------------------------------------------- gate module

test('gate key: the service id is the entry id when it fits the 64-char cap, a stable hash when it does not', () => {
  assert.deepEqual(customGateKey('claude', 'custom-weather'), { scopeKind: 'workspace', scopeId: 'claude', serviceId: 'custom-weather' });
  const longId = `custom-${'a'.repeat(80)}`;
  const hashed = customGateServiceId(longId);
  assert.ok(hashed.length <= 64, 'hashed service id fits sql/061');
  assert.equal(hashed, customGateServiceId(longId), 'deterministic — every reader computes the same key');
  assert.notEqual(hashed, customGateServiceId(`custom-${'b'.repeat(80)}`));
});

test('gate classification: only a verified state carrying its receipt passes', () => {
  assert.equal(classifyCustomGate(null).state, 'missing');
  assert.equal(classifyCustomGate(null).passed, false);
  assert.equal(classifyCustomGate(null).reason, 'not-gated');
  assert.equal(classifyCustomGate({ state: 'registered', lastVerifiedAt: null }).passed, false);
  assert.equal(classifyCustomGate({ state: 'probing', lastVerifiedAt: null }).passed, false);
  const failed = classifyCustomGate({ state: 'failed', lastVerifiedAt: null, lastError: 'HTTP 500' });
  assert.equal(failed.passed, false);
  assert.equal(failed.reason, 'gate-check-failed');
  assert.equal(failed.lastError, 'HTTP 500');
  assert.equal(classifyCustomGate({ state: 'verified', lastVerifiedAt: new Date() }).passed, true);
  // A verified state with no receipt timestamp is ruled unpassed —
  // the store cannot write one, and the gate does not pretend.
  assert.equal(classifyCustomGate({ state: 'verified', lastVerifiedAt: null }).passed, false);
  assert.equal(classifyCustomGate({ state: 'revoked', lastVerifiedAt: null }).passed, false);
});

test('gate intent: register records who added it, the URL, and no credential — and lands as intent, never verified', async () => {
  const tc = fakeToolConnections();
  const entry = CUSTOM_ENTRY();
  const row = await registerCustomGateIntent(tc, TENANT, 'user:troy', entry);
  assert.equal(row.state, 'registered');
  assert.equal(row.serverRef, 'https://weather.example.com/mcp', 'the URL is the provenance record');
  assert.equal(row.updatedBySubject, 'user:troy', 'who added it');
  assert.ok(row.createdAt, 'when (the row timestamp)');
  assert.equal(row.credentialReference, null, 'the gate row names no credential');
  assert.equal(row.accountLabel, 'Weather');
  assert.deepEqual(
    { scopeKind: row.scopeKind, scopeId: row.scopeId, serviceId: row.serviceId },
    { scopeKind: 'workspace', scopeId: 'claude', serviceId: 'custom-weather' },
  );
});

// ------------------------------------------------------------- dispatch (a)

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
      return state.snapshot;
    },
  };
}

const CUSTOM_CONNECTION = {
  personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather', accountIdentity: 'API key',
  accessTokenRef: 'vault://tenant/tenant-a/connector.claude.custom-weather/p-x.access', refreshTokenRef: null,
  grantedScopes: [], posture: 'ask', toolEnableMap: {}, toolSnapshotRef: 7, state: 'connected',
};
const CUSTOM_PLAN = planToolSnapshot(GATE_TOOLS);
const CUSTOM_SNAPSHOT = { id: 7, connectionId: 1, takenAt: null, tools: CUSTOM_PLAN.tools, snapshotHash: CUSTOM_PLAN.snapshotHash };
const NO_LIST = async () => { throw new Error('listTools must not be called'); };

async function gateRow(tc, state, over = {}) {
  const entry = CUSTOM_ENTRY();
  await registerCustomGateIntent(tc, TENANT, 'user:troy', entry);
  const key = customGateKey(entry.seatId, entry.id);
  if (state === 'verified') return tc.recordProbeReceipt(TENANT, key, { method: PROBE_METHOD_TOOLS_LIST, toolsCount: GATE_TOOLS.length }, 'system:tool-probe');
  if (state === 'failed') return tc.recordProbeFailure(TENANT, key, { method: PROBE_METHOD_TOOLS_LIST, error: 'HTTP 500 from the server' }, 'system:tool-probe');
  return tc.get(TENANT, key);
}

test('(a) dispatch: an ungated custom entry cannot arm — not-gated, and its token is never resolved', async () => {
  const tc = fakeToolConnections(); // no gate row at all
  let tokenResolutions = 0;
  const credentials = { resolveVaultCredential: async () => { tokenResolutions += 1; return { accepted: true, credential: 'the-key' }; } };
  const record = await resolveArmingRecord({
    store: fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: CUSTOM_CONNECTION, snapshot: CUSTOM_SNAPSHOT }),
    credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: tc,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(record.state, 'not-gated');
  assert.equal(record.reason, 'not-gated');
  assert.equal(record.accessToken, undefined, 'an ungated record carries no token');
  assert.equal(tokenResolutions, 0, 'the credential road is never walked for an ungated entry');

  // Registered but never probed: same ruling.
  await gateRow(tc, 'registered');
  const pending = await resolveArmingRecord({
    store: fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: CUSTOM_CONNECTION, snapshot: CUSTOM_SNAPSHOT }),
    credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: tc,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(pending.state, 'not-gated');

  // And with no gate store reachable at all, dispatch fails closed.
  const noStore = await resolveArmingRecord({
    store: fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: CUSTOM_CONNECTION, snapshot: CUSTOM_SNAPSHOT }),
    credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(noStore.state, 'not-gated');
});

test('(a) dispatch: a failed gate check unarms as gate-check-failed', async () => {
  const tc = fakeToolConnections();
  await gateRow(tc, 'failed');
  const record = await resolveArmingRecord({
    store: fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: CUSTOM_CONNECTION, snapshot: CUSTOM_SNAPSHOT }),
    credentials: null, listTools: NO_LIST, operatorTokens: {}, toolConnections: tc,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(record.state, 'not-gated');
  assert.equal(record.reason, 'gate-check-failed');
});

test('(a) dispatch: a gated custom entry with no snapshot gets NO backstop freeze — freeze-failed, the lister never runs', async () => {
  const tc = fakeToolConnections();
  await gateRow(tc, 'verified');
  const store = fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: { ...CUSTOM_CONNECTION, toolSnapshotRef: null }, snapshot: null });
  let listCalls = 0;
  const record = await resolveArmingRecord({
    store, credentials: { resolveVaultCredential: async () => ({ accepted: true, credential: 'the-key' }) },
    listTools: async () => { listCalls += 1; return { supported: true, tools: GATE_TOOLS }; },
    operatorTokens: {}, toolConnections: tc,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(record.state, 'freeze-failed');
  assert.equal(record.reason, 'freeze-failed');
  assert.equal(listCalls, 0, 'dispatch never lists an ungated-by-freeze custom server at arm time');
  assert.equal(store.state.freezes.length, 0);
});

test('(a) dispatch: a gated custom entry with its frozen snapshot arms in full; resolveDispatchArming carries the gate store', async () => {
  const tc = fakeToolConnections();
  await gateRow(tc, 'verified');
  const store = fakeArmingStore({ entry: CUSTOM_ENTRY(), connection: CUSTOM_CONNECTION, snapshot: CUSTOM_SNAPSHOT });
  const credentials = { resolveVaultCredential: async () => ({ accepted: true, credential: { apiKey: 'the-key' } }) };
  const record = await resolveArmingRecord({
    store, credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: tc,
    tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
  });
  assert.equal(record.state, 'connected');
  assert.equal(record.accessToken, 'the-key');
  assert.equal(record.posture, 'ask');
  assert.deepEqual(record.snapshotTools.map((t) => t.name), CUSTOM_PLAN.tools.map((t) => t.name));

  const records = await resolveDispatchArming({
    tenantId: TENANT, personId: 'user:troy',
    pairs: [{ seatId: 'claude', entryId: 'custom-weather' }],
    store, credentials, listTools: NO_LIST, operatorTokens: {}, toolConnections: tc,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'connected');
});

// ------------------------------------------------------------- write route

function fakeLibraryStore(entries = {}) {
  const calls = [];
  const connections = new Map();
  const snapshots = new Map();
  const connKey = (p, s, e) => `${p}/${s}/${e}`;
  return {
    calls, connections, snapshots, entries,
    async getEntry(tenantId, seatId, entryId) { calls.push(['getEntry', seatId, entryId]); return entries[`${seatId}/${entryId}`] ?? null; },
    async createEntry(tenantId, subject, input) {
      calls.push(['createEntry', input]);
      const entry = { ...input, state: 'available' };
      entries[`${input.seatId}/${input.id}`] = entry;
      return entry;
    },
    async createConnection(tenantId, subject, input) {
      calls.push(['createConnection', input]);
      // The real store's law: posture defaults to 'ask' when the
      // caller does not name one.
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
    async removeEntry(tenantId, seatId, entryId) { calls.push(['removeEntry', seatId, entryId]); delete entries[`${seatId}/${entryId}`]; return { seatId, id: entryId }; },
    async setEntryState(tenantId, seatId, entryId, state) { calls.push(['setEntryState', seatId, entryId, state]); return { seatId, id: entryId, state }; },
    async setPosture(tenantId, key, posture) { calls.push(['setPosture', key, posture]); return { ...key, posture, state: 'connected' }; },
    async disconnectConnection() { throw Object.assign(new Error('connection not found'), { status: 404 }); },
  };
}

function fakeCredentials() {
  const calls = [];
  return {
    calls,
    async storeCredential(input) { calls.push(['storeCredential', input]); return { accepted: true, status: 'stored' }; },
    async resolveVaultCredential() { calls.push(['resolveVaultCredential']); return { accepted: true, credential: 'the-key-itself' }; },
    async revokeVaultCredential() { calls.push(['revokeVaultCredential']); return { accepted: true, status: 'revoked' }; },
  };
}

function writeHarness({ store, toolConnections, gateProbe, credentials } = {}) {
  const handler = createConnectorLibraryWriteHandler({
    store: store ?? fakeLibraryStore(),
    pendingStore: { async save() { return true; }, async take() { return null; } },
    credentialClient: credentials ?? fakeCredentials(),
    oauthClientFor: () => null,
    ...(toolConnections !== undefined ? { toolConnections } : {}),
    ...(gateProbe !== undefined ? { gateProbe } : {}),
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const sent = [];
  return {
    sent,
    async run(path, { method = 'POST', body = {}, actor = OWNER } = {}) {
      const requestUrl = new URL(path, 'https://helmian.cloud');
      const handled = await handler({
        request: { method }, response: {}, requestUrl,
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

const P = '/api/admin/connector-library';

test('create: a custom entry registers its intent (provenance) and is probed before it is offered', async () => {
  const store = fakeLibraryStore();
  const tc = fakeToolConnections();
  const outcome = { mode: 'verified' };
  const h = writeHarness({ store, toolConnections: tc, gateProbe: switchableGateProbe(outcome) });
  const out = await h.run(`${P}/entries`, { body: { seatId: 'grok', name: 'My Weather MCP', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header' } });
  assert.equal(out.status, 201);
  assert.equal(out.json.gate.state, 'verified');
  assert.equal(out.json.gate.toolsCount, GATE_TOOLS.length);
  const row = await tc.get(TENANT, customGateKey('grok', 'custom-my-weather-mcp'));
  assert.equal(row.state, 'verified');
  assert.equal(row.serverRef, 'https://weather.example.com/mcp');
  assert.equal(row.lastToolsCount, GATE_TOOLS.length);
  const [registerCall] = tc.calls.filter(([n]) => n === 'register');
  assert.equal(registerCall[2], 'user:troy', 'registration names the person who added it');
  assert.equal(registerCall[1].credentialReference, null);
});

test('(c) a failed probe leaves the entry standing but unconnectable, with the failure on its gate row', async () => {
  const store = fakeLibraryStore();
  const tc = fakeToolConnections();
  const outcome = { mode: 'failed', error: 'HTTP 500 from the server' };
  const h = writeHarness({ store, toolConnections: tc, gateProbe: switchableGateProbe(outcome) });
  const created = await h.run(`${P}/entries`, { body: { seatId: 'claude', name: 'Weather', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'none' } });
  assert.equal(created.status, 201, 'the entry is created — as intent, honestly gated');
  assert.equal(created.json.gate.state, 'failed');
  assert.match(created.json.gate.error, /HTTP 500/);
  const row = await tc.get(TENANT, customGateKey('claude', 'custom-weather'));
  assert.equal(row.state, 'failed');
  assert.match(row.lastError, /HTTP 500/, 'the failure is recorded on the gate row');
  assert.equal(row.lastVerifiedAt, null, 'no receipt survives a failure');

  const connect = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'custom-weather' } });
  assert.equal(connect.status, 409);
  assert.equal(connect.json.code, 'CUSTOM_GATE_NOT_PASSED');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'nothing was connected');
});

test('connect heals: a server that answers later passes on the connect click, freezes the probe list, and lands at ask', async () => {
  const store = fakeLibraryStore();
  const tc = fakeToolConnections();
  const outcome = { mode: 'failed' };
  const h = writeHarness({ store, toolConnections: tc, gateProbe: switchableGateProbe(outcome) });
  await h.run(`${P}/entries`, { body: { seatId: 'claude', name: 'Weather', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'none' } });
  outcome.mode = 'verified';
  // The body asks for the loosest posture; a custom entry lands at
  // 'ask' regardless (gate step 4).
  const connect = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'custom-weather', posture: 'all' } });
  assert.equal(connect.status, 201);
  assert.equal(connect.json.gate.state, 'verified');
  assert.equal(connect.json.gate.frozen, true);
  const [, connInput] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(connInput.posture, undefined, 'no posture rides the custom connect — the store default (ask) rules');
  assert.equal(connect.json.connection.posture, 'ask');
  const freeze = store.calls.find(([n]) => n === 'freezeSnapshot');
  assert.ok(freeze, 'the connection was frozen at connect');
  assert.deepEqual(freeze[2], GATE_TOOLS, 'the frozen list is the gate probe\u2019s own list — the uncredentialed look');
});

test('connect/header: the key is never stored for an ungated server; a gated one lands and freezes', async () => {
  const store = fakeLibraryStore({ 'claude/custom-weather': CUSTOM_ENTRY() });
  const tc = fakeToolConnections();
  const outcome = { mode: 'failed' };
  const credentials = fakeCredentials();
  const h = writeHarness({ store, toolConnections: tc, gateProbe: switchableGateProbe(outcome), credentials });
  const refused = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: 'custom-weather', apiKey: 'sk-weather' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'CUSTOM_GATE_NOT_PASSED');
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0, 'no credential is committed to an ungated server');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);

  outcome.mode = 'verified';
  const ok = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: 'custom-weather', apiKey: 'sk-weather', posture: 'all' } });
  assert.equal(ok.status, 201);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 1, 'the key lands once the gate has passed');
  const [, connInput] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(connInput.posture, undefined, 'custom connections land at the default ask');
  assert.equal(ok.json.gate.frozen, true);
});

test('no behaviour change off the gate: a catalog connect keeps its body posture and needs no gate', async () => {
  const docs = {
    seatId: 'cloudflare', id: 'cloudflare-docs', kind: 'catalog', name: 'Cloudflare Docs', vendorName: 'Cloudflare',
    brokerMode: 'helmian', mcpEndpointUrl: 'https://docs.mcp.cloudflare.com/mcp', authMode: 'none', state: 'available',
  };
  const store = fakeLibraryStore({ 'cloudflare/cloudflare-docs': docs });
  const tc = fakeToolConnections();
  const h = writeHarness({ store, toolConnections: tc, gateProbe: switchableGateProbe({ mode: 'failed' }) });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'cloudflare', entryId: 'cloudflare-docs', posture: 'read' } });
  assert.equal(out.status, 201);
  const [, connInput] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(connInput.posture, 'read', 'catalog entries keep the connect-body posture road');
  assert.equal(out.json.gate, undefined, 'no gate rides a catalog connect');
  assert.equal(tc.calls.length, 0, 'the gate store is never consulted for a catalog entry');
});

// ------------------------------------------------------------- probe (b)
// The repo's fake pool for the real tool-connections store
// (tool-connections.test.mjs's pattern), and its loopback MCP stub.

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

async function startHttpStub() {
  const state = { methods: [], auth: [], failList: false };
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
        if (state.failList) { reply({ error: 'tools are down' }, 500); return; }
        reply({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [
              { name: 'stub_read', description: 'reads', inputSchema: { type: 'object' } },
              { name: 'stub_write', description: 'writes', inputSchema: { type: 'object' } },
            ],
          },
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

test('(b) the null-credential gate probe sends NO credential — even when the row names one', async () => {
  const stub = await startHttpStub();
  try {
    const SECRET = 'GATE-PROBE-SECRET-789';
    const store = createToolConnectionsStore(fakePool());
    const key = customGateKey('claude', 'custom-weather');
    // The row deliberately carries a credential reference: if the
    // gate probe resolved references, the secret would be sent.
    await store.register(TENANT, 'user:troy', {
      ...key, kind: 'mcp-http', serverRef: stub.url,
      credentialReference: { type: 'token-source', source: { kind: 'env', name: 'GATE_TEST_TOKEN' } },
    });
    const env = { GATE_TEST_TOKEN: SECRET };

    // Control: the ordinary probe DOES send the resolved token —
    // the stub can catch a credential when one is sent.
    const control = await probeToolConnection({ store, tenantId: TENANT, key, timeoutMs: 10_000, env });
    assert.equal(control.state, 'verified');
    assert.ok(stub.state.auth.some((a) => a === `Bearer ${SECRET}`), 'control: the credentialed probe authenticates');

    // The gate probe: forceNoCredential — the server is examined
    // exactly as the sandbox stage examines a candidate.
    const before = stub.state.auth.length;
    const gated = await probeToolConnection({ store, tenantId: TENANT, key, timeoutMs: 10_000, env, forceNoCredential: true });
    assert.equal(gated.state, 'verified');
    assert.equal(gated.toolsCount, 2);
    assert.equal(gated.tools.length, 2, 'the probe returns the tool list the freeze is planned from');
    const gateRunAuth = stub.state.auth.slice(before);
    assert.ok(gateRunAuth.length > 0, 'the gate probe really contacted the server');
    assert.ok(gateRunAuth.every((a) => a === null), 'no Authorization header rode any gate-probe request');
  } finally {
    await stub.close();
  }
});

// ------------------------------------------------------------- read + panel

function fakeReadStores({ gateRow }) {
  const entry = CUSTOM_ENTRY({ authMode: 'none' });
  const connection = {
    id: 1, personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather',
    accountIdentity: 'No sign-in', accessTokenRef: null, refreshTokenRef: null, grantedScopes: [],
    posture: 'ask', toolEnableMap: {}, toolSnapshotRef: 42, state: 'connected',
    lastDiscoveryAt: null, lastUsedAt: null, createdAt: null, updatedAt: null,
  };
  const libraryStore = {
    async listEntries() { return [entry]; },
    async listConnections() { return [connection]; },
    async listMirrors() { return []; },
  };
  const toolConnectionsStore = {
    async list() { return []; },
    async get(tenantId, key) {
      assert.deepEqual(key, customGateKey('claude', 'custom-weather'));
      return gateRow;
    },
  };
  return createSeatLibraryRead({ libraryStore, toolConnectionsStore });
}

test('read: an ungated custom row never reads connected — the gate caps it and rides in the detail', async () => {
  const failed = await fakeReadStores({ gateRow: { state: 'failed', lastVerifiedAt: null, lastToolsCount: null, lastError: 'HTTP 500' } })
    .readSeatLibrary(TENANT, { personId: 'user:troy', seatId: 'claude' });
  assert.equal(failed.rows[0].state, 'not-connected', 'a recorded connection does not outrank a failed gate');
  assert.equal(failed.rows[0].stateDetail.gate.state, 'failed');
  assert.equal(failed.rows[0].stateDetail.gate.lastError, 'HTTP 500');
  assert.equal(failed.connectedCount, 0);

  const missing = await fakeReadStores({ gateRow: null })
    .readSeatLibrary(TENANT, { personId: 'user:troy', seatId: 'claude' });
  assert.equal(missing.rows[0].state, 'not-connected');
  assert.equal(missing.rows[0].stateDetail.gate.state, 'missing');

  const passed = await fakeReadStores({ gateRow: { state: 'verified', lastVerifiedAt: new Date(), lastToolsCount: 2, lastError: null } })
    .readSeatLibrary(TENANT, { personId: 'user:troy', seatId: 'claude' });
  assert.equal(passed.rows[0].state, 'connected');
  assert.equal(passed.rows[0].stateDetail.gate.passed, true);
  assert.equal(passed.rows[0].stateDetail.posture, 'ask');
  assert.equal(passed.connectedCount, 1);
});

test('panel: the gated row words its state and carries no toggle until the gate passes', async () => {
  const libraryRow = (gate) => ({
    iconRef: null, name: 'Weather', oneLiner: 'Weather tools', vendorLabel: 'Connector by Custom',
    trustLabel: 'custom', state: gate.passed ? 'connected' : 'not-connected',
    entryId: 'custom-weather', seatId: 'claude', kind: 'custom', brokerMode: 'helmian',
    category: null, accountIdentity: gate.passed ? 'No sign-in' : null, stateDetail: { gate },
  });
  const failed = level2Model({ seatId: 'claude', rows: [libraryRow({ state: 'failed', passed: false, lastError: 'HTTP 500' })] }, {}, 'channel:1');
  assert.equal(failed.catalog[0].stateLabel, 'Check failed — not ready');
  assert.equal(failed.catalog[0].toggleable, false);
  assert.equal(failed.catalog[0].gate.state, 'failed');

  const pending = level2Model({ seatId: 'claude', rows: [libraryRow({ state: 'registered', passed: false, lastError: null })] }, {}, 'channel:1');
  assert.equal(pending.catalog[0].stateLabel, 'Not ready — safety check has not passed');
  assert.equal(pending.catalog[0].toggleable, false);

  const passed = level2Model({ seatId: 'claude', rows: [libraryRow({ state: 'verified', passed: true, lastError: null })] }, {}, 'channel:1');
  assert.equal(passed.connected[0].stateLabel, 'Connected as No sign-in');
  assert.equal(passed.connected[0].toggleable, true);
});

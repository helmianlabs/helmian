// Connector library WRITE routes (mirror M1, DESIGN §5): the
// manage surface's server half, exercised with a fake store that
// honours the real store's contract, a fake credential service, a
// fake pending store, and a fake OAuth door.
//
// What is proven here:
//   - gating: membership required; auditors never write; workspace
//     acts (entry-state, add/remove custom) are owner/admin; a body
//     naming a tenant or a person is refused; credential VALUES are
//     refused on every action except the one header landing;
//   - the record holds references only: connections are created with
//     vault references minted by buildConnectorTokenRef, and the key
//     itself goes to the credential service under that reference;
//   - per-kind connect truth: vendor → plain refusal; none → lands
//     at once; header → needs-credential + reference; OAuth → the
//     consent boundary, nothing connected;
//   - the callback lands the OAuth connection: code exchanged, the
//     pair stored as oauth_bundle under BOTH references, connection
//     recorded — and only for the person who started it;
//   - disconnect runs the revoke hook BEFORE the record clears, and
//     a revoke refusal aborts the disconnect;
//   - posture and entry-state pass through the store's own rules.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { hashOAuthState } from '../src/cloud/connector-oauth-pending.mjs';

class TenantAuthorizationError extends Error {}

const OWNER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const MEMBER = { subject: 'user:pat', tenantId: 'tenant-a', role: 'member' };
const AUDITOR = { subject: 'user:aud', tenantId: 'tenant-a', role: 'auditor' };

const ENTRY = (over = {}) => ({
  seatId: 'claude', id: 'helmian-github', kind: 'helmian-native', brokerMode: 'helmian',
  authMode: 'oauth', state: 'available', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/', ...over,
});

function fakeStore(entries = {}) {
  const calls = [];
  const connections = new Map();
  return {
    calls, connections,
    async getEntry(tenantId, seatId, entryId) { calls.push(['getEntry', seatId, entryId]); return entries[`${seatId}/${entryId}`] ?? null; },
    async createConnection(tenantId, subject, input) {
      calls.push(['createConnection', input]);
      const connection = { personId: input.personId, seatId: input.seatId, entryId: input.entryId, state: 'connected', ...input };
      connections.set(`${input.personId}/${input.seatId}/${input.entryId}`, connection);
      return connection;
    },
    async disconnectConnection(tenantId, key, subject, { revoke } = {}) {
      calls.push(['disconnectConnection', key]);
      const id = `${key.personId}/${key.seatId}/${key.entryId}`;
      const prior = connections.get(id);
      if (!prior) throw Object.assign(new Error('connection not found'), { status: 404 });
      const refs = [prior.accessTokenRef, prior.refreshTokenRef].filter(Boolean);
      if (revoke) for (const ref of refs) await revoke(ref);
      const cleared = { ...prior, state: 'disconnected', accessTokenRef: null, refreshTokenRef: null };
      connections.set(id, cleared);
      return { connection: cleared, revokedRefs: refs };
    },
    async setPosture(tenantId, key, posture, subject) { calls.push(['setPosture', key, posture]); return { ...key, posture, state: 'connected' }; },
    async setEntryState(tenantId, seatId, entryId, state, subject) { calls.push(['setEntryState', seatId, entryId, state]); return { seatId, id: entryId, state }; },
    async createEntry(tenantId, subject, input) { calls.push(['createEntry', input]); return { ...input, state: 'available' }; },
    async removeEntry(tenantId, seatId, entryId, subject) { calls.push(['removeEntry', seatId, entryId]); return { seatId, id: entryId }; },
  };
}

function fakeCredentials({ refuseStore = false, refuseRevoke = false, refuseResolve = false } = {}) {
  const calls = [];
  return {
    calls,
    async storeCredential(input) { calls.push(['storeCredential', input]); return refuseStore ? { accepted: false, status: 'no' } : { accepted: true, status: 'stored' }; },
    async resolveVaultCredential(input) { calls.push(['resolveVaultCredential', input]); return refuseResolve ? { accepted: false } : { accepted: true, credential: 'the-key-itself' }; },
    async revokeVaultCredential(input) { calls.push(['revokeVaultCredential', input]); return refuseRevoke ? { accepted: false, status: 'no' } : { accepted: true, status: 'revoked' }; },
  };
}

function fakePending({ saveResult = true, takeRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async save(tenantId, pending) { calls.push(['save', pending]); return saveResult; },
    async take(tenantId, stateHash) { calls.push(['take', stateHash]); return takeRow; },
  };
}

function fakeDoor() {
  const calls = [];
  return {
    calls,
    async registerClient(input) { calls.push(['registerClient', input]); return { clientId: 'client-123' }; },
    async authorizeUrl(input) { calls.push(['authorizeUrl', input]); return `https://connect.helmian.cloud/authorize?state=${input.state}&client_id=${input.clientId}`; },
    async exchangeCode(input) { calls.push(['exchangeCode', input]); return { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', scope: 'memory.read memory.write', expiresIn: 3600 }; },
  };
}

function harness({ actor = OWNER, store, pending, credentials, door, fetchImpl } = {}) {
  const s = store ?? fakeStore({ 'claude/helmian-github': ENTRY() });
  const handler = createConnectorLibraryWriteHandler({
    store: s,
    pendingStore: pending ?? fakePending(),
    credentialClient: credentials === undefined ? fakeCredentials() : credentials,
    doorOAuth: door ?? fakeDoor(),
    fetchImpl: fetchImpl ?? (async () => { throw new Error('no network in tests'); }),
  });
  const sent = [];
  return {
    store: s, sent,
    async run(path, { method = 'POST', body = {}, actorError = null } = {}) {
      const requestUrl = new URL(path, 'https://helmian.cloud');
      const handled = await handler({
        request: { method },
        response: {},
        requestUrl,
        activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
        send: (response, status, payload, contentType) => { sent.push({ status, payload, contentType }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? ''); } catch { /* html */ }
      return { handled, status: last?.status, json, raw: last?.payload };
    },
  };
}

const P = '/api/admin/connector-library';

test('gating: membership failure is 403, auditor writes are 403, other paths are not handled', async () => {
  const h = harness();
  assert.equal((await h.run(`${P}/connect`, { actorError: new TenantAuthorizationError('nope') })).status, 403);
  const a = harness({ actor: AUDITOR });
  assert.equal((await a.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } })).status, 403);
  assert.equal((await h.run('/api/admin/something-else', {})).handled, false);
  assert.equal((await h.run(`${P}/connect`, { method: 'GET' })).handled, false);
});

test('gating: a body naming a tenant or another person is refused; naming a credential value is refused off the header road', async () => {
  const h = harness();
  assert.equal((await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'x', tenantId: 'tenant-b' } })).status, 400);
  assert.equal((await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'x', personId: 'user:other' } })).status, 400);
  assert.equal((await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'x', accessToken: 'sk-live' } })).status, 400);
  assert.equal((await h.run(`${P}/disconnect`, { body: { seatId: 'claude', entryId: 'x', apiKey: 'sk-live' } })).status, 400);
});

test('connect: a vendor-brokered mirror is refused plainly and nothing is recorded', async () => {
  const store = fakeStore({ 'claude/github': ENTRY({ id: 'github', kind: 'catalog', brokerMode: 'vendor', authMode: 'oauth', mcpEndpointUrl: null }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'github' } });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'VENDOR_MANAGED');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect: authMode none lands the connection at once, with no token references', async () => {
  const store = fakeStore({ 'cloudflare/cloudflare-docs': ENTRY({ seatId: 'cloudflare', id: 'cloudflare-docs', kind: 'catalog', authMode: 'none', mcpEndpointUrl: 'https://docs.mcp.cloudflare.com/mcp' }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'cloudflare', entryId: 'cloudflare-docs' } });
  assert.equal(out.status, 201);
  assert.equal(out.json.status, 'connected');
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.personId, 'user:troy');
  assert.equal(input.accessTokenRef, undefined);
});

test('connect: a disabled entry is a 409 before any road starts', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ state: 'disabled-by-owner' }) });
  const h = harness({ store });
  assert.equal((await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } })).status, 409);
});

test('connect: header entries answer the minted vault reference and connect nothing yet', async () => {
  const store = fakeStore({ 'grok/custom-keys': ENTRY({ seatId: 'grok', id: 'custom-keys', kind: 'custom', authMode: 'header', mcpEndpointUrl: 'https://example.com/mcp' }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'grok', entryId: 'custom-keys' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'needs-credential');
  assert.equal(out.json.accessTokenRef, buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'grok', entryId: 'custom-keys', personId: 'user:troy', tokenKind: 'access' }));
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect/header: the key goes to the credential service under the reference; the record holds the reference only', async () => {
  const store = fakeStore({ 'grok/custom-keys': ENTRY({ seatId: 'grok', id: 'custom-keys', kind: 'custom', authMode: 'header', mcpEndpointUrl: 'https://example.com/mcp' }) });
  const credentials = fakeCredentials();
  const h = harness({ store, credentials });
  const out = await h.run(`${P}/connect/header`, { body: { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-secret-value', accountLabel: 'Work key' } });
  assert.equal(out.status, 201);
  const [, stored] = credentials.calls.find(([n]) => n === 'storeCredential');
  const ref = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'grok', entryId: 'custom-keys', personId: 'user:troy', tokenKind: 'access' });
  assert.equal(stored.credentialReference, ref);
  assert.equal(stored.credentialKind, 'api_key');
  assert.equal(stored.apiKey, 'sk-secret-value');
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.accessTokenRef, ref);
  assert.equal(input.accountIdentity, 'Work key');
  assert.ok(!('apiKey' in input) && !JSON.stringify(input).includes('sk-secret-value'), 'the library record never carries the key');
});

test('connect/header: a credential-service refusal connects nothing', async () => {
  const store = fakeStore({ 'grok/custom-keys': ENTRY({ seatId: 'grok', id: 'custom-keys', kind: 'custom', authMode: 'header', mcpEndpointUrl: 'https://example.com/mcp' }) });
  const h = harness({ store, credentials: fakeCredentials({ refuseStore: true }) });
  const out = await h.run(`${P}/connect/header`, { body: { seatId: 'grok', entryId: 'custom-keys', apiKey: 'sk-x' } });
  assert.equal(out.status, 502);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect: GitHub OAuth reaches its consent boundary and connects nothing', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ id: 'helmian-github', authMode: 'oauth', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/' }) });
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth-protected-resource')) return { ok: true, json: async () => ({ authorization_servers: ['https://github.com'] }) };
    if (String(url).includes('oauth-authorization-server')) return { ok: true, json: async () => ({ authorization_endpoint: 'https://github.com/login/oauth/authorize' }) };
    throw new Error('unexpected fetch');
  };
  const h = harness({ store, fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  assert.equal(out.json.provider, 'github');
  assert.equal(out.json.authorizationEndpoint, 'https://github.com/login/oauth/authorize');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('callback: the door code lands the connection — pair stored under both references, record holds references only', async () => {
  const pending = fakePending({
    takeRow: { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'github', clientId: 'client-123', codeVerifier: 'verifier-1', redirectUri: 'https://helmian.cloud/api/admin/connector-library/oauth/callback', scopes: ['memory.read'] },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const door = fakeDoor();
  const h = harness({ pending, credentials, store, door });
  const out = await h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /Scribe is connected/);
  const accessRef = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'refresh' });
  const storedRefs = credentials.calls.filter(([n]) => n === 'storeCredential').map(([, i]) => i.credentialReference).sort();
  assert.deepEqual(storedRefs, [accessRef, refreshRef].sort());
  const [, bundle] = credentials.calls.find(([n]) => n === 'storeCredential');
  assert.equal(bundle.credentialKind, 'oauth_bundle');
  assert.equal(bundle.accessToken, 'at-1');
  assert.equal(bundle.refreshToken, 'rt-1');
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.accessTokenRef, accessRef);
  assert.equal(input.refreshTokenRef, refreshRef);
  assert.ok(!JSON.stringify(input).includes('at-1'), 'tokens never touch the library record');
});

test('callback: a handshake started by someone else, or an expired one, lands nothing', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const other = harness({ store, pending: fakePending({ takeRow: { personId: 'user:pat', seatId: 'claude', entryId: 'helmian-github', provider: 'github', clientId: 'c', codeVerifier: 'v', redirectUri: 'r', scopes: [] } }) });
  const out = await other.run(`${P}/oauth/callback?code=c&state=s`, { method: 'GET' });
  assert.match(out.raw, /did not land/);
  const expired = harness({ store, pending: fakePending({ takeRow: null }) });
  const out2 = await expired.run(`${P}/oauth/callback?code=c&state=s`, { method: 'GET' });
  assert.match(out2.raw, /did not land/);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('disconnect: the revoke hook runs for both stored references and the answer names them', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const credentials = fakeCredentials();
  const h = harness({ store, credentials });
  await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: 'helmian-github', apiKey: 'x' } }).catch(() => {});
  // Seed a connected record directly (header road refuses oauth entries).
  const accessRef = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'refresh' });
  store.connections.set('user:troy/claude/helmian-github', { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', accessTokenRef: accessRef, refreshTokenRef: refreshRef, state: 'connected' });
  const out = await h.run(`${P}/disconnect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.revokedRefs.sort(), [accessRef, refreshRef].sort());
  assert.equal(out.json.custodyRevoked, true);
  const revoked = credentials.calls.filter(([n]) => n === 'revokeVaultCredential').map(([, i]) => i.credentialReference).sort();
  assert.deepEqual(revoked, [accessRef, refreshRef].sort());
});

test('disconnect: a revoke refusal aborts before the record clears', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ store, credentials: fakeCredentials({ refuseRevoke: true }) });
  const accessRef = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'access' });
  store.connections.set('user:troy/claude/helmian-github', { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', accessTokenRef: accessRef, refreshTokenRef: null, state: 'connected' });
  const out = await h.run(`${P}/disconnect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 502);
  assert.equal(store.connections.get('user:troy/claude/helmian-github').state, 'connected');
});

test('posture: a valid posture is set on the caller\u2019s own connection; an invalid one is 400', async () => {
  const h = harness();
  const ok = await h.run(`${P}/posture`, { body: { seatId: 'claude', entryId: 'helmian-github', posture: 'read' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.connection.posture, 'read');
  assert.equal((await h.run(`${P}/posture`, { body: { seatId: 'claude', entryId: 'helmian-github', posture: 'everything' } })).status, 400);
});

test('entry-state and add/remove custom are owner/admin acts; members are refused', async () => {
  const member = harness({ actor: MEMBER });
  assert.equal((await member.run(`${P}/entry-state`, { body: { seatId: 'claude', entryId: 'helmian-github', state: 'disabled-by-owner' } })).status, 403);
  assert.equal((await member.run(`${P}/entries`, { body: { seatId: 'claude', name: 'Mine', mcpEndpointUrl: 'https://example.com/mcp', authMode: 'none' } })).status, 403);
  const owner = harness();
  const ok = await owner.run(`${P}/entry-state`, { body: { seatId: 'claude', entryId: 'helmian-github', state: 'disabled-by-owner' } });
  assert.equal(ok.status, 200);
  assert.equal((await owner.run(`${P}/entry-state`, { body: { seatId: 'claude', entryId: 'helmian-github', state: 'gone' } })).status, 400);
});

test('add-custom: the entry is created kind custom, helmian-brokered, labelled by the store, id from the name', async () => {
  const store = fakeStore({});
  const h = harness({ store });
  const out = await h.run(`${P}/entries`, { body: { seatId: 'grok', name: 'My Weather MCP', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header', oneLiner: 'Weather tools' } });
  assert.equal(out.status, 201);
  const [, input] = store.calls.find(([n]) => n === 'createEntry');
  assert.equal(input.kind, 'custom');
  assert.equal(input.brokerMode, 'helmian');
  assert.equal(input.id, 'custom-my-weather-mcp');
  assert.equal(input.vendorName, 'Custom');
  assert.equal(input.addedBy, 'user:troy');
  assert.equal(input.authMode, 'header');
  assert.equal((await h.run(`${P}/entries`, { body: { seatId: 'nope', name: 'X', mcpEndpointUrl: 'https://x.example.com/mcp', authMode: 'none' } })).status, 400);
});

test('entries/remove: only custom entries go; catalog entries are refused', async () => {
  const store = fakeStore({
    'claude/helmian-github': ENTRY(),
    'claude/custom-x': ENTRY({ id: 'custom-x', kind: 'custom', authMode: 'none', mcpEndpointUrl: 'https://x.example.com/mcp' }),
  });
  const h = harness({ store });
  assert.equal((await h.run(`${P}/entries/remove`, { body: { seatId: 'claude', entryId: 'helmian-github' } })).status, 400);
  const ok = await h.run(`${P}/entries/remove`, { body: { seatId: 'claude', entryId: 'custom-x' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'removed');
});

test('connect/complete: only the exact minted reference lands, and only once a credential resolves under it', async () => {
  const store = fakeStore({ 'grok/custom-keys': ENTRY({ seatId: 'grok', id: 'custom-keys', kind: 'custom', authMode: 'header', mcpEndpointUrl: 'https://example.com/mcp' }) });
  const ref = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'grok', entryId: 'custom-keys', personId: 'user:troy', tokenKind: 'access' });
  const h = harness({ store });
  assert.equal((await h.run(`${P}/connect/complete`, { body: { seatId: 'grok', entryId: 'custom-keys', accessTokenRef: 'vault://tenant/tenant-a/connector.grok.custom-keys/p-deadbeef.access' } })).status, 400);
  const ok = await h.run(`${P}/connect/complete`, { body: { seatId: 'grok', entryId: 'custom-keys', accessTokenRef: ref } });
  assert.equal(ok.status, 201);
  const refused = harness({ store, credentials: fakeCredentials({ refuseResolve: true }) });
  assert.equal((await refused.run(`${P}/connect/complete`, { body: { seatId: 'grok', entryId: 'custom-keys', accessTokenRef: ref } })).status, 400);
});

test('connect: a DRIFTED native row (stored authMode none, catalog oauth) takes the OAuth road and records nothing', async () => {
  // The 2026-11-09 live bug: live rows seeded under the old catalog
  // still said 'none', and connect dispatched on the stored label —
  // one click recorded a "No sign-in" connection no consent produced.
  // The catalog is the authority: the OAuth road must answer anyway.
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ authMode: 'none' }) });
  const pending = fakePending();
  const h = harness({ store, pending });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0, 'no handshake starts inside Helmian — starting one is M3 work');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'no connection may be recorded without consent');
});

test('connect: a native row stored as header still takes the OAuth road, and the header road refuses it', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ authMode: 'header' }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  const landed = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: 'helmian-github', apiKey: 'sk-x' } });
  assert.equal(landed.status, 400);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect/complete: an OAuth entry can never be landed from a stored reference — drifted or not', async () => {
  for (const storedMode of ['oauth', 'none']) {
    const store = fakeStore({ 'claude/helmian-github': ENTRY({ authMode: storedMode }) });
    const h = harness({ store });
    const ref = buildConnectorTokenRef({ tenantId: 'tenant-a', seatId: 'claude', entryId: 'helmian-github', personId: 'user:troy', tokenKind: 'access' });
    const out = await h.run(`${P}/connect/complete`, { body: { seatId: 'claude', entryId: 'helmian-github', accessTokenRef: ref } });
    assert.equal(out.status, 400, `stored authMode ${storedMode}`);
    assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
  }
});

test('connect: a custom entry keeps its own stored mode — a custom none lands at once', async () => {
  const store = fakeStore({ 'grok/custom-notes': ENTRY({ seatId: 'grok', id: 'custom-notes', kind: 'custom', authMode: 'none', mcpEndpointUrl: 'https://notes.example.com/mcp' }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'grok', entryId: 'custom-notes' } });
  assert.equal(out.status, 201);
  assert.equal(out.json.status, 'connected');
});

test('an unknown write action is a 404, answered by the route', async () => {
  const h = harness();
  const out = await h.run(`${P}/frobnicate`, { body: {} });
  assert.equal(out.handled, true);
  assert.equal(out.status, 404);
});

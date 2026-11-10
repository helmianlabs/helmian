// Connector library WRITE routes (mirror M1, DESIGN §5): the
// manage surface's server half, exercised with a fake store that
// honours the real store's contract, a fake credential service, a
// fake pending store, and a fake OAuth provider client served
// through the registry seam (oauthClientFor).
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
//     authorize start when a client answers for the entry (the
//     fixed registry, or the self-registering DCR road), the
//     consent boundary when none does — nothing connected either
//     way until the callback lands it;
//   - the callback lands the OAuth connection: code exchanged, the
//     pair stored as oauth_bundle under BOTH references, connection
//     recorded — and only for the person who started it;
//   - disconnect runs the revoke hook BEFORE the record clears, and
//     a revoke refusal aborts the disconnect;
//   - posture and entry-state pass through the store's own rules.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorLibraryWriteHandler, declaredOAuthScopes } from '../src/cloud/connector-library-write-route.mjs';
import { buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { createConnectorOAuthClient, hashOAuthState, pkceChallenge } from '../src/cloud/connector-oauth-pending.mjs';

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

// The fake registry provider: a GitHub-shaped client, resolved by
// the harness's oauthClientFor for provider 'github' only. It
// carries its clientId the way every real registry client does
// since Bite R2 (the factories expose the id they were built from;
// the write route names it on the pending row).
function fakeOAuthClient({ identity = 'troy-shoemaker', identityFails = false, exchangeFails = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: 'github',
    displayName: 'GitHub',
    clientId: 'cid-test',
    async authorizeUrl(input) { calls.push(['authorizeUrl', input]); return `https://github.com/login/oauth/authorize?state=${input.state}`; },
    async exchangeCode(input) {
      calls.push(['exchangeCode', input]);
      if (exchangeFails) throw Object.assign(new Error('bad_verification_code'), { status: 502 });
      return { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', scope: 'repo read:org', expiresIn: null };
    },
    async fetchIdentity(input) {
      calls.push(['fetchIdentity', input]);
      if (identityFails) throw new Error('github unreachable');
      return identity;
    },
  };
}

function harness({ actor = OWNER, store, pending, credentials, oauthClient, oauthClientFor, fetchImpl } = {}) {
  const s = store ?? fakeStore({ 'claude/helmian-github': ENTRY() });
  const client = oauthClient ?? fakeOAuthClient();
  const handler = createConnectorLibraryWriteHandler({
    store: s,
    pendingStore: pending ?? fakePending(),
    credentialClient: credentials === undefined ? fakeCredentials() : credentials,
    // oauthClientFor: undefined → the default fake-registry seam;
    // null → NO seam at all, so the handler's own registry and
    // pending-row resolution rule (the DCR wiring tests below).
    oauthClientFor: oauthClientFor === undefined ? ((provider) => (provider === 'github' ? client : null)) : oauthClientFor,
    fetchImpl: fetchImpl ?? (async () => { throw new Error('no network in tests'); }),
  });
  const sent = [];
  return {
    store: s, sent, oauthClient: client,
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

test('connect: GitHub OAuth starts the handshake and answers the authorize URL — nothing is connected yet', async () => {
  // Re-pinned by the DCR wiring bite: this test used to pin the
  // consent-boundary answer for GitHub, from when connect could not
  // start a handshake at all. The start half is wired now (M3
  // §6.3): with a registered client resolvable, connect mints state
  // + PKCE, saves the pending handshake, and answers the authorize
  // URL. The boundary answer survives for the no-client case in the
  // next test.
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ id: 'helmian-github', authMode: 'oauth', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/' }) });
  const pending = fakePending();
  const h = harness({ store, pending });
  const priorClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'cid-test';
  let out;
  try {
    out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  } finally {
    if (priorClientId === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = priorClientId;
  }
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
  assert.equal(out.json.provider, 'github');
  const state = new URL(out.json.authorizeUrl).searchParams.get('state');
  assert.ok(state, 'the authorize URL carries the state the handshake remembers');
  const saves = pending.calls.filter(([n]) => n === 'save');
  assert.equal(saves.length, 1, 'exactly one handshake is saved');
  const [, saved] = saves[0];
  assert.equal(saved.provider, 'github');
  assert.equal(saved.clientId, 'cid-test', 'the row names the client id the handshake runs under');
  assert.equal(saved.personId, 'user:troy');
  assert.equal(saved.seatId, 'claude');
  assert.equal(saved.entryId, 'helmian-github');
  assert.deepEqual(saved.scopes, ['repo', 'read:org']);
  assert.equal(saved.redirectUri, 'https://helmian.cloud/api/admin/connector-library/oauth/callback');
  assert.equal(saved.stateHash, hashOAuthState(state), 'the row is keyed by the hash of the state in the authorize URL');
  const [, authorizeInput] = h.oauthClient.calls.find(([n]) => n === 'authorizeUrl');
  assert.equal(authorizeInput.challenge, pkceChallenge(saved.codeVerifier), 'the authorize URL carries the S256 challenge of the saved verifier');
  assert.deepEqual(authorizeInput.scopes, ['repo', 'read:org']);
  assert.equal(authorizeInput.redirectUri, saved.redirectUri);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'starting a handshake connects nothing — the callback lands it');
});

test('connect: GitHub OAuth with no registered client keeps the consent-boundary answer', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ id: 'helmian-github', authMode: 'oauth', mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/' }) });
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth-protected-resource')) return { ok: true, json: async () => ({ authorization_servers: ['https://github.com'] }) };
    if (String(url).includes('oauth-authorization-server')) return { ok: true, json: async () => ({ authorization_endpoint: 'https://github.com/login/oauth/authorize' }) };
    throw new Error('unexpected fetch');
  };
  const pending = fakePending();
  const h = harness({ store, fetchImpl, pending, oauthClientFor: () => null });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  assert.equal(out.json.provider, 'github');
  assert.equal(out.json.authorizationEndpoint, 'https://github.com/login/oauth/authorize');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0, 'no client, no handshake');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('callback: the provider code lands the connection — pair stored under both references, record holds references only, identity is the GitHub login', async () => {
  const pending = fakePending({
    takeRow: { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'github', clientId: 'client-123', codeVerifier: 'verifier-1', redirectUri: 'https://helmian.cloud/api/admin/connector-library/oauth/callback', scopes: ['repo', 'read:org'] },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ pending, credentials, store });
  const out = await h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /GitHub is connected/);
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
  assert.equal(input.accountIdentity, 'troy-shoemaker', 'the recorded identity is the login the client fetched at callback time');
  assert.ok(!JSON.stringify(input).includes('at-1'), 'tokens never touch the library record');
});

test('callback: an identity fetch that fails still lands the connection under the provider label', async () => {
  const pending = fakePending({
    takeRow: { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'github', clientId: 'client-123', codeVerifier: 'verifier-1', redirectUri: 'https://helmian.cloud/api/admin/connector-library/oauth/callback', scopes: ['repo'] },
  });
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ pending, store, oauthClient: fakeOAuthClient({ identityFails: true }) });
  const out = await h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /GitHub is connected/);
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.accountIdentity, 'GitHub account');
});

test('callback: a provider with no registered client lands nothing — there is no default client', async () => {
  const pending = fakePending({
    takeRow: { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'door', clientId: 'c', codeVerifier: 'v', redirectUri: 'r', scopes: [] },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ pending, credentials, store });
  const out = await h.run(`${P}/oauth/callback?code=c&state=s`, { method: 'GET' });
  assert.match(out.raw, /did not land/);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0);
});

test('callback: a refused code exchange names the provider on the failure page and lands nothing', async () => {
  const pending = fakePending({
    takeRow: { personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'github', clientId: 'client-123', codeVerifier: 'verifier-1', redirectUri: 'https://helmian.cloud/api/admin/connector-library/oauth/callback', scopes: ['repo'] },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ pending, credentials, store, oauthClient: fakeOAuthClient({ exchangeFails: true }) });
  const out = await h.run(`${P}/oauth/callback?code=stale&state=state-9`, { method: 'GET' });
  assert.match(out.raw, /did not land/);
  assert.match(out.raw, /The GitHub sign-in answered with an error/);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0);
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

test('connect: a DRIFTED native row (stored authMode none, catalog oauth) takes the OAuth road and records no connection', async () => {
  // The 2026-11-09 live bug: live rows seeded under the old catalog
  // still said 'none', and connect dispatched on the stored label —
  // one click recorded a "No sign-in" connection no consent produced.
  // The catalog is the authority: the OAuth road must answer anyway.
  // (The DCR wiring bite re-pins the handshake count: the OAuth road
  // now STARTS — one pending save, the authorize answer — because
  // the kind resolution runs on the same catalog authority. The
  // load-bearing pin is unchanged: no CONNECTION without consent.)
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ authMode: 'none' }) });
  const pending = fakePending();
  const h = harness({ store, pending });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 1, 'the OAuth road starts its handshake even for a drifted row');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'no connection may be recorded without consent');
});

test('connect: a native row stored as header still takes the OAuth road, and the header road refuses it', async () => {
  const store = fakeStore({ 'claude/helmian-github': ENTRY({ authMode: 'header' }) });
  const h = harness({ store });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'helmian-github' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
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

// ---------------------------------------------------------- registry
// The provider registry (m3-github/DESIGN.md §6.2): resolution is by
// the pending row's provider, GitHub is the first member, and an
// unconfigured GitHub is absent — honestly, not defaulted.

test('registry: an unknown provider resolves to no client', () => {
  assert.equal(createConnectorOAuthClient('door', { fetchImpl: async () => { throw new Error('no network'); }, env: {} }), null);
  assert.equal(createConnectorOAuthClient('', { fetchImpl: async () => { throw new Error('no network'); }, env: {} }), null);
  assert.equal(createConnectorOAuthClient(undefined, { fetchImpl: async () => { throw new Error('no network'); }, env: {} }), null);
});

test('registry: GitHub without its environment pair is not configured — absent from the registry', () => {
  const noFetch = async () => { throw new Error('no network'); };
  assert.equal(createConnectorOAuthClient('github', { fetchImpl: noFetch, env: {} }), null);
  assert.equal(createConnectorOAuthClient('github', { fetchImpl: noFetch, env: { GITHUB_OAUTH_CLIENT_ID: 'cid' } }), null);
  assert.equal(createConnectorOAuthClient('github', { fetchImpl: noFetch, env: { GITHUB_OAUTH_CLIENT_SECRET: 'sec' } }), null);
});

test('registry: the GitHub client uses the fixed endpoints, posts the secret server-side, and reads the login', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push([String(url), opts]);
    if (String(url).startsWith('https://github.com/login/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'gho_x', token_type: 'bearer', scope: 'repo,read:org' }) };
    }
    if (String(url) === 'https://api.github.com/user') {
      return { ok: true, json: async () => ({ login: 'troy-shoemaker' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const client = createConnectorOAuthClient('github', {
    fetchImpl,
    env: { GITHUB_OAUTH_CLIENT_ID: 'cid-1', GITHUB_OAUTH_CLIENT_SECRET: 'sec-1' },
  });
  assert.ok(client);
  assert.equal(client.registerClient, undefined, 'a fixed OAuth App has no registration step');
  const authorize = await client.authorizeUrl({
    redirectUri: 'https://helmian.cloud/api/admin/connector-library/oauth/callback',
    state: 'st', challenge: 'ch', scopes: ['repo', 'read:org'],
  });
  const au = new URL(authorize);
  assert.equal(`${au.origin}${au.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.equal(au.searchParams.get('client_id'), 'cid-1');
  assert.equal(au.searchParams.get('code_challenge'), 'ch');
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(au.searchParams.get('scope'), 'repo read:org');
  const tokens = await client.exchangeCode({ code: 'code-1', codeVerifier: 'ver-1', redirectUri: 'https://helmian.cloud/cb' });
  assert.equal(tokens.accessToken, 'gho_x');
  const [, exchangeOpts] = seen.find(([u]) => u.includes('access_token'));
  const form = new URLSearchParams(exchangeOpts.body);
  assert.equal(form.get('client_id'), 'cid-1');
  assert.equal(form.get('client_secret'), 'sec-1');
  assert.equal(form.get('code_verifier'), 'ver-1');
  assert.equal(await client.fetchIdentity({ accessToken: 'gho_x' }), 'troy-shoemaker');
  const [, userOpts] = seen.find(([u]) => u === 'https://api.github.com/user');
  assert.equal(userOpts.headers.authorization, 'Bearer gho_x');
});

// ---------------------------------------------------------- the wiring
// The DCR wiring bite: the connect action's OAuth branch resolves
// the entry's sign-in kind and STARTS the road — the fixed start
// above, and the self-registering road here — and the callback
// resolves its client from the pending ROW (the fixed registry
// first, then the row's DCR fields) instead of by provider alone.
// The no-seam tests (oauthClientFor: null) run the handler's own
// resolvers against fake fetches; no live service is ever called.

const CALLBACK_URL = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const NOTION_ENTRY = (over = {}) => ENTRY({
  id: 'registry-notion', kind: 'catalog', authMode: 'oauth',
  mcpEndpointUrl: 'https://mcp.notion.com/mcp', ...over,
});

// A Notion-shaped DCR server behind a fake fetch (the DCR suite's
// stub shape, URL-keyed): the protected-resource document names the
// /mcp resource, the authorization-server document carries the
// endpoints, /register issues a public client, /token records the
// exchange form. Options drop the registration endpoint (the
// dcr-unsupported shape) or make the resource document name a
// different resource (the mismatch refusal).
function fakeDcrServer({ registration = true, resourceName = 'https://mcp.notion.com/mcp' } = {}) {
  const seen = { registrations: [], tokenForms: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, json: async () => body });
    if (u === 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp' || u === 'https://mcp.notion.com/.well-known/oauth-protected-resource') {
      return json({
        resource: resourceName,
        authorization_servers: ['https://mcp.notion.com'],
        scopes_supported: ['default'],
        bearer_methods_supported: ['header'],
        resource_name: 'Notion MCP (Beta)',
      });
    }
    if (u === 'https://mcp.notion.com/.well-known/oauth-authorization-server') {
      return json({
        issuer: 'https://mcp.notion.com',
        authorization_endpoint: 'https://mcp.notion.com/authorize',
        token_endpoint: 'https://mcp.notion.com/token',
        ...(registration ? { registration_endpoint: 'https://mcp.notion.com/register' } : {}),
        scopes_supported: ['default'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (u === 'https://mcp.notion.com/register' && opts.method === 'POST') {
      seen.registrations.push(JSON.parse(opts.body));
      return json({ client_id: 'notion-client-1', token_endpoint_auth_method: 'none' });
    }
    if (u === 'https://mcp.notion.com/token' && opts.method === 'POST') {
      const form = new URLSearchParams(opts.body);
      seen.tokenForms.push(form);
      if (form.get('client_secret') && form.get('client_secret') !== 'notion-secret-1') {
        return json({ error: 'invalid_client' }, false);
      }
      return json({ access_token: 'notion-at-1', token_type: 'Bearer', scope: 'default', expires_in: 3600 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, seen };
}

async function withGithubEnv(fn) {
  const priorId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const priorSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'cid-1';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'sec-1';
  try { return await fn(); } finally {
    if (priorId === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = priorId;
    if (priorSecret === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    else process.env.GITHUB_OAUTH_CLIENT_SECRET = priorSecret;
  }
}

test('connect: a DCR entry starts the self-registering road — discovery, registration, a pending row carrying the DCR facts, and the briefing', async () => {
  const store = fakeStore({ 'claude/registry-notion': NOTION_ENTRY() });
  const pending = fakePending();
  const dcr = fakeDcrServer();
  const h = harness({ store, pending, fetchImpl: dcr.fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-notion' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
  assert.equal(out.json.provider, 'notion');
  const au = new URL(out.json.authorizeUrl);
  assert.equal(`${au.origin}${au.pathname}`, 'https://mcp.notion.com/authorize');
  assert.equal(au.searchParams.get('response_type'), 'code');
  assert.equal(au.searchParams.get('client_id'), 'notion-client-1');
  assert.equal(au.searchParams.get('redirect_uri'), CALLBACK_URL);
  assert.equal(au.searchParams.get('scope'), 'default');
  assert.equal(au.searchParams.get('resource'), 'https://mcp.notion.com/mcp');
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(dcr.seen.registrations.length, 1, 'Helmian registered itself exactly once');
  assert.equal(dcr.seen.registrations[0].token_endpoint_auth_method, 'none', 'a public client — no secret exists on this road');
  assert.deepEqual(dcr.seen.registrations[0].redirect_uris, [CALLBACK_URL]);
  const saves = pending.calls.filter(([n]) => n === 'save');
  assert.equal(saves.length, 1);
  const [, saved] = saves[0];
  assert.equal(saved.provider, 'notion');
  assert.equal(saved.clientId, 'notion-client-1');
  assert.equal(saved.tokenEndpoint, 'https://mcp.notion.com/token', 'the row carries the token endpoint for the callback');
  assert.equal(saved.tokenEndpointAuthMethod, 'none');
  assert.equal(saved.clientSecret, null);
  assert.deepEqual(saved.scopes, ['default']);
  assert.equal(saved.redirectUri, CALLBACK_URL);
  assert.equal(saved.stateHash, hashOAuthState(au.searchParams.get('state')));
  assert.equal(au.searchParams.get('code_challenge'), pkceChallenge(saved.codeVerifier), 'the authorize URL carries the S256 challenge of the saved verifier');
  assert.equal(out.json.briefing.serviceName, 'Notion MCP (Beta)', 'the briefing names the service from its own resource document');
  assert.equal(out.json.briefing.authorizationHost, 'mcp.notion.com');
  assert.equal(out.json.briefing.scopes[0].name, 'default');
  assert.ok(out.json.briefing.scopes[0].words.length > 0, 'each scope carries its plain words');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'starting the road connects nothing — the callback lands it');
});

test('connect: a server that takes no self-registered clients falls through to the consent boundary', async () => {
  const store = fakeStore({ 'claude/registry-notion': NOTION_ENTRY() });
  const pending = fakePending();
  const dcr = fakeDcrServer({ registration: false });
  const h = harness({ store, pending, fetchImpl: dcr.fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-notion' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  assert.equal(out.json.authorizationEndpoint, 'https://mcp.notion.com/authorize');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect: a DCR server whose metadata refuses the road answers with its named code — nothing saved, nothing connected', async () => {
  const store = fakeStore({ 'claude/registry-notion': NOTION_ENTRY() });
  const pending = fakePending();
  const dcr = fakeDcrServer({ resourceName: 'https://mcp.notion.com' });
  const h = harness({ store, pending, fetchImpl: dcr.fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-notion' } });
  assert.equal(out.status, 502);
  assert.equal(out.json.code, 'resource-mismatch');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('connect: an OAuth entry carrying no endpoint has no road to start — the consent boundary answers honestly', async () => {
  const store = fakeStore({ 'claude/registry-endless': NOTION_ENTRY({ id: 'registry-endless', mcpEndpointUrl: null }) });
  const pending = fakePending();
  const h = harness({ store, pending });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-endless' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'consent-boundary');
  assert.equal(out.json.authorizationEndpoint, null);
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

test('callback: a DCR pending row resolves its client from the row — the exchange hits the row token endpoint with the verifier and no secret', async () => {
  const pending = fakePending({
    takeRow: {
      personId: 'user:troy', seatId: 'claude', entryId: 'registry-notion', provider: 'notion',
      clientId: 'notion-client-1', codeVerifier: 'ver-9', redirectUri: CALLBACK_URL, scopes: ['default'],
      clientSecret: null, tokenEndpoint: 'https://mcp.notion.com/token', tokenEndpointAuthMethod: 'none',
    },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/registry-notion': NOTION_ENTRY() });
  const dcr = fakeDcrServer();
  const h = harness({ pending, credentials, store, oauthClientFor: null, fetchImpl: dcr.fetchImpl });
  const out = await h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /Notion is connected/);
  assert.equal(dcr.seen.tokenForms.length, 1, 'the exchange went to the token endpoint the row carries');
  const form = dcr.seen.tokenForms[0];
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-9');
  assert.equal(form.get('client_id'), 'notion-client-1');
  assert.equal(form.get('code_verifier'), 'ver-9');
  assert.equal(form.get('client_secret'), null, 'a public client presents no secret — the verifier is the proof');
  const [, bundle] = credentials.calls.find(([n]) => n === 'storeCredential');
  assert.equal(bundle.credentialKind, 'oauth_bundle');
  assert.equal(bundle.accessToken, 'notion-at-1');
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.entryId, 'registry-notion');
  assert.equal(input.accountIdentity, 'Notion account');
  assert.ok(!JSON.stringify(input).includes('notion-at-1'), 'tokens never touch the library record');
});

test('callback: a DCR pending row carrying an issued secret presents it the registered way (client_secret_post)', async () => {
  const pending = fakePending({
    takeRow: {
      personId: 'user:troy', seatId: 'claude', entryId: 'registry-notion', provider: 'notion',
      clientId: 'notion-client-1', codeVerifier: 'ver-9', redirectUri: CALLBACK_URL, scopes: ['default'],
      clientSecret: 'notion-secret-1', tokenEndpoint: 'https://mcp.notion.com/token', tokenEndpointAuthMethod: 'client_secret_post',
    },
  });
  const store = fakeStore({ 'claude/registry-notion': NOTION_ENTRY() });
  const dcr = fakeDcrServer();
  const h = harness({ pending, store, oauthClientFor: null, fetchImpl: dcr.fetchImpl });
  const out = await h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /Notion is connected/);
  assert.equal(dcr.seen.tokenForms.length, 1);
  assert.equal(dcr.seen.tokenForms[0].get('client_secret'), 'notion-secret-1', 'the issued secret rode the form, per the registered method');
});

test('callback: a GitHub pending row resolves the fixed registry client with no seam — the exchange posts the env secret and the login lands (regression)', async () => {
  const pending = fakePending({
    takeRow: {
      personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'github',
      clientId: 'cid-1', codeVerifier: 'verifier-1', redirectUri: CALLBACK_URL, scopes: ['repo', 'read:org'],
      clientSecret: null, tokenEndpoint: null, tokenEndpointAuthMethod: null,
    },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push([String(url), opts]);
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      return { ok: true, json: async () => ({ access_token: 'gho_x', token_type: 'bearer', scope: 'repo,read:org' }) };
    }
    if (String(url) === 'https://api.github.com/user') {
      return { ok: true, json: async () => ({ login: 'troy-shoemaker' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const h = harness({ pending, credentials, store, oauthClientFor: null, fetchImpl });
  const out = await withGithubEnv(() => h.run(`${P}/oauth/callback?code=code-9&state=state-9`, { method: 'GET' }));
  assert.equal(out.status, 200);
  assert.match(out.raw, /GitHub is connected/);
  const [, exchangeOpts] = seen.find(([u]) => u.includes('access_token'));
  const form = new URLSearchParams(exchangeOpts.body);
  assert.equal(form.get('client_id'), 'cid-1');
  assert.equal(form.get('client_secret'), 'sec-1', 'the fixed client posted its env secret server-side, exactly as before the wiring');
  assert.equal(form.get('code_verifier'), 'verifier-1');
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.accountIdentity, 'troy-shoemaker', 'the recorded identity is still the login the fixed client fetches');
});

test('callback: a pending row no client answers for fails honestly — nothing stored, nothing connected', async () => {
  const pending = fakePending({
    takeRow: {
      personId: 'user:troy', seatId: 'claude', entryId: 'helmian-github', provider: 'door',
      clientId: 'c', codeVerifier: 'v', redirectUri: CALLBACK_URL, scopes: [],
      clientSecret: null, tokenEndpoint: null, tokenEndpointAuthMethod: null,
    },
  });
  const credentials = fakeCredentials();
  const store = fakeStore({ 'claude/helmian-github': ENTRY() });
  const h = harness({ pending, credentials, store, oauthClientFor: null });
  const out = await h.run(`${P}/oauth/callback?code=c&state=s`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /That sign-in did not land/);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0);
});

// ------------------------------------------------------------- R1
// The DCR family finished (PLAN.md Bite R1): Atlassian and Linear
// were catalog-only rows on brokered entries until their live
// metadata reads (2026-11-10) proved both publish a registration
// endpoint and offer a public client — they ride the DCR road
// unchanged. The fake servers below are shaped from those live
// reads: Atlassian's issuer carries a path segment and its
// resource document publishes 40 scopes; Linear's issuer is its
// MCP origin. Atlassian's entry DECLARES its ask in the catalog
// (the products and verbs its own words promise), so its connect
// must register and request exactly that subset — never the
// server's delete-and-manage whole. Linear declares nothing, so
// its connect keeps the server's own set, as the road has always
// run.

const ATL_ISSUER = 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3';
// The 40 scopes Atlassian's resource document published on the
// 2026-11-10 live read (R1 harness record).
const ATL_PUBLISHED_SCOPES = [
  'read:me', 'read:account', 'offline_access', 'email',
  'read:jira:agent-interface', 'write:jira:agent-interface', 'search:jira:agent-interface',
  'delete:jira:agent-interface', 'manage:jira:agent-interface',
  'read:confluence:agent-interface', 'write:confluence:agent-interface', 'search:confluence:agent-interface',
  'search:rovo:agent-interface', 'search:code:agent-interface',
  'read:jsm:agent-interface', 'write:jsm:agent-interface',
  'read:all:twg', 'write:all:twg',
  'read:goals:agent-interface', 'write:goals:agent-interface',
  'read:projects:agent-interface', 'write:projects:agent-interface',
  'read:bitbucket:agent-interface', 'write:bitbucket:agent-interface',
  'read:loom:agent-interface', 'write:loom:agent-interface',
  'read:talent:agent-interface', 'write:talent:agent-interface',
  'read:jira-align:agent-interface', 'write:jira-align:agent-interface',
  'read:teams:agent-interface', 'write:teams:agent-interface',
  'read:artifacts:agent-interface', 'write:artifacts:agent-interface',
  'read:capacity-planning:agent-interface', 'write:capacity-planning:agent-interface',
  'read:focus:agent-interface', 'write:focus:agent-interface',
  'read:assets:agent-interface', 'write:assets:agent-interface',
];
const ATL_DECLARED_SCOPES = [
  'read:me', 'read:account', 'email', 'offline_access',
  'read:jira:agent-interface', 'write:jira:agent-interface', 'search:jira:agent-interface',
  'read:confluence:agent-interface', 'write:confluence:agent-interface', 'search:confluence:agent-interface',
  'search:rovo:agent-interface',
  'read:loom:agent-interface', 'write:loom:agent-interface',
];

function fakeAtlassianServer() {
  const seen = { registrations: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, json: async () => body });
    if (u === 'https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp') {
      return json({
        resource: 'https://mcp.atlassian.com/v2/mcp',
        authorization_servers: [ATL_ISSUER],
        scopes_supported: ATL_PUBLISHED_SCOPES,
        bearer_methods_supported: ['header'],
      });
    }
    if (u === `https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`) {
      return json({
        issuer: ATL_ISSUER,
        authorization_endpoint: 'https://auth.atlassian.com/authorize',
        token_endpoint: 'https://auth.atlassian.com/oauth/token',
        registration_endpoint: `${ATL_ISSUER}/dcr/register`,
        scopes_supported: [],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (u === `${ATL_ISSUER}/dcr/register` && opts.method === 'POST') {
      seen.registrations.push(JSON.parse(opts.body));
      return json({ client_id: 'atl-client-1', token_endpoint_auth_method: 'none' });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, seen };
}

function fakeLinearServer() {
  const seen = { registrations: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, json: async () => body });
    if (u === 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp') {
      return json({
        resource: 'https://mcp.linear.app/mcp',
        authorization_servers: ['https://mcp.linear.app'],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
      });
    }
    if (u === 'https://mcp.linear.app/.well-known/oauth-authorization-server') {
      return json({
        issuer: 'https://mcp.linear.app',
        authorization_endpoint: 'https://mcp.linear.app/authorize',
        token_endpoint: 'https://mcp.linear.app/token',
        registration_endpoint: 'https://mcp.linear.app/register',
        scopes_supported: ['read', 'write', 'openid', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (u === 'https://mcp.linear.app/register' && opts.method === 'POST') {
      seen.registrations.push(JSON.parse(opts.body));
      return json({ client_id: 'linear-client-1', token_endpoint_auth_method: 'none' });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, seen };
}

test('R1 connect: Atlassian starts the DCR road and asks only for the scopes its catalog entry declares', async () => {
  const store = fakeStore({
    'claude/registry-atlassian': ENTRY({
      id: 'registry-atlassian', kind: 'catalog', authMode: 'oauth',
      mcpEndpointUrl: 'https://mcp.atlassian.com/v2/mcp',
    }),
  });
  const pending = fakePending();
  const atl = fakeAtlassianServer();
  const h = harness({ store, pending, fetchImpl: atl.fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-atlassian' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
  assert.equal(out.json.provider, 'atlassian');
  const au = new URL(out.json.authorizeUrl);
  assert.equal(`${au.origin}${au.pathname}`, 'https://auth.atlassian.com/authorize');
  assert.equal(au.searchParams.get('client_id'), 'atl-client-1');
  assert.equal(au.searchParams.get('scope'), ATL_DECLARED_SCOPES.join(' '), 'consent asks for the declared ask, not the published whole');
  assert.equal(atl.seen.registrations.length, 1);
  assert.equal(atl.seen.registrations[0].scope, ATL_DECLARED_SCOPES.join(' '), 'registration carries the same narrowed set');
  assert.equal(atl.seen.registrations[0].token_endpoint_auth_method, 'none');
  const saves = pending.calls.filter(([n]) => n === 'save');
  assert.equal(saves.length, 1);
  const [, saved] = saves[0];
  assert.equal(saved.provider, 'atlassian');
  assert.equal(saved.tokenEndpoint, 'https://auth.atlassian.com/oauth/token');
  assert.deepEqual(saved.scopes, ATL_DECLARED_SCOPES, 'the pending row — and so the briefing and the callback — carry the narrowed set');
  assert.deepEqual(out.json.briefing.scopes.map((s) => s.name), ATL_DECLARED_SCOPES);
  for (const scope of [...saved.scopes]) {
    assert.ok(!scope.includes('delete') && !scope.includes('manage'), `no destructive scope is asked for: ${scope}`);
  }
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'starting the road connects nothing');
});

test('R1 connect: Linear starts the DCR road on the server’s own scopes — no declaration, no narrowing', async () => {
  const store = fakeStore({
    'claude/registry-linear': ENTRY({
      id: 'registry-linear', kind: 'catalog', authMode: 'oauth',
      mcpEndpointUrl: 'https://mcp.linear.app/mcp',
    }),
  });
  const pending = fakePending();
  const lin = fakeLinearServer();
  const h = harness({ store, pending, fetchImpl: lin.fetchImpl });
  const out = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: 'registry-linear' } });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'authorize');
  assert.equal(out.json.provider, 'linear');
  const au = new URL(out.json.authorizeUrl);
  assert.equal(`${au.origin}${au.pathname}`, 'https://mcp.linear.app/authorize');
  assert.equal(au.searchParams.get('scope'), 'read write');
  assert.equal(lin.seen.registrations.length, 1);
  assert.equal(lin.seen.registrations[0].scope, 'read write');
  const saves = pending.calls.filter(([n]) => n === 'save');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0][1].scopes, ['read', 'write']);
  assert.equal(saves[0][1].tokenEndpoint, 'https://mcp.linear.app/token');
});

test('R1: declaredOAuthScopes reads the catalog definition — Atlassian declares, Linear and Notion do not, custom never does', () => {
  assert.deepEqual(
    declaredOAuthScopes({ seatId: 'claude', id: 'registry-atlassian', kind: 'catalog' }),
    ATL_DECLARED_SCOPES,
  );
  assert.equal(declaredOAuthScopes({ seatId: 'claude', id: 'registry-linear', kind: 'catalog' }), null);
  assert.equal(declaredOAuthScopes({ seatId: 'claude', id: 'registry-notion', kind: 'catalog' }), null);
  assert.equal(declaredOAuthScopes({ seatId: 'claude', id: 'registry-atlassian', kind: 'custom' }), null);
  assert.equal(declaredOAuthScopes(null), null);
});

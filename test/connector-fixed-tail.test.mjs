// The fixed tail — Canva, Dropbox.
//
// What is proven here:
//   - the catalog stocks the two brokered entries beside the
//     mirrors on claude, chatgpt, grok (nowhere else), as
//     Helmian-brokered OAuth rows naming the vendors' own
//     published MCP servers (Canva's DEVELOPER endpoint, not
//     the public consumer surface), each declaring its own ask
//     — exactly the scopes_supported set in that server's own
//     protected-resource document, read live 2026-11-10;
//   - the copy is truthful: Canva's words stay inside the MCP
//     scope set (brand kits are named because brandkit:read is
//     in it; exports are never promised — no export scope is);
//     Dropbox's words say files.content.write is in the ask and
//     why, and that the MCP server is in beta;
//   - kind resolution: both entries resolve the FIXED kind
//     under their own providers ('canva', 'dropbox') — Canva
//     offers CIMD only through a waitlist and Dropbox limits
//     MCP dynamic registration to a trusted set of named
//     clients, so neither the DCR nor the CIMD road serves
//     them — configured exactly when each env pair is placed;
//   - the registry: each provider answers a client only with
//     its pair present; Canva's factory builds Canva's real
//     authorize URL (PKCE S256) and exchanges Basic-auth + PKCE
//     at the token endpoint its authorization-server metadata
//     names, refresh included; Dropbox's factory builds
//     Dropbox's real authorize URL carrying
//     token_access_type=offline (without it Dropbox issues no
//     refresh token) and exchanges client_secret_post at
//     Dropbox's token endpoint, refresh included;
//   - the write route through the real handler with the real
//     catalog rows: with no env pair placed, each start answers
//     the consent boundary naming its OWN provider and connects
//     nothing; with a (dummy, test-only) pair placed, each
//     start saves its pending row under its own provider and
//     answers the provider's real authorize URL with PKCE
//     (plus Dropbox's offline parameter);
//   - the neighbours are unmoved: a Google entry still resolves
//     'google' with its own ask, and GitHub keeps its table ask.
//
// Live evidence behind the shapes (2026-11-10, re-read in this
// build): Canva PRM https://api.canva.com/.well-known/oauth-
// protected-resource/connect/v1/mcp (resource api.canva.com/
// connect/v1/mcp, AS https://www.canva.com, 16 scopes); Canva
// AS metadata (authorize https://www.canva.com/api/oauth/
// authorize, token https://api.canva.com/auth/v1/oauth/token,
// code, PKCE S256); Canva Connect authentication page (Basic
// recommended for the token endpoint; a refresh token is
// issued with the code and a fresh one with each refresh).
// Dropbox PRM https://mcp.dropbox.com/.well-known/oauth-
// protected-resource/mcp (resource mcp.dropbox.com/mcp, AS
// https://www.dropbox.com, 9 scopes); Dropbox AS metadata
// (authorize https://www.dropbox.com/oauth2/authorize, token
// https://api.dropboxapi.com/oauth2/token, authorization_code
// + refresh_token grants, PKCE S256, client_secret_post);
// Dropbox Help Center (MCP server in beta; DCR for a trusted
// set only; App Console permissions list = the PRM set minus
// files.metadata.write).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_CATALOG,
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
} from '../src/cloud/connector-catalog.mjs';
import { connectorOAuthKindForEntry, fixedProviderForEntry } from '../src/cloud/connector-oauth-dcr.mjs';
import { createConnectorOAuthClient } from '../src/cloud/connector-oauth-pending.mjs';
import { createConnectorLibraryWriteHandler, declaredOAuthScopes } from '../src/cloud/connector-library-write-route.mjs';

class TenantAuthorizationError extends Error {}

const OWNER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];

const CANVA_SCOPES = [
  'profile:read',
  'design:meta:read', 'design:content:read', 'design:content:write',
  'folder:read', 'folder:write',
  'brandtemplate:meta:read', 'brandtemplate:content:read', 'brandtemplate:content:write',
  'comment:read', 'comment:write',
  'asset:read', 'asset:write',
  'brandkit:read',
  'help:answers:read', 'help:answers:write',
];
const DROPBOX_SCOPES = [
  'account_info.read',
  'file_requests.read', 'file_requests.write',
  'files.content.read', 'files.content.write',
  'files.metadata.read', 'files.metadata.write',
  'sharing.read', 'sharing.write',
];

const FAMILY = [
  {
    entryId: 'helmian-canva', provider: 'canva', name: 'Canva', mirrorId: 'canva',
    endpoint: 'https://api.canva.com/connect/v1/mcp', scopes: CANVA_SCOPES,
    authorizeOrigin: 'https://www.canva.com/api/oauth/authorize',
    envId: 'CANVA_OAUTH_CLIENT_ID', envSecret: 'CANVA_OAUTH_CLIENT_SECRET',
  },
  {
    entryId: 'helmian-dropbox', provider: 'dropbox', name: 'Dropbox', mirrorId: 'dropbox',
    endpoint: 'https://mcp.dropbox.com/mcp', scopes: DROPBOX_SCOPES,
    authorizeOrigin: 'https://www.dropbox.com/oauth2/authorize',
    envId: 'DROPBOX_OAUTH_CLIENT_ID', envSecret: 'DROPBOX_OAUTH_CLIENT_SECRET',
  },
];

const noFetch = async () => { throw new Error('no network in tests'); };

// ------------------------------------------------------------ catalog

test('catalog: the fixed tail is stocked brokered on claude, chatgpt, grok — and nowhere else', () => {
  for (const fam of FAMILY) {
    for (const seatId of SEATS) {
      const def = catalogEntryById(seatId, fam.entryId);
      assert.ok(def, `${seatId}/${fam.entryId}: stocked`);
      assert.equal(def.name, fam.name);
      assert.equal(def.vendorName, fam.name);
      assert.equal(def.trustLabel, 'community', `${seatId}/${fam.entryId}: the mirror's own label, upgraded nowhere`);
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${fam.entryId}: Helmian's own pipe`);
      assert.equal(def.authMode, 'oauth');
      assert.equal(def.mcpEndpointUrl, fam.endpoint, `${seatId}/${fam.entryId}: the vendor's published MCP server`);
      assert.equal(def.vendorPublished, true, `${seatId}/${fam.entryId}: the vendor's own server, marked as provenance`);
      assert.equal(def.vendorConnectorRef, undefined, `${seatId}/${fam.entryId}: a brokered entry carries no vendor ref`);
      assert.equal(def.addedBy, 'system');
      assert.deepEqual(def.oauthScopes, fam.scopes, `${seatId}/${fam.entryId}: the entry declares its server's published MCP scope set`);
      assert.ok(def.scopesSummary.length > 20, `${seatId}/${fam.entryId}: plain-words connect summary present`);
    }
    for (const seatId of LIVE_SEATS) {
      if (SEATS.includes(seatId)) continue;
      assert.equal(catalogEntryById(seatId, fam.entryId), null, `${seatId}: not stocked in this bite`);
    }
    for (const seatId of SEATS) {
      const ids = catalogEntriesForSeat(seatId).map((d) => d.id);
      assert.equal(ids.filter((id) => id === fam.entryId).length, 1, `${seatId}: exactly one ${fam.entryId}`);
    }
  }
  // Canva's brokered endpoint is the DEVELOPER server, never the
  // public consumer surface.
  const canva = catalogEntryById('claude', 'helmian-canva');
  assert.notEqual(canva.mcpEndpointUrl, 'https://mcp.canva.com/mcp');
  assert.equal(canva.mcpEndpointUrl, 'https://api.canva.com/connect/v1/mcp');
});

test('catalog: the vendor mirrors stay as data beside the brokered rows', () => {
  for (const seatId of SEATS) {
    const mirror = catalogEntryById(seatId, 'canva');
    assert.ok(mirror, `${seatId}/canva: mirror still stocked`);
    assert.equal(mirror.brokerMode, 'vendor', `${seatId}/canva: mirror untouched`);
    assert.equal(mirror.trustLabel, 'community');
  }
  // Dropbox's only mirror lives on chatgpt; it stays, untouched.
  const dropboxMirror = catalogEntryById('chatgpt', 'dropbox');
  assert.ok(dropboxMirror, 'chatgpt/dropbox: mirror still stocked');
  assert.equal(dropboxMirror.brokerMode, 'vendor', 'chatgpt/dropbox: mirror untouched');
  assert.equal(dropboxMirror.trustLabel, 'community');
  assert.equal(catalogEntryById('claude', 'dropbox'), null, 'claude: no Dropbox mirror was invented');
  assert.equal(catalogEntryById('grok', 'dropbox'), null, 'grok: no Dropbox mirror was invented');
});

test('catalog: no new service names — Canva and Dropbox were already named by their mirrors', () => {
  const names = new Set(CONNECTOR_CATALOG.map((d) => d.name.toLowerCase()));
  assert.equal(names.size, 27);
});

test('catalog copy: Canva stays inside its MCP scope set; Dropbox names the write scope and the beta', () => {
  const canva = catalogEntryById('claude', 'helmian-canva');
  assert.match(canva.scopesSummary, /brand kits/, 'Canva: brandkit:read is in the published set, so brand kits may be named');
  assert.match(canva.scopesSummary, /create and edit designs/, 'Canva: the design read/create family, as documented');
  assert.doesNotMatch(canva.scopesSummary, /export/i, 'Canva: no export scope is published, so no export promise');
  assert.doesNotMatch(canva.oneLiner, /export/i, 'Canva one-liner: no export promise');
  const dropbox = catalogEntryById('claude', 'helmian-dropbox');
  assert.ok(dropbox.oauthScopes.includes('files.content.write'), 'Dropbox: files.content.write is in the declared ask');
  assert.match(dropbox.scopesSummary, /writing file content/, 'Dropbox: the write scope is named in the words, with its reason');
  assert.match(dropbox.scopesSummary, /in beta/, 'Dropbox: the beta truth, said plainly');
  assert.match(dropbox.scopesSummary, /file requests/, 'Dropbox: file_requests scopes are in the ask, so file requests may be named');
});

// ------------------------------------------------- kind + registry

test('kind: both entries resolve the fixed kind under their own providers', () => {
  for (const fam of FAMILY) {
    const entry = { id: fam.entryId, authMode: 'oauth', mcpEndpointUrl: fam.endpoint };
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: {} }),
      { kind: 'fixed', provider: fam.provider, configured: false },
      `${fam.entryId}: fixed + unconfigured with no env`,
    );
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: { [fam.envId]: 'dummy-id', [fam.envSecret]: 'dummy-secret' } }),
      { kind: 'fixed', provider: fam.provider, configured: true },
      `${fam.entryId}: fixed + configured with the dummy pair`,
    );
    assert.equal(fixedProviderForEntry(entry), fam.provider);
    assert.equal(fixedProviderForEntry(catalogEntryById('claude', fam.entryId)), fam.provider);
  }
  // The neighbours are unmoved: Google still google, a DCR entry still DCR.
  assert.equal(fixedProviderForEntry({ id: 'helmian-gmail' }), 'google');
  assert.equal(
    connectorOAuthKindForEntry({ id: 'helmian-notion', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.notion.com/mcp' }, { env: {} }).kind,
    'dcr',
  );
});

test('kind: declaredOAuthScopes reads each entry\u2019s own ask from the catalog definition, never the stored row', () => {
  for (const fam of FAMILY) {
    assert.deepEqual(
      declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'catalog' }),
      fam.scopes,
      `${fam.entryId}: the catalog ask, from a row that carries none`,
    );
    assert.equal(declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'custom' }), null, 'custom never reads the catalog ask');
  }
});

test('registry: each provider answers null without its pair, a client carrying its clientId with it', () => {
  for (const fam of FAMILY) {
    assert.equal(createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: {} }), null, `${fam.provider}: absent unconfigured`);
    assert.equal(createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: { [fam.envId]: 'dummy-id' } }), null, `${fam.provider}: half a pair is not configured`);
    assert.equal(createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: { [fam.envSecret]: 'dummy-secret' } }), null, `${fam.provider}: the other half alone is not configured`);
    const client = createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: { [fam.envId]: 'dummy-id', [fam.envSecret]: 'dummy-secret' } });
    assert.ok(client, `${fam.provider}: client with the pair`);
    assert.equal(client.provider, fam.provider);
    assert.equal(client.displayName, fam.name);
    assert.equal(client.clientId, 'dummy-id', `${fam.provider}: the client names the id it was built from`);
    assert.equal(typeof client.refreshTokens, 'function', `${fam.provider}: the refresh exchange exists from day one`);
  }
});

// ------------------------------------------------------- factories

test('canva authorize URL: Canva\u2019s real endpoint, the declared scopes, PKCE S256, no offline shaping', async () => {
  const client = createConnectorOAuthClient('canva', { fetchImpl: noFetch, env: { CANVA_OAUTH_CLIENT_ID: 'canva-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-secret' } });
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', challenge: 'ch-1', scopes: CANVA_SCOPES }));
  assert.equal(url.origin + url.pathname, 'https://www.canva.com/api/oauth/authorize', "Canva's authorize endpoint, from its AS metadata");
  assert.equal(url.searchParams.get('client_id'), 'canva-id');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'ch-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.deepEqual(url.searchParams.get('scope').split(' '), CANVA_SCOPES, 'exactly the declared MCP scope set');
  assert.equal(url.searchParams.get('token_access_type'), null, 'Canva shapes no offline parameter — its refresh token rides the code exchange');
});

test('canva exchange: Basic-auth + PKCE at the metadata token endpoint; the secret never rides the form', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 14400 }) };
  };
  const client = createConnectorOAuthClient('canva', { fetchImpl, env: { CANVA_OAUTH_CLIENT_ID: 'canva-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-secret' } });
  const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK });
  assert.equal(seen[0][0], 'https://api.canva.com/auth/v1/oauth/token', "the token endpoint Canva's AS metadata names for this road");
  assert.equal(
    seen[0][1].headers.authorization,
    `Basic ${Buffer.from('canva-id:canva-secret', 'utf8').toString('base64')}`,
    'Basic access authentication, as Canva\u2019s Connect page recommends',
  );
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'authorization_code');
  assert.equal(sentForm.get('code'), 'c1');
  assert.equal(sentForm.get('code_verifier'), 'v1', 'the PKCE verifier rides the exchange');
  assert.equal(sentForm.get('redirect_uri'), CALLBACK);
  assert.equal(sentForm.get('client_secret'), null, 'the secret rides the Basic header, never the form');
  assert.equal(sentForm.get('client_id'), null, 'the client id rides the Basic header, never the form');
  assert.deepEqual([tokens.accessToken, tokens.refreshToken, tokens.expiresIn], ['at-1', 'rt-1', 14400]);
});

test('canva refresh: grant_type=refresh_token under the same Basic auth; a refused grant is marked refreshRefused', async () => {
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 14400 }) };
  };
  const client = createConnectorOAuthClient('canva', { fetchImpl: okFetch, env: { CANVA_OAUTH_CLIENT_ID: 'canva-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-secret' } });
  const tokens = await client.refreshTokens({ refreshToken: 'rt-1' });
  assert.equal(seen[0][0], 'https://api.canva.com/auth/v1/oauth/token');
  assert.equal(seen[0][1].headers.authorization, `Basic ${Buffer.from('canva-id:canva-secret', 'utf8').toString('base64')}`);
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'refresh_token');
  assert.equal(sentForm.get('refresh_token'), 'rt-1');
  assert.deepEqual([tokens.accessToken, tokens.refreshToken], ['at-2', 'rt-2'], 'Canva rotates: a fresh refresh token rides each refresh');

  const refuseFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Refresh token has already been used.' }) });
  const refusing = createConnectorOAuthClient('canva', { fetchImpl: refuseFetch, env: { CANVA_OAUTH_CLIENT_ID: 'canva-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-secret' } });
  await assert.rejects(
    () => refusing.refreshTokens({ refreshToken: 'rt-used' }),
    (error) => error.refreshRefused === true && /already been used/.test(error.message),
    'a provider refusal is marked, so the arming leg may mark needs-reconnect',
  );
});

test('dropbox authorize URL: Dropbox\u2019s real endpoint, the declared scopes, PKCE S256, token_access_type=offline', async () => {
  const client = createConnectorOAuthClient('dropbox', { fetchImpl: noFetch, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', challenge: 'ch-1', scopes: DROPBOX_SCOPES }));
  assert.equal(url.origin + url.pathname, 'https://www.dropbox.com/oauth2/authorize', "Dropbox's authorize endpoint, from its AS metadata");
  assert.equal(url.searchParams.get('client_id'), 'dropbox-key', 'the App key is the client_id on this road');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'ch-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.deepEqual(url.searchParams.get('scope').split(' '), DROPBOX_SCOPES, 'exactly the declared MCP scope set');
  assert.equal(url.searchParams.get('token_access_type'), 'offline', 'without offline access Dropbox issues no refresh token');
});

test('dropbox exchange: client_secret_post to Dropbox\u2019s token endpoint; tokens and refresh tokens parse', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 14400 }) };
  };
  const client = createConnectorOAuthClient('dropbox', { fetchImpl, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK });
  assert.equal(seen[0][0], 'https://api.dropboxapi.com/oauth2/token');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'authorization_code');
  assert.equal(sentForm.get('client_id'), 'dropbox-key');
  assert.equal(sentForm.get('client_secret'), 'dropbox-secret', 'client_secret_post: the App secret rides the exchange, server-side');
  assert.equal(sentForm.get('code_verifier'), 'v1');
  assert.equal(sentForm.get('redirect_uri'), CALLBACK);
  assert.deepEqual([tokens.accessToken, tokens.refreshToken, tokens.expiresIn], ['at-1', 'rt-1', 14400]);
});

test('dropbox refresh: grant_type=refresh_token on the same endpoint; a refused grant is marked refreshRefused', async () => {
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-2', token_type: 'bearer', expires_in: 14400 }) };
  };
  const client = createConnectorOAuthClient('dropbox', { fetchImpl: okFetch, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  const tokens = await client.refreshTokens({ refreshToken: 'rt-1' });
  assert.equal(seen[0][0], 'https://api.dropboxapi.com/oauth2/token');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'refresh_token');
  assert.equal(sentForm.get('refresh_token'), 'rt-1');
  assert.equal(sentForm.get('client_secret'), 'dropbox-secret');
  assert.equal(tokens.accessToken, 'at-2');

  const refuseFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'refresh token has been revoked' }) });
  const refusing = createConnectorOAuthClient('dropbox', { fetchImpl: refuseFetch, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  await assert.rejects(
    () => refusing.refreshTokens({ refreshToken: 'rt-dead' }),
    (error) => error.refreshRefused === true && /revoked/.test(error.message),
    'a provider refusal is marked, so the arming leg may mark needs-reconnect',
  );
});

test('dropbox identity: the current-account read answers the email; any miss is fail-soft null', async () => {
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ account_id: 'dbid:1', email: 'person@example.com', name: { display_name: 'A Person' } }) };
  };
  const client = createConnectorOAuthClient('dropbox', { fetchImpl: okFetch, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  assert.equal(await client.fetchIdentity({ accessToken: 'at-1' }), 'person@example.com');
  assert.equal(seen[0][0], 'https://api.dropboxapi.com/2/users/get_current_account');
  assert.equal(seen[0][1].headers.authorization, 'Bearer at-1');

  const downFetch = async () => { throw new Error('network down'); };
  const soft = createConnectorOAuthClient('dropbox', { fetchImpl: downFetch, env: { DROPBOX_OAUTH_CLIENT_ID: 'dropbox-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-secret' } });
  assert.equal(await soft.fetchIdentity({ accessToken: 'at-1' }), null, 'a failed identity read leaves the label to the provider name');

  const canva = createConnectorOAuthClient('canva', { fetchImpl: noFetch, env: { CANVA_OAUTH_CLIENT_ID: 'canva-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-secret' } });
  assert.equal(canva.fetchIdentity, undefined, 'Canva exposes no identity read on the MCP road — the label stands');
});

// ----------------------------------------------------- write route

function fakeStore(entries = {}) {
  const calls = [];
  const connections = new Map();
  return {
    calls, connections,
    async getEntry(tenantId, seatId, entryId) { return entries[`${seatId}/${entryId}`] ?? null; },
    async createConnection(tenantId, subject, input) {
      calls.push(['createConnection', input]);
      const connection = { personId: input.personId, seatId: input.seatId, entryId: input.entryId, state: 'connected', ...input };
      connections.set(`${input.personId}/${input.seatId}/${input.entryId}`, connection);
      return connection;
    },
    async disconnectConnection() { throw new Error('not used here'); },
    async setPosture() { throw new Error('not used here'); },
    async setEntryState() { throw new Error('not used here'); },
    async createEntry() { throw new Error('not used here'); },
    async removeEntry() { throw new Error('not used here'); },
  };
}

function fakePending() {
  const calls = [];
  return {
    calls,
    async save(tenantId, pending) { calls.push(['save', pending]); return true; },
    async take() { return null; },
  };
}

function fakeCredentials() {
  return {
    async storeCredential() { return { accepted: true, status: 'stored' }; },
    async resolveVaultCredential() { return { accepted: true, credential: 'x' }; },
    async revokeVaultCredential() { return { accepted: true, status: 'revoked' }; },
  };
}

const rowFor = (seatId, entryId) => ({ ...catalogEntryById(seatId, entryId), state: 'available' });

function harness({ store, pending, fetchImpl }) {
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: pending ?? fakePending(),
    credentialClient: fakeCredentials(),
    oauthClientFor: null,
    fetchImpl: fetchImpl ?? noFetch,
  });
  const sent = [];
  return {
    async run(path, body) {
      const handled = await handler({
        request: { method: 'POST' },
        response: {},
        requestUrl: new URL(path, 'https://helmian.cloud'),
        activeTenantActor: async () => OWNER,
        send: (response, status, payload) => { sent.push({ status, payload }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      return { handled, status: last?.status, json: JSON.parse(last?.payload ?? 'null') };
    },
  };
}

async function withEnv(pairs, fn) {
  const saved = {};
  for (const key of Object.keys(pairs)) {
    saved[key] = process.env[key];
    if (pairs[key] === undefined) delete process.env[key]; else process.env[key] = pairs[key];
  }
  try { return await fn(); } finally {
    for (const key of Object.keys(pairs)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

const NO_PAIRS = {
  CANVA_OAUTH_CLIENT_ID: undefined, CANVA_OAUTH_CLIENT_SECRET: undefined,
  DROPBOX_OAUTH_CLIENT_ID: undefined, DROPBOX_OAUTH_CLIENT_SECRET: undefined,
};

// The boundary's discovery stubs, shaped on each provider's real
// documents (the live reads in the header): the resource document
// names the issuer, the issuer's metadata names the authorize
// endpoint the factory builds.
const BOUNDARY_FETCH = {
  'helmian-canva': async (url) => {
    if (String(url).includes('/.well-known/oauth-protected-resource')) {
      return { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://www.canva.com'] }) };
    }
    if (String(url).includes('/.well-known/oauth-authorization-server')) {
      return { ok: true, status: 200, json: async () => ({ authorization_endpoint: 'https://www.canva.com/api/oauth/authorize' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  },
  'helmian-dropbox': async (url) => {
    if (String(url).includes('/.well-known/oauth-protected-resource')) {
      return { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://www.dropbox.com'] }) };
    }
    if (String(url).includes('/.well-known/oauth-authorization-server')) {
      return { ok: true, status: 200, json: async () => ({ authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  },
};

test('write route: with no registration placed, each start answers the consent boundary naming its own provider and connects nothing', async () => {
  await withEnv(NO_PAIRS, async () => {
    for (const fam of FAMILY) {
      const store = fakeStore({ [`claude/${fam.entryId}`]: rowFor('claude', fam.entryId) });
      const h = harness({ store, fetchImpl: BOUNDARY_FETCH[fam.entryId] });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.entryId}: the boundary answers 200`);
      assert.equal(out.json.status, 'consent-boundary', `${fam.entryId}: registration-missing, said honestly`);
      assert.equal(out.json.provider, fam.provider, `${fam.entryId}: the boundary names its own provider, not a sibling's`);
      assert.equal(out.json.mcpEndpointUrl, fam.endpoint);
      assert.equal(out.json.authorizationEndpoint, fam.authorizeOrigin);
      assert.match(out.json.note, new RegExp(`app registration in ${fam.name}`), `${fam.entryId}: the note names the provider`);
      assert.match(out.json.note, /cannot be connected inside Helmian yet/);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.entryId}: nothing connected`);
    }
  });
});

test('write route: with a dummy pair placed, each start saves its pending row under its own provider and answers the real authorize URL with PKCE', async () => {
  await withEnv({
    ...NO_PAIRS,
    CANVA_OAUTH_CLIENT_ID: 'canva-dummy-id', CANVA_OAUTH_CLIENT_SECRET: 'canva-dummy-secret',
    DROPBOX_OAUTH_CLIENT_ID: 'dropbox-dummy-key', DROPBOX_OAUTH_CLIENT_SECRET: 'dropbox-dummy-secret',
  }, async () => {
    for (const fam of FAMILY) {
      const store = fakeStore({ [`chatgpt/${fam.entryId}`]: rowFor('chatgpt', fam.entryId) });
      const pending = fakePending();
      const h = harness({ store, pending });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'chatgpt', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.entryId}: start answers`);
      assert.equal(out.json.status, 'authorize', `${fam.entryId}: the authorize start, not the boundary`);
      assert.equal(out.json.provider, fam.provider);
      const url = new URL(out.json.authorizeUrl);
      assert.equal(url.origin + url.pathname, fam.authorizeOrigin, `${fam.entryId}: the provider's real authorize endpoint`);
      assert.equal(url.searchParams.get('client_id'), fam.provider === 'canva' ? 'canva-dummy-id' : 'dropbox-dummy-key');
      assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('code_challenge'), `${fam.entryId}: a PKCE challenge rides the URL`);
      assert.deepEqual(url.searchParams.get('scope').split(' '), fam.scopes, `${fam.entryId}: the URL carries this entry's declared ask`);
      if (fam.provider === 'dropbox') {
        assert.equal(url.searchParams.get('token_access_type'), 'offline', 'Dropbox: the offline parameter rides the start');
      } else {
        assert.equal(url.searchParams.get('token_access_type'), null, 'Canva: no offline parameter is shaped');
      }
      const [, row] = pending.calls.find(([n]) => n === 'save') ?? [];
      assert.ok(row, `${fam.entryId}: a pending row was saved`);
      assert.equal(row.provider, fam.provider, `${fam.entryId}: the row runs under its own provider`);
      assert.equal(row.clientId, fam.provider === 'canva' ? 'canva-dummy-id' : 'dropbox-dummy-key', `${fam.entryId}: the row names the client the handshake runs under`);
      assert.deepEqual(row.scopes, fam.scopes, `${fam.entryId}: the row carries the declared ask`);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.entryId}: nothing connected before consent`);
    }
  });
});

test('write route: the neighbours are unmoved — GitHub keeps its table ask beside the new fixed entries', async () => {
  await withEnv({
    ...NO_PAIRS,
    GITHUB_OAUTH_CLIENT_ID: 'github-dummy-id', GITHUB_OAUTH_CLIENT_SECRET: 'github-dummy-secret',
  }, async () => {
    const ghStore = fakeStore({ 'claude/helmian-github': rowFor('claude', 'helmian-github') });
    const ghPending = fakePending();
    const gh = harness({ store: ghStore, pending: ghPending });
    const ghOut = await gh.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-github' });
    assert.equal(ghOut.json.status, 'authorize');
    assert.equal(ghOut.json.provider, 'github');
    const [, ghRow] = ghPending.calls.find(([n]) => n === 'save') ?? [];
    assert.deepEqual(ghRow.scopes, ['repo', 'read:org'], 'GitHub: the per-provider table ask, unchanged');
  });
});

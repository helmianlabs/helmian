// Bite R2 — the team-work family: Slack, Asana, HubSpot brokered,
// Figma mirror-only.
//
// What is proven here:
//   - the catalog stocks the three brokered entries on claude,
//     chatgpt, grok (nowhere else yet), as Helmian-brokered OAuth
//     rows naming the vendors' own published MCP servers; the Slack
//     vendor mirrors stay untouched as data; Figma exists ONLY as
//     a vendor mirror (Figma's own client-catalog gate) — no
//     brokered Figma entry exists anywhere;
//   - kind resolution: the three entries resolve the FIXED kind
//     under their own providers (their servers publish no
//     registration endpoint, so the DCR road cannot serve them),
//     configured exactly when the provider's env pair is placed;
//   - the registry: each provider answers a client only with its
//     env pair present; the factories build the authorize URLs the
//     providers' own documents name — Slack's user-token endpoint
//     carrying the declared user scopes, Asana's authorize with the
//     resource indicator and NO scope parameter (Asana errors on
//     one), HubSpot's MCP authorize with PKCE and no scopes
//     (HubSpot defines none on the connector);
//   - the exchanges: Slack's ok:false refusal shape is a refusal,
//     never an empty success; the standard JSON exchanges parse
//     tokens and refresh tokens;
//   - the write route: with no env pair placed, each entry's
//     connect start answers the consent boundary NAMING its own
//     provider and connects nothing; with a (dummy, test-only) pair
//     placed, the start saves the pending row under that provider
//     and its own client id and answers the provider's real
//     authorize URL; GitHub's fixed road is unchanged (the row
//     still names the env client id).
//
// Live evidence behind the shapes (2026-11-10): Slack's own
// metadata (issuer https://mcp.slack.com) names
// https://slack.com/oauth/v2_user/authorize and
// https://slack.com/api/oauth.v2.user.access, PKCE S256,
// client_secret_post, and the 30 published scopes pinned below;
// Asana's metadata names https://app.asana.com/-/oauth_authorize
// and /-/oauth_token with NO registration endpoint; HubSpot's
// names https://mcp.hubspot.com/oauth/authorize/user and
// /oauth/v3/token, client_secret_post, no registration endpoint.

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
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';

class TenantAuthorizationError extends Error {}

const OWNER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];

const FAMILY = [
  { entryId: 'helmian-slack', name: 'Slack', provider: 'slack', endpoint: 'https://mcp.slack.com/mcp', envId: 'SLACK_OAUTH_CLIENT_ID', envSecret: 'SLACK_OAUTH_CLIENT_SECRET' },
  { entryId: 'helmian-asana', name: 'Asana', provider: 'asana', endpoint: 'https://mcp.asana.com/v2/mcp', envId: 'ASANA_OAUTH_CLIENT_ID', envSecret: 'ASANA_OAUTH_CLIENT_SECRET' },
  { entryId: 'helmian-hubspot', name: 'HubSpot', provider: 'hubspot', endpoint: 'https://mcp.hubspot.com', envId: 'HUBSPOT_OAUTH_CLIENT_ID', envSecret: 'HUBSPOT_OAUTH_CLIENT_SECRET' },
];

// The scopes Slack's MCP server itself publishes (its protected-
// resource and authorization-server documents, read live
// 2026-11-10). The declared ask must sit inside this set.
const SLACK_PUBLISHED_SCOPES = [
  'canvases:read', 'canvases:write', 'channels:history', 'channels:read', 'channels:write',
  'chat:write', 'emoji:read', 'files:read', 'files:write', 'groups:history', 'groups:read',
  'groups:write', 'im:history', 'im:read', 'im:write', 'lists:read', 'lists:write',
  'mpim:history', 'mpim:read', 'mpim:write', 'reactions:read', 'reactions:write',
  'search:read.files', 'search:read.im', 'search:read.mpim', 'search:read.private',
  'search:read.public', 'search:read.users', 'users:read', 'users:read.email',
];

// The declared Slack ask: search + read only — the catalog entry's
// words promise drafting, never posting — pinned exactly.
const SLACK_DECLARED_SCOPES = [
  'search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim',
  'search:read.files', 'search:read.users',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'users:read', 'users:read.email', 'files:read',
];

const noFetch = async () => { throw new Error('no network in tests'); };

// ------------------------------------------------------------ catalog

test('catalog: the team-work family is stocked brokered on claude, chatgpt, grok — and nowhere else', () => {
  for (const fam of FAMILY) {
    for (const seatId of SEATS) {
      const def = catalogEntryById(seatId, fam.entryId);
      assert.ok(def, `${seatId}/${fam.entryId}: stocked`);
      assert.equal(def.name, fam.name);
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${fam.entryId}: Helmian's own pipe`);
      assert.equal(def.authMode, 'oauth');
      assert.equal(def.mcpEndpointUrl, fam.endpoint, `${seatId}/${fam.entryId}: the vendor's published server`);
      assert.equal(def.vendorPublished, true, `${seatId}/${fam.entryId}: the vendor's own server, marked as provenance`);
      assert.equal(def.vendorConnectorRef, undefined, `${seatId}/${fam.entryId}: a brokered entry carries no vendor ref`);
      assert.equal(def.addedBy, 'system');
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
});

test('catalog: the Slack vendor mirrors stay as data beside the brokered row; grok gains no mirror', () => {
  for (const seatId of ['claude', 'chatgpt']) {
    const mirror = catalogEntryById(seatId, 'slack');
    assert.ok(mirror, `${seatId}: mirror still stocked`);
    assert.equal(mirror.brokerMode, 'vendor', `${seatId}: mirror untouched`);
  }
  assert.equal(catalogEntryById('grok', 'slack'), null, 'grok never carried a Slack mirror');
});

test('catalog: Figma is a vendor mirror only — no brokered Figma entry exists on any seat', () => {
  for (const seatId of ['claude', 'chatgpt']) {
    const def = catalogEntryById(seatId, 'figma');
    assert.ok(def, `${seatId}: Figma mirror stocked`);
    assert.equal(def.brokerMode, 'vendor');
    assert.equal(def.name, 'Figma');
  }
  assert.equal(CONNECTOR_CATALOG.some((d) => d.id === 'helmian-figma'), false, 'no brokered Figma entry anywhere');
});

test('catalog: the library names 27 services after R2 (24 + Asana + HubSpot brokered, + Figma mirror-only)', () => {
  const names = new Set(CONNECTOR_CATALOG.map((d) => d.name.toLowerCase()));
  assert.equal(names.size, 27);
  for (const name of ['slack', 'asana', 'hubspot', 'figma']) assert.ok(names.has(name), name);
});

// ------------------------------------------------- kind + registry

test('kind: the family resolves the fixed kind under its own provider, configured only with its env pair placed', () => {
  for (const fam of FAMILY) {
    const entry = { id: fam.entryId, authMode: 'oauth', mcpEndpointUrl: fam.endpoint };
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: {} }),
      { kind: 'fixed', provider: fam.provider, configured: false },
      `${fam.provider}: fixed + unconfigured with no env`,
    );
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: { [fam.envId]: 'dummy-id', [fam.envSecret]: 'dummy-secret' } }),
      { kind: 'fixed', provider: fam.provider, configured: true },
      `${fam.provider}: fixed + configured with the dummy pair`,
    );
    assert.equal(fixedProviderForEntry(entry), fam.provider);
  }
  // The neighbours are unmoved: GitHub fixed, a DCR pick still DCR.
  assert.equal(connectorOAuthKindForEntry({ id: 'helmian-github', authMode: 'oauth' }, { env: {} }).kind, 'fixed');
  assert.equal(
    connectorOAuthKindForEntry({ id: 'helmian-notion', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.notion.com/mcp' }, { env: {} }).kind,
    'dcr',
  );
});

test('registry: each family provider answers null without its pair, a client carrying its clientId with it', () => {
  for (const fam of FAMILY) {
    assert.equal(createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: {} }), null, `${fam.provider}: absent unconfigured`);
    assert.equal(createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: { [fam.envId]: 'dummy-id' } }), null, `${fam.provider}: half a pair is not configured`);
    const client = createConnectorOAuthClient(fam.provider, { fetchImpl: noFetch, env: { [fam.envId]: 'dummy-id', [fam.envSecret]: 'dummy-secret' } });
    assert.ok(client, `${fam.provider}: client with the pair`);
    assert.equal(client.provider, fam.provider);
    assert.equal(client.clientId, 'dummy-id', `${fam.provider}: the client names the id it was built from`);
  }
});

// ------------------------------------------------------- factories

test('slack authorize URL: the user-token endpoint, the declared scopes, PKCE S256', async () => {
  const client = createConnectorOAuthClient('slack', { fetchImpl: noFetch, env: { SLACK_OAUTH_CLIENT_ID: 'slack-id', SLACK_OAUTH_CLIENT_SECRET: 'slack-secret' } });
  const raw = await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', challenge: 'ch-1', scopes: SLACK_DECLARED_SCOPES });
  const url = new URL(raw);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2_user/authorize');
  assert.equal(url.searchParams.get('client_id'), 'slack-id');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'ch-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const asked = url.searchParams.get('scope').split(' ');
  assert.deepEqual([...asked].sort(), [...SLACK_DECLARED_SCOPES].sort(), 'the exact declared ask');
  for (const scope of asked) assert.ok(SLACK_PUBLISHED_SCOPES.includes(scope), `${scope}: inside the set Slack's server publishes`);
  assert.ok(!asked.includes('chat:write'), 'no posting scope: the promise is drafting, never sending');
});

test('slack exchange: the Web API token method; ok:false is a refusal, a token parses with its scope', async () => {
  const seen = [];
  const refuseFetch = async (url, init) => { seen.push([url, init]); return { ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_code' }) }; };
  const refusing = createConnectorOAuthClient('slack', { fetchImpl: refuseFetch, env: { SLACK_OAUTH_CLIENT_ID: 'slack-id', SLACK_OAUTH_CLIENT_SECRET: 'slack-secret' } });
  await assert.rejects(() => refusing.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK }), /invalid_code/);
  assert.equal(seen[0][0], 'https://slack.com/api/oauth.v2.user.access');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('client_secret'), 'slack-secret');
  assert.equal(sentForm.get('code_verifier'), 'v1');
  assert.equal(sentForm.get('redirect_uri'), CALLBACK);

  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, access_token: 'xoxp-1', token_type: 'user', scope: 'channels:read' }) });
  const client = createConnectorOAuthClient('slack', { fetchImpl: okFetch, env: { SLACK_OAUTH_CLIENT_ID: 'slack-id', SLACK_OAUTH_CLIENT_SECRET: 'slack-secret' } });
  const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK });
  assert.equal(tokens.accessToken, 'xoxp-1');
  assert.equal(tokens.refreshToken, null, 'no rotation on this app: no refresh token, said plainly');
  assert.equal(await client.fetchIdentity({ accessToken: 'xoxp-1' }), null, 'identity read is fail-soft when auth.test does not answer ok');
});

test('asana authorize URL: the resource indicator is set and NO scope parameter exists, whatever the caller passes', async () => {
  const client = createConnectorOAuthClient('asana', { fetchImpl: noFetch, env: { ASANA_OAUTH_CLIENT_ID: 'asana-id', ASANA_OAUTH_CLIENT_SECRET: 'asana-secret' } });
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 's', challenge: 'ch', scopes: ['default', 'anything'] }));
  assert.equal(url.origin + url.pathname, 'https://app.asana.com/-/oauth_authorize');
  assert.equal(url.searchParams.get('resource'), 'https://mcp.asana.com/v2');
  assert.equal(url.searchParams.has('scope'), false, 'Asana errors on a scope parameter (its own guide) — none is sent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(client.fetchIdentity, undefined, 'no identity read exists on the Asana road: MCP tokens never reach the standard API');
});

test('asana + hubspot exchanges: the standard JSON shape parses tokens and refresh tokens', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 }) }; };
  const asana = createConnectorOAuthClient('asana', { fetchImpl, env: { ASANA_OAUTH_CLIENT_ID: 'a', ASANA_OAUTH_CLIENT_SECRET: 'b' } });
  const asanaTokens = await asana.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: CALLBACK });
  assert.equal(seen[0], 'https://app.asana.com/-/oauth_token');
  assert.deepEqual([asanaTokens.accessToken, asanaTokens.refreshToken, asanaTokens.expiresIn], ['at-1', 'rt-1', 3600], 'the one-hour token and its refresh token both land');

  const hubspot = createConnectorOAuthClient('hubspot', { fetchImpl, env: { HUBSPOT_OAUTH_CLIENT_ID: 'h', HUBSPOT_OAUTH_CLIENT_SECRET: 's' } });
  const hubspotTokens = await hubspot.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: CALLBACK });
  assert.equal(seen[1], 'https://mcp.hubspot.com/oauth/v3/token');
  assert.equal(hubspotTokens.accessToken, 'at-1');
});

test('hubspot authorize URL: the MCP authorize path, PKCE, no scope parameter; identity reads the token owner', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/api\.hubapi\.com\/oauth\/v1\/access-tokens\//);
    return { ok: true, status: 200, json: async () => ({ user: 'owner@example.com', hub_id: 123 }) };
  };
  const client = createConnectorOAuthClient('hubspot', { fetchImpl, env: { HUBSPOT_OAUTH_CLIENT_ID: 'hub-id', HUBSPOT_OAUTH_CLIENT_SECRET: 'hub-secret' } });
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 's', challenge: 'ch', scopes: ['should-not-ride'] }));
  assert.equal(url.origin + url.pathname, 'https://mcp.hubspot.com/oauth/authorize/user');
  assert.equal(url.searchParams.has('scope'), false, 'HubSpot defines no scopes on an MCP connector — none is sent');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(await client.fetchIdentity({ accessToken: 'at-1' }), 'owner@example.com');
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
    // null → NO registry seam: the handler's own registry and env
    // rule, the production shape.
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

// Set (or clear) env pairs for one route run, restoring the
// process env afterwards. Dummy values only — test fixtures, never
// a real registration.
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

const NO_FAMILY_ENV = {
  SLACK_OAUTH_CLIENT_ID: undefined, SLACK_OAUTH_CLIENT_SECRET: undefined,
  ASANA_OAUTH_CLIENT_ID: undefined, ASANA_OAUTH_CLIENT_SECRET: undefined,
  HUBSPOT_OAUTH_CLIENT_ID: undefined, HUBSPOT_OAUTH_CLIENT_SECRET: undefined,
};

test('write route: with no registration placed, each family start answers the consent boundary naming its own provider', async () => {
  await withEnv(NO_FAMILY_ENV, async () => {
    for (const fam of FAMILY) {
      const store = fakeStore({ [`claude/${fam.entryId}`]: rowFor('claude', fam.entryId) });
      // The boundary's live metadata fetch, shaped the way the
      // provider's own documents answer.
      const fetchImpl = async (url) => {
        if (String(url).includes('/.well-known/oauth-protected-resource')) {
          return { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://issuer.example'] }) };
        }
        if (String(url).includes('/.well-known/oauth-authorization-server')) {
          return { ok: true, status: 200, json: async () => ({ authorization_endpoint: 'https://issuer.example/authorize' }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      const h = harness({ store, fetchImpl });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.provider}: the boundary answers 200`);
      assert.equal(out.json.status, 'consent-boundary', `${fam.provider}: registration-missing, said honestly`);
      assert.equal(out.json.provider, fam.provider, `${fam.provider}: the boundary names its own provider`);
      assert.equal(out.json.authorizationEndpoint, 'https://issuer.example/authorize');
      assert.match(out.json.note, /no OAuth client registration/);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.provider}: nothing connected`);
    }
  });
});

test('write route: with a dummy pair placed, each family start saves its pending row and answers the real authorize URL', async () => {
  for (const fam of FAMILY) {
    await withEnv({ ...NO_FAMILY_ENV, [fam.envId]: `${fam.provider}-dummy-id`, [fam.envSecret]: `${fam.provider}-dummy-secret` }, async () => {
      const store = fakeStore({ [`grok/${fam.entryId}`]: rowFor('grok', fam.entryId) });
      const pending = fakePending();
      const h = harness({ store, pending });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'grok', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.provider}: start answers`);
      assert.equal(out.json.status, 'authorize', `${fam.provider}: the authorize start, not the boundary`);
      assert.equal(out.json.provider, fam.provider);
      const url = new URL(out.json.authorizeUrl);
      assert.equal(url.searchParams.get('client_id'), `${fam.provider}-dummy-id`);
      assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const [, row] = pending.calls.find(([n]) => n === 'save') ?? [];
      assert.ok(row, `${fam.provider}: a pending row was saved`);
      assert.equal(row.provider, fam.provider);
      assert.equal(row.clientId, `${fam.provider}-dummy-id`, `${fam.provider}: the row names the client the handshake runs under`);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.provider}: nothing connected before consent`);
      if (fam.provider === 'slack') {
        assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2_user/authorize');
        assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [...SLACK_DECLARED_SCOPES].sort());
        assert.deepEqual([...row.scopes].sort(), [...SLACK_DECLARED_SCOPES].sort(), 'the row carries the declared ask');
      }
      if (fam.provider === 'asana') {
        assert.equal(url.origin + url.pathname, 'https://app.asana.com/-/oauth_authorize');
        assert.equal(url.searchParams.get('resource'), 'https://mcp.asana.com/v2');
        assert.equal(url.searchParams.has('scope'), false);
        assert.deepEqual(row.scopes, [], 'the Asana row carries no scopes: Asana defines none');
      }
      if (fam.provider === 'hubspot') {
        assert.equal(url.origin + url.pathname, 'https://mcp.hubspot.com/oauth/authorize/user');
        assert.equal(url.searchParams.has('scope'), false);
        assert.deepEqual(row.scopes, [], 'the HubSpot row carries no scopes: HubSpot defines none on the connector');
      }
    });
  }
});

test('write route: the GitHub fixed road is unchanged — its row still names the env client id', async () => {
  await withEnv({ ...NO_FAMILY_ENV, GITHUB_OAUTH_CLIENT_ID: 'github-dummy-id', GITHUB_OAUTH_CLIENT_SECRET: 'github-dummy-secret' }, async () => {
    const store = fakeStore({ 'claude/helmian-github': rowFor('claude', 'helmian-github') });
    const pending = fakePending();
    const h = harness({ store, pending });
    const out = await h.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-github' });
    assert.equal(out.json.status, 'authorize');
    assert.equal(out.json.provider, 'github');
    const [, row] = pending.calls.find(([n]) => n === 'save') ?? [];
    assert.equal(row.clientId, 'github-dummy-id');
    assert.deepEqual(row.scopes, ['repo', 'read:org']);
  });
});

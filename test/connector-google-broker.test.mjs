// The Google family broker — Gmail, Google Calendar, Google Drive.
//
// What is proven here:
//   - the catalog stocks the three brokered entries beside the
//     mirrors on claude, chatgpt, grok (nowhere else), as
//     Helmian-brokered OAuth rows naming Google's own published
//     MCP servers, each declaring its OWN product scopes — the
//     scopes Google's Workspace MCP setup page names for that
//     product;
//   - the copy is truthful: Gmail's words promise drafts and
//     reads and say plainly it cannot send (Google's published
//     Gmail tool list has no send tool); Calendar's words promise
//     no event creation (its declared scopes are read-only and
//     write tools are UNVERIFIED in the research);
//   - kind resolution: all three entries resolve the FIXED kind
//     under the ONE provider 'google' (one Google Cloud OAuth
//     client covers all three; Google's authorization-server
//     metadata names no registration endpoint and no CIMD
//     support, so neither other road can serve them), configured
//     exactly when the GOOGLE_OAUTH_* pair is placed;
//   - the registry: 'google' answers a client only with its pair
//     present; the factory builds Google's real authorize URL
//     carrying the per-entry declared scopes plus
//     access_type=offline + prompt=consent (without them Google
//     issues no refresh token) and PKCE S256; the exchange and
//     the refresh exchange both post client_secret_post to
//     Google's token endpoint; the identity read is Google's
//     userinfo, fail-soft;
//   - the write route through the real handler with the real
//     catalog rows: with no env pair placed, each start answers
//     the consent boundary (provider 'google') and connects
//     nothing; with a (dummy, test-only) pair placed, each start
//     saves its pending row under provider 'google' and answers
//     Google's real authorize URL with that product's scopes;
//   - the neighbours are unmoved: GitHub's fixed ask and Slack's
//     declared ask are byte-for-byte what they were (the fixed
//     start's declared-scopes precedence touches no road that
//     declares none).
//
// Live evidence behind the shapes (2026-11-10, whole-list
// research google-microsoft.md §1): endpoints
// gmailmcp/calendarmcp/drivemcp.googleapis.com/mcp/v1; authorize
// https://accounts.google.com/o/oauth2/v2/auth; token
// https://oauth2.googleapis.com/token; PKCE S256; grants
// authorization_code + refresh_token; no registration_endpoint,
// no client_id_metadata_document_supported.

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

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const FAMILY = [
  { entryId: 'helmian-gmail', name: 'Gmail', mirrorId: 'gmail', endpoint: 'https://gmailmcp.googleapis.com/mcp/v1', scopes: GMAIL_SCOPES },
  { entryId: 'helmian-google-calendar', name: 'Google Calendar', mirrorId: 'google-calendar', endpoint: 'https://calendarmcp.googleapis.com/mcp/v1', scopes: CALENDAR_SCOPES },
  { entryId: 'helmian-google-drive', name: 'Google Drive', mirrorId: 'google-drive', endpoint: 'https://drivemcp.googleapis.com/mcp/v1', scopes: DRIVE_SCOPES },
];

const noFetch = async () => { throw new Error('no network in tests'); };

// ------------------------------------------------------------ catalog

test('catalog: the Google family is stocked brokered on claude, chatgpt, grok — and nowhere else', () => {
  for (const fam of FAMILY) {
    for (const seatId of SEATS) {
      const def = catalogEntryById(seatId, fam.entryId);
      assert.ok(def, `${seatId}/${fam.entryId}: stocked`);
      assert.equal(def.name, fam.name);
      assert.equal(def.vendorName, 'Google');
      assert.equal(def.trustLabel, 'verified');
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${fam.entryId}: Helmian's own pipe`);
      assert.equal(def.authMode, 'oauth');
      assert.equal(def.mcpEndpointUrl, fam.endpoint, `${seatId}/${fam.entryId}: Google's published server`);
      assert.equal(def.vendorPublished, true, `${seatId}/${fam.entryId}: Google's own server, marked as provenance`);
      assert.equal(def.vendorConnectorRef, undefined, `${seatId}/${fam.entryId}: a brokered entry carries no vendor ref`);
      assert.equal(def.addedBy, 'system');
      assert.deepEqual(def.oauthScopes, fam.scopes, `${seatId}/${fam.entryId}: the entry declares its own product scopes`);
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

test('catalog: the Google vendor mirrors stay as data beside the brokered rows, gemini included', () => {
  for (const fam of FAMILY) {
    for (const seatId of ['claude', 'chatgpt', 'grok', 'gemini']) {
      const mirror = catalogEntryById(seatId, fam.mirrorId);
      assert.ok(mirror, `${seatId}/${fam.mirrorId}: mirror still stocked`);
      assert.equal(mirror.brokerMode, 'vendor', `${seatId}/${fam.mirrorId}: mirror untouched`);
    }
    // The brokered row never lands on gemini in this bite, even
    // though its mirrors live there.
    assert.equal(catalogEntryById('gemini', fam.entryId), null, `gemini: no brokered ${fam.entryId}`);
  }
});

test('catalog: no new service names — Gmail, Google Calendar and Google Drive were already named by their mirrors', () => {
  const names = new Set(CONNECTOR_CATALOG.map((d) => d.name.toLowerCase()));
  assert.equal(names.size, 27);
});

test('catalog copy: Gmail promises drafts and reads and never sending; Calendar promises no event creation', () => {
  const gmail = catalogEntryById('claude', 'helmian-gmail');
  assert.match(gmail.scopesSummary, /drafts/i, 'Gmail: drafts are the promise');
  assert.match(gmail.scopesSummary, /cannot send mail/, 'Gmail: the no-send truth, said plainly');
  assert.match(gmail.oneLiner, /draft replies/i);
  assert.doesNotMatch(gmail.oneLiner, /send/i, 'Gmail one-liner never promises sending');
  const calendar = catalogEntryById('claude', 'helmian-google-calendar');
  assert.doesNotMatch(calendar.scopesSummary, /creat/i, 'Calendar: no creation promise (write tools UNVERIFIED)');
  assert.doesNotMatch(calendar.oneLiner, /creat/i, 'Calendar one-liner: no creation promise');
  assert.match(calendar.scopesSummary, /read your events/);
});

// ------------------------------------------------- kind + registry

test('kind: all three entries resolve the fixed kind under the one provider google', () => {
  for (const fam of FAMILY) {
    const entry = { id: fam.entryId, authMode: 'oauth', mcpEndpointUrl: fam.endpoint };
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: {} }),
      { kind: 'fixed', provider: 'google', configured: false },
      `${fam.entryId}: fixed + unconfigured with no env`,
    );
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: { GOOGLE_OAUTH_CLIENT_ID: 'dummy-id', GOOGLE_OAUTH_CLIENT_SECRET: 'dummy-secret' } }),
      { kind: 'fixed', provider: 'google', configured: true },
      `${fam.entryId}: fixed + configured with the dummy pair`,
    );
    assert.equal(fixedProviderForEntry(entry), 'google');
    // The catalog-shaped entry resolves identically.
    assert.equal(fixedProviderForEntry(catalogEntryById('claude', fam.entryId)), 'google');
  }
  // The neighbours are unmoved: GitHub fixed, Slack fixed, a DCR pick still DCR.
  assert.equal(connectorOAuthKindForEntry({ id: 'helmian-github', authMode: 'oauth' }, { env: {} }).kind, 'fixed');
  assert.equal(connectorOAuthKindForEntry({ id: 'helmian-slack', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.slack.com/mcp' }, { env: {} }).provider, 'slack');
  assert.equal(
    connectorOAuthKindForEntry({ id: 'helmian-notion', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.notion.com/mcp' }, { env: {} }).kind,
    'dcr',
  );
});

test('kind: declaredOAuthScopes reads each Google entry\u2019s own ask from the catalog definition, never the stored row', () => {
  for (const fam of FAMILY) {
    // A stored-row shape: no oauthScopes field exists on the row —
    // the answer must still be the catalog's declaration.
    assert.deepEqual(
      declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'catalog' }),
      fam.scopes,
      `${fam.entryId}: the catalog ask, from a row that carries none`,
    );
    assert.equal(declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'custom' }), null, 'custom never reads the catalog ask');
  }
  // One provider, three DIFFERENT asks — the reason no
  // per-provider scope table can carry this family.
  assert.notDeepEqual(GMAIL_SCOPES, CALENDAR_SCOPES);
  assert.notDeepEqual(GMAIL_SCOPES, DRIVE_SCOPES);
  assert.notDeepEqual(CALENDAR_SCOPES, DRIVE_SCOPES);
});

test('registry: google answers null without its pair, a client carrying its clientId with it', () => {
  assert.equal(createConnectorOAuthClient('google', { fetchImpl: noFetch, env: {} }), null, 'absent unconfigured');
  assert.equal(createConnectorOAuthClient('google', { fetchImpl: noFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'dummy-id' } }), null, 'half a pair is not configured');
  assert.equal(createConnectorOAuthClient('google', { fetchImpl: noFetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 'dummy-secret' } }), null, 'the other half alone is not configured');
  const client = createConnectorOAuthClient('google', { fetchImpl: noFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'dummy-id', GOOGLE_OAUTH_CLIENT_SECRET: 'dummy-secret' } });
  assert.ok(client, 'client with the pair');
  assert.equal(client.provider, 'google');
  assert.equal(client.displayName, 'Google');
  assert.equal(client.clientId, 'dummy-id', 'the client names the id it was built from');
  assert.equal(typeof client.refreshTokens, 'function', 'the refresh exchange exists from day one');
});

// ------------------------------------------------------- factories

test('google authorize URL: Google\u2019s real endpoint, the per-entry scopes, offline + consent, PKCE S256', async () => {
  const client = createConnectorOAuthClient('google', { fetchImpl: noFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  for (const fam of FAMILY) {
    const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', challenge: 'ch-1', scopes: fam.scopes }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth', `${fam.entryId}: Google's authorize endpoint`);
    assert.equal(url.searchParams.get('client_id'), 'google-id');
    assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge'), 'ch-1');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state-1');
    assert.deepEqual(url.searchParams.get('scope').split(' '), fam.scopes, `${fam.entryId}: exactly its own product scopes`);
    assert.equal(url.searchParams.get('access_type'), 'offline', 'without offline access Google issues no refresh token');
    assert.equal(url.searchParams.get('prompt'), 'consent', 'consent is what makes Google re-issue the refresh token');
  }
});

test('google exchange: client_secret_post to Google\u2019s token endpoint; tokens and refresh tokens parse', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', scope: GMAIL_SCOPES.join(' '), expires_in: 3599 }) };
  };
  const client = createConnectorOAuthClient('google', { fetchImpl, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK });
  assert.equal(seen[0][0], 'https://oauth2.googleapis.com/token');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'authorization_code');
  assert.equal(sentForm.get('client_id'), 'google-id');
  assert.equal(sentForm.get('client_secret'), 'google-secret', 'client_secret_post: the secret rides the exchange, server-side');
  assert.equal(sentForm.get('code_verifier'), 'v1');
  assert.equal(sentForm.get('redirect_uri'), CALLBACK);
  assert.deepEqual([tokens.accessToken, tokens.refreshToken, tokens.expiresIn], ['at-1', 'rt-1', 3599]);
});

test('google refresh: grant_type=refresh_token on the same endpoint; a refused grant is marked refreshRefused', async () => {
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-2', token_type: 'Bearer', expires_in: 3599 }) };
  };
  const client = createConnectorOAuthClient('google', { fetchImpl: okFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  const tokens = await client.refreshTokens({ refreshToken: 'rt-1' });
  assert.equal(seen[0][0], 'https://oauth2.googleapis.com/token');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'refresh_token');
  assert.equal(sentForm.get('refresh_token'), 'rt-1');
  assert.equal(sentForm.get('client_secret'), 'google-secret');
  assert.equal(tokens.accessToken, 'at-2');
  assert.equal(tokens.refreshToken, null, 'Google does not rotate on refresh: no new refresh token, said plainly');

  const refuseFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been revoked.' }) });
  const refusing = createConnectorOAuthClient('google', { fetchImpl: refuseFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  await assert.rejects(
    () => refusing.refreshTokens({ refreshToken: 'rt-dead' }),
    (error) => error.refreshRefused === true && /revoked/.test(error.message),
    'a provider refusal is marked, so the arming leg may mark needs-reconnect',
  );
});

test('google identity: userinfo answers the account email; any miss is fail-soft null', async () => {
  const seen = [];
  const okFetch = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ sub: '123', email: 'person@example.com', name: 'A Person' }) };
  };
  const client = createConnectorOAuthClient('google', { fetchImpl: okFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  assert.equal(await client.fetchIdentity({ accessToken: 'at-1' }), 'person@example.com');
  assert.equal(seen[0][0], 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(seen[0][1].headers.authorization, 'Bearer at-1');

  const downFetch = async () => { throw new Error('network down'); };
  const soft = createConnectorOAuthClient('google', { fetchImpl: downFetch, env: { GOOGLE_OAUTH_CLIENT_ID: 'google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' } });
  assert.equal(await soft.fetchIdentity({ accessToken: 'at-1' }), null, 'a failed identity read leaves the label to the provider name');
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

const NO_GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined };

test('write route: with no registration placed, each Google start answers the consent boundary naming Google and connects nothing', async () => {
  await withEnv(NO_GOOGLE_ENV, async () => {
    for (const fam of FAMILY) {
      const store = fakeStore({ [`claude/${fam.entryId}`]: rowFor('claude', fam.entryId) });
      const fetchImpl = async (url) => {
        if (String(url).includes('/.well-known/oauth-protected-resource')) {
          return { ok: true, status: 200, json: async () => ({ authorization_servers: ['https://accounts.google.com/'] }) };
        }
        if (String(url).includes('/.well-known/oauth-authorization-server')) {
          return { ok: true, status: 200, json: async () => ({ authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth' }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      const h = harness({ store, fetchImpl });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.entryId}: the boundary answers 200`);
      assert.equal(out.json.status, 'consent-boundary', `${fam.entryId}: registration-missing, said honestly`);
      assert.equal(out.json.provider, 'google', `${fam.entryId}: the boundary names the one Google provider`);
      assert.equal(out.json.mcpEndpointUrl, fam.endpoint);
      assert.equal(out.json.authorizationEndpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.match(out.json.note, /app registration in .* own console has not been placed yet/);
      assert.match(out.json.note, /cannot be connected inside Helmian yet/);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.entryId}: nothing connected`);
    }
  });
});

test('write route: with a dummy pair placed, each Google start saves its pending row under google and answers the real authorize URL with that product\u2019s scopes', async () => {
  await withEnv({ ...NO_GOOGLE_ENV, GOOGLE_OAUTH_CLIENT_ID: 'google-dummy-id', GOOGLE_OAUTH_CLIENT_SECRET: 'google-dummy-secret' }, async () => {
    for (const fam of FAMILY) {
      const store = fakeStore({ [`chatgpt/${fam.entryId}`]: rowFor('chatgpt', fam.entryId) });
      const pending = fakePending();
      const h = harness({ store, pending });
      const out = await h.run('/api/admin/connector-library/connect', { seatId: 'chatgpt', entryId: fam.entryId });
      assert.equal(out.status, 200, `${fam.entryId}: start answers`);
      assert.equal(out.json.status, 'authorize', `${fam.entryId}: the authorize start, not the boundary`);
      assert.equal(out.json.provider, 'google');
      const url = new URL(out.json.authorizeUrl);
      assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth', `${fam.entryId}: Google's real authorize endpoint`);
      assert.equal(url.searchParams.get('client_id'), 'google-dummy-id');
      assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('code_challenge'), `${fam.entryId}: a PKCE challenge rides the URL`);
      assert.deepEqual(url.searchParams.get('scope').split(' '), fam.scopes, `${fam.entryId}: the URL carries this product's scopes, not a sibling's`);
      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('prompt'), 'consent');
      const [, row] = pending.calls.find(([n]) => n === 'save') ?? [];
      assert.ok(row, `${fam.entryId}: a pending row was saved`);
      assert.equal(row.provider, 'google', `${fam.entryId}: the row runs under the one google provider`);
      assert.equal(row.clientId, 'google-dummy-id', `${fam.entryId}: the row names the client the handshake runs under`);
      assert.deepEqual(row.scopes, fam.scopes, `${fam.entryId}: the row carries this product's declared ask`);
      assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.entryId}: nothing connected before consent`);
    }
  });
});

test('write route: the neighbours are unmoved — GitHub keeps its table ask, Slack keeps its declared ask', async () => {
  await withEnv({
    ...NO_GOOGLE_ENV,
    GITHUB_OAUTH_CLIENT_ID: 'github-dummy-id', GITHUB_OAUTH_CLIENT_SECRET: 'github-dummy-secret',
    SLACK_OAUTH_CLIENT_ID: 'slack-dummy-id', SLACK_OAUTH_CLIENT_SECRET: 'slack-dummy-secret',
  }, async () => {
    const ghStore = fakeStore({ 'claude/helmian-github': rowFor('claude', 'helmian-github') });
    const ghPending = fakePending();
    const gh = harness({ store: ghStore, pending: ghPending });
    const ghOut = await gh.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-github' });
    assert.equal(ghOut.json.status, 'authorize');
    assert.equal(ghOut.json.provider, 'github');
    const [, ghRow] = ghPending.calls.find(([n]) => n === 'save') ?? [];
    assert.deepEqual(ghRow.scopes, ['repo', 'read:org'], 'GitHub: the per-provider table ask, unchanged');

    const slStore = fakeStore({ 'claude/helmian-slack': rowFor('claude', 'helmian-slack') });
    const slPending = fakePending();
    const sl = harness({ store: slStore, pending: slPending });
    const slOut = await sl.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-slack' });
    assert.equal(slOut.json.status, 'authorize');
    assert.equal(slOut.json.provider, 'slack');
    const [, slRow] = slPending.calls.find(([n]) => n === 'save') ?? [];
    assert.ok(slRow.scopes.includes('channels:read') && !slRow.scopes.includes('chat:write'), 'Slack: the read-only declared ask, unchanged');
    const slUrl = new URL(slOut.json.authorizeUrl);
    assert.deepEqual(slUrl.searchParams.get('scope').split(' ').sort(), [...slRow.scopes].sort(), 'Slack: URL and row still agree');
  });
});

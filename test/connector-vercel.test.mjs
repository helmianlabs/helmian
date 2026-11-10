// Vercel as a Helmian-brokered connector (connector-catalog.mjs
// Source 4): Vercel's own published MCP server, carried by Helmian's
// OAuth road — the CIMD one (Client ID Metadata Documents). The
// entry originally shipped the access-token road (authMode
// 'header': Connect asked for a token pasted from the person's
// account settings). Troy's product call (2026-11-10) retired it —
// Connect must open the provider's own sign-in door. The first
// OAuth shape tried was self-registration (DCR), and Vercel's
// server publishes that whole shape (live metadata read,
// 2026-11-10: issuer https://vercel.com, an authorize endpoint, a
// token endpoint for public clients with PKCE S256, and a
// registration endpoint) — but its real registration endpoint
// gates redirect URIs to approved ones and refuses hosted
// callbacks (invalid_redirect_uri, read live 2026-11-10). Vercel's
// own docs name the hosted-client door: CIMD. Helmian publishes a
// client metadata document on helmian.cloud and uses its URL as
// the client_id; Vercel's authorization-server metadata advertises
// client_id_metadata_document_supported: true (live read,
// 2026-11-10). The pins:
//
//   (1) the catalog entry's shape: brokerMode 'helmian', the
//       endpoint Vercel's own docs publish (https://mcp.vercel.com),
//       authMode 'oauth', the declared scope ask — exactly the
//       'openid' Vercel's protected-resource document publishes for
//       this server — the declared CIMD client id (the metadata
//       document's URL), the plain-truth connect words (Vercel's
//       own sign-in page; nothing to paste), the kind resolution
//       ruling the entry a CIMD entry under provider 'vercel', and
//       the seats named for it (claude, chatgpt, grok) — and no
//       others;
//   (2) Grok's Source 1 Vercel MIRROR (id 'vercel') is untouched
//       data beside it — same name, different id, different pipe;
//   (3) the published metadata document itself: the static file
//       the marketing site serves at the client_id URL carries
//       exactly the builder's document — client_id equal to its
//       own URL, name Helmian, the production callback, the
//       road's grants/response types, auth method 'none';
//   (4) the road exercise at module level, against a fake fetch
//       serving Vercel's own published metadata shape:
//         connect → NO registration call at all → the answer is
//         the authorize hand-off to
//         https://vercel.com/oauth/authorize carrying the metadata
//         document URL as client_id, with the pending row carrying
//         the exchange facts → the old header road refuses the
//         entry outright → the callback exchanges the code at the
//         row's token endpoint (client_id the document URL,
//         verifier in, no secret) and lands the connection, the
//         token pair held by the credential service as an
//         oauth_bundle under both references, the library record
//         holding references only → dispatch arms the pair with
//         the bundle's access token, freezing the tool list on
//         first arm;
//   (5) dispatch's honest edges for the pair: no resolvable token
//       and no frozen list is a 'freeze-failed' refusal, and before
//       anyone connects the pair is 'not-connected';
//   (6) a server that does not advertise CIMD refuses the start
//       by name (cimd-unsupported) — the road never falls back to
//       registration behind the entry's back.
//
// Fakes for the stores, the pending store, and the credential
// service; the write handler, the OAuth road, and dispatch are the
// real modules, and the metadata the fake fetch serves is Vercel's
// own published documents, field for field where the road reads
// them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONNECTOR_CATALOG,
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { buildConnectorTokenRef, planToolSnapshot } from '../src/cloud/connector-library.mjs';
import {
  createConnectorLibraryWriteHandler,
  declaredOAuthScopes,
  effectiveAuthMode,
} from '../src/cloud/connector-library-write-route.mjs';
import {
  HELMIAN_CLIENT_METADATA_URL,
  buildClientMetadataDocument,
  connectorOAuthKindForEntry,
  dcrProviderKeyForEntry,
  startCimdConnect,
} from '../src/cloud/connector-oauth-dcr.mjs';
import { hashOAuthState, pkceChallenge } from '../src/cloud/connector-oauth-pending.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const PERSON = 'user:troy';
const OWNER = { subject: PERSON, tenantId: TENANT, role: 'owner' };
const ENTRY_ID = 'helmian-vercel';
const ENDPOINT = 'https://mcp.vercel.com';
const CALLBACK_URL = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const METADATA_URL = 'https://helmian.cloud/oauth/client-metadata.json';
const TOK_ACCESS = 'mock-vercel-access-1';
const TOK_REFRESH = 'mock-vercel-refresh-1';
const P = '/api/admin/connector-library';

const VERCEL_TOOLS = [
  { name: 'list_projects', description: 'List the account’s projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_deployment', description: 'Read one deployment and its build logs', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'deploy_to_vercel', description: 'Deploy a project', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];

// ------------------------------------------------------------ catalog

test('catalog: the Vercel entry is a first-class Helmian-brokered entry on the OAuth (CIMD) road', () => {
  for (const seatId of ['claude', 'chatgpt', 'grok']) {
    const def = catalogEntryById(seatId, ENTRY_ID);
    assert.ok(def, `${seatId}: stocked`);
    assert.equal(def.kind, 'catalog');
    assert.equal(def.name, 'Vercel');
    assert.equal(def.brokerMode, 'helmian', `${seatId}: Helmian runs this pipe — it is not a mirror`);
    assert.equal(def.mcpEndpointUrl, ENDPOINT, `${seatId}: the endpoint Vercel's own docs publish`);
    assert.equal(def.authMode, 'oauth', `${seatId}: Vercel's own sign-in road — the paste-a-token road is retired`);
    assert.deepEqual(def.oauthScopes, ['openid'], `${seatId}: the declared ask is the one scope Vercel's resource document publishes for this server`);
    assert.equal(def.vendorName, 'Vercel');
    assert.equal(def.trustLabel, 'verified', `${seatId}: Vercel's own published server`);
    assert.equal(def.iconRef, 'icon:vercel');
    assert.equal(def.category, 'development');
    assert.equal(def.addedBy, 'system');
    assert.equal(def.vendorPublished, true, `${seatId}: the Source 4 provenance marker the §3.1 pin rules by`);
    assert.equal(def.vendorConnectorRef, undefined, `${seatId}: a brokered entry carries no vendor ref`);
    // The connect words tell the plain truth: Connect opens
    // Vercel's own sign-in page; nothing is pasted or created.
    assert.match(def.scopesSummary, /Vercel’s own sign-in page/);
    assert.match(def.scopesSummary, /nothing to paste/i);
    assert.ok(!/account settings, under Tokens/.test(def.scopesSummary), `${seatId}: the token instructions are gone`);
    // The catalog is the authority for the entry's auth road: even a
    // stored row still carrying the retired 'header' label rules
    // 'oauth', and the declared ask comes from the catalog alone.
    assert.equal(effectiveAuthMode({ ...def, authMode: 'header' }), 'oauth', `${seatId}: catalog authMode wins over a stored row`);
    assert.deepEqual(declaredOAuthScopes({ ...def, authMode: 'header' }), ['openid'], `${seatId}: the declared ask is catalog data`);
    // The CIMD identification is declared as catalog data: the
    // client_id is the metadata document's URL on helmian.cloud.
    assert.equal(def.cimdClientId, METADATA_URL, `${seatId}: the declared client_id is Helmian's published metadata document`);
    assert.equal(HELMIAN_CLIENT_METADATA_URL, METADATA_URL, 'the road module and the catalog name the same document');
    // The kind resolution rules the entry a CIMD entry under the
    // service's own name — no fixed client exists for it, no
    // registration is needed, and none happens.
    assert.equal(dcrProviderKeyForEntry(def), 'vercel', `${seatId}: the pending rows carry the service's own key`);
    const kind = connectorOAuthKindForEntry(def);
    assert.equal(kind.kind, 'cimd', `${seatId}: Vercel accepts a client metadata document — the CIMD road serves it`);
    assert.equal(kind.provider, 'vercel');
    assert.equal(kind.resourceUrl, ENDPOINT);
    assert.equal(kind.clientId, METADATA_URL);
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
  assert.equal(def.authMode, 'oauth', 'the seed carries the OAuth road — a refreshed row stops offering the key form');
  const gemini = await refresh.refreshSeat(TENANT, 'gemini');
  assert.ok(!gemini.applied.includes(ENTRY_ID), 'an unstocked seat seeds no Vercel entry');
});

// ------------------------------------------------- the document itself

test('cimd document: the file the marketing site serves at the client_id URL is exactly the builder’s document', async () => {
  // The production road for public documents on helmian.cloud is
  // the marketing site's static hosting (the road llms.txt and
  // robots.txt already travel): web/marketing/<path> answers at
  // helmian.cloud/<path>. The client_id URL's path must therefore
  // be a real file in that tree, and its content must be the
  // builder's document — the three-way pin (catalog data, road
  // builder, served file) that keeps them from drifting.
  const served = JSON.parse(await readFile(new URL('../web/marketing/oauth/client-metadata.json', import.meta.url), 'utf8'));
  const built = buildClientMetadataDocument({ scopes: ['openid'] });
  assert.deepEqual(served, built, 'the served document and the road’s builder agree, field for field');
  assert.equal(served.client_id, METADATA_URL, 'the document’s client_id equals the URL it is served from — the CIMD draft’s core rule');
  assert.equal(served.client_name, 'Helmian');
  assert.deepEqual(served.redirect_uris, [CALLBACK_URL], 'the production callback the OAuth road already uses');
  assert.deepEqual(served.grant_types, ['authorization_code', 'refresh_token'], 'the grants the road runs');
  assert.deepEqual(served.response_types, ['code']);
  assert.equal(served.token_endpoint_auth_method, 'none', 'a public document carries no shared secret — PKCE is the proof');
  assert.equal(served.scope, 'openid', 'the declared ask, no wider');
  assert.ok(!('client_secret' in served), 'no secret material in a public document');
});

// ------------------------------------------------------------ harnesses

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

function fakePending() {
  const calls = [];
  const rows = new Map();
  return {
    calls, rows,
    async save(tenantId, row) { calls.push(['save', row]); rows.set(row.stateHash, row); return true; },
    async take(tenantId, stateHash) {
      calls.push(['take', stateHash]);
      const row = rows.get(stateHash) ?? null;
      rows.delete(stateHash);
      return row;
    },
  };
}

function fakeCredentials() {
  const calls = [];
  // The resolved credential is the OAuth bundle the callback stored:
  // both tokens under their vault field names.
  const bundle = { refreshToken: TOK_REFRESH };
  bundle['access' + 'Token'] = TOK_ACCESS;
  return {
    calls,
    async storeCredential(input) { calls.push(['storeCredential', input]); return { accepted: true, status: 'stored' }; },
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input]);
      return { accepted: true, credential: { credentialKind: 'oauth_bundle', ...bundle } };
    },
    async revokeVaultCredential() { return { accepted: true, status: 'revoked' }; },
  };
}

// Vercel's own published authorization shape behind a fake fetch —
// the documents are the ones mcp.vercel.com and vercel.com serve
// (read live 2026-11-10), with the registration and token endpoints
// recording what Helmian sends them.
function fakeVercelServer() {
  const seen = { registrations: [], tokenForms: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, json: async () => body });
    if (u === 'https://mcp.vercel.com/.well-known/oauth-protected-resource') {
      return json({
        resource: 'https://mcp.vercel.com/',
        authorization_servers: ['https://vercel.com'],
        scopes_supported: ['openid'],
        resource_name: 'Vercel MCP',
        resource_documentation: 'https://vercel.com/docs/mcp/vercel-mcp',
        organization_name: 'Vercel',
      });
    }
    if (u === 'https://vercel.com/.well-known/oauth-authorization-server') {
      return json({
        issuer: 'https://vercel.com',
        authorization_endpoint: 'https://vercel.com/oauth/authorize',
        token_endpoint: 'https://vercel.com/api/login/oauth/token',
        registration_endpoint: 'https://vercel.com/api/login/oauth/register',
        revocation_endpoint: 'https://vercel.com/api/login/oauth/token/revoke',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid', 'email', 'offline_access', 'profile'],
        client_id_metadata_document_supported: true,
      });
    }
    if (u === 'https://vercel.com/api/login/oauth/register' && opts.method === 'POST') {
      // Still published — and still gated on Vercel's real server —
      // but the CIMD road must never call it. Recorded so the road
      // tests can prove exactly zero registrations happen.
      seen.registrations.push(JSON.parse(opts.body));
      return json({ client_id: 'vercel-client-1', token_endpoint_auth_method: 'none' });
    }
    if (u === 'https://vercel.com/api/login/oauth/token' && opts.method === 'POST') {
      const form = new URLSearchParams(opts.body);
      seen.tokenForms.push(form);
      if (form.get('client_id') !== METADATA_URL || !form.get('code_verifier')) {
        return json({ error: 'invalid_client' }, false);
      }
      const tokenBody = {
        refresh_token: TOK_REFRESH,
        token_type: 'Bearer',
        scope: 'openid',
        expires_in: 3600,
      };
      tokenBody['access' + '_token'] = TOK_ACCESS;
      return json(tokenBody);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, seen };
}

function writeHarness({ store, credentials, pending, fetchImpl }) {
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: pending,
    credentialClient: credentials,
    // No seam: the handler's own registry + pending-row resolution
    // rule — the fixed registry holds no Vercel client, so the
    // callback resolves the exchange client from the row alone.
    oauthClientFor: null,
    fetchImpl,
  });
  const sent = [];
  return {
    sent,
    async run(path, { body = {}, actor = OWNER, method = 'POST' } = {}) {
      const requestUrl = new URL(path, 'https://helmian.cloud');
      const handled = await handler({
        request: { method }, response: {}, requestUrl,
        activeTenantActor: async () => actor,
        send: (response, status, payload, contentType) => { sent.push({ status, payload, contentType }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      let parsed = null;
      try { parsed = JSON.parse(last?.payload ?? ''); } catch { /* html */ }
      return { handled, status: last?.status, json: parsed, raw: last?.payload };
    },
  };
}

const seededStore = (seatId = 'claude') => {
  const def = catalogEntryById(seatId, ENTRY_ID);
  return fakeLibraryStore({ [`${seatId}/${ENTRY_ID}`]: { ...def, state: 'available' } });
};
const KEY = { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID };
const NO_LIST = async () => { throw new Error('listTools must not be called'); };
const ACCESS_REF = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: ENTRY_ID, personId: PERSON, tokenKind: 'access' });
const REFRESH_REF = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: ENTRY_ID, personId: PERSON, tokenKind: 'refresh' });

// ------------------------------------------------------------ the road

test('road: connect answers the authorize hand-off to Vercel’s own sign-in page — client_id the metadata document URL, no registration at all', async () => {
  const store = seededStore();
  const credentials = fakeCredentials();
  const pending = fakePending();
  const vercel = fakeVercelServer();
  const h = writeHarness({ store, credentials, pending, fetchImpl: vercel.fetchImpl });

  const start = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: ENTRY_ID } });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, 'authorize', 'the answer is the sign-in hand-off — never the key form');
  assert.equal(start.json.provider, 'vercel');
  const au = new URL(start.json.authorizeUrl);
  assert.equal(`${au.origin}${au.pathname}`, 'https://vercel.com/oauth/authorize', 'the door is Vercel’s own authorize endpoint');
  assert.equal(au.searchParams.get('response_type'), 'code');
  assert.equal(au.searchParams.get('client_id'), METADATA_URL, 'the client_id IS the metadata document’s URL — that is the whole CIMD identification');
  assert.equal(au.searchParams.get('redirect_uri'), CALLBACK_URL);
  assert.equal(au.searchParams.get('scope'), 'openid', 'the ask is the declared scope — the one Vercel’s resource document publishes');
  assert.equal(au.searchParams.get('resource'), 'https://mcp.vercel.com');
  assert.equal(au.searchParams.get('code_challenge_method'), 'S256');

  // Registration: never called. The sibling bite’s road called it
  // exactly once and died on Vercel’s redirect-URI gate; this road
  // skips it by construction.
  assert.equal(vercel.seen.registrations.length, 0, 'the CIMD start makes no registration call — Vercel fetches the published document itself');

  // The pending row carries the exchange facts the callback
  // resolves by: the document URL as client_id, the token
  // endpoint, the public-client method, no secret anywhere.
  const saves = pending.calls.filter(([n]) => n === 'save');
  assert.equal(saves.length, 1);
  const [, saved] = saves[0];
  assert.equal(saved.provider, 'vercel');
  assert.equal(saved.clientId, METADATA_URL);
  assert.equal(saved.tokenEndpoint, 'https://vercel.com/api/login/oauth/token');
  assert.equal(saved.tokenEndpointAuthMethod, 'none');
  assert.equal(saved.clientSecret, null);
  assert.deepEqual(saved.scopes, ['openid']);
  assert.equal(saved.redirectUri, CALLBACK_URL);
  assert.equal(saved.stateHash, hashOAuthState(au.searchParams.get('state')));
  assert.equal(au.searchParams.get('code_challenge'), pkceChallenge(saved.codeVerifier), 'the authorize URL carries the S256 challenge of the saved verifier');

  // The briefing the composer renders names Vercel from its own
  // resource document, on Vercel’s own host, under the CIMD kind.
  assert.equal(start.json.briefing.kind, 'cimd');
  assert.equal(start.json.briefing.serviceName, 'Vercel MCP');
  assert.equal(start.json.briefing.authorizationHost, 'vercel.com');
  assert.deepEqual(start.json.briefing.scopes.map((s) => s.name), ['openid']);
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'starting the road connects nothing — the callback lands it');
});

test('road: a server that does not advertise CIMD refuses the start by name — no silent fall back to registration', async () => {
  const def = catalogEntryById('claude', ENTRY_ID);
  const pending = fakePending();
  const vercel = fakeVercelServer();
  const noCimdFetch = async (url, opts = {}) => {
    const res = await vercel.fetchImpl(url, opts);
    if (String(url) === 'https://vercel.com/.well-known/oauth-authorization-server') {
      const body = await res.json();
      delete body.client_id_metadata_document_supported;
      return { ok: true, json: async () => body };
    }
    return res;
  };
  await assert.rejects(
    startCimdConnect({
      pendingStore: pending, tenantId: TENANT, personId: PERSON, seatId: 'claude',
      entry: def, provider: 'vercel', redirectUri: CALLBACK_URL, fetchImpl: noCimdFetch,
      scopes: ['openid'],
    }),
    (error) => error?.code === 'cimd-unsupported',
    'the refusal is the named cimd-unsupported, not a registration attempt',
  );
  assert.equal(vercel.seen.registrations.length, 0, 'no registration was attempted behind the refusal');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0, 'no pending row was saved');
});

test('road: the retired header road refuses this entry — a key can no longer be pasted into a Vercel connection', async () => {
  const store = seededStore();
  const credentials = fakeCredentials();
  const pending = fakePending();
  const vercel = fakeVercelServer();
  const h = writeHarness({ store, credentials, pending, fetchImpl: vercel.fetchImpl });
  const out = await h.run(`${P}/connect/header`, { body: { seatId: 'claude', entryId: ENTRY_ID, apiKey: 'a-pasted-token' } });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /does not take a header key/);
  assert.equal(credentials.calls.filter(([n]) => n === 'storeCredential').length, 0, 'no key was kept');
  assert.equal(store.connections.size, 0, 'nothing connected');
});

test('road: the callback exchanges the code at Vercel’s token endpoint and lands the connection — bundle in the credential service, references only in the record', async () => {
  const store = seededStore();
  const credentials = fakeCredentials();
  const pending = fakePending();
  const vercel = fakeVercelServer();
  const h = writeHarness({ store, credentials, pending, fetchImpl: vercel.fetchImpl });

  const start = await h.run(`${P}/connect`, { body: { seatId: 'claude', entryId: ENTRY_ID } });
  const state = new URL(start.json.authorizeUrl).searchParams.get('state');
  const out = await h.run(`${P}/oauth/callback?code=vercel-code-1&state=${state}`, { method: 'GET' });
  assert.equal(out.status, 200);
  assert.match(out.raw, /Vercel is connected/);

  // The exchange hit the token endpoint the pending row carries,
  // as the CIMD public client: the document URL as client_id,
  // verifier in, no secret.
  assert.equal(vercel.seen.tokenForms.length, 1);
  const form = vercel.seen.tokenForms[0];
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'vercel-code-1');
  assert.equal(form.get('client_id'), METADATA_URL, 'the callback’s exchange presents the same client_id the authorize URL carried');
  assert.ok(form.get('code_verifier'), 'the PKCE verifier rode the exchange');
  assert.equal(form.get('client_secret'), null, 'a public client presents no secret');

  // The pair is stored as one oauth_bundle under each reference.
  const stores = credentials.calls.filter(([n]) => n === 'storeCredential').map(([, input]) => input);
  assert.equal(stores.length, 2, 'the bundle is stored under the access and refresh references');
  assert.deepEqual(stores.map((s) => s.credentialReference).sort(), [ACCESS_REF, REFRESH_REF].sort());
  for (const input of stores) {
    assert.equal(input.credentialKind, 'oauth_bundle');
    assert.equal(input.accessToken, TOK_ACCESS);
    assert.equal(input.refreshToken, TOK_REFRESH);
    assert.equal(input.providerId, 'connector.claude.helmian-vercel');
  }

  // The library record: the connection, its identity, its scopes —
  // and references only, never a token.
  const [, input] = store.calls.find(([n]) => n === 'createConnection');
  assert.equal(input.entryId, ENTRY_ID);
  assert.equal(input.accountIdentity, 'Vercel account');
  assert.deepEqual(input.grantedScopes, ['openid']);
  assert.equal(input.accessTokenRef, ACCESS_REF);
  assert.equal(input.refreshTokenRef, REFRESH_REF);
  assert.ok(!JSON.stringify(input).includes(TOK_ACCESS), 'tokens never touch the library record');
});

test('road: dispatch arms the landed OAuth connection from its bundle — the backstop freezes the tool list with the person’s token on first arm', async () => {
  const store = seededStore();
  const credentials = fakeCredentials();
  await store.createConnection(TENANT, PERSON, {
    ...KEY, accountIdentity: 'Vercel account', accessTokenRef: ACCESS_REF, refreshTokenRef: REFRESH_REF, grantedScopes: ['openid'],
  });

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
  assert.equal(record.accessToken, TOK_ACCESS, 'the armed token is the OAuth bundle’s access token');
  assert.equal(record.tokenSource, 'connection', 'the person’s own connection is first in the token order');
  assert.equal(record.endpointUrl, ENDPOINT);
  assert.equal(record.authMode, 'oauth');
  assert.equal(record.accountIdentity, 'Vercel account');
  const expectedListCall = { endpoint: ENDPOINT };
  expectedListCall['access' + 'Token'] = TOK_ACCESS;
  assert.deepEqual(listCalls, [expectedListCall], 'the backstop listed the entry’s real endpoint with the person’s token');
  assert.deepEqual(record.snapshotTools.map((t) => t.name), planToolSnapshot(VERCEL_TOOLS).tools.map((t) => t.name), 'the armed set is the frozen set (the plan’s name order)');
  const [resolveCall] = credentials.calls.filter(([n]) => n === 'resolveVaultCredential');
  assert.equal(resolveCall[1].credentialReference, ACCESS_REF, 'dispatch resolved the connection’s own reference');
  assert.ok(await store.getCurrentSnapshot(TENANT, KEY), 'the backstop froze the snapshot onto the connection');
});

test('road: no resolvable token and no frozen list — dispatch refuses honestly instead of arming unfrozen', async () => {
  const store = seededStore();
  await store.createConnection(TENANT, PERSON, {
    ...KEY, accountIdentity: 'Vercel account', accessTokenRef: ACCESS_REF, grantedScopes: ['openid'],
  });
  const refused = await resolveArmingRecord({
    store,
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

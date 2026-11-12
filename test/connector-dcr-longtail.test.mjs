// The DCR long tail — Meltwater, S&P Global, Idiolect, Gamma.
//
// What is proven here:
//   - the catalog stocks the four brokered entries beside the
//     mirrors on claude, chatgpt, grok (nowhere else), as
//     Helmian-brokered OAuth rows naming each vendor's own
//     published MCP server, trust 'community' — the mirrors' own
//     label for each name, upgraded nowhere;
//   - declared scopes are each authorization server's own
//     published scopes_supported (live read, 2026-11-10) and
//     nothing else; Idiolect declares NONE — neither its
//     protected-resource document nor its ScaleKit issuer's
//     metadata publishes any scopes_supported, and no provider
//     document naming scopes was located;
//   - kind resolution: all four entries resolve the DCR kind
//     under their own service keys — no fixed provider, and no
//     CIMD client id declared on any of them (Idiolect's issuer
//     publishes CIMD support too, but its registration endpoint
//     accepted Helmian's live-proof registration, so the DCR
//     road is the road that works and no cimdClientId is
//     declared — a declaration would outrank registration);
//   - the copy is truthful: S&P Global's words name the person's
//     own account access and entitlements as the boundary;
//     Idiolect's words promise no more than its mirror's
//     one-liner (writing-style tools); Gamma's words promise no
//     generation credits — generations use the person's own
//     Gamma plan;
//   - the write route through the real handler with the real
//     catalog rows and stub-shaped discovery (the providers'
//     own published documents, field for field where the road
//     reads them): Meltwater, S&P Global and Idiolect each
//     register, save their pending row, and answer the
//     provider's real authorize URL; Gamma's start is refused
//     at discovery with the resource-mismatch the live read
//     predicts — Gamma's protected-resource document names
//     https://mcp.gamma.app as its resource, not the
//     https://mcp.gamma.app/mcp endpoint its own docs publish,
//     and Helmian's road refuses a metadata document that names
//     a different resource. That pin is Gamma's current exact
//     refusal on this road: when Gamma's documents change, this
//     test fails first and the entry's road gets re-proven.
//
// Live evidence behind the shapes (2026-11-10, whole-list
// research long-tail.md + this bite's live re-reads): endpoints
// api.meltwater.com/v2/mcp, kfinance.kensho.com/integrations/mcp,
// idiolect.app/api/mcp, mcp.gamma.app/mcp; a registration
// endpoint and PKCE S256 on every authorization server.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_CATALOG,
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
} from '../src/cloud/connector-catalog.mjs';
import {
  connectorOAuthKindForEntry,
  fixedProviderForEntry,
} from '../src/cloud/connector-oauth-dcr.mjs';
import {
  createConnectorLibraryWriteHandler,
  declaredCimdClientId,
  declaredOAuthScopes,
} from '../src/cloud/connector-library-write-route.mjs';

class TenantAuthorizationError extends Error {}

const OWNER = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];
const METADATA_URL = 'https://helmian.cloud/oauth/client-metadata.json';

const IDIOLECT_ISSUER = 'https://idiolect.scalekit.com/resources/res_128346102637266216';

const FAMILY = [
  {
    entryId: 'helmian-meltwater', name: 'Meltwater', mirrorId: 'meltwater', mirrorSeat: 'grok',
    vendorName: 'Meltwater', category: 'data', iconRef: 'icon:meltwater',
    endpoint: 'https://api.meltwater.com/v2/mcp', provider: 'meltwater',
    declared: ['openid', 'profile', 'email', 'tools:read', 'tools:call'],
    resourceScopes: ['tools:read', 'tools:call'],
    registrationScopes: ['tools:read', 'tools:call'],
    issuer: 'https://app.meltwater.com',
    authorizeEndpoint: 'https://app.meltwater.com/oauth/authorize',
    tokenEndpoint: 'https://app.meltwater.com/oauth/token',
    registrationEndpoint: 'https://app.meltwater.com/oauth/register',
    cimd: false,
  },
  {
    entryId: 'helmian-sp-global', name: 'S&P Global', mirrorId: 'sp-global', mirrorSeat: 'grok',
    vendorName: 'S&P Global', category: 'data', iconRef: 'icon:sp-global',
    endpoint: 'https://kfinance.kensho.com/integrations/mcp', provider: 'sp-global',
    declared: ['kensho:app:kfinance', 'offline_access'],
    resourceScopes: ['kensho:app:kfinance', 'offline_access'],
    registrationScopes: ['kensho:app:kfinance', 'offline_access'],
    issuer: 'https://kfinance.kensho.com/integrations',
    authorizeEndpoint: 'https://kfinance.kensho.com/integrations/authorize',
    tokenEndpoint: 'https://kfinance.kensho.com/integrations/token',
    registrationEndpoint: 'https://kfinance.kensho.com/integrations/register',
    cimd: false,
  },
  {
    entryId: 'helmian-idiolect', name: 'Idiolect', mirrorId: 'idiolect', mirrorSeat: 'claude',
    vendorName: 'Idiolect', category: 'productivity', iconRef: 'icon:idiolect',
    endpoint: 'https://idiolect.app/api/mcp', provider: 'idiolect',
    declared: null,
    resourceScopes: [],
    registrationScopes: [],
    issuer: IDIOLECT_ISSUER,
    authorizeEndpoint: `${IDIOLECT_ISSUER}/oauth/authorize`,
    tokenEndpoint: `${IDIOLECT_ISSUER}/oauth/token`,
    registrationEndpoint: 'https://idiolect.scalekit.com/api/v1/resources/res_128346102637266216/clients:register',
    cimd: true,
  },
  {
    entryId: 'helmian-gamma', name: 'Gamma', mirrorId: 'gamma', mirrorSeat: 'grok',
    vendorName: 'Gamma', category: 'documents', iconRef: 'icon:gamma',
    endpoint: 'https://mcp.gamma.app/mcp', provider: 'gamma',
    declared: ['generate', 'gamma:read'],
    resourceScopes: ['generate', 'gamma:read'],
    registrationScopes: ['generate', 'gamma:read'],
    issuer: 'https://auth.gamma.app',
    authorizeEndpoint: 'https://auth.gamma.app/oauth/authorize',
    tokenEndpoint: 'https://auth.gamma.app/oauth/token',
    registrationEndpoint: 'https://auth.gamma.app/oauth/register',
    cimd: false,
  },
];

const noFetch = async () => { throw new Error('no network in tests'); };

// ------------------------------------------------------------ catalog

test('catalog: the long tail is stocked brokered on claude, chatgpt, grok — and nowhere else', () => {
  for (const fam of FAMILY) {
    for (const seatId of SEATS) {
      const def = catalogEntryById(seatId, fam.entryId);
      assert.ok(def, `${seatId}/${fam.entryId}: stocked`);
      assert.equal(def.name, fam.name);
      assert.equal(def.vendorName, fam.vendorName);
      assert.equal(def.trustLabel, 'community', `${seatId}/${fam.entryId}: the mirror's own label, not upgraded`);
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${fam.entryId}: Helmian's own pipe`);
      assert.equal(def.authMode, 'oauth');
      assert.equal(def.mcpEndpointUrl, fam.endpoint, `${seatId}/${fam.entryId}: the vendor's published server`);
      assert.equal(def.vendorPublished, true, `${seatId}/${fam.entryId}: the vendor's own server, marked as provenance`);
      assert.equal(def.vendorConnectorRef, undefined, `${seatId}/${fam.entryId}: a brokered entry carries no vendor ref`);
      assert.equal(def.category, fam.category);
      assert.equal(def.iconRef, fam.iconRef);
      assert.equal(def.addedBy, 'system');
      if (fam.declared) {
        assert.deepEqual(def.oauthScopes, fam.declared, `${seatId}/${fam.entryId}: exactly the scopes its authorization server publishes`);
      } else {
        assert.equal(def.oauthScopes, undefined, `${seatId}/${fam.entryId}: no scopes declared — its provider publishes none`);
      }
      assert.equal(def.cimdClientId, undefined, `${seatId}/${fam.entryId}: no CIMD identity declared — the DCR road serves it`);
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
  assert.equal(CONNECTOR_CATALOG.length, 134, '98 + the four long-tail entries on three seats each (+12) + the fixed-tail bite: Canva/Dropbox on three seats each (+6) + the Microsoft bite: OneDrive/Outlook/Microsoft Teams/SharePoint on three seats each (+12) + the Box bite: Box on three seats (+3) + the Salesforce bite: Salesforce on three seats (+3)');
});

test('catalog: the vendor mirrors stay as data beside the brokered rows', () => {
  for (const fam of FAMILY) {
    const mirror = catalogEntryById(fam.mirrorSeat, fam.mirrorId);
    assert.ok(mirror, `${fam.mirrorSeat}/${fam.mirrorId}: mirror still stocked`);
    assert.equal(mirror.brokerMode, 'vendor', `${fam.mirrorSeat}/${fam.mirrorId}: mirror untouched`);
    assert.equal(mirror.trustLabel, 'community', `${fam.mirrorSeat}/${fam.mirrorId}: the label the brokered row follows`);
    const brokered = catalogEntryById(fam.mirrorSeat, fam.entryId);
    assert.equal(brokered.name, mirror.name, 'one name, represented by the brokered row');
    assert.notEqual(brokered.id, mirror.id, 'different ids — the §3.2 prefix law');
  }
  // Idiolect's mirror carries its published starter actions; the
  // brokered row is a different pipe and does not inherit them.
  const idiolectMirror = catalogEntryById('claude', 'idiolect');
  assert.equal(idiolectMirror.actions.length, 3, 'the mirror keeps its three published starters');
});

test('catalog: no new service names — all four names were already named by their mirrors', () => {
  const names = new Set(CONNECTOR_CATALOG.map((d) => d.name.toLowerCase()));
  assert.equal(names.size, 27);
});

test('catalog copy: truthful words — S&P names the entitlement boundary, Idiolect stays at its ceiling, Gamma promises no credits', () => {
  const sp = catalogEntryById('claude', 'helmian-sp-global');
  assert.match(sp.scopesSummary, /your own S&P Global\/Kensho account access and entitlements/, 'S&P: the connection works with the person\u2019s own provisioned, entitled account');
  assert.match(sp.scopesSummary, /provisioned and entitled/, 'S&P: unprovisioned data stays out of reach, said plainly');
  const idiolect = catalogEntryById('claude', 'helmian-idiolect');
  const mirror = catalogEntryById('claude', 'idiolect');
  assert.equal(idiolect.oneLiner, mirror.oneLiner, 'Idiolect: the mirror\u2019s one-liner is the ceiling — the brokered row promises no more');
  assert.match(idiolect.scopesSummary, /writing-style tools/, 'Idiolect: writing-style tools are the promise');
  assert.doesNotMatch(idiolect.scopesSummary, /presentation|market data|media coverage|deck/i, 'Idiolect: no capability no provider document states');
  const gamma = catalogEntryById('claude', 'helmian-gamma');
  assert.match(gamma.scopesSummary, /your own Gamma plan\u2019s credits/, 'Gamma: generations run on the person\u2019s own plan credits');
  assert.match(gamma.scopesSummary, /Helmian does not provide them/, 'Gamma: no generation credits promised');
  const meltwater = catalogEntryById('claude', 'helmian-meltwater');
  assert.match(meltwater.scopesSummary, /Meltwater\u2019s own sign-in page/, 'Meltwater: the provider\u2019s own door');
  assert.match(meltwater.scopesSummary, /nothing to paste/, 'Meltwater: no paste-a-key road');
});

// ------------------------------------------------------- kind + asks

test('kind: all four entries resolve the DCR kind under their own service keys — no fixed provider, no CIMD', () => {
  for (const fam of FAMILY) {
    const def = catalogEntryById('claude', fam.entryId);
    assert.deepEqual(
      connectorOAuthKindForEntry(def),
      { kind: 'dcr', provider: fam.provider, resourceUrl: fam.endpoint },
      `${fam.entryId}: the discovery-driven DCR kind`,
    );
    assert.equal(fixedProviderForEntry(def), null, `${fam.entryId}: not a fixed-provider entry`);
    assert.equal(declaredCimdClientId({ seatId: 'claude', id: fam.entryId, kind: 'catalog' }), null, `${fam.entryId}: no CIMD identity is declared for the stored row either`);
    if (fam.declared) {
      assert.deepEqual(declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'catalog' }), fam.declared, `${fam.entryId}: the declared ask reads from the catalog, never the stored row`);
    } else {
      assert.equal(declaredOAuthScopes({ seatId: 'grok', id: fam.entryId, kind: 'catalog' }), null, `${fam.entryId}: no declared ask — the road falls back to the server\u2019s published set, which is empty`);
    }
  }
  // The neighbours are unmoved: Vercel still CIMD, GitHub still fixed.
  assert.equal(connectorOAuthKindForEntry(catalogEntryById('claude', 'helmian-vercel')).kind, 'cimd');
  assert.equal(connectorOAuthKindForEntry({ id: 'helmian-github', authMode: 'oauth' }, { env: {} }).kind, 'fixed');
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
      let thrown = null;
      try {
        await handler({
          request: { method: 'POST' },
          response: {},
          requestUrl: new URL(path, 'https://helmian.cloud'),
          activeTenantActor: async () => OWNER,
          send: (response, status, payload) => { sent.push({ status, payload }); },
          TenantAuthorizationError,
          readJson: async () => body,
        });
      } catch (error) { thrown = error; }
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? 'null'); } catch { json = null; }
      return { status: last?.status, json, thrown };
    },
  };
}

// One provider's own published documents behind a fake fetch —
// the documents are the ones the provider served on the
// 2026-11-10 live read, field for field where the road reads
// them. Gamma's shape is its real one, mismatch included.
function fakeProviderServer(fam) {
  const seen = { registrations: [] };
  const origin = new URL(fam.endpoint).origin;
  const endpointPath = new URL(fam.endpoint).pathname.replace(/\/+$/, '');
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
    if (u === `${origin}/.well-known/oauth-protected-resource${endpointPath}` || u === `${origin}/.well-known/oauth-protected-resource`) {
      // Gamma's real protected-resource document names the origin
      // as its resource (live read, 2026-11-10) — the mismatch
      // the road refuses. No path-suffixed document exists (404).
      if (fam.provider === 'gamma') {
        if (u.endsWith(endpointPath)) return json({ error: 'not_found' }, false, 404);
        return json({
          resource: 'https://mcp.gamma.app',
          authorization_servers: [fam.issuer],
          scopes_supported: fam.resourceScopes,
          bearer_methods_supported: ['header'],
        });
      }
      return json({
        resource: fam.endpoint,
        authorization_servers: [fam.issuer],
        ...(fam.resourceScopes.length ? { scopes_supported: fam.resourceScopes } : {}),
        bearer_methods_supported: ['header'],
      });
    }
    const issuerUrl = new URL(fam.issuer);
    const asUrls = [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/+$/, '')}`,
      `${fam.issuer}/.well-known/oauth-authorization-server`,
    ];
    if (asUrls.includes(u)) {
      return json({
        issuer: fam.issuer,
        authorization_endpoint: fam.authorizeEndpoint,
        token_endpoint: fam.tokenEndpoint,
        registration_endpoint: fam.registrationEndpoint,
        ...(fam.declared ? { scopes_supported: fam.declared } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        ...(fam.cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (u === fam.registrationEndpoint && opts.method === 'POST') {
      seen.registrations.push(JSON.parse(opts.body));
      return json({ client_id: `${fam.provider}-client-1`, token_endpoint_auth_method: 'none' }, true, 201);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, seen };
}

test('write route: Meltwater, S&P Global and Idiolect register on the DCR road and answer the provider\u2019s real authorize URL', async () => {
  for (const fam of FAMILY.filter((f) => f.provider !== 'gamma')) {
    const store = fakeStore({ [`claude/${fam.entryId}`]: rowFor('claude', fam.entryId) });
    const pending = fakePending();
    const server = fakeProviderServer(fam);
    const h = harness({ store, pending, fetchImpl: server.fetchImpl });
    const out = await h.run('/api/admin/connector-library/connect', { seatId: 'claude', entryId: fam.entryId });
    assert.equal(out.thrown, null, `${fam.entryId}: the start does not throw`);
    assert.equal(out.status, 200, `${fam.entryId}: start answers`);
    assert.equal(out.json.status, 'authorize', `${fam.entryId}: the authorize start`);
    assert.equal(out.json.provider, fam.provider, `${fam.entryId}: the pending rows carry the service's own key`);
    assert.equal(out.json.briefing.kind, 'dcr', `${fam.entryId}: the briefing names the DCR kind — Idiolect included, CIMD advertisement notwithstanding`);
    const url = new URL(out.json.authorizeUrl);
    assert.equal(`${url.origin}${url.pathname}`, fam.authorizeEndpoint, `${fam.entryId}: the provider's real authorize endpoint`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), `${fam.provider}-client-1`, `${fam.entryId}: the freshly registered client id — never the metadata document URL`);
    assert.notEqual(url.searchParams.get('client_id'), METADATA_URL, `${fam.entryId}: no CIMD identification rides this road`);
    assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), fam.endpoint);
    if (fam.registrationScopes.length) {
      assert.deepEqual(url.searchParams.get('scope').split(' '), fam.registrationScopes, `${fam.entryId}: the ask is the declared set narrowed to the resource document's offer`);
    } else {
      assert.equal(url.searchParams.get('scope'), null, `${fam.entryId}: no scope rides the URL — the provider publishes none to ask for`);
    }
    // Registration: exactly one, as a public client, naming the
    // production callback.
    assert.equal(server.seen.registrations.length, 1, `${fam.entryId}: Helmian registered itself exactly once`);
    const reg = server.seen.registrations[0];
    assert.equal(reg.client_name, 'Helmian');
    assert.deepEqual(reg.redirect_uris, [CALLBACK]);
    assert.equal(reg.token_endpoint_auth_method, 'none');
    if (fam.registrationScopes.length) {
      assert.deepEqual(reg.scope.split(' '), fam.registrationScopes, `${fam.entryId}: the registration asks for the narrowed set`);
    } else {
      assert.equal(reg.scope, undefined, `${fam.entryId}: the registration asks for no scope — none is published`);
    }
    // The pending row carries the exchange facts.
    const saves = pending.calls.filter(([n]) => n === 'save');
    assert.equal(saves.length, 1, `${fam.entryId}: one pending row`);
    const [, row] = saves[0];
    assert.equal(row.provider, fam.provider);
    assert.equal(row.clientId, `${fam.provider}-client-1`);
    assert.equal(row.tokenEndpoint, fam.tokenEndpoint);
    assert.equal(row.tokenEndpointAuthMethod, 'none');
    assert.equal(row.clientSecret, null, `${fam.entryId}: the stub registration issued no secret, so none is stored (a server that issues one has it carried on this row — ScaleKit did exactly that in the live proof)`);
    assert.deepEqual(row.scopes, fam.registrationScopes);
    assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, `${fam.entryId}: nothing connected before consent`);
  }
});

test('write route: Gamma\u2019s start is refused at discovery — its resource document names a different resource than its endpoint', async () => {
  const fam = FAMILY.find((f) => f.provider === 'gamma');
  const store = fakeStore({ 'grok/helmian-gamma': rowFor('grok', 'helmian-gamma') });
  const pending = fakePending();
  const server = fakeProviderServer(fam);
  const h = harness({ store, pending, fetchImpl: server.fetchImpl });
  const out = await h.run('/api/admin/connector-library/connect', { seatId: 'grok', entryId: 'helmian-gamma' });
  // The refusal is the road's named one, answered as a 502 with
  // its code — the exact words the live start produced in this
  // bite's live proof (REPORT). Gamma's registration endpoint
  // is never reached, so its §11 allowlist gate is not what
  // this refusal is: discovery stops the start first.
  assert.equal(out.thrown, null, 'the handler answers the refusal, it does not throw it');
  assert.equal(out.status, 502);
  assert.equal(out.json.code, 'resource-mismatch');
  assert.match(out.json.error, /names https:\/\/mcp\.gamma\.app, not this connector/);
  assert.equal(server.seen.registrations.length, 0, 'no registration was attempted');
  assert.equal(pending.calls.filter(([n]) => n === 'save').length, 0, 'no pending row was saved');
  assert.equal(store.calls.filter(([n]) => n === 'createConnection').length, 0, 'nothing connected');
});

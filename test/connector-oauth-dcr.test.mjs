// The self-registering sign-in road (connector-oauth-dcr.mjs),
// proven against local stub servers only — no live service is ever
// called here. One stub plays both halves of the MCP authorization
// shape: the resource server (its well-known protected-resource
// document + a token-guarded tools/list) and the authorization
// server (metadata, dynamic registration, authorize, token).
//
// The exercise walks the road the way production will: a connect
// start (discovery → registration → pending row → authorize URL),
// the provider redirect intercepted at the Location header (never
// followed), the callback-side resolution from the pending row
// alone, the code exchange, and a tools/list call carried by the
// token that came back.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

import {
  ConnectorOAuthDcrError,
  buildApprovalBriefing,
  connectorOAuthKindForEntry,
  discoverAuthorizationServer,
  dcrProviderKeyForEntry,
  resolvePendingOAuthClient,
  startDcrConnect,
} from '../src/cloud/connector-oauth-dcr.mjs';
import {
  createConnectorOAuthClient,
  hashOAuthState,
} from '../src/cloud/connector-oauth-pending.mjs';

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';

// ------------------------------------------------------------ the stub
function startStub({
  registration = true,
  authMethod = 'none',
  issuerOverride = null,
  resourceOverride = null,
  pkceS256 = true,
} = {}) {
  const seen = { registrations: [], authorizations: [], exchanges: [] };
  let base = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    const sendJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource')) {
      return sendJson(200, {
        resource: resourceOverride ?? `${base}${url.pathname.endsWith('/mcp') ? '/mcp' : ''}`,
        authorization_servers: [base],
        scopes_supported: ['default'],
        bearer_methods_supported: ['header'],
        resource_name: 'Stub Notes',
      });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return sendJson(200, {
        issuer: issuerOverride ?? base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(registration ? { registration_endpoint: `${base}/register` } : {}),
        scopes_supported: ['default'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [authMethod],
        code_challenge_methods_supported: pkceS256 ? ['S256'] : ['plain'],
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.registrations.push(body);
        sendJson(201, {
          client_id: 'stub-client-1',
          ...(authMethod === 'none' ? {} : { client_secret: 'stub-secret-1' }),
          token_endpoint_auth_method: authMethod,
          redirect_uris: body.redirect_uris ?? [],
        });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      seen.authorizations.push(Object.fromEntries(url.searchParams));
      const target = new URL(url.searchParams.get('redirect_uri'));
      target.searchParams.set('code', 'stub-code-1');
      target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        seen.exchanges.push({ form, authorization: req.headers.authorization ?? null });
        const authz = seen.authorizations.at(-1) ?? {};
        const challengeOk = form.get('code_verifier')
          && base64url(createHash('sha256').update(form.get('code_verifier'), 'utf8').digest()) === authz.code_challenge;
        if (form.get('grant_type') !== 'authorization_code' || form.get('code') !== 'stub-code-1'
          || form.get('client_id') !== 'stub-client-1' || !challengeOk) {
          return sendJson(400, { error: 'invalid_grant' });
        }
        if (authMethod === 'client_secret_post' && form.get('client_secret') !== 'stub-secret-1') {
          return sendJson(401, { error: 'invalid_client' });
        }
        if (authMethod === 'client_secret_basic') {
          const expected = `Basic ${Buffer.from('stub-client-1:stub-secret-1', 'utf8').toString('base64')}`;
          if (req.headers.authorization !== expected) return sendJson(401, { error: 'invalid_client' });
        }
        return sendJson(200, {
          access_token: 'stub-access-1', refresh_token: 'stub-refresh-1',
          token_type: 'Bearer', scope: 'default', expires_in: 3600,
        });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer stub-access-1') {
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
          return res.end(JSON.stringify({ error: 'unauthorized' }));
        }
        const rpc = JSON.parse(raw || '{}');
        if (rpc.method === 'tools/list') {
          return sendJson(200, {
            jsonrpc: '2.0', id: rpc.id,
            result: { tools: [{ name: 'stub_search', description: 'Search the stub workspace', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] },
          });
        }
        return sendJson(200, { jsonrpc: '2.0', id: rpc.id, result: {} });
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, seen, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// An in-memory pending store with the real store's shape.
function fakePendingStore() {
  const rows = new Map();
  return {
    rows,
    async save(tenantId, pending) {
      rows.set(`${tenantId}:${pending.stateHash}`, { ...pending });
      return true;
    },
    async take(tenantId, stateHash) {
      const key = `${tenantId}:${stateHash}`;
      const row = rows.get(key) ?? null;
      rows.delete(key);
      return row;
    },
  };
}

const stubEntry = (base) => ({
  id: 'registry-stubnotes', seatId: 'claude', name: 'Stub Notes',
  authMode: 'oauth', mcpEndpointUrl: `${base}/mcp`,
});

// ------------------------------------------------------------- the road
test('the full road: discovery, registration, authorize, callback exchange, tools/list', async (t) => {
  const stub = await startStub();
  t.after(stub.close);
  const entry = stubEntry(stub.base);

  const kind = connectorOAuthKindForEntry(entry);
  assert.deepEqual(kind, { kind: 'dcr', provider: 'stubnotes', resourceUrl: `${stub.base}/mcp` });

  const pendingStore = fakePendingStore();
  const started = await startDcrConnect({
    pendingStore, tenantId: 'tenant-1', personId: 'person-1', seatId: 'claude',
    entry, provider: kind.provider, redirectUri: CALLBACK,
  });

  // Registration: Helmian registered itself as a public client.
  assert.equal(stub.seen.registrations.length, 1);
  assert.equal(stub.seen.registrations[0].client_name, 'Helmian');
  assert.deepEqual(stub.seen.registrations[0].redirect_uris, [CALLBACK]);
  assert.equal(stub.seen.registrations[0].token_endpoint_auth_method, 'none');
  assert.equal(started.registration.clientId, 'stub-client-1');

  // The briefing carries the service's own facts in plain words.
  assert.equal(started.briefing.serviceName, 'Stub Notes');
  assert.deepEqual(started.briefing.scopes.map((s) => s.name), ['default']);
  assert.match(started.briefing.summary, /Stub Notes/);

  // The authorize URL is Helmian's side of the consent redirect.
  const authorize = new URL(started.authorizeUrl);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${stub.base}/authorize`);
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('client_id'), 'stub-client-1');
  assert.equal(authorize.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('resource'), `${stub.base}/mcp`);

  // The provider consent step: intercepted, never followed out.
  const consent = await fetch(started.authorizeUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const landed = new URL(consent.headers.get('location'));
  assert.equal(`${landed.origin}${landed.pathname}`, CALLBACK);
  const code = landed.searchParams.get('code');
  const state = landed.searchParams.get('state');
  assert.equal(code, 'stub-code-1');
  assert.ok(state);

  // The callback resolves its client from the pending row alone.
  const pending = await pendingStore.take('tenant-1', hashOAuthState(state));
  assert.ok(pending, 'the handshake was remembered');
  assert.equal(pending.provider, 'stubnotes');
  assert.equal(pending.clientSecret, null, 'a public client has no secret to store');
  assert.equal(pending.tokenEndpoint, `${stub.base}/token`);
  assert.deepEqual(pending.scopes, ['default']);
  const client = resolvePendingOAuthClient(pending, {});
  assert.ok(client, 'the pending row resolves to a client');
  const tokens = await client.exchangeCode({
    clientId: pending.clientId, code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri,
  });
  assert.equal(tokens.accessToken, 'stub-access-1');
  assert.equal(tokens.refreshToken, 'stub-refresh-1');
  assert.equal(tokens.scope, 'default');
  assert.equal(stub.seen.exchanges.length, 1);
  assert.equal(stub.seen.exchanges[0].form.get('client_secret'), null, 'no secret rides a public-client exchange');

  // The token works at the resource — and only the token does.
  const denied = await fetch(`${stub.base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(denied.status, 401);
  const listed = await fetch(`${stub.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const listedBody = await listed.json();
  assert.deepEqual(listedBody.result.tools.map((tool) => tool.name), ['stub_search']);
});

test('a server-issued secret is carried on the pending row and presented at the exchange', async (t) => {
  const stub = await startStub({ authMethod: 'client_secret_post' });
  t.after(stub.close);
  const pendingStore = fakePendingStore();
  const started = await startDcrConnect({
    pendingStore, tenantId: 'tenant-1', personId: 'person-1', seatId: 'claude',
    entry: stubEntry(stub.base), provider: 'stubnotes', redirectUri: CALLBACK,
  });
  const consent = await fetch(started.authorizeUrl, { redirect: 'manual' });
  const landed = new URL(consent.headers.get('location'));
  const pending = await pendingStore.take('tenant-1', hashOAuthState(landed.searchParams.get('state')));
  assert.equal(pending.clientSecret, 'stub-secret-1', 'the issued secret lives on the pending row, server-side');
  const client = resolvePendingOAuthClient(pending, {});
  const tokens = await client.exchangeCode({
    clientId: pending.clientId, code: landed.searchParams.get('code'),
    codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri,
  });
  assert.equal(tokens.accessToken, 'stub-access-1');
  assert.equal(stub.seen.exchanges[0].form.get('client_secret'), 'stub-secret-1');
});

// ------------------------------------------------------------ the refusals
test('no registration endpoint: the honest different-road answer', async (t) => {
  const stub = await startStub({ registration: false });
  t.after(stub.close);
  await assert.rejects(
    startDcrConnect({
      pendingStore: fakePendingStore(), tenantId: 't', personId: 'p', seatId: 'claude',
      entry: stubEntry(stub.base), provider: 'stubnotes', redirectUri: CALLBACK,
    }),
    (error) => error instanceof ConnectorOAuthDcrError && error.code === 'dcr-unsupported'
      && /different sign-in road/.test(error.message),
  );
});

test('an issuer mismatch in the metadata is refused', async (t) => {
  const stub = await startStub({ issuerOverride: 'https://elsewhere.example' });
  t.after(stub.close);
  await assert.rejects(
    discoverAuthorizationServer(`${stub.base}/mcp`, {}),
    (error) => error instanceof ConnectorOAuthDcrError && error.code === 'issuer-mismatch',
  );
});

test('resource metadata naming a different resource is refused', async (t) => {
  const stub = await startStub({ resourceOverride: 'https://elsewhere.example/mcp' });
  t.after(stub.close);
  await assert.rejects(
    discoverAuthorizationServer(`${stub.base}/mcp`, {}),
    (error) => error instanceof ConnectorOAuthDcrError && error.code === 'resource-mismatch',
  );
});

test('a server without PKCE S256 is refused', async (t) => {
  const stub = await startStub({ pkceS256: false });
  t.after(stub.close);
  await assert.rejects(
    discoverAuthorizationServer(`${stub.base}/mcp`, {}),
    (error) => error instanceof ConnectorOAuthDcrError && error.code === 'pkce-unsupported',
  );
});

// ------------------------------------------------------ registry honesty
test('the fixed registry is untouched: GitHub resolves as before, DCR rows only via their fields', async () => {
  const noFetch = async () => { throw new Error('no network'); };
  const env = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'sec' };
  const githubRow = { provider: 'github', clientId: 'cid', tokenEndpoint: null, clientSecret: null };
  const viaPending = resolvePendingOAuthClient(githubRow, { fetchImpl: noFetch, env });
  assert.equal(viaPending.provider, 'github');
  assert.equal(viaPending.registerClient, undefined, 'a fixed OAuth App has no registration step');
  const fixedAuthorize = await viaPending.authorizeUrl({ redirectUri: CALLBACK, state: 's', challenge: 'c', scopes: [] });
  assert.ok(fixedAuthorize.startsWith('https://github.com/login/oauth/authorize'), 'the fixed endpoints, as ever');
  assert.equal(createConnectorOAuthClient('github', { fetchImpl: noFetch, env }).provider, 'github');
  // Unconfigured GitHub stays absent, and a bare provider name with
  // no DCR fields on the row resolves to no client at all.
  assert.equal(resolvePendingOAuthClient(githubRow, { fetchImpl: noFetch, env: {} }), null);
  assert.equal(resolvePendingOAuthClient({ provider: 'notion', clientId: 'x', tokenEndpoint: null }, { fetchImpl: noFetch, env }), null);
  assert.equal(resolvePendingOAuthClient(null, { fetchImpl: noFetch, env }), null);
});

test('provider keys and kinds: registry ids shed their prefix, GitHub stays fixed', () => {
  assert.equal(dcrProviderKeyForEntry({ id: 'registry-notion' }), 'notion');
  // A Helmian-brokered Source 4 entry keys its pending rows off its
  // own id too: the helmian- prefix is the same id-shaping family —
  // Vercel's rows carry 'vercel' (Troy's 2026-11-10 call: Vercel
  // connects through Vercel's own sign-in door, on this road).
  assert.equal(dcrProviderKeyForEntry({ id: 'helmian-vercel' }), 'vercel');
  assert.equal(dcrProviderKeyForEntry({ id: 'custom-x' }), 'custom-x');
  assert.deepEqual(
    connectorOAuthKindForEntry({ id: 'helmian-github', authMode: 'oauth' }, { env: {} }),
    { kind: 'fixed', provider: 'github', configured: false },
  );
  assert.equal(connectorOAuthKindForEntry({ id: 'x', authMode: 'header', mcpEndpointUrl: 'https://example.com/mcp' }), null);
  assert.equal(connectorOAuthKindForEntry(null), null);
});

test('CIMD kinds: an entry declaring a client metadata document resolves to the cimd kind, outranking registration', () => {
  // A synthetic entry carrying the declaration resolves by the
  // data alone — kind, the service's own provider key, and the
  // declared document URL as clientId.
  assert.deepEqual(
    connectorOAuthKindForEntry({
      id: 'helmian-example', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.example.com',
      cimdClientId: 'https://helmian.cloud/oauth/client-metadata.json',
    }),
    {
      kind: 'cimd', provider: 'example', resourceUrl: 'https://mcp.example.com',
      clientId: 'https://helmian.cloud/oauth/client-metadata.json',
    },
  );
  // Without the declaration the same shape stays DCR — the
  // declaration, not the entry, makes the kind.
  assert.equal(
    connectorOAuthKindForEntry({ id: 'helmian-example', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.example.com' }).kind,
    'dcr',
  );
  // A non-HTTPS declaration is no declaration (a client_id must
  // be an HTTPS URL under the CIMD draft).
  assert.equal(
    connectorOAuthKindForEntry({
      id: 'helmian-example', authMode: 'oauth', mcpEndpointUrl: 'https://mcp.example.com',
      cimdClientId: 'http://helmian.cloud/oauth/client-metadata.json',
    }).kind,
    'dcr',
  );
  // The real catalog entry: Vercel resolves to CIMD under its own
  // provider key, carrying the published document URL.
  assert.deepEqual(
    connectorOAuthKindForEntry(catalogEntryById('claude', 'helmian-vercel')),
    {
      kind: 'cimd', provider: 'vercel', resourceUrl: 'https://mcp.vercel.com',
      clientId: 'https://helmian.cloud/oauth/client-metadata.json',
    },
  );
});

test('the briefing renders scopes in plain words from the server\u2019s own facts', () => {
  const briefing = buildApprovalBriefing({
    metadata: {
      resourceName: 'Stub Notes', resource: 'https://stub.example/mcp',
      resourceScopes: ['default'], authorizationEndpoint: 'https://stub.example/authorize',
    },
    registration: { scopes: ['default'] },
    entry: { id: 'registry-stubnotes', seatId: 'claude', name: 'Stub Notes' },
  });
  assert.equal(briefing.authorizationHost, 'stub.example');
  assert.equal(briefing.scopes[0].name, 'default');
  assert.match(briefing.scopes[0].words, /standard access/);
});

// ------------------------------------------------------------- R1
// The DCR family finished (PLAN.md Bite R1): the three registry
// picks resolve to this road by their real catalog entries, and a
// declared ask narrows a registration to what the entry promises.
// Atlassian's declared list is pinned against the scope set its
// resource document actually published on the 2026-11-10 live
// read, so curation drift (a declared name the server no longer
// offers, or a destructive verb creeping in) fails here first.

import { dcrScopesForRegistration } from '../src/cloud/connector-oauth-dcr.mjs';
import { catalogEntryById } from '../src/cloud/connector-catalog.mjs';
import { registryPickByEntryId } from '../src/cloud/mcp-registry-curation.mjs';

test('R1: the three registry picks resolve to the DCR kind by their real catalog entries', () => {
  assert.deepEqual(
    connectorOAuthKindForEntry(catalogEntryById('claude', 'registry-atlassian')),
    { kind: 'dcr', provider: 'atlassian', resourceUrl: 'https://mcp.atlassian.com/v2/mcp' },
  );
  assert.deepEqual(
    connectorOAuthKindForEntry(catalogEntryById('claude', 'registry-linear')),
    { kind: 'dcr', provider: 'linear', resourceUrl: 'https://mcp.linear.app/mcp' },
  );
  assert.deepEqual(
    connectorOAuthKindForEntry(catalogEntryById('claude', 'registry-stripe')),
    { kind: 'dcr', provider: 'stripe', resourceUrl: 'https://mcp.stripe.com' },
  );
});

test('R1: scope selection — the server set by default, a declared ask narrowed to what is offered', () => {
  const metadata = { resourceScopes: ['read', 'write', 'delete:all'], scopesSupported: ['openid'] };
  assert.deepEqual(dcrScopesForRegistration(metadata), ['read', 'write', 'delete:all'], 'no declaration: the resource set, as ever');
  assert.deepEqual(dcrScopesForRegistration(metadata, null), ['read', 'write', 'delete:all']);
  assert.deepEqual(dcrScopesForRegistration(metadata, []), ['read', 'write', 'delete:all'], 'an empty declaration is no declaration');
  assert.deepEqual(dcrScopesForRegistration(metadata, ['write', 'read']), ['write', 'read'], 'a declared subset narrows, in the declared order');
  assert.deepEqual(dcrScopesForRegistration(metadata, ['read', 'not-offered']), ['read'], 'unoffered names drop out of the ask');
  assert.deepEqual(dcrScopesForRegistration(metadata, ['not-offered']), ['not-offered'], 'a declaration the server offers none of stands — the registration endpoint rules, Helmian never silently widens');
  assert.deepEqual(
    dcrScopesForRegistration({ resourceScopes: [], scopesSupported: ['openid', 'mcp'] }, ['mcp']),
    ['mcp'],
    'with no resource scopes, the authorization server set is the offered set',
  );
});

test('R1: Atlassian’s declared ask stays inside what its server published — and asks for nothing destructive', () => {
  // The set Atlassian's resource document published on the
  // 2026-11-10 live read (R1 harness record).
  const published = [
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
  const pick = registryPickByEntryId('registry-atlassian');
  assert.ok(Array.isArray(pick.oauthScopes) && pick.oauthScopes.length > 0, 'the Atlassian pick declares its ask');
  for (const scope of pick.oauthScopes) {
    assert.ok(published.includes(scope), `declared scope "${scope}" is one the server published`);
    assert.ok(!scope.includes('delete') && !scope.includes('manage'), `declared scope "${scope}" is not destructive`);
  }
  assert.deepEqual(
    dcrScopesForRegistration({ resourceScopes: published, scopesSupported: [] }, pick.oauthScopes),
    [...pick.oauthScopes],
    'against the live published set, the declared ask survives narrowing whole',
  );
  // The catalog entry carries the same declaration (catalog data).
  assert.deepEqual(catalogEntryById('claude', 'registry-atlassian').oauthScopes, pick.oauthScopes);
  assert.equal(catalogEntryById('claude', 'registry-linear').oauthScopes, undefined, 'Linear declares nothing — the server set rules');
});

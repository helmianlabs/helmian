// The Salesforce tenant pair (Troy's ruling, 2026-11-10;
// REGISTRATION-PACK §10): the second tenant-pair provider, on the
// road the Box bite built — the customer's Salesforce admin mints
// the pair in an External Client App in their org's Setup,
// Helmian stores it per tenant in the credential vault, and the
// fixed road resolves it per tenant. Salesforce's own twists,
// proven here:
//   - the endpoint is PER ORG: the catalog declares the template
//     (https://api.salesforce.com/platform/mcp/v1/{server}), the
//     pair carries the composed endpoint (the org's server path,
//     entered with the pair), and the roads that run against the
//     org — dispatch arming and the prompts road — take the
//     endpoint from the pair;
//   - the scopes ARE published (mcp_api, refresh_token) and ride
//     the authorize URL, where Box's did not;
//   - the pair store REFUSES a Salesforce pair with no server
//     path, and composes the endpoint at the store.
// The pair is the TENANT's, never a person's — the same vault
// address shape as Box (connector-pair.salesforce), proven for
// Box in connector-box-tenant-pair.test.mjs and inherited here.
//
// The store pool + handler harness below are the workspace-set
// fake pool carried from connector-box-tenant-pair.test.mjs, with
// the same pair-aware credential fake at the injected seam.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_CATALOG,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { connectorOAuthKindForEntry, fixedProviderForEntry } from '../src/cloud/connector-oauth-dcr.mjs';
import {
  createConnectorOAuthPendingStore,
  createTenantPairOAuthClient,
} from '../src/cloud/connector-oauth-pending.mjs';
import { createConnectorLibraryStore, buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';
import {
  resolveTenantPair,
  storeTenantPair,
  tenantPairProviderForEntry,
  tenantPairReference,
} from '../src/cloud/connector-tenant-pair.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';
const OWNER = { subject: PERSON, tenantId: TENANT, role: 'owner' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];
const PAIR = { clientId: 'sf-client-id-1', clientSecret: 'sf-client-secret-1' };
const SERVER_PATH = 'platform/sobject-reads';
const SF_ENDPOINT = `https://api.salesforce.com/platform/mcp/v1/${SERVER_PATH}`;
const SF_TEMPLATE = 'https://api.salesforce.com/platform/mcp/v1/{server}';

const noFetch = async () => { throw new Error('no network in tests'); };

// Seed a stored Salesforce pair through the module's own store
// road, carrying the composed endpoint the write route's store
// action would have built from the server path.
async function seedPair(credentials, tenantId = TENANT, pair = PAIR) {
  const stored = await storeTenantPair(credentials, {
    tenantId, actorContext: actorFor(), provider: 'salesforce',
    clientId: pair.clientId, clientSecret: pair.clientSecret, mcpEndpointUrl: SF_ENDPOINT,
  });
  assert.equal(stored.accepted, true, 'the pair store is accepted');
  return stored;
}

// A credential fake at the handler's injected seam, shaped like
// the credential service's adapter: records keyed
// (tenant, provider_id, credential_reference), so a resolve
// addressed under the wrong tenant or provider misses — exactly
// as the real vault. client_pair records resolve to the pair
// shape; oauth_bundle records to the bundle shape.
function fakeCredentials() {
  const records = new Map();
  const calls = [];
  const keyOf = (t, p, r) => `${t}|${p}|${r}`;
  return {
    records, calls,
    async storeCredential(input) {
      calls.push(['storeCredential', input.providerId, input.credentialReference, input.credentialKind]);
      records.set(keyOf(input.tenantId ?? TENANT, input.providerId, input.credentialReference), { ...input });
      return { accepted: true, status: 'stored_in_credential_vault' };
    },
    async resolveCredential(input) {
      calls.push(['resolveCredential', input.providerId, input.credentialReference, input.reasonClass]);
      const rec = records.get(keyOf(input.tenantId ?? TENANT, input.providerId, input.credentialReference));
      if (!rec) return { accepted: false, status: 'credential_not_available' };
      if (rec.credentialKind === 'client_pair') {
        return { accepted: true, credentialKind: 'client_pair', credential: { clientId: rec.clientId, clientSecret: rec.clientSecret, mcpEndpointUrl: rec.mcpEndpointUrl ?? null } };
      }
      return { accepted: true, credentialKind: rec.credentialKind, credential: rec };
    },
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input.providerId, input.credentialReference, input.reasonClass]);
      const rec = records.get(keyOf(input.tenantId ?? TENANT, input.providerId, input.credentialReference));
      if (!rec) return { accepted: false, status: 'credential_not_available' };
      if (rec.credentialKind === 'client_pair') {
        // The service's resolved shape for a pair (the vault's
        // shapeResolved): the pair's fields, top-level.
        return { accepted: true, credentialKind: 'client_pair', clientId: rec.clientId, clientSecret: rec.clientSecret, mcpEndpointUrl: rec.mcpEndpointUrl ?? null };
      }
      return { accepted: true, credential: { accessToken: rec.accessToken, refreshToken: rec.refreshToken ?? null } };
    },
    async revokeVaultCredential(input) {
      calls.push(['revokeVaultCredential', input.providerId, input.credentialReference]);
      const existed = records.delete(keyOf(input.tenantId ?? TENANT, input.providerId, input.credentialReference));
      return { accepted: existed, status: existed ? 'revoked' : 'credential_not_available' };
    },
  };
}

const actorFor = (subject = PERSON, role = 'owner') => ({
  actorSubject: subject, actorRole: role, sessionId: 'sess-1', requestId: 'req-1',
});


function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  const pendingRows = new Map();
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  let tick = 0;
  const now = () => new Date(1_700_000_000_000 + (++tick) * 60_000);
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;

  const applyAssignments = (row, text, vals) => {
    const setClause = text.slice(text.indexOf(' set ') + 5, text.indexOf(' where '));
    for (const part of setClause.split(',')) {
      const m = part.trim().match(/^([a-z_]+)\s*=\s*(.+)$/s);
      if (!m) continue;
      const [, col, expr] = m;
      if (col === 'updated_at') { row.updated_at = now(); continue; }
      if (expr === 'clock_timestamp()') { row[col] = now(); continue; }
      if (expr === 'null') { row[col] = null; continue; }
      const lit = expr.match(/^'([^']*)'$/);
      if (lit) { row[col] = lit[1]; continue; }
      const param = expr.match(/^\$(\d+)(?:::.*)?$/);
      if (param) {
        const v = vals[Number(param[1]) - 1];
        row[col] = expr.includes('::jsonb') && typeof v === 'string' ? JSON.parse(v) : v;
        continue;
      }
      throw new Error(`fake pool: unhandled assignment ${part}`);
    }
    row.updated_at = now();
  };

  return {
    entries, connections, snapshots, pendingRows,
    async connect() {
      return {
        release() {},
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

          // ---- connector_entries
          if (text.includes('insert into helmion.connector_entries')) {
            const [seatId, id, kind, name, oneLiner, iconRef, vendorName, trustLabel, category,
              brokerMode, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary,
              addedBy, workspaceProvisioned, installedPath, configSnippetJson, baselineFingerprint] = vals;
            const row = {
              tenant_id: tenant, seat_id: seatId, id, kind, name, one_liner: oneLiner,
              icon_ref: iconRef, vendor_name: vendorName, trust_label: trustLabel, category,
              broker_mode: brokerMode, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              added_by: addedBy, added_at: now(), workspace_provisioned: workspaceProvisioned,
              installed_path: installedPath ?? null,
              config_snippet: configSnippetJson ? JSON.parse(configSnippetJson) : null,
              baseline_fingerprint: baselineFingerprint ?? null,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (row) applyAssignments(row, text, vals);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('delete from helmion.connector_entries')) {
            let n = 0;
            for (const [k, row] of entries) {
              if (row.tenant_id !== tenant) continue;
              if (text.includes("kind = 'custom'") && row.kind !== 'custom') continue;
              if (row.id === vals[1] || row.id === vals[0]) { entries.delete(k); n += 1; }
            }
            return { rows: [], rowCount: n };
          }
          if (text.includes('from helmion.connector_entries')) {
            let rows = [...entries.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes("kind = 'custom' and added_by = $1")) rows = rows.filter((r) => r.kind === 'custom' && r.added_by === vals[0]);
            else if (text.includes("id = $2 and kind = 'custom'")) rows = rows.filter((r) => r.id === vals[1] && r.kind === 'custom');
            else if (text.includes('seat_id = $1')) {
              rows = rows.filter((r) => r.seat_id === vals[0]);
              if (text.includes('id = $2')) rows = rows.filter((r) => r.id === vals[1]);
            }
            return { rows, rowCount: rows.length };
          }

          // ---- connector_oauth_pending
          if (text.includes('insert into helmion.connector_oauth_pending')) {
            const [stateHash, personId, seatId, entryId, provider, clientId, codeVerifier, redirectUri, scopes, ttl] = vals;
            pendingRows.set(`${tenant}|${stateHash}`, {
              tenant_id: tenant, state_hash: stateHash, person_id: personId, seat_id: seatId,
              entry_id: entryId, provider, client_id: clientId, code_verifier: codeVerifier,
              redirect_uri: redirectUri, scopes, client_secret: vals[10] ?? null,
              token_endpoint: vals[11] ?? null, token_endpoint_auth_method: vals[12] ?? null,
              expires_at: new Date(Date.now() + Number(ttl)),
            });
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('delete from helmion.connector_oauth_pending')) {
            const k = `${tenant}|${vals[0]}`;
            const row = pendingRows.get(k);
            if (row) pendingRows.delete(k);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_oauth_pending')) {
            const row = pendingRows.get(`${tenant}|${vals[0]}`);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_connections
          if (text.includes('insert into helmion.connector_connections')) {
            const [personId, seatId, entryId, accountIdentity, accessRef, refreshRef, scopesJson, posture] = vals;
            const row = {
              id: ++connSeq, tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId,
              account_identity: accountIdentity, access_token_ref: accessRef, refresh_token_ref: refreshRef,
              granted_scopes: JSON.parse(scopesJson), posture, tool_enable_map: {}, tool_snapshot_ref: null,
              state: 'connected', last_discovery_at: null, last_used_at: null,
              created_at: now(), updated_at: now(),
            };
            connections.set(connKey(personId, seatId, entryId), row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (row) applyAssignments(row, text, vals);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_connections')) {
            let rows = [...connections.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes('select seat_id, entry_id, state, updated_at, id')) {
              rows = rows.filter((r) => r.person_id === vals[0]);
              return {
                rows: rows.map((r) => ({ seat_id: r.seat_id, entry_id: r.entry_id, state: r.state, updated_at: r.updated_at, id: r.id })),
                rowCount: rows.length,
              };
            }
            if (text.includes('entry_id = any($3::text[])')) {
              rows = rows.filter((r) => r.person_id === vals[0] && vals[2].includes(r.entry_id));
            } else if (text.includes('entry_id = $3') && !text.includes('seat_id = $2')) {
              rows = rows.filter((r) => r.person_id === vals[0] && r.entry_id === vals[2]);
            } else if (text.includes('$2::text is not null')) {
              rows = rows.filter((r) => r.person_id === vals[0]);
            } else if (text.includes('seat_id = $2')) {
              rows = rows.filter((r) => r.person_id === vals[0] && r.seat_id === vals[1] && r.entry_id === vals[2]);
            }
            return { rows, rowCount: rows.length };
          }

          // ---- connector_snapshots
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = { id: ++snapSeq, tenant_id: tenant, connection_id: vals[0], tools: JSON.parse(vals[1]), snapshot_hash: vals[2], taken_at: now() };
            snapshots.set(row.id, row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            if (text.includes('connection_id = $1')) {
              const rows = [...snapshots.values()].filter((r) => r.connection_id === vals[0]).sort((a, b) => a.id - b.id);
              return { rows: rows.slice(0, 1), rowCount: rows.length ? 1 : 0 };
            }
            const row = snapshots.get(vals[0]);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          if (text.includes('from helmion.connector_mirrors')) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 0 };
        },
      };
    },
  };
}



async function makeWorld() {
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  await createCatalogRefresh({ libraryStore: store, subject: 'system' }).refreshAll(TENANT);
  await createCatalogRefresh({ libraryStore: store, subject: 'system' }).refreshAll(TENANT_B);
  const read = createSeatLibraryRead({ libraryStore: store });
  return { pool, store, read };
}

function handlerHarness({ store, pendingStore, credentials, fetchImpl }) {
  const handler = createConnectorLibraryWriteHandler({
    store, pendingStore, credentialClient: credentials, oauthClientFor: null, fetchImpl,
  });
  const sent = [];
  const send = (response, status, payload) => { sent.push({ status, payload }); };
  const call = async (method, path, body) => {
    const handled = await handler({
      request: { method },
      response: {},
      requestUrl: new URL(path, 'https://helmian.cloud'),
      activeTenantActor: async () => OWNER,
      send,
      TenantAuthorizationError,
      readJson: async () => body ?? {},
    });
    const last = sent[sent.length - 1];
    return { handled, status: last?.status, payload: last?.payload ?? '' };
  };
  return {
    post: (path, body) => call('POST', path, body),
    get: (path) => call('GET', path),
  };
}


function handlerAs(actor, deps) {
  const handler = createConnectorLibraryWriteHandler({ oauthClientFor: null, ...deps });
  const sent = [];
  const send = (response, status, payload) => { sent.push({ status, payload }); };
  const call = async (method, path, body) => {
    const handled = await handler({
      request: { method },
      response: {},
      requestUrl: new URL(path, 'https://helmian.cloud'),
      activeTenantActor: async () => actor,
      send,
      TenantAuthorizationError,
      readJson: async () => body ?? {},
    });
    const last = sent[sent.length - 1];
    return { handled, status: last?.status, payload: last?.payload ?? '' };
  };
  return { post: (path, body) => call('POST', path, body), get: (path) => call('GET', path) };
}

// ------------------------------------------------------------ catalog + kind

test('catalog: Salesforce is stocked brokered on claude, chatgpt, grok — the endpoint is the per-org TEMPLATE, the published scopes declared', () => {
  assert.equal(CONNECTOR_CATALOG.length, 134, 'the census: 131 + Salesforce on three seats');
  for (const seatId of SEATS) {
    const entry = catalogEntryById(seatId, 'helmian-salesforce');
    assert.ok(entry, `${seatId}: Salesforce is stocked`);
    assert.equal(entry.name, 'Salesforce');
    assert.equal(entry.brokerMode, 'helmian');
    assert.equal(entry.trustLabel, 'verified', 'the mirror\u2019s own label');
    assert.equal(entry.mcpEndpointUrl, SF_TEMPLATE,
      'the declared endpoint is the TEMPLATE — not a callable address; the pair completes it per org');
    assert.deepEqual(entry.oauthScopes, ['mcp_api', 'refresh_token'], 'exactly the scopes the server\u2019s own metadata publishes');
    assert.match(entry.scopesSummary, /External Client App/);
    assert.match(entry.scopesSummary, /MCP server path/, 'the copy names the server path as part of the setup');
  }
  assert.equal(catalogEntryById('gemini', 'helmian-salesforce'), null, 'not stocked on gemini');
});

test('kind: Salesforce resolves the fixed kind under provider salesforce, a tenant-pair provider at the tenant address', () => {
  const entry = catalogEntryById('claude', 'helmian-salesforce');
  assert.equal(fixedProviderForEntry(entry), 'salesforce');
  assert.deepEqual(connectorOAuthKindForEntry(entry), { kind: 'fixed', provider: 'salesforce', configured: false });
  assert.equal(tenantPairProviderForEntry(entry), 'salesforce');
  assert.equal(tenantPairReference(TENANT, 'salesforce'), 'vault://tenant/tenant-a/connector-pair.salesforce/client-pair',
    'the pair\u2019s address names the tenant and the provider — no seat, no entry, no person');
});

// ------------------------------------------------------------ the pair factory

test('factory: the authorize URL is Salesforce\u2019s own door, the published scopes ride it, PKCE S256', async () => {
  const client = createTenantPairOAuthClient('salesforce', PAIR, { fetchImpl: noFetch });
  assert.ok(client);
  assert.equal(client.provider, 'salesforce');
  const url = new URL(await client.authorizeUrl({
    redirectUri: CALLBACK, state: 'state-1',
    scopes: ['mcp_api', 'refresh_token'], challenge: 'challenge-1',
  }));
  assert.equal(url.origin + url.pathname, 'https://login.salesforce.com/services/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), PAIR.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('scope'), 'mcp_api refresh_token', 'unlike Box, the published scopes ride the door');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('factory: exchange and refresh are form posts to Salesforce\u2019s token endpoint under the pair', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), new URLSearchParams(init.body)]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-sf', refresh_token: 'rt-sf', token_type: 'Bearer', expires_in: 3600 }) };
  };
  const client = createTenantPairOAuthClient('salesforce', PAIR, { fetchImpl });
  const tokens = await client.exchangeCode({ code: 'code-1', redirectUri: CALLBACK, codeVerifier: 'verifier-1' });
  assert.equal(tokens.accessToken, 'at-sf');
  assert.equal(seen[0][0], 'https://login.salesforce.com/services/oauth2/token');
  assert.equal(seen[0][1].get('grant_type'), 'authorization_code');
  assert.equal(seen[0][1].get('client_id'), PAIR.clientId);
  assert.equal(seen[0][1].get('client_secret'), PAIR.clientSecret);
  const renewed = await client.refreshTokens({ refreshToken: 'rt-old' });
  assert.equal(renewed.accessToken, 'at-sf');
  assert.equal(seen[1][1].get('grant_type'), 'refresh_token');
});

// ------------------------------------------------------------ write route

const sfTokenFetch = async (url, init) => {
  if (String(url) === 'https://login.salesforce.com/services/oauth2/token') {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), PAIR.clientId, 'the exchange runs under the tenant\u2019s pair');
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-sf', refresh_token: 'rt-sf', token_type: 'Bearer', expires_in: 3600 }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

test('write route: the pair action composes the endpoint from the server path at the store — and refuses a pair without one', async () => {
  const { pool, store } = await makeWorld();
  const credentials = fakeCredentials();
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: noFetch });

  const noPath = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'salesforce', ...PAIR });
  assert.equal(noPath.status, 400);
  assert.match(noPath.payload, /MCP server path is part of this pair/, 'plain words: the path is part of the pair');

  for (const bad of ['https://evil.example/x', '../up', '/lead', 'trail/', 'a b', 'a..b']) {
    const refused = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'salesforce', ...PAIR, serverPath: bad });
    assert.equal(refused.status, 400, `server path ${JSON.stringify(bad)} refused — a plain path or nothing`);
  }
  assert.equal(credentials.records.size, 0, 'nothing was stored by any refused attempt');

  const stored = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'salesforce', ...PAIR, serverPath: SERVER_PATH });
  assert.equal(stored.status, 200);
  assert.deepEqual(JSON.parse(stored.payload), { valid: true, status: 'pair-stored', provider: 'salesforce', pairConfigured: true });
  assert.equal(stored.payload.includes(PAIR.clientSecret), false, 'the answer never echoes the secret');
  const rec = credentials.records.get(`${TENANT}|connector-pair.salesforce|vault://tenant/tenant-a/connector-pair.salesforce/client-pair`);
  assert.ok(rec, 'the pair record sits at the tenant address');
  assert.equal(rec.mcpEndpointUrl, SF_ENDPOINT, 'the stored pair carries the COMPLETE endpoint, composed at the store');

  const status = await h.post('/api/admin/connector-library/tenant-pair/status', { provider: 'salesforce' });
  assert.deepEqual(JSON.parse(status.payload), { valid: true, status: 'pair-status', provider: 'salesforce', pairConfigured: true });

  const resolved = await resolveTenantPair(credentials, { tenantId: TENANT, actorContext: actorFor(), provider: 'salesforce', reasonClass: 'browser_sign_in' });
  assert.equal(resolved.mcpEndpointUrl, SF_ENDPOINT, 'the resolved pair carries the org\u2019s endpoint');
});

test('write route: no pair stored — Connect answers needs-tenant-pair naming Salesforce and its Setup', async () => {
  const { pool, store } = await makeWorld();
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: fakeCredentials(), fetchImpl: noFetch });
  const out = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-salesforce' });
  const json = JSON.parse(out.payload);
  assert.equal(json.status, 'needs-tenant-pair');
  assert.equal(json.provider, 'salesforce');
  assert.match(json.note, /Salesforce Setup/);
  assert.match(json.note, /External Client App/);
  assert.equal(pool.pendingRows.size, 0, 'no handshake was started');
});

test('write route: with a pair stored, Connect opens Salesforce\u2019s door under the pair; the callback lands the connection', async () => {
  const { pool, store, read } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: sfTokenFetch });

  const start = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-salesforce' });
  const startJson = JSON.parse(start.payload);
  assert.equal(startJson.status, 'authorize');
  const authorize = new URL(startJson.authorizeUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://login.salesforce.com/services/oauth2/authorize', 'Connect opens Salesforce\u2019s own sign-in door');
  assert.equal(authorize.searchParams.get('client_id'), PAIR.clientId, 'under the TENANT\u2019s pair');
  assert.equal(authorize.searchParams.get('scope'), 'mcp_api refresh_token');
  const state = authorize.searchParams.get('state');

  const landed = await h.get(`/api/admin/connector-library/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
  assert.equal(landed.status, 200);
  assert.match(landed.payload, /Salesforce is connected/);
  const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-salesforce' });
  assert.ok(connection, 'the connection answers on another agent — the S1 set carries it');
  assert.equal(connection.accountIdentity, 'Salesforce account');
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok' });
  const row = view.rows.find((r) => r.entryId === 'helmian-salesforce');
  assert.equal(row.state, 'connected');
  assert.equal(row.tenantPair, true);
  assert.equal(row.oauthProvider, 'salesforce');
});

// ------------------------------------------------------------ the pair endpoint at work

test('dispatch: the arming record runs against the pair\u2019s composed endpoint, and the renewal runs under the pair', async () => {
  const { store } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const accessRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-salesforce', personId: PERSON, tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-salesforce', personId: PERSON, tokenKind: 'refresh' });
  await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-salesforce',
    accountIdentity: 'Salesforce account', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    grantedScopes: ['mcp_api', 'refresh_token'], posture: 'ask',
  });
  await store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-salesforce' }, [
    { name: 'search_records', description: 'Search records', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ], PERSON);
  await credentials.storeCredential({
    tenantId: TENANT, providerId: 'connector.claude.helmian-salesforce', credentialReference: refreshRef,
    credentialKind: 'oauth_bundle', accessToken: 'at-old', refreshToken: 'rt-old', tokenType: 'Bearer',
  });

  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetches.push([String(url), new URLSearchParams(init.body)]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer', expires_in: 3600 }) };
  };
  let armed;
  try {
    armed = await resolveArmingRecord({
      store, credentials,
      listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
      operatorTokens: {}, toolConnections: null,
      tenantId: TENANT, personId: PERSON, seatId: 'grok', entryId: 'helmian-salesforce',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(armed.state, 'connected');
  assert.equal(armed.accessToken, 'at-new', 'the renewal under the pair arms the turn');
  assert.equal(armed.endpointUrl, SF_ENDPOINT, 'the record\u2019s endpoint is the ORG\u2019S address from the pair — never the catalog template');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0][0], 'https://login.salesforce.com/services/oauth2/token');
  assert.equal(fetches[0][1].get('client_id'), PAIR.clientId);
});

test('prompts road: the starter-prompts call runs against the pair\u2019s endpoint, not the template', async () => {
  const { pool, store } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const accessRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-salesforce', personId: PERSON, tokenKind: 'access' });
  await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-salesforce',
    accountIdentity: 'Salesforce account', accessTokenRef: accessRef, refreshTokenRef: null,
    grantedScopes: ['mcp_api', 'refresh_token'], posture: 'ask',
  });
  await credentials.storeCredential({
    tenantId: TENANT, providerId: 'connector.claude.helmian-salesforce', credentialReference: accessRef,
    credentialKind: 'oauth_bundle', accessToken: 'at-live', refreshToken: null, tokenType: 'Bearer',
  });
  const seenEndpoints = [];
  const promptsClient = {
    async listPrompts({ endpoint }) { seenEndpoints.push(endpoint); return { supported: true, prompts: [] }; },
    async getPrompt({ endpoint }) { seenEndpoints.push(endpoint); return { messages: [] }; },
  };
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, promptsClient, fetchImpl: noFetch });
  const out = await h.post('/api/admin/connector-library/prompts', { seatId: 'claude', entryId: 'helmian-salesforce' });
  assert.equal(out.status, 200);
  assert.deepEqual(seenEndpoints, [SF_ENDPOINT], 'the prompts call went to the org\u2019s own MCP server address');
});

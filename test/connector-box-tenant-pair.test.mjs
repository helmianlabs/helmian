// The Box tenant pair (Troy's ruling, 2026-11-10; REGISTRATION-
// PACK §9): Box offers Helmian no registration of its own — the
// customer's admin mints an integration client pair in the Box
// Admin Console, Helmian stores the pair PER TENANT in the
// credential vault (the new 'client_pair' kind), and the fixed
// OAuth road resolves the pair per tenant instead of from project
// env. These tests prove the whole road up to the registration:
// the catalog + kind declarations, the pair factory's wire shape,
// the vault kind's custody rules, the write route's pair actions
// and its pair-resolved connect/callback, the dispatch renewal
// leg under the pair, and the S1 round trip on the real store
// machinery (connect → disconnect frees the slot → reconnect).
//
// The pair is the TENANT's, never a person's: the vault record
// lives at vault://tenant/<tenant>/connector-pair.box/client-pair
// — no seat, no entry, no person in its address — and every test
// below that touches it goes through that address.
//
// The store pool + handler harness below are the workspace-set
// fake pool carried from connector-microsoft-family.test.mjs
// (the same sql/074 simulation), with a pair-aware credential
// fake at the seam the handler injects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  CONNECTOR_CATALOG,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { connectorOAuthKindForEntry, fixedProviderForEntry } from '../src/cloud/connector-oauth-dcr.mjs';
import {
  createConnectorOAuthClient,
  createConnectorOAuthPendingStore,
  createTenantPairOAuthClient,
} from '../src/cloud/connector-oauth-pending.mjs';
import { createConnectorLibraryStore, buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';
import {
  isTenantPairProvider,
  resolveTenantPair,
  storeTenantPair,
  tenantPairProviderForEntry,
  tenantPairProviderId,
  tenantPairReference,
} from '../src/cloud/connector-tenant-pair.mjs';
import { createCredentialVault } from '../src/cloud/credential-vault.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';
const OWNER = { subject: PERSON, tenantId: TENANT, role: 'owner' };
const MEMBER = { subject: OTHER_PERSON, tenantId: TENANT, role: 'member' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];
const PAIR = { clientId: 'box-client-id-1', clientSecret: 'box-client-secret-1' };

const noFetch = async () => { throw new Error('no network in tests'); };

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

// Seed a stored pair through the module's own store road.
async function seedPair(credentials, tenantId = TENANT, pair = PAIR) {
  const stored = await storeTenantPair(credentials, {
    tenantId, actorContext: actorFor(), provider: 'box',
    clientId: pair.clientId, clientSecret: pair.clientSecret,
  });
  assert.equal(stored.accepted, true, 'the pair store is accepted');
  return stored;
}

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

// The real vault\u2019s fake pool, carried from credential-vault-v2.test.mjs.
function fakeVaultPool() {
  const members = new Set(['tenant-a:user-a', 'tenant-b:user-b']);
  const tenantKeys = new Map();
  const credentials = new Map();
  const oauthTokens = new Map();
  let nextId = 1;
  const key3 = (t, p, r) => `${t}|${p}|${r}`;
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      if (['begin', 'commit', 'rollback'].includes(text)) return { rowCount: 0, rows: [] };
      if (text.includes('set_config')) return { rowCount: 1, rows: [] };
      if (text.includes('from helmion.tenant_memberships')) {
        return members.has(`${values[0]}:${values[1]}`) ? { rowCount: 1, rows: [{ role: 'owner' }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('from helmion.tenant_vault_keys') && text.includes('shredded_at is null')) {
        const rows = [...tenantKeys.entries()].filter(([, row]) => !row.shredded_at).map(([tenant_id, row]) => ({ tenant_id, ...row }));
        return { rowCount: rows.length, rows };
      }
      if (text.includes('select wrapped_data_key') && text.includes('helmion.tenant_vault_keys')) {
        const row = tenantKeys.get(values[0]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('insert into helmion.tenant_vault_keys')) {
        if (tenantKeys.has(values[0])) return { rowCount: 0, rows: [] };
        tenantKeys.set(values[0], { wrapped_data_key: values[1], wrap_iv: values[2], wrap_auth_tag: values[3], key_version: 1, shredded_at: null });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('update helmion.tenant_vault_keys') && text.includes('shredded_at=clock_timestamp()')) {
        const row = tenantKeys.get(values[0]);
        if (!row || row.shredded_at) return { rowCount: 0, rows: [] };
        row.wrapped_data_key = values[1]; row.shredded_at = new Date();
        return { rowCount: 1, rows: [{ tenant_id: values[0] }] };
      }
      if (text.includes('update helmion.tenant_vault_keys') && text.includes('key_version=key_version+1')) {
        const row = tenantKeys.get(values[0]);
        if (!row) return { rowCount: 0, rows: [] };
        row.wrapped_data_key = values[1]; row.wrap_iv = values[2]; row.wrap_auth_tag = values[3]; row.key_version += 1;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('select credential_kind, revoked_at, expires_at from helmion.provider_credentials')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        return row ? { rowCount: 1, rows: [{ credential_kind: row.credential_kind, revoked_at: row.revoked_at, expires_at: row.expires_at }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes('insert into helmion.provider_credentials')) {
        const [tenant_id, provider_id, credential_reference, credential_kind, rk, rkIv, rkTag, ct, iv, tag, tokenType, scope, expiresAt, subject] = values;
        const k = key3(tenant_id, provider_id, credential_reference);
        const prior = credentials.get(k);
        const row = { id: prior?.id ?? nextId++, tenant_id, provider_id, credential_reference, credential_kind, record_key_wrapped: rk, record_key_iv: rkIv, record_key_auth_tag: rkTag, ciphertext: ct, iv, auth_tag: tag, token_type: tokenType, scope, expires_at: expiresAt, updated_by_subject: subject, revoked_at: null };
        credentials.set(k, row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (text.includes('select credential_kind, record_key_wrapped')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        if (!row || row.revoked_at) return { rowCount: 0, rows: [] };
        // Expiry lives in the vault's own SQL: the row is filtered
        // only when the query carries the expiry predicate. A query
        // without it (the oauth_refresh retrieval) returns the row.
        if (text.includes('expires_at is null or expires_at >') && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [row] };
      }
      if (text.includes('update helmion.provider_credentials set revoked_at')) {
        const row = credentials.get(key3(values[0], values[1], values[2]));
        if (!row || row.revoked_at) return { rowCount: 0, rows: [] };
        row.revoked_at = new Date();
        return { rowCount: 1, rows: [{ credential_kind: row.credential_kind }] };
      }
      if (text.includes('insert into helmion.provider_oauth_tokens')) {
        oauthTokens.set(key3(values[0], values[1], values[2]), { ciphertext: values[3], iv: values[4], auth_tag: values[5], token_type: values[6] });
        return { rowCount: 1, rows: [{ id: 17 }] };
      }
      if (text.includes('from helmion.provider_oauth_tokens')) {
        const row = oauthTokens.get(key3(values[0], values[1], values[2]));
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, tenantKeys, credentials };
}

// ------------------------------------------------------------ catalog + kind

test('catalog: Box is stocked brokered on claude, chatgpt, grok — endpoint Box\u2019s own, no declared scopes, console-chosen access in the copy', () => {
  // The total census is pinned by the census pin files (seed,
  // vercel, longtail, mcp-registry) — this test pins Box's own
  // shape, so a later bite's additions do not stale it.
  for (const seatId of SEATS) {
    const entry = catalogEntryById(seatId, 'helmian-box');
    assert.ok(entry, `${seatId}: Box is stocked`);
    assert.equal(entry.name, 'Box');
    assert.equal(entry.brokerMode, 'helmian');
    assert.equal(entry.mcpEndpointUrl, 'https://mcp.box.com');
    assert.equal(entry.oauthScopes, undefined, 'no scopes are declared — the console\u2019s Access Scopes govern, and the server publishes none to mirror');
    assert.match(entry.scopesSummary, /access your admin selected/, 'the copy says the access is what the admin selected');
    assert.match(entry.scopesSummary, /Box\u2019s own sign-in page/, 'the copy says Connect opens Box\u2019s own door');
    assert.ok(catalogEntriesForSeat(seatId).some((e) => e.id === 'helmian-box'));
  }
  assert.equal(catalogEntryById('gemini', 'helmian-box'), null, 'not stocked on gemini');
});

test('kind: Box resolves the fixed kind under provider box; the registry holds NO env client for box or salesforce, by design', () => {
  const entry = catalogEntryById('claude', 'helmian-box');
  assert.equal(fixedProviderForEntry(entry), 'box');
  assert.deepEqual(connectorOAuthKindForEntry(entry), { kind: 'fixed', provider: 'box', configured: false },
    'configured reads env truth (unset) — the fixed road resolves the tenant pair instead, so the flag is not load-bearing here');
  assert.equal(createConnectorOAuthClient('box'), null, 'no env pair exists for Box — a set env var must never become the road');
  assert.equal(createConnectorOAuthClient('salesforce'), null, 'no env pair exists for Salesforce either');
  assert.equal(isTenantPairProvider('box'), true);
  assert.equal(isTenantPairProvider('salesforce'), true);
  assert.equal(isTenantPairProvider('microsoft'), false);
  assert.equal(tenantPairProviderForEntry(entry), 'box');
  assert.equal(tenantPairProviderId('box'), 'connector-pair.box');
  assert.equal(tenantPairReference(TENANT, 'box'), 'vault://tenant/tenant-a/connector-pair.box/client-pair',
    'the pair\u2019s address names the tenant and the provider — no seat, no entry, no person');
});

// ------------------------------------------------------------ the pair factory

test('factory: the authorize URL is Box\u2019s own door, PKCE S256, the pair\u2019s client id — and NO scope parameter', async () => {
  const client = createTenantPairOAuthClient('box', PAIR, { fetchImpl: noFetch });
  assert.ok(client, 'the pair builds a client');
  assert.equal(client.provider, 'box');
  assert.equal(client.clientId, PAIR.clientId);
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', scopes: [], challenge: 'challenge-1' }));
  assert.equal(url.origin + url.pathname, 'https://account.box.com/api/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), PAIR.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('scope'), null,
    'no scope rides the door: Box\u2019s server publishes no scopes_supported and the console-selected Access Scopes govern (UNVERIFIED until the live walk)');
});

test('factory: exchange and refresh are form posts to Box\u2019s token endpoint under the pair', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), new URLSearchParams(init.body)]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-box', refresh_token: 'rt-box', token_type: 'Bearer', expires_in: 3600 }) };
  };
  const client = createTenantPairOAuthClient('box', PAIR, { fetchImpl });
  const tokens = await client.exchangeCode({ code: 'code-1', redirectUri: CALLBACK, codeVerifier: 'verifier-1' });
  assert.equal(tokens.accessToken, 'at-box');
  assert.equal(seen[0][0], 'https://api.box.com/oauth2/token');
  assert.equal(seen[0][1].get('grant_type'), 'authorization_code');
  assert.equal(seen[0][1].get('client_id'), PAIR.clientId);
  assert.equal(seen[0][1].get('client_secret'), PAIR.clientSecret);
  assert.equal(seen[0][1].get('code_verifier'), 'verifier-1');
  const renewed = await client.refreshTokens({ refreshToken: 'rt-old' });
  assert.equal(renewed.refreshToken, 'rt-box', 'Box rotates: the new refresh token surfaces');
  assert.equal(seen[1][1].get('grant_type'), 'refresh_token');
  assert.equal(createTenantPairOAuthClient('nope', PAIR, { fetchImpl }), null, 'an unknown provider builds nothing');
  assert.equal(createTenantPairOAuthClient('box', { clientId: '', clientSecret: 'x' }, { fetchImpl }), null, 'an incomplete pair builds nothing');
});

// ------------------------------------------------------------ the vault kind

const VAULT_MASTER = randomBytes(32).toString('base64url');
// The pair helpers consume the credential SERVICE's surface in
// production (storeCredential / resolveVaultCredential /
// revokeVaultCredential — createCredentialServiceClient); the
// service is a transport wrapper over this vault, so the vault
// tests hand the helpers the vault through that same surface.
const asServiceClient = (vault) => ({
  storeCredential: (input) => vault.storeCredential(input),
  resolveVaultCredential: (input) => vault.resolveCredential(input),
  revokeVaultCredential: (input) => vault.revokeCredential(input),
});
const vaultActor = (subject = 'user-a', role = 'owner') => ({ actorSubject: subject, actorRole: role, sessionId: 'sess-v', requestId: 'req-v' });

test('vault: the client pair round-trips through the real vault under the tenant\u2019s address', async () => {
  const { pool } = fakeVaultPool();
  const vault = createCredentialVault({ pool, masterKey: VAULT_MASTER });
  const stored = await storeTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', ...PAIR });
  assert.equal(stored.accepted, true);
  const resolved = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', reasonClass: 'browser_sign_in' });
  assert.deepEqual(resolved, { clientId: PAIR.clientId, clientSecret: PAIR.clientSecret, mcpEndpointUrl: null });
  const forRefresh = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', reasonClass: 'oauth_refresh' });
  assert.deepEqual(forRefresh, resolved, 'the renewal reason resolves the pair too');
  const forCall = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', reasonClass: 'provider_call' });
  assert.equal(forCall, null, 'a provider_call resolve is refused — the pair is never spent as a call credential');
});

test('vault: another tenant\u2019s pair is unreachable, and a pair is not a password (no password gate, no value echo)', async () => {
  const { pool } = fakeVaultPool();
  const vault = createCredentialVault({ pool, masterKey: VAULT_MASTER });
  await storeTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', ...PAIR });
  const other = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT_B, actorContext: vaultActor('user-b'), provider: 'box', reasonClass: 'browser_sign_in' });
  assert.equal(other, null, 'tenant-b holds no pair and cannot read tenant-a\u2019s');
  const stored = await storeTenantPair(asServiceClient(vault), { tenantId: TENANT_B, actorContext: vaultActor('user-b'), provider: 'box', clientId: 'b-id', clientSecret: 'b-secret' });
  assert.equal(stored.accepted, true);
  assert.equal(JSON.stringify(stored).includes('b-secret'), false, 'store answers never echo the secret');
  const resolvedB = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT_B, actorContext: vaultActor('user-b'), provider: 'box', reasonClass: 'browser_sign_in' });
  assert.equal(resolvedB.clientId, 'b-id', 'each tenant reads its OWN pair');
});

test('vault: replacing a stored pair routes through the Guard replacement gate', async () => {
  const { pool } = fakeVaultPool();
  const open = createCredentialVault({ pool, masterKey: VAULT_MASTER });
  await storeTenantPair(asServiceClient(open), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', ...PAIR });

  const denying = createCredentialVault({ pool, masterKey: VAULT_MASTER, guardGate: async () => ({ approved: false }) });
  const refused = await storeTenantPair(asServiceClient(denying), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', clientId: 'new-id', clientSecret: 'new-secret' });
  assert.equal(refused.accepted, false, 'the gate\u2019s refusal refuses the replacement');
  const still = await resolveTenantPair(asServiceClient(open), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', reasonClass: 'browser_sign_in' });
  assert.equal(still.clientId, PAIR.clientId, 'the stored pair is untouched by the refused replacement');

  const approving = createCredentialVault({ pool, masterKey: VAULT_MASTER, guardGate: async () => ({ approved: true }) });
  const replaced = await storeTenantPair(asServiceClient(approving), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', clientId: 'new-id', clientSecret: 'new-secret' });
  assert.equal(replaced.accepted, true);
  const now = await resolveTenantPair(asServiceClient(open), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', reasonClass: 'browser_sign_in' });
  assert.equal(now.clientId, 'new-id', 'an approved replacement lands');
});

test('vault: the dispatch renewal actor resolves the pair under oauth_refresh — and under nothing else', async () => {
  const { pool } = fakeVaultPool();
  const vault = createCredentialVault({ pool, masterKey: VAULT_MASTER });
  await storeTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: vaultActor(), provider: 'box', ...PAIR });
  const arming = { actorSubject: 'helmion:connector-arming', actorRole: 'device', sessionId: 'sess-arm', requestId: 'req-arm' };
  const forRefresh = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: arming, provider: 'box', reasonClass: 'oauth_refresh' });
  assert.deepEqual(forRefresh, { clientId: PAIR.clientId, clientSecret: PAIR.clientSecret, mcpEndpointUrl: null },
    'the renewal road is the pair\u2019s one qualified unattended reader');
  const forCall = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: arming, provider: 'box', reasonClass: 'provider_call' });
  assert.equal(forCall, null, 'the same actor under a call reason is refused');
  const forSignIn = await resolveTenantPair(asServiceClient(vault), { tenantId: TENANT, actorContext: arming, provider: 'box', reasonClass: 'browser_sign_in' });
  assert.equal(forSignIn, null, 'and under a sign-in reason is refused — the qualification is the renewal alone');
});

// ------------------------------------------------------------ write route

const boxTokenFetch = async (url, init) => {
  if (String(url) === 'https://api.box.com/oauth2/token') {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), PAIR.clientId, 'the exchange runs under the tenant\u2019s pair');
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-box', refresh_token: 'rt-box', token_type: 'Bearer', expires_in: 3600 }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

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

test('write route: no pair stored — Connect answers needs-tenant-pair naming Box and its console, and starts no handshake', async () => {
  const { pool, store } = await makeWorld();
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: fakeCredentials(), fetchImpl: noFetch });
  const out = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-box' });
  assert.equal(out.status, 200);
  const json = JSON.parse(out.payload);
  assert.equal(json.status, 'needs-tenant-pair');
  assert.equal(json.provider, 'box');
  assert.match(json.note, /Box/);
  assert.match(json.note, /Box Admin Console/, 'the note names where the pair is minted');
  assert.match(json.note, /no pair is stored for this workspace yet/, 'the note says plainly that no pair is stored yet');
  assert.equal(pool.pendingRows.size, 0, 'no handshake was started');
  assert.equal(await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-box' }), null, 'nothing connected');
});

test('write route: the pair actions — status answers a boolean only, the store lands the pair at the tenant address and echoes nothing', async () => {
  const { pool, store } = await makeWorld();
  const credentials = fakeCredentials();
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: noFetch });

  const before = await h.post('/api/admin/connector-library/tenant-pair/status', { provider: 'box' });
  assert.deepEqual(JSON.parse(before.payload), { valid: true, status: 'pair-status', provider: 'box', pairConfigured: false });

  const stored = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'box', ...PAIR });
  assert.equal(stored.status, 200);
  assert.deepEqual(JSON.parse(stored.payload), { valid: true, status: 'pair-stored', provider: 'box', pairConfigured: true });
  assert.equal(stored.payload.includes(PAIR.clientSecret), false, 'the answer never echoes the secret');
  assert.equal(stored.payload.includes(PAIR.clientId), false, 'nor the client id');
  const rec = credentials.records.get(`${TENANT}|connector-pair.box|vault://tenant/tenant-a/connector-pair.box/client-pair`);
  assert.ok(rec, 'the pair record sits at the tenant address');
  assert.equal(rec.credentialKind, 'client_pair');

  const after = await h.post('/api/admin/connector-library/tenant-pair/status', { provider: 'box' });
  assert.deepEqual(JSON.parse(after.payload), { valid: true, status: 'pair-status', provider: 'box', pairConfigured: true });

  // The pair actions are the owner/admin's alone.
  const member = handlerAs(MEMBER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: noFetch });
  const memberStore = await member.post('/api/admin/connector-library/tenant-pair', { provider: 'box', clientId: 'x', clientSecret: 'y' });
  assert.ok(memberStore.status >= 400, 'a member cannot store a pair');
  const memberStatus = await member.post('/api/admin/connector-library/tenant-pair/status', { provider: 'box' });
  assert.ok(memberStatus.status >= 400, 'a member cannot even ask after the pair');

  // Shape refusals, in plain words.
  const wrongProvider = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'gmail', clientId: 'x', clientSecret: 'y' });
  assert.equal(wrongProvider.status, 400);
  const incomplete = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'box', clientId: 'x' });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.payload, /the client pair itself is required/);
  const boxPath = await h.post('/api/admin/connector-library/tenant-pair', { provider: 'box', ...PAIR, serverPath: 'platform/sobject-reads' });
  assert.equal(boxPath.status, 400, 'a Box pair carries no server path');
  assert.match(boxPath.payload, /carries no server path/);
});

test('write route: with a pair stored, Connect opens Box\u2019s door under the pair; the callback lands the connection on the set', async () => {
  const { pool, store, read } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: boxTokenFetch });

  const start = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-box' });
  const startJson = JSON.parse(start.payload);
  assert.equal(startJson.status, 'authorize');
  assert.equal(startJson.provider, 'box');
  const authorize = new URL(startJson.authorizeUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://account.box.com/api/oauth2/authorize', 'Connect opens Box\u2019s own sign-in door');
  assert.equal(authorize.searchParams.get('client_id'), PAIR.clientId, 'under the TENANT\u2019s pair — no env client exists');
  assert.equal(authorize.searchParams.get('scope'), null, 'no scope parameter rides the door');
  const state = authorize.searchParams.get('state');
  assert.ok(state);

  const landed = await h.get(`/api/admin/connector-library/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
  assert.equal(landed.status, 200);
  assert.match(landed.payload, /Box is connected/);
  const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-box' });
  assert.ok(connection, 'the connection answers on another agent — the S1 set carries it');
  assert.equal(connection.state, 'connected');
  assert.equal(connection.accountIdentity, 'Box account');
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok' });
  const row = view.rows.find((r) => r.entryId === 'helmian-box');
  assert.equal(row.state, 'connected');
  assert.equal(row.tenantPair, true, 'the read marks the row as a tenant-pair row');
  assert.equal(row.oauthProvider, 'box');
});

test('write route: a pair replaced between start and callback refuses the landing — the handshake\u2019s client id rules', async () => {
  const { pool, store } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const h = handlerAs(OWNER, { store, pendingStore: createConnectorOAuthPendingStore(pool), credentialClient: credentials, fetchImpl: boxTokenFetch });
  const start = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-box' });
  const state = new URL(JSON.parse(start.payload).authorizeUrl).searchParams.get('state');

  // The pair is replaced (an admin re-minted it) before Box answers.
  credentials.records.set(`${TENANT}|connector-pair.box|vault://tenant/tenant-a/connector-pair.box/client-pair`, {
    tenantId: TENANT, providerId: 'connector-pair.box',
    credentialReference: 'vault://tenant/tenant-a/connector-pair.box/client-pair',
    credentialKind: 'client_pair', clientId: 'box-client-id-2', clientSecret: 'box-client-secret-2', mcpEndpointUrl: null,
  });
  const landed = await h.get(`/api/admin/connector-library/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
  assert.equal(landed.status, 200);
  assert.match(landed.payload, /That sign-in did not land/, 'the stale handshake is refused honestly, not completed under the new pair');
  assert.equal(await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-box' }), null, 'nothing connected');
});

// ------------------------------------------------------------ dispatch + round trip

test('dispatch: the renewal leg runs under the tenant\u2019s pair — the refresh posts to Box under the pair\u2019s client id', async () => {
  const { store } = await makeWorld();
  const credentials = fakeCredentials();
  await seedPair(credentials);
  const accessRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-box', personId: PERSON, tokenKind: 'access' });
  const refreshRef = buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-box', personId: PERSON, tokenKind: 'refresh' });
  await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-box',
    accountIdentity: 'Box account', accessTokenRef: accessRef, refreshTokenRef: refreshRef,
    grantedScopes: [], posture: 'ask',
  });
  await store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-box' }, [
    { name: 'search_files', description: 'Search files', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ], PERSON);
  // Only the refresh reference resolves (the access token aged out).
  await credentials.storeCredential({
    tenantId: TENANT, providerId: 'connector.claude.helmian-box', credentialReference: refreshRef,
    credentialKind: 'oauth_bundle', accessToken: 'at-old', refreshToken: 'rt-old', tokenType: 'Bearer',
  });

  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetches.push([String(url), new URLSearchParams(init.body)]);
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer', expires_in: 3600 }) };
  };
  try {
    const armed = await resolveArmingRecord({
      store, credentials,
      listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
      operatorTokens: {}, toolConnections: null,
      tenantId: TENANT, personId: PERSON, seatId: 'grok', entryId: 'helmian-box',
    });
    assert.equal(armed.state, 'connected');
    assert.equal(armed.accessToken, 'at-new', 'the renewed token arms the turn');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches.length, 1, 'exactly one renewal exchange');
  assert.equal(fetches[0][0], 'https://api.box.com/oauth2/token');
  assert.equal(fetches[0][1].get('grant_type'), 'refresh_token');
  assert.equal(fetches[0][1].get('client_id'), PAIR.clientId, 'the renewal ran under the tenant\u2019s pair');
  assert.equal(fetches[0][1].get('refresh_token'), 'rt-old');
  const after = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-box' });
  assert.equal(after.accessTokenRef, accessRef, 'the reference family is unchanged — the renewal replaced the credential under the same address');
});

test('round trip on the real store machinery: connect, disconnect frees the slot, reconnect lands (S1)', async () => {
  const { store } = await makeWorld();
  const key = { personId: PERSON, seatId: 'chatgpt', entryId: 'helmian-box' };
  const first = await store.createConnection(TENANT, PERSON, {
    ...key, accountIdentity: 'Box account',
    accessTokenRef: buildConnectorTokenRef({ tenantId: TENANT, seatId: 'chatgpt', entryId: 'helmian-box', personId: PERSON, tokenKind: 'access' }),
    refreshTokenRef: null, grantedScopes: [], posture: 'ask',
  });
  assert.equal(first.state, 'connected');
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, { ...key, accountIdentity: 'Box account', accessTokenRef: buildConnectorTokenRef({ tenantId: TENANT, seatId: 'chatgpt', entryId: 'helmian-box', personId: PERSON, tokenKind: 'access' }), refreshTokenRef: null, grantedScopes: [], posture: 'ask' }),
    /already has a connection for this connector/, 'a second connect on the occupied slot is refused',
  );
  const gone = await store.disconnectConnection(TENANT, key, PERSON);
  assert.equal(gone.connection.state, 'disconnected');
  const afterGone = await store.getConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-box' });
  assert.equal(afterGone.state, 'disconnected', 'the set reads disconnected on every agent — the slot is freed');
  // The reconnect lands from another agent (the store's standing
  // law for every connector: a disconnected row keeps its own
  // physical key, and the set takes the newest row as its
  // connection — the same shape the Microsoft family round trip
  // proved under a sibling member).
  const second = await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'claude', entryId: 'helmian-box', accountIdentity: 'Box account',
    accessTokenRef: buildConnectorTokenRef({ tenantId: TENANT, seatId: 'claude', entryId: 'helmian-box', personId: PERSON, tokenKind: 'access' }),
    refreshTokenRef: null, grantedScopes: [], posture: 'ask',
  });
  assert.equal(second.state, 'connected', 'the freed slot takes the reconnect');
  assert.notEqual(second.id, first.id, 'a fresh physical row for the new connection');
  const fromGrok = await store.getConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-box' });
  assert.equal(fromGrok.id, second.id, 'the reconnected connection is the set\u2019s, on every agent');
});

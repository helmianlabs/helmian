// The Microsoft family — OneDrive, Outlook, Microsoft Teams,
// SharePoint: four names, ONE connection (Troy's ruling,
// 2026-11-10; REGISTRATION-PACK §6).
//
// What is proven here:
//   - the catalog stocks the four brokered entries beside the
//     mirrors on claude, chatgpt, grok (nowhere else), as
//     Helmian-brokered OAuth rows naming Microsoft's own unified
//     Work IQ server, each declaring the connectionFamily
//     'microsoft' and the SAME ask — the scope set the server's
//     own protected-resource document publishes, plus the
//     standard sign-in scopes. No new service names: the four
//     were already named by their mirrors (the unique-name count
//     stays 27);
//   - the copy is truthful: every entry says the four share ONE
//     Microsoft connection, says a work or school account is
//     required, and names the admin-approval possibility; the
//     Teams words promise reading only (Work IQ's write depth
//     for Teams is UNVERIFIED);
//   - kind resolution: all four entries resolve the FIXED kind
//     under the ONE provider 'microsoft' (Entra offers no
//     dynamic registration and no client metadata document, so
//     neither other road can serve them), configured exactly
//     when the MICROSOFT_OAUTH_* pair is placed;
//   - the registry: 'microsoft' answers a client only with its
//     pair present; the factory builds Microsoft's real
//     authorize URL (login.microsoftonline.com/organizations)
//     carrying the declared scopes and PKCE S256, exchanges and
//     refreshes by client_secret_post form against the token
//     endpoint, surfaces the ROTATED refresh token Entra issues,
//     and carries NO identity read (the token is Work-IQ-scoped;
//     the callback falls back to the provider's name);
//   - the store's family table equals the catalog's declarations
//     (the two are kept in step by hand and pinned equal here);
//   - the SET carries the family (SYNC S1 over the family): over
//     the REAL store on a fake pool, a connection recorded under
//     OneDrive is the connection for Outlook, Teams and
//     SharePoint on every seat; listConnections projects it onto
//     every member with provenanceEntryId naming the member it
//     was recorded under; posture and token updates addressed to
//     a sibling land on the family's one physical row; a
//     disconnect addressed to a sibling disconnects the family;
//     a reconnect under another member re-points the provenance
//     (the connect → disconnect → reconnect round trip on the
//     real machinery); another person and another tenant never
//     see it; a vendor mirror still refuses a Helmian connection;
//   - the read: the real library read shows all four rows
//     connected, the siblings carrying the sharedConnection
//     detail (family + recorded-under member), and the Level 1
//     counts count the family connection on its member rows;
//   - the write route through the real handler, the real pending
//     store and the real factory: with no registration placed a
//     start answers the consent boundary naming Microsoft and
//     connects nothing; with a (dummy, test-only) pair placed a
//     start answers Microsoft's real authorize URL and the
//     callback lands the connection under the member the person
//     connected — after which the other three read connected;
//   - the admin-consent road (PACK §6): a callback carrying
//     Microsoft's consent error answers the admin-approval page
//     (the admin-consent link for Helmian's registration) and
//     consumes the handshake; a DIFFERENT provider's error keeps
//     the standing generic page and its row is NOT consumed;
//   - arming: the real dispatch arms a sibling member (Teams on
//     another seat) from the family's one connection — the vault
//     resolve presents the PHYSICAL member's provider id, and a
//     vault that only holds the record under that id arms it
//     while the sibling's id would miss; the refresh leg renews
//     through the microsoft client and re-stores the pair under
//     references minted with the physical member's entry id.
//
// Live evidence behind the shapes (2026-11-10, REGISTRATION-PACK
// §6 + the Work IQ server's own protected-resource document,
// fetched live this session): endpoint
// https://workiq.svc.cloud.microsoft/mcp; authorization server
// https://login.microsoftonline.com/organizations/v2.0;
// scopes_supported exactly
// [fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask].

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_CATALOG,
  LIVE_SEATS,
  catalogEntriesForSeat,
  catalogEntryById,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { connectorOAuthKindForEntry, fixedProviderForEntry } from '../src/cloud/connector-oauth-dcr.mjs';
import {
  createConnectorOAuthClient,
  createConnectorOAuthPendingStore,
  hashOAuthState,
} from '../src/cloud/connector-oauth-pending.mjs';
import {
  createConnectorLibraryStore,
  buildConnectorTokenRef,
  CONNECTOR_CONNECTION_FAMILIES,
  connectionFamilyForEntry,
} from '../src/cloud/connector-library.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';

class TenantAuthorizationError extends Error {}

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';
const OWNER = { subject: PERSON, tenantId: TENANT, role: 'owner' };
const CALLBACK = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const SEATS = ['claude', 'chatgpt', 'grok'];
const WORKIQ = 'https://workiq.svc.cloud.microsoft/mcp';

const MS_SCOPES = [
  'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask',
  'offline_access', 'openid', 'profile',
];

const FAMILY = [
  { entryId: 'helmian-onedrive', name: 'OneDrive', mirrorId: 'onedrive' },
  { entryId: 'helmian-outlook', name: 'Outlook', mirrorId: 'outlook' },
  { entryId: 'helmian-microsoft-teams', name: 'Microsoft Teams', mirrorId: 'microsoft-teams' },
  { entryId: 'helmian-sharepoint', name: 'SharePoint', mirrorId: 'sharepoint' },
];
const FAMILY_IDS = FAMILY.map((f) => f.entryId);

const noFetch = async () => { throw new Error('no network in tests'); };

// ------------------------------------------------------------ catalog

test('catalog: the Microsoft four are stocked brokered on claude, chatgpt, grok — and nowhere else', () => {
  for (const fam of FAMILY) {
    for (const seatId of SEATS) {
      const def = catalogEntryById(seatId, fam.entryId);
      assert.ok(def, `${seatId}/${fam.entryId}: stocked`);
      assert.equal(def.name, fam.name);
      assert.equal(def.vendorName, 'Microsoft');
      assert.equal(def.trustLabel, 'verified', `${seatId}/${fam.entryId}: the mirror's own label, not upgraded`);
      assert.equal(def.brokerMode, 'helmian', `${seatId}/${fam.entryId}: Helmian's own pipe`);
      assert.equal(def.authMode, 'oauth');
      assert.equal(def.mcpEndpointUrl, WORKIQ, `${seatId}/${fam.entryId}: Microsoft's unified Work IQ server`);
      assert.equal(def.vendorPublished, true, `${seatId}/${fam.entryId}: Microsoft's own server, marked as provenance`);
      assert.equal(def.vendorConnectorRef, undefined, `${seatId}/${fam.entryId}: a brokered entry carries no vendor ref`);
      assert.equal(def.addedBy, 'system');
      assert.equal(def.connectionFamily, 'microsoft', `${seatId}/${fam.entryId}: declares the one-connection family`);
      assert.deepEqual(def.oauthScopes, MS_SCOPES, `${seatId}/${fam.entryId}: the Work IQ ask — the same for all four, because the connection is one`);
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

test('catalog: the Microsoft vendor mirrors stay as data beside the brokered rows', () => {
  for (const fam of FAMILY) {
    const mirror = catalogEntryById('grok', fam.mirrorId);
    assert.ok(mirror, `grok/${fam.mirrorId}: mirror still stocked`);
    assert.equal(mirror.brokerMode, 'vendor', `grok/${fam.mirrorId}: mirror untouched`);
    assert.equal(mirror.vendorName, 'Microsoft');
  }
});

test('catalog: no new service names — the four were already named by their mirrors', () => {
  const names = new Set(CONNECTOR_CATALOG.map((d) => d.name.toLowerCase()));
  assert.equal(names.size, 27);
});

test('catalog copy: one shared connection, work or school only, admin approval named; Teams promises reading only', () => {
  for (const fam of FAMILY) {
    const def = catalogEntryById('claude', fam.entryId);
    assert.match(def.scopesSummary, /share this one Microsoft connection/, `${fam.entryId}: the shared truth`);
    assert.match(def.scopesSummary, /work or school Microsoft account/, `${fam.entryId}: organizations only, said plainly`);
    assert.match(def.scopesSummary, /personal Microsoft account cannot connect/, `${fam.entryId}: the personal-account wall, said plainly`);
    assert.match(def.scopesSummary, /admin may need to approve Helmian/, `${fam.entryId}: the admin-approval possibility, named`);
  }
  const teams = catalogEntryById('claude', 'helmian-microsoft-teams');
  assert.match(teams.scopesSummary, /read your Teams chats and channels/);
  assert.doesNotMatch(teams.scopesSummary, /send|post/i, 'Teams: no writing promise — Work IQ write depth is UNVERIFIED');
  assert.doesNotMatch(teams.oneLiner, /send|post|write/i, 'Teams one-liner: reading only');
});

test('family tables agree: the store\u2019s hand-kept family table equals the catalog\u2019s declarations', () => {
  const declared = new Set();
  for (const def of CONNECTOR_CATALOG) {
    if (def.connectionFamily) declared.add(`${def.connectionFamily}:${def.id}`);
  }
  const stored = new Set();
  for (const [family, members] of Object.entries(CONNECTOR_CONNECTION_FAMILIES)) {
    for (const id of members) stored.add(`${family}:${id}`);
  }
  assert.deepEqual([...declared].sort(), [...stored].sort(), 'catalog declarations and the store table name the same members');
  for (const fam of FAMILY) assert.equal(connectionFamilyForEntry(fam.entryId), 'microsoft');
  assert.equal(connectionFamilyForEntry('helmian-gmail'), null, 'the Google entries share a provider but are NOT one connection');
});

// ------------------------------------------------- kind + registry

test('kind: all four entries resolve the fixed kind under the one provider microsoft', () => {
  for (const fam of FAMILY) {
    const entry = { id: fam.entryId, authMode: 'oauth', mcpEndpointUrl: WORKIQ };
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: {} }),
      { kind: 'fixed', provider: 'microsoft', configured: false },
      `${fam.entryId}: fixed + unconfigured with no env`,
    );
    assert.deepEqual(
      connectorOAuthKindForEntry(entry, { env: { MICROSOFT_OAUTH_CLIENT_ID: 'dummy-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'dummy-secret' } }),
      { kind: 'fixed', provider: 'microsoft', configured: true },
      `${fam.entryId}: fixed + configured with the dummy pair`,
    );
    assert.equal(fixedProviderForEntry(entry), 'microsoft');
    assert.equal(fixedProviderForEntry(catalogEntryById('claude', fam.entryId)), 'microsoft');
  }
});

test('registry: microsoft answers null without its pair, a client carrying its clientId with it', () => {
  assert.equal(createConnectorOAuthClient('microsoft', { fetchImpl: noFetch, env: {} }), null, 'absent unconfigured');
  assert.equal(createConnectorOAuthClient('microsoft', { fetchImpl: noFetch, env: { MICROSOFT_OAUTH_CLIENT_ID: 'dummy-id' } }), null, 'half a pair is not configured');
  assert.equal(createConnectorOAuthClient('microsoft', { fetchImpl: noFetch, env: { MICROSOFT_OAUTH_CLIENT_SECRET: 'dummy-secret' } }), null, 'the other half alone is not configured');
  const client = createConnectorOAuthClient('microsoft', { fetchImpl: noFetch, env: { MICROSOFT_OAUTH_CLIENT_ID: 'dummy-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'dummy-secret' } });
  assert.ok(client, 'client with the pair');
  assert.equal(client.provider, 'microsoft');
  assert.equal(client.displayName, 'Microsoft');
  assert.equal(client.clientId, 'dummy-id');
  assert.equal(typeof client.refreshTokens, 'function', 'the refresh exchange exists from day one');
  assert.equal(client.fetchIdentity, undefined, 'no identity read: the token is Work-IQ-scoped, so the callback falls back to the provider name (the Asana precedent)');
});

// ------------------------------------------------------- factories

test('microsoft authorize URL: Microsoft\u2019s real endpoint under organizations, the declared scopes, PKCE S256', async () => {
  const client = createConnectorOAuthClient('microsoft', { fetchImpl: noFetch, env: { MICROSOFT_OAUTH_CLIENT_ID: 'ms-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms-secret' } });
  const url = new URL(await client.authorizeUrl({ redirectUri: CALLBACK, state: 'state-1', challenge: 'ch-1', scopes: MS_SCOPES }));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize', 'the authorization server the Work IQ metadata names');
  assert.equal(url.searchParams.get('client_id'), 'ms-id');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'ch-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope').split(' '), MS_SCOPES, 'the declared ask, from the caller — never a factory table');
});

test('microsoft exchange + refresh: client_secret_post forms to the token endpoint; the rotated refresh token surfaces', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init]);
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'refresh_token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3599 }) };
    }
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', scope: MS_SCOPES.join(' '), expires_in: 3599 }) };
  };
  const client = createConnectorOAuthClient('microsoft', { fetchImpl, env: { MICROSOFT_OAUTH_CLIENT_ID: 'ms-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms-secret' } });
  const tokens = await client.exchangeCode({ code: 'c1', codeVerifier: 'v1', redirectUri: CALLBACK });
  assert.equal(seen[0][0], 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  const sentForm = new URLSearchParams(seen[0][1].body);
  assert.equal(sentForm.get('grant_type'), 'authorization_code');
  assert.equal(sentForm.get('client_id'), 'ms-id');
  assert.equal(sentForm.get('client_secret'), 'ms-secret', 'client_secret_post: the secret rides the exchange, server-side');
  assert.equal(sentForm.get('code_verifier'), 'v1');
  assert.deepEqual([tokens.accessToken, tokens.refreshToken], ['at-1', 'rt-1']);

  const renewed = await client.refreshTokens({ refreshToken: 'rt-1' });
  const refreshForm = new URLSearchParams(seen[1][1].body);
  assert.equal(refreshForm.get('grant_type'), 'refresh_token');
  assert.equal(renewed.accessToken, 'at-2');
  assert.equal(renewed.refreshToken, 'rt-2', 'Entra rotates the refresh token; the rotated one surfaces for the re-store');
});

// ------------------------------------------------------------ fake pool
// Simulates the sql/074 tables with a monotonic clock, so every
// write stamps a strictly newer updated_at (the collapse rule's
// input). The connection UPDATE applier is generic: every store
// update is `set col = $n | 'literal' | null | clock_timestamp()`
// over the exact-row WHERE (person $1, seat $2, entry $3).

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

// A vault fake shaped like the real one: records keyed
// (provider_id, credential_reference), so a resolve addressed
// under the WRONG provider id misses — exactly as the real vault.
function fakeCredentials() {
  const records = new Map();
  const calls = [];
  const keyOf = (p, r) => `${p}|${r}`;
  return {
    records, calls,
    async storeCredential(input) {
      calls.push(['storeCredential', input.providerId, input.credentialReference]);
      records.set(keyOf(input.providerId, input.credentialReference), { ...input });
      return { accepted: true, status: 'stored' };
    },
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input.providerId, input.credentialReference, input.reasonClass]);
      const rec = records.get(keyOf(input.providerId, input.credentialReference));
      if (!rec) return { accepted: false, status: 'credential_not_available' };
      return { accepted: true, credential: { accessToken: rec.accessToken, refreshToken: rec.refreshToken ?? null } };
    },
    async revokeVaultCredential(input) {
      calls.push(['revokeVaultCredential', input.providerId, input.credentialReference]);
      const existed = records.delete(keyOf(input.providerId, input.credentialReference));
      return { accepted: existed, status: existed ? 'revoked' : 'credential_not_available' };
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

const refFor = (tenantId, seatId, entryId, personId, kind) =>
  buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind: kind });

const connectFamily = (store, { seatId = 'claude', entryId = 'helmian-onedrive', personId = PERSON, tenantId = TENANT } = {}) =>
  store.createConnection(tenantId, PERSON, {
    personId, seatId, entryId,
    accountIdentity: 'troy@contoso.example',
    accessTokenRef: refFor(tenantId, seatId, entryId, personId, 'access'),
    refreshTokenRef: refFor(tenantId, seatId, entryId, personId, 'refresh'),
    grantedScopes: MS_SCOPES,
    posture: 'ask',
  });

// ------------------------------------------------- the set carries the family

test('store: a connection recorded under OneDrive IS the connection for all four, on every seat', async () => {
  const { store } = await makeWorld();
  const landed = await connectFamily(store);
  assert.equal(landed.entryId, 'helmian-onedrive', 'the physical row sits under the member the person connected');

  for (const seatId of SEATS) {
    for (const fam of FAMILY) {
      const connection = await store.getConnection(TENANT, { personId: PERSON, seatId, entryId: fam.entryId });
      assert.ok(connection, `${seatId}/${fam.entryId}: the family connection answers`);
      assert.equal(connection.id, landed.id, `${seatId}/${fam.entryId}: the SAME physical row`);
      assert.equal(connection.entryId, 'helmian-onedrive', `${seatId}/${fam.entryId}: the record names its physical member`);
      assert.equal(connection.state, 'connected');
      assert.equal(connection.accountIdentity, 'troy@contoso.example');
    }
  }

  // The list projects the winner onto every member, naming the
  // member it was recorded under on the siblings only.
  const listed = await store.listConnections(TENANT, { personId: PERSON, seatId: 'grok' });
  const familyRows = listed.filter((c) => FAMILY_IDS.includes(c.entryId));
  assert.equal(familyRows.length, 4, 'one projection per member — four rows, one connection');
  assert.ok(familyRows.every((c) => c.id === landed.id), 'every projection is the same physical row');
  const underItself = familyRows.find((c) => c.entryId === 'helmian-onedrive');
  assert.equal(underItself.provenanceEntryId, undefined, 'the recorded-under member carries no provenance marker');
  for (const fam of FAMILY.slice(1)) {
    const projected = familyRows.find((c) => c.entryId === fam.entryId);
    assert.equal(projected.provenanceEntryId, 'helmian-onedrive', `${fam.entryId}: the projection names where the connection was made`);
  }

  // The walls hold: another person, another tenant.
  assert.equal(await store.getConnection(TENANT, { personId: OTHER_PERSON, seatId: 'claude', entryId: 'helmian-outlook' }), null, 'another person: nothing');
  assert.equal(await store.getConnection(TENANT_B, { personId: PERSON, seatId: 'claude', entryId: 'helmian-outlook' }), null, 'another tenant: nothing');
  const otherList = await store.listConnections(TENANT, { personId: OTHER_PERSON, seatId: 'claude' });
  assert.equal(otherList.filter((c) => FAMILY_IDS.includes(c.entryId)).length, 0, 'another person\u2019s list holds no family rows');
});

test('store: writes addressed to a sibling land on the family\u2019s one row; disconnect via a sibling frees all four; reconnect re-points provenance', async () => {
  const { store } = await makeWorld();
  const landed = await connectFamily(store);

  // Posture via Teams.
  const postured = await store.setPosture(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-microsoft-teams' }, 'read', PERSON);
  assert.equal(postured.id, landed.id);
  assert.equal(postured.posture, 'read');
  const viaOneDrive = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-onedrive' });
  assert.equal(viaOneDrive.posture, 'read', 'the posture change is the family\u2019s, whichever member it was addressed to');

  // Token landing via Outlook.
  const newAccess = refFor(TENANT, 'claude', 'helmian-onedrive', PERSON, 'access');
  const updated = await store.updateConnectionTokens(TENANT, { personId: PERSON, seatId: 'chatgpt', entryId: 'helmian-outlook' }, { accessTokenRef: newAccess }, PERSON);
  assert.equal(updated.id, landed.id, 'the token update lands on the physical row');
  assert.equal(updated.accessTokenRef, newAccess);

  // Disconnect via SharePoint, from grok: the whole family reads
  // disconnected afterwards — the slot is freed.
  const gone = await store.disconnectConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-sharepoint' }, PERSON);
  assert.equal(gone.connection.id, landed.id);
  assert.equal(gone.connection.state, 'disconnected');
  for (const fam of FAMILY) {
    const after = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: fam.entryId });
    assert.equal(after.state, 'disconnected', `${fam.entryId}: disconnected with the family`);
  }

  // Reconnect under Outlook: the round trip closes, and the
  // provenance now names Outlook.
  const relanded = await connectFamily(store, { seatId: 'chatgpt', entryId: 'helmian-outlook' });
  assert.notEqual(relanded.id, landed.id, 'a fresh physical row for the new connection');
  const listed = await store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' });
  const familyRows = listed.filter((c) => FAMILY_IDS.includes(c.entryId));
  assert.equal(familyRows.length, 4);
  assert.ok(familyRows.every((c) => c.id === relanded.id), 'the newest family row wins the set');
  assert.equal(familyRows.find((c) => c.entryId === 'helmian-onedrive').provenanceEntryId, 'helmian-outlook', 'provenance follows the member the reconnect used');
});

test('store: a vendor mirror still refuses a Helmian connection (the family changes no mirror law)', async () => {
  const { store } = await makeWorld();
  await assert.rejects(
    () => store.createConnection(TENANT, PERSON, {
      personId: PERSON, seatId: 'grok', entryId: 'onedrive',
      accountIdentity: 'x',
      accessTokenRef: refFor(TENANT, 'grok', 'onedrive', PERSON, 'access'),
    }),
    /vendor-brokered/,
    'the grok OneDrive mirror holds no Helmian tokens — the brokered row beside it is the connection\u2019s home',
  );
});

test('read: all four rows read connected; siblings carry the shared detail; counts count the family on its member rows', async () => {
  const { store, read } = await makeWorld();
  await connectFamily(store);

  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'chatgpt' });
  for (const fam of FAMILY) {
    const row = view.rows.find((r) => r.entryId === fam.entryId);
    assert.ok(row, `chatgpt/${fam.entryId}: row present`);
    assert.equal(row.state, 'connected', `chatgpt/${fam.entryId}: connected`);
    assert.equal(row.accountIdentity, 'troy@contoso.example');
  }
  const oneDrive = view.rows.find((r) => r.entryId === 'helmian-onedrive');
  assert.equal(oneDrive.stateDetail?.sharedConnection, undefined, 'the recorded-under member needs no shared marker');
  for (const fam of FAMILY.slice(1)) {
    const row = view.rows.find((r) => r.entryId === fam.entryId);
    assert.deepEqual(
      row.stateDetail?.sharedConnection,
      { family: 'microsoft', recordedUnderEntryId: 'helmian-onedrive' },
      `${fam.entryId}: the detail names the shared connection and where it was recorded`,
    );
  }

  const counts = await read.readSeatCounts(TENANT, { personId: PERSON });
  for (const seatId of SEATS) {
    const seatCounts = counts.seats.find((s) => s.seatId === seatId);
    assert.ok(seatCounts, `${seatId}: counted`);
    assert.ok(seatCounts.connectedCount >= 4, `${seatId}: the family connection counts on its member rows (got ${seatCounts.connectedCount})`);
  }
});

// ----------------------------------------------------- write route

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

const NO_MS_ENV = { MICROSOFT_OAUTH_CLIENT_ID: undefined, MICROSOFT_OAUTH_CLIENT_SECRET: undefined };

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

const tokenFetch = async (url) => {
  if (String(url) === 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token') {
    return { ok: true, status: 200, json: async () => ({ access_token: 'at-ms', refresh_token: 'rt-ms', token_type: 'Bearer', scope: MS_SCOPES.join(' '), expires_in: 3599 }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

test('write route: no registration placed — the start answers the consent boundary naming Microsoft and connects nothing', async () => {
  await withEnv(NO_MS_ENV, async () => {
    const { pool, store } = await makeWorld();
    const h = handlerHarness({ store, pendingStore: createConnectorOAuthPendingStore(pool), credentials: fakeCredentials(), fetchImpl: noFetch });
    const out = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-onedrive' });
    assert.equal(out.status, 200);
    const json = JSON.parse(out.payload);
    assert.equal(json.status, 'consent-boundary', 'registration-missing, said honestly');
    assert.equal(json.provider, 'microsoft');
    assert.match(json.note, /app registration in OneDrive's own console has not been placed yet/, 'the boundary note names the product the person tried to connect; the answer\u2019s provider field names Microsoft');
    assert.equal(pool.pendingRows.size, 0, 'no handshake was started');
    assert.equal(await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-onedrive' }), null, 'nothing connected');
  });
});

test('write route: the full landing — start answers Microsoft\u2019s door, the callback lands the connection, the other three read connected', async () => {
  await withEnv({ ...NO_MS_ENV, MICROSOFT_OAUTH_CLIENT_ID: 'ms-dummy-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms-dummy-secret' }, async () => {
    const { pool, store, read } = await makeWorld();
    const credentials = fakeCredentials();
    const h = handlerHarness({ store, pendingStore: createConnectorOAuthPendingStore(pool), credentials, fetchImpl: tokenFetch });

    const start = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-onedrive' });
    const startJson = JSON.parse(start.payload);
    assert.equal(startJson.status, 'authorize');
    assert.equal(startJson.provider, 'microsoft');
    const authorize = new URL(startJson.authorizeUrl);
    assert.equal(authorize.origin + authorize.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize', 'Connect opens Microsoft\u2019s own sign-in door');
    assert.equal(authorize.searchParams.get('client_id'), 'ms-dummy-id');
    assert.deepEqual(authorize.searchParams.get('scope').split(' '), MS_SCOPES, 'the declared ask rides the door URL');
    const state = authorize.searchParams.get('state');
    assert.ok(state, 'the handshake state rides the URL');

    const landed = await h.get(`/api/admin/connector-library/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`);
    assert.equal(landed.status, 200);
    assert.match(landed.payload, /Microsoft is connected/, 'the callback lands it');

    const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'grok', entryId: 'helmian-sharepoint' });
    assert.ok(connection, 'the family connection answers from a sibling on another seat');
    assert.equal(connection.entryId, 'helmian-onedrive', 'recorded under the member the person connected');
    assert.equal(connection.state, 'connected');
    assert.equal(connection.accountIdentity, 'Microsoft account', 'no identity read on this road — the provider\u2019s name is the label');
    // The token pair sits in the vault under the PHYSICAL member's
    // provider id — the address every later resolve must present.
    const storedUnder = credentials.calls.filter(([n]) => n === 'storeCredential').map(([, p]) => p);
    assert.ok(storedUnder.length >= 2 && storedUnder.every((p) => p === 'connector.claude.helmian-onedrive'), 'both token stores addressed under connector.claude.helmian-onedrive');

    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok' });
    for (const fam of FAMILY) {
      const row = view.rows.find((r) => r.entryId === fam.entryId);
      assert.equal(row.state, 'connected', `grok/${fam.entryId}: connected after the one landing`);
    }
  });
});

test('write route: a Microsoft consent error answers the admin-approval page and consumes the handshake; another provider\u2019s error keeps the generic page and its row', async () => {
  await withEnv({ ...NO_MS_ENV, MICROSOFT_OAUTH_CLIENT_ID: 'ms-dummy-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'ms-dummy-secret' }, async () => {
    const { pool, store } = await makeWorld();
    const pendingStore = createConnectorOAuthPendingStore(pool);
    const h = handlerHarness({ store, pendingStore, credentials: fakeCredentials(), fetchImpl: tokenFetch });

    const start = await h.post('/api/admin/connector-library/connect', { seatId: 'claude', entryId: 'helmian-outlook' });
    const state = new URL(JSON.parse(start.payload).authorizeUrl).searchParams.get('state');
    const consent = await h.get(`/api/admin/connector-library/oauth/callback?error=consent_required&error_description=${encodeURIComponent('AADSTS65001: The user or administrator has not consented to use the application')}&state=${encodeURIComponent(state)}`);
    assert.match(consent.payload, /Microsoft needs your admin/, 'the page names the real blocker');
    assert.match(consent.payload, /admin has to approve Helmian/, 'in plain words');
    assert.match(consent.payload, /login\.microsoftonline\.com\/organizations\/adminconsent\?client_id=ms-dummy-id/, 'the approval road itself rides the page');
    assert.match(consent.payload, /nothing was connected/i, 'honest about the outcome');
    assert.equal(await pendingStore.peek(TENANT, hashOAuthState(state)), null, 'the dead handshake is consumed by the road that acted on it');
    assert.equal(await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-outlook' }), null, 'nothing connected');

    // A different provider's error: the generic page, row intact.
    await pendingStore.save(TENANT, {
      stateHash: hashOAuthState('gh-state'), personId: PERSON, seatId: 'claude', entryId: 'helmian-github',
      provider: 'github', clientId: 'gh-id', codeVerifier: 'v', redirectUri: CALLBACK, scopes: [],
    });
    const generic = await h.get('/api/admin/connector-library/oauth/callback?error=access_denied&state=gh-state');
    assert.match(generic.payload, /That sign-in did not land/);
    assert.doesNotMatch(generic.payload, /adminconsent/, 'no Microsoft road on another provider\u2019s error');
    const stillThere = await pendingStore.peek(TENANT, hashOAuthState('gh-state'));
    assert.ok(stillThere, 'the other provider\u2019s handshake row was NOT consumed');
  });
});

// ---------------------------------------------------------- arming

test('arming: a sibling member arms from the family\u2019s one connection — the resolve presents the physical member\u2019s provider id; the refresh leg re-stores under the physical member\u2019s references', async () => {
  const { store } = await makeWorld();
  const landed = await connectFamily(store);
  // Freeze the tool snapshot through a SIBLING key — it lands on
  // the family's one row.
  await store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'chatgpt', entryId: 'helmian-microsoft-teams' }, [
    { name: 'search_chats', description: 'Search chats', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ], PERSON);

  const credentials = fakeCredentials();
  const accessRef = refFor(TENANT, 'claude', 'helmian-onedrive', PERSON, 'access');
  const refreshRef = refFor(TENANT, 'claude', 'helmian-onedrive', PERSON, 'refresh');
  assert.equal(landed.accessTokenRef, accessRef);
  await credentials.storeCredential({
    providerId: 'connector.claude.helmian-onedrive', credentialReference: accessRef,
    credentialKind: 'oauth_bundle', accessToken: 'at-live', refreshToken: 'rt-live', tokenType: 'Bearer',
  });
  await credentials.storeCredential({
    providerId: 'connector.claude.helmian-onedrive', credentialReference: refreshRef,
    credentialKind: 'oauth_bundle', accessToken: 'at-live', refreshToken: 'rt-live', tokenType: 'Bearer',
  });
  credentials.calls.length = 0;

  const arm = (seatId, entryId) => resolveArmingRecord({
    store, credentials,
    listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
    operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId, entryId,
  });

  const armed = await arm('grok', 'helmian-microsoft-teams');
  assert.equal(armed.state, 'connected', 'the sibling member arms');
  assert.equal(armed.accessToken, 'at-live', 'the token is the family connection\u2019s token');
  const resolves = credentials.calls.filter(([n]) => n === 'resolveVaultCredential');
  assert.ok(resolves.length >= 1 && resolves.every(([, p]) => p === 'connector.claude.helmian-onedrive'),
    'every resolve presented the PHYSICAL member\u2019s provider id — the sibling\u2019s id holds no vault row and would have missed');

  // Refresh leg: the access resolve now misses (an expired token
  // the vault no longer answers for), the refresh reference
  // resolves, and the microsoft client renews. The renewed pair
  // must be re-stored under references minted with the PHYSICAL
  // member's entry id.
  credentials.records.delete(`connector.claude.helmian-onedrive|${accessRef}`);
  credentials.calls.length = 0;
  const renewed = await resolveArmingRecord({
    store, credentials,
    listTools: async () => { throw new Error('listTools tripwire'); },
    operatorTokens: {}, toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId: 'chatgpt', entryId: 'helmian-outlook',
    oauthClientFor: (provider) => (provider === 'microsoft'
      ? { provider: 'microsoft', clientId: 'ms-dummy-id', refreshTokens: async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', tokenType: 'Bearer', expiresIn: 3599 }) }
      : null),
  });
  assert.equal(renewed.accessToken, 'at-new', 'the renewed token arms the turn');
  const restores = credentials.calls.filter(([n]) => n === 'storeCredential').map(([, p, r]) => `${p}|${r}`);
  assert.ok(restores.length >= 2 && restores.every((k) => k.startsWith('connector.claude.helmian-onedrive|vault://tenant/tenant-a/connector.claude.helmian-onedrive/')),
    'the renewed pair was re-stored under the physical member\u2019s provider id and references');
  const after = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-sharepoint' });
  assert.equal(after.accessTokenRef, accessRef, 'the reference family is unchanged — the renewal replaced the credential under the same address');
});

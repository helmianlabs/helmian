// Workspace SET projection (2026-11-10 defect fix) — the panel
// defect: on a seat the catalog stocks only a subset of the
// brokered entries on (Gemini stocks Weather and the native
// GitHub entry, not the brokered set), the workspace set's rows
// were ABSENT — not "not connected", absent — because the set
// shares connection STATE by entry id (SYNC S1) while a seat's
// library listed only the entries its catalog stocks, so the
// read had no row on that seat to join the set's state onto.
//
// Exercised here on the REAL paths, production-shaped, with the
// entry stocked on ONE seat only (the production shape):
//   · the real connector library store (connector-library.mjs)
//     over the same in-memory fake pool pattern as
//     connector-workspace-set.test.mjs (the sql/074 tables);
//   · the real library read (connector-library-read.mjs) — the
//     row read and the Level 1 counts read;
//   · the real tool-access read (productionToolAccess,
//     connector-library-read-route.mjs);
//   · the real write handler (connect / disconnect) and the real
//     arming dispatch (resolveArmingRecord) — a disconnect and an
//     arm addressed through the seat that does NOT stock the
//     entry must resolve the set's row, never refuse it.
// The fake credential service is shaped like the real vault
// (records keyed (provider_id, credential_reference)).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectorLibraryStore,
  buildConnectorTokenRef,
  effectiveToolAnnotation,
} from '../src/cloud/connector-library.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import * as readRouteModule from '../src/cloud/connector-library-read-route.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';

// The tool-access read: the route's own productionToolAccess,
// exported by this bite so the real read is exercised. On the
// pre-bite base the same function exists unexported; the fallback
// below is its base body verbatim (store built from the pool
// there, injected here) so the sync assertions — not an import
// error — are what fail on the base.
const productionToolAccess = readRouteModule.productionToolAccess
  ?? (async (tenantId, { personId, seatId, entryId }, store) => {
    const connection = await store.getConnection(tenantId, { personId, seatId, entryId });
    if (!connection || connection.state === 'disconnected') {
      return { connected: false, posture: null, tools: [], snapshotTakenAt: null, snapshotHash: null };
    }
    const snapshot = await store.getCurrentSnapshot(tenantId, { personId, seatId, entryId });
    const enableMap = connection.toolEnableMap ?? {};
    return {
      connected: connection.state === 'connected',
      posture: connection.posture ?? null,
      tools: (snapshot?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        annotation: tool.annotation,
        effectiveAnnotation: effectiveToolAnnotation(tool.annotation),
        enabled: enableMap[tool.name] !== false,
      })),
      snapshotTakenAt: snapshot?.takenAt ?? null,
      snapshotHash: snapshot?.snapshotHash ?? null,
    };
  });

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';
const SUBJECT = PERSON;
const ENTRY_ID = 'sync-header-svc';
const VENDOR_ENTRY_ID = 'sync-vendor';
const KEY_VALUE = 'sk-sync-1234567890';

const TOOLS = [
  { name: 'lookup', description: 'Look a record up', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'update_record', description: 'Change a record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];

// ---------------------------------------------------------------- fake pool
// Simulates the sql/074 tables with a monotonic clock, so every
// write stamps a strictly newer updated_at (the collapse rule's
// input). seedConnection / seedSnapshot plant rows with explicit
// timestamps for the collapse tests.
function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  const mirrors = new Map();
  const queries = [];
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  let tick = 0;
  const now = () => new Date(1_700_000_000_000 + (++tick) * 60_000);
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;

  return {
    queries,
    seedConnection(row) {
      const full = {
        id: ++connSeq, tenant_id: tenant ?? TENANT, person_id: PERSON, seat_id: 'claude', entry_id: ENTRY_ID,
        account_identity: 'Seeded account', access_token_ref: null, refresh_token_ref: null,
        granted_scopes: [], posture: 'ask', tool_enable_map: {}, tool_snapshot_ref: null,
        state: 'connected', last_discovery_at: null, last_used_at: null,
        created_at: now(), updated_at: now(), ...row,
      };
      connections.set(connKey(full.person_id, full.seat_id, full.entry_id), full);
      return full;
    },
    seedSnapshot({ connection_id, tools, snapshot_hash = 'seeded-hash' }) {
      const row = { id: ++snapSeq, tenant_id: tenant ?? TENANT, connection_id, taken_at: now(), tools, snapshot_hash };
      snapshots.set(row.id, row);
      return row;
    },
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
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
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            entries.delete(entryKey(vals[0], vals[1]));
            for (const [k, c] of connections) if (c.seat_id === vals[0] && c.entry_id === vals[1] && c.tenant_id === tenant) connections.delete(k);
            for (const [k, m] of mirrors) if (m.seat_id === vals[0] && m.entry_id === vals[1] && m.tenant_id === tenant) mirrors.delete(k);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries') && text.includes('set state = $3')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            row.state = vals[2]; row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            const [, , name, oneLiner, iconRef, vendorName, trustLabel, category, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary, workspaceProvisioned, installedPath, configSnippetJson, baselineFingerprint] = vals;
            Object.assign(row, {
              name, one_liner: oneLiner, icon_ref: iconRef, vendor_name: vendorName,
              trust_label: trustLabel, category, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              workspace_provisioned: workspaceProvisioned,
              installed_path: installedPath ?? null,
              config_snippet: configSnippetJson ? JSON.parse(configSnippetJson) : null,
              baseline_fingerprint: baselineFingerprint ?? null,
              updated_at: now(),
            });
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('select seat_id, id, kind, broker_mode, state from helmion.connector_entries')) {
            const out = [...entries.values()].filter((r) => r.tenant_id === tenant);
            return { rows: out.map((r) => ({ seat_id: r.seat_id, id: r.id, kind: r.kind, broker_mode: r.broker_mode, state: r.state })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_entries') && text.includes('order by id')) {
            const out = [...entries.values()].filter((r) => r.tenant_id === tenant && r.seat_id === vals[0]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_snapshots
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = { id: ++snapSeq, tenant_id: tenant, connection_id: vals[0], taken_at: now(), tools: JSON.parse(vals[1]), snapshot_hash: vals[2] };
            snapshots.set(row.id, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots') && text.includes('connection_id = $1')) {
            const out = [...snapshots.values()].filter((s) => s.connection_id === vals[0]).sort((a, b) => a.id - b.id);
            return { rows: out.slice(0, 1).map((r) => ({ ...r })), rowCount: out.length ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            const row = snapshots.get(vals[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_connections
          if (text.includes('insert into helmion.connector_connections')) {
            const [personId, seatId, entryId, accountIdentity, accessRef, refreshRef, scopesJson, posture] = vals;
            const row = {
              id: ++connSeq, tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId,
              account_identity: accountIdentity, access_token_ref: accessRef, refresh_token_ref: refreshRef,
              granted_scopes: JSON.parse(scopesJson), posture, tool_enable_map: {}, tool_snapshot_ref: null,
              state: 'connected', last_discovery_at: null, last_used_at: null, created_at: now(), updated_at: now(),
            };
            connections.set(connKey(personId, seatId, entryId), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (!row) return { rows: [], rowCount: 0 };
            if (text.includes("set state = 'disconnected'")) {
              row.state = 'disconnected'; row.access_token_ref = null; row.refresh_token_ref = null; row.tool_snapshot_ref = null;
            } else if (text.includes('set access_token_ref = $4')) {
              row.access_token_ref = vals[3]; row.refresh_token_ref = vals[4];
              row.account_identity = vals[5]; row.granted_scopes = JSON.parse(vals[6]); row.state = 'connected';
            } else if (text.includes('set tool_snapshot_ref = $4')) {
              row.tool_snapshot_ref = vals[3]; row.last_discovery_at = now(); row.tool_enable_map = JSON.parse(vals[4]);
            } else if (text.includes('set tool_enable_map = $4::jsonb')) {
              row.tool_enable_map = JSON.parse(vals[3]);
            } else if (text.includes('set posture = $4')) {
              row.posture = vals[3];
            } else if (text.includes("set state = 'needs-reconnect'")) {
              row.state = 'needs-reconnect';
            } else if (text.includes('set last_used_at = clock_timestamp()')) {
              row.last_used_at = now();
            } else {
              throw new Error(`fake pool: unhandled connection update: ${text}`);
            }
            row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('select seat_id, entry_id, state, updated_at, id from helmion.connector_connections')) {
            const out = [...connections.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0]);
            return { rows: out.map((r) => ({ seat_id: r.seat_id, entry_id: r.entry_id, state: r.state, updated_at: r.updated_at, id: r.id })), rowCount: out.length };
          }
          // The SET read: every physical row for (person, entry), any seat.
          // (The pre-set exact-seat read also names entry_id = $3 —
          // it is told apart by its seat filter, which the set read
          // deliberately does not carry.)
          if (text.includes('from helmion.connector_connections') && text.includes('entry_id = $3') && !text.includes('seat_id = $2')) {
            const out = [...connections.values()]
              .filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.entry_id === vals[2])
              .sort((a, b) => (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          // The SET list: every physical row for the person, any seat, any entry.
          if (text.includes('from helmion.connector_connections') && text.includes('$2::text is not null')) {
            const out = [...connections.values()]
              .filter((r) => r.tenant_id === tenant && r.person_id === vals[0])
              .sort((a, b) => (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0) || (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_connections') && text.includes('order by entry_id')) {
            const out = [...connections.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.seat_id === vals[1]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_mirrors
          if (text.includes('insert into helmion.connector_mirrors')) {
            const [personId, seatId, entryId, reportedState, reportedAccount, reportedAt] = vals;
            const key = connKey(personId, seatId, entryId);
            const existing = mirrors.get(key);
            const row = existing ?? { tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId, created_at: now() };
            row.reported_state = reportedState;
            row.reported_account_identity = reportedAccount;
            row.reported_at = reportedAt ? new Date(reportedAt) : now();
            row.updated_at = now();
            mirrors.set(key, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('select seat_id, entry_id, reported_state from helmion.connector_mirrors')) {
            const out = [...mirrors.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0]);
            return { rows: out.map((r) => ({ seat_id: r.seat_id, entry_id: r.entry_id, reported_state: r.reported_state })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_mirrors') && text.includes('order by entry_id')) {
            const out = [...mirrors.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.seat_id === vals[1]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_mirrors')) {
            const row = mirrors.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          throw new Error(`fake pool: unhandled query: ${text}`);
        },
        release() {},
      };
    },
  };
}

// ------------------------------------------------- fake credential service
// Shaped like the real vault's keying: a record exists only under
// the exact (provider_id, credential_reference) it was stored
// with. Resolves and revokes addressed anywhere else miss.
function fakeCredentials() {
  const vault = new Map();
  const calls = [];
  const keyOf = (providerId, ref) => `${providerId}|${ref}`;
  return {
    vault, calls,
    async storeCredential(input) {
      calls.push(['storeCredential', input.providerId, input.credentialReference]);
      vault.set(keyOf(input.providerId, input.credentialReference), { ...input });
      return { accepted: true, status: 'stored_in_credential_vault' };
    },
    async resolveVaultCredential(input) {
      calls.push(['resolveVaultCredential', input.providerId, input.credentialReference]);
      const rec = vault.get(keyOf(input.providerId, input.credentialReference));
      if (!rec) return { accepted: false, status: 'credential_not_available' };
      return { accepted: true, credential: { accessToken: rec.apiKey ?? rec.accessToken, refreshToken: rec.refreshToken ?? null } };
    },
    async revokeVaultCredential(input) {
      calls.push(['revokeVaultCredential', input.providerId, input.credentialReference]);
      const existed = vault.delete(keyOf(input.providerId, input.credentialReference));
      return { accepted: existed, status: existed ? 'revoked' : 'credential_not_available' };
    },
  };
}

class TenantAuthorizationError extends Error {}

const headerEntry = (seatId, over = {}) => ({
  seatId, id: ENTRY_ID, kind: 'catalog', name: 'Sync Header Service',
  oneLiner: 'The set-sync proof entry', vendorName: 'Sync Co', trustLabel: 'verified',
  category: 'productivity', brokerMode: 'helmian',
  mcpEndpointUrl: 'https://sync.example.com/mcp', authMode: 'header',
  scopesSummary: 'Reads and writes records', addedBy: 'system', ...over,
});
const vendorEntry = (seatId) => ({
  seatId, id: VENDOR_ENTRY_ID, kind: 'catalog', name: 'Sync Vendor Mirror',
  oneLiner: 'A vendor-brokered mirror', vendorName: 'Sync Co', trustLabel: 'verified',
  category: 'productivity', brokerMode: 'vendor',
  vendorConnectorRef: { ref: 'vendor:sync', manageUrl: 'https://vendor.example.com/manage' },
  authMode: 'oauth', addedBy: 'system',
});

function makeWorld() {
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  const credentials = fakeCredentials();
  const read = createSeatLibraryRead({ libraryStore: store });
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: null,
    credentialClient: credentials,
    oauthClientFor: () => null,
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const actor = { subject: PERSON, tenantId: TENANT, role: 'owner', sessionId: 'sess-1', requestId: 'req-1' };
  const runWrite = async (action, body, asActor = actor) => {
    const sent = [];
    const handled = await handler({
      request: { method: 'POST' },
      response: {},
      requestUrl: new URL(`/api/admin/connector-library/${action}`, 'https://helmian.cloud'),
      activeTenantActor: async () => asActor,
      send: (response, status, payload) => { sent.push({ status, payload }); },
      TenantAuthorizationError,
      readJson: async () => body,
    });
    const last = sent[sent.length - 1];
    return { handled, status: last?.status, json: last ? JSON.parse(last.payload) : null };
  };
  const arm = (seatId, personId = PERSON, tenantId = TENANT) => resolveArmingRecord({
    store,
    credentials,
    listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
    operatorTokens: {},
    toolConnections: null,
    tenantId, personId, seatId, entryId: ENTRY_ID,
  });
  const rowFor = async (seatId, personId = PERSON, tenantId = TENANT) => {
    const view = await read.readSeatLibrary(tenantId, { personId, seatId });
    return view.rows.find((r) => r.entryId === ENTRY_ID) ?? null;
  };
  return { pool, store, credentials, read, runWrite, arm, rowFor, actor };
}

const refFor = (seatId, tokenKind = 'access') =>
  buildConnectorTokenRef({ tenantId: TENANT, seatId, entryId: ENTRY_ID, personId: PERSON, tokenKind });

// ============================================================ the defect
// The entry is stocked on ONE seat only (claude) — the production
// shape for the brokered set on Gemini, whose catalog stocks
// Weather and the native GitHub entry but not Notion / Vercel.
test('SET PROJECTION — a brokered entry stocked on one seat only carries its set row to a seat that does not stock it', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));

  // Before any connection, the unstocked seat has no row: the
  // projection is the SET's, not the catalog's — nothing to join.
  const before = await w.store.listEntries(TENANT, 'gemini', { personId: PERSON });
  assert.equal(before.find((e) => e.id === ENTRY_ID), undefined, 'no connection yet: no projected row');

  // Connect on the stocked seat through the real write handler.
  const start = await w.runWrite('connect', { seatId: 'claude', entryId: ENTRY_ID });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, 'needs-credential');
  const expectedRef = refFor('claude');
  const landed = await w.runWrite('connect/header', {
    seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read',
  });
  assert.equal(landed.status, 201);
  await w.store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, TOOLS, SUBJECT);

  // The store's entry list for the unstocked seat now carries the
  // entry: this seat's view of the physical record on the set
  // winner's seat, the road and the provenance named on it.
  const listed = await w.store.listEntries(TENANT, 'gemini', { personId: PERSON });
  const projected = listed.find((e) => e.id === ENTRY_ID);
  assert.ok(projected, 'the unstocked seat’s entry list carries the set’s entry');
  assert.equal(projected.seatId, 'gemini', 'the projected view answers in the requesting seat’s name');
  assert.equal(projected.workspaceSet, true, 'the projection is named on the record');
  assert.equal(projected.provenanceSeatId, 'claude', 'provenance is the seat the record lives on');
  assert.equal(projected.name, 'Sync Header Service');

  // The single-entry read resolves it there too (the arming
  // dispatch’s road — it refused 'unknown-entry' here before).
  const entry = await w.store.getEntry(TENANT, 'gemini', ENTRY_ID, { personId: PERSON });
  assert.ok(entry, 'getEntry resolves the set’s entry on the unstocked seat');
  assert.equal(entry.id, ENTRY_ID);

  // The set’s connection lists and reads from the unstocked seat.
  const connections = await w.store.listConnections(TENANT, { personId: PERSON, seatId: 'gemini' });
  const listedConnection = connections.find((c) => c.entryId === ENTRY_ID);
  assert.ok(listedConnection, 'listConnections carries the set’s row to the unstocked seat');
  assert.equal(listedConnection.state, 'connected');
  const connection = await w.store.getConnection(TENANT, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID });
  assert.ok(connection, 'getConnection resolves from the unstocked seat');
  assert.equal(connection.state, 'connected');
  assert.equal(connection.accountIdentity, 'Sync account');
  assert.equal(connection.posture, 'read');

  // The panel’s row read: the row EXISTS on the unstocked seat,
  // with the set’s shared state — the defect’s exact shape.
  const row = await w.rowFor('gemini');
  assert.ok(row, 'the row read carries the row on the unstocked seat');
  assert.equal(row.state, 'connected', 'the row reads the set’s shared state');
  assert.equal(row.accountIdentity, 'Sync account');
  assert.equal(row.stateDetail.posture, 'read');
  assert.equal(row.workspaceSet, true, 'the row names the projection');
  assert.equal(row.provenanceSeatId, 'claude');

  // The Level 1 counts agree with the row read for that seat.
  const counts = await w.read.readSeatCounts(TENANT, { personId: PERSON });
  const geminiCounts = counts.seats.find((s) => s.seatId === 'gemini');
  const geminiView = await w.read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini' });
  assert.ok(geminiCounts, 'the counts read lists the unstocked seat');
  assert.equal(geminiCounts.entryCount, geminiView.rows.length, 'counts entryCount is the row read’s rows counted');
  assert.equal(geminiCounts.connectedCount, geminiView.connectedCount, 'counts connectedCount is the row read’s connected rows counted');
  assert.ok(geminiCounts.connectedCount >= 1, 'the set’s connection counts on the unstocked seat');

  // Tool access and arming resolve through the unstocked seat.
  const access = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID }, w.store);
  assert.equal(access.connected, true, 'tool-access read from the unstocked seat: connected');
  assert.equal(access.posture, 'read');
  assert.deepEqual(access.tools.map((t) => t.name), ['lookup', 'update_record'], 'tool-access reads the set’s frozen snapshot');
  const armed = await w.arm('gemini');
  assert.equal(armed.state, 'connected', 'arming from the unstocked seat resolves the set’s record');
  assert.equal(armed.accessToken, KEY_VALUE, 'arming resolves the credential stored on the stocked seat');

  // Disconnect addressed through the unstocked seat lands on the
  // set’s row: the connection reads disconnected everywhere, and
  // the row stays on the unstocked seat — listed, not connected,
  // so it can be reconnected from there.
  const gone = await w.runWrite('disconnect', { seatId: 'gemini', entryId: ENTRY_ID });
  assert.equal(gone.status, 200, 'disconnect through the unstocked seat is answered, not refused');
  assert.equal(gone.json.connection.state, 'disconnected');
  assert.deepEqual(gone.json.revokedRefs, [expectedRef], 'disconnect revokes the set row’s references');
  const rowAfter = await w.rowFor('gemini');
  assert.ok(rowAfter, 'the row stays listed on the unstocked seat after disconnect');
  assert.equal(rowAfter.state, 'not-connected', 'the shared state after disconnect is not-connected there too');
  assert.equal(rowAfter.workspaceSet, true);
  const rowStocked = await w.rowFor('claude');
  assert.equal(rowStocked.state, 'not-connected', 'and on the stocked seat');
});

// ============================================================ the walls
test('SET PROJECTION walls — another person, another tenant, and vendor mirrors never project', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  await w.store.createEntry(TENANT, SUBJECT, vendorEntry('claude'));
  const start = await w.runWrite('connect', { seatId: 'claude', entryId: ENTRY_ID });
  assert.equal(start.json.status, 'needs-credential');
  await w.runWrite('connect/header', { seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account' });
  await w.store.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: VENDOR_ENTRY_ID, reportedState: 'connected',
    reportedAccountIdentity: 'troy@example.com',
  });

  // Another person: nothing of the set reaches their library on
  // any seat — no row, no entry, no connection.
  const strangerListed = await w.store.listEntries(TENANT, 'gemini', { personId: OTHER_PERSON });
  assert.equal(strangerListed.find((e) => e.id === ENTRY_ID), undefined, 'another person: no projected entry');
  assert.equal(await w.store.getEntry(TENANT, 'gemini', ENTRY_ID, { personId: OTHER_PERSON }), null, 'another person: getEntry stays absent');
  assert.equal(await w.store.getConnection(TENANT, { personId: OTHER_PERSON, seatId: 'gemini', entryId: ENTRY_ID }), null, 'another person: no connection');
  const strangerView = await w.read.readSeatLibrary(TENANT, { personId: OTHER_PERSON, seatId: 'gemini' });
  assert.equal(strangerView.rows.find((r) => r.entryId === ENTRY_ID), undefined, 'another person: no row');

  // A vendor entry is a mirror, never a connection: a connected
  // mirror report on the stocked seat does not project the entry
  // onto a seat that does not stock it.
  const listed = await w.store.listEntries(TENANT, 'gemini', { personId: PERSON });
  assert.equal(listed.find((e) => e.id === VENDOR_ENTRY_ID), undefined, 'vendor mirror entries never project');
  const view = await w.read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini' });
  assert.equal(view.rows.find((r) => r.entryId === VENDOR_ENTRY_ID), undefined, 'no vendor row appears on the unstocked seat');

  // Another tenant: the same person id in another workspace sees
  // none of this tenant’s set.
  const otherTenantListed = await w.store.listEntries(TENANT_B, 'gemini', { personId: PERSON });
  assert.equal(otherTenantListed.find((e) => e.id === ENTRY_ID), undefined, 'another tenant: no projected entry');
  assert.equal(await w.store.getConnection(TENANT_B, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID }), null, 'another tenant: no connection');

  // And without a person the physical list is exactly as before:
  // the projection is a person-scoped read, never a stocking.
  const physical = await w.store.listEntries(TENANT, 'gemini');
  assert.equal(physical.find((e) => e.id === ENTRY_ID), undefined, 'no person: the physical list is untouched');
});

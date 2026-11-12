// Tool-access route proof (2026-11-10, Defect 2) — the panel
// defect: in Claude's panel, Tool access → a connected entry
// showed "Loading tool access..." and then "Tool access could
// not be loaded. Try again.", deterministically. That wording
// is painted only when the face's GET throws — a non-200 from
// GET /api/admin/connector-library/tool-access (the face's
// loadToolAccess over the workspace's own api road;
// envoy-workspace.js refreshToolAccess sets the error only in
// its catch).
//
// This file drives the REAL road end to end, production-shaped:
//   · the real route handler (handleConnectorLibraryRoute,
//     connector-library-read-route.mjs) — the branch had NO
//     route-level test before this file (the route suite covers
//     the seats and library branches only);
//   · the route's own production read (productionToolAccess)
//     over the real store (connector-library.mjs) on the
//     established fake-pool pattern — injected into the handler
//     exactly as its toolAccess seam allows, the same shape the
//     production default builds from the route's pool;
//   · the walked shape: the entry stocked and connected on
//     Claude, the read asked from Claude.
// Plus the answer shapes around it: an unconnected entry is a
// 200 that reads connected:false (the face's "Connect first",
// NOT the error), a missing seat/entry is a 400, an authority
// selector is a 400, a POST is a 405, a refused actor is a 403
// membership answer, and the uninjected production default —
// with no database configured — maps its failure to the named
// 503 CONNECTOR_LIBRARY_READ_FAILED (the shape a live failure
// of this read carries; see this bite's REPORT).

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

import { handleConnectorLibraryRoute } from '../src/cloud/connector-library-read-route.mjs';

// The route runner: the real handler, an actor stub, and a send
// capture — the delegate's own call shape (envoy-ably.mjs).
function runRoute(w, { url, method = 'GET', actor = null, toolAccess } = {}) {
  const sent = [];
  return handleConnectorLibraryRoute({
    request: { method },
    response: {},
    requestUrl: new URL(url, 'https://helmian.cloud'),
    activeTenantActor: actor ?? (async () => w.actor),
    send: (response, status, payload) => { sent.push({ status, payload }); },
    TenantAuthorizationError,
    ...(toolAccess !== undefined ? { toolAccess } : {}),
  }).then((handled) => {
    const last = sent[sent.length - 1];
    return { handled, status: last?.status, json: last ? JSON.parse(last.payload) : null };
  });
}

// The route's production read, built exactly as production
// builds it — productionToolAccess over a store — with the
// store injected through the function's own third parameter.
const productionReadFor = (w) => (tenantId, key) => productionToolAccess(tenantId, key, w.store);

async function connectedWorld() {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  const landed = await w.runWrite('connect/header', {
    seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read',
  });
  assert.equal(landed.status, 201);
  await w.store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, TOOLS, SUBJECT);
  return w;
}

test('TOOL-ACCESS ROUTE — the walked shape answers 200 with the connection’s posture and frozen tools', async () => {
  const w = await connectedWorld();
  const out = await runRoute(w, {
    url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}`,
    toolAccess: productionReadFor(w),
  });
  assert.equal(out.handled, true);
  assert.equal(out.status, 200);
  assert.equal(out.json.valid, true);
  assert.equal(out.json.seatId, 'claude');
  assert.equal(out.json.entryId, ENTRY_ID);
  assert.equal(out.json.connected, true);
  assert.equal(out.json.posture, 'read');
  assert.deepEqual(out.json.tools.map((t) => [t.name, t.enabled]), [['lookup', true], ['update_record', true]]);
  assert.ok(out.json.snapshotHash, 'the frozen snapshot’s hash rides the answer');
});

test('TOOL-ACCESS ROUTE — an unconnected entry answers 200 connected:false (the face’s "Connect first", never the error)', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  const out = await runRoute(w, {
    url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}`,
    toolAccess: productionReadFor(w),
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.connected, false);
  assert.equal(out.json.posture, null);
  assert.deepEqual(out.json.tools, []);
});

test('TOOL-ACCESS ROUTE — the refusal shapes around the read', async () => {
  const w = await connectedWorld();
  const missing = await runRoute(w, {
    url: '/api/admin/connector-library/tool-access?seat=claude',
    toolAccess: productionReadFor(w),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'CONNECTOR_LIBRARY_TOOL_ACCESS_INVALID');

  const selector = await runRoute(w, {
    url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}&personId=user:mallory`,
    toolAccess: productionReadFor(w),
  });
  assert.equal(selector.status, 400);
  assert.equal(selector.json.code, 'CONNECTOR_LIBRARY_SELECTOR_INVALID');

  const posted = await runRoute(w, {
    url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}`,
    method: 'POST',
    toolAccess: productionReadFor(w),
  });
  assert.equal(posted.status, 405);

  const refused = await runRoute(w, {
    url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}`,
    actor: async () => { throw new TenantAuthorizationError('not a member'); },
    toolAccess: productionReadFor(w),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED');
});

test('TOOL-ACCESS ROUTE — the uninjected production default maps a dead database road to the named 503', async () => {
  const w = await connectedWorld();
  const saved = process.env.HELMION_DATABASE_URL;
  delete process.env.HELMION_DATABASE_URL;
  try {
    const out = await runRoute(w, {
      url: `/api/admin/connector-library/tool-access?seat=claude&entry=${ENTRY_ID}`,
    });
    assert.equal(out.status, 503);
    assert.equal(out.json.code, 'CONNECTOR_LIBRARY_READ_FAILED',
      'a production read failure carries this code — the answer a live walk of this defect would have received');
  } finally {
    if (saved !== undefined) process.env.HELMION_DATABASE_URL = saved;
  }
});

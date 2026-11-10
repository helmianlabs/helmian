// Workspace connector SET (SYNC S1) — the headline proof.
//
// Troy's design: set a service up once on ONE agent and the system
// syncs that set to every other agent in the workspace; a new agent
// inherits the set. What syncs is the SET — which services, their
// posture/settings — for the same person's workspace; each agent
// works through the person's own stored credentials via the
// existing roads.
//
// Exercised here on the REAL paths, production-shaped:
//   · the real connector library store (connector-library.mjs)
//     over an in-memory fake pool that simulates the sql/074 tables
//     (the repo's established pattern), including the store's SET
//     COLLAPSE RULE over pre-existing per-seat rows;
//   · the real write handler (connector-library-write-route.mjs) —
//     connect / posture / tool-enable / disconnect all land through
//     it, on whichever seat the action names;
//   · the real library read (connector-library-read.mjs) and the
//     real tool-access read (productionToolAccess,
//     connector-library-read-route.mjs);
//   · the real arming dispatch (resolveArmingRecord,
//     connector-arming-dispatch.mjs).
// The only fake besides the pool is the credential service, and it
// is shaped like the real vault: records keyed (provider_id,
// credential_reference), so a resolve or revoke addressed under
// the WRONG seat's provider id misses — exactly as the real vault
// (credential-vault.mjs: rows keyed (tenant_id, provider_id,
// credential_reference), provider id bound into the encryption)
// would miss. The provider network edge is never reached: the
// entry's snapshot is frozen from a local tool list, and arming's
// listTools is a tripwire that fails the record if it is called.

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

// =============================================== the headline flow (1–5)
test('SYNC S1 — connect on seat A syncs the set to seat B, a fresh seat inherits it, disconnect on B removes it everywhere', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('gemini'));

  // (1) Connect on seat A (claude) through the real write handler:
  // the header road — the one road that stores a credential
  // reference — with a posture set at connect time.
  const start = await w.runWrite('connect', { seatId: 'claude', entryId: ENTRY_ID });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, 'needs-credential');
  const expectedRef = refFor('claude');
  assert.equal(start.json.accessTokenRef, expectedRef, 'the connect start mints the reference for the connecting seat');

  const landed = await w.runWrite('connect/header', {
    seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read',
  });
  assert.equal(landed.status, 201);
  assert.equal(landed.json.connection.seatId, 'claude', 'the connecting seat is the record’s provenance');
  assert.equal(landed.json.connection.accessTokenRef, expectedRef);
  assert.equal(landed.json.connection.posture, 'read');
  // The key itself went to the credential service under that
  // reference and the connecting seat's provider id — nowhere else.
  assert.deepEqual(w.credentials.calls.filter(([n]) => n === 'storeCredential'),
    [['storeCredential', 'connector.claude.sync-header-svc', expectedRef]]);

  // Freeze the tool snapshot on seat A (the frozen set is part of
  // the set: same snapshot, same tool settings, on every seat).
  await w.store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, TOOLS, SUBJECT);

  // (2) WITHOUT touching seat B: seat B reads the set.
  const rowB = await w.rowFor('gemini');
  assert.equal(rowB.state, 'connected', 'seat B library read: connected');
  assert.equal(rowB.accountIdentity, 'Sync account', 'seat B library read: same account label');
  assert.equal(rowB.stateDetail.posture, 'read', 'seat B library read: same posture');

  const accessA = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, w.store);
  const accessB = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID }, w.store);
  assert.equal(accessB.connected, true, 'seat B tool-access read: connected');
  assert.equal(accessB.posture, 'read', 'seat B tool-access read: same posture');
  assert.equal(accessB.snapshotHash, accessA.snapshotHash, 'tool-access: same frozen snapshot on both seats');
  assert.deepEqual(accessB.tools.map((t) => [t.name, t.enabled]), [['lookup', true], ['update_record', true]], 'tool-access: same snapshot tools');

  // The Level 1 counts read agrees: gemini's connected count is
  // its row read's connected count (the counts join is set-based).
  const counts = await w.read.readSeatCounts(TENANT, { personId: PERSON });
  const geminiCounts = counts.seats.find((s) => s.seatId === 'gemini');
  const geminiView = await w.read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini' });
  assert.equal(geminiCounts.connectedCount, geminiView.connectedCount, 'counts read and row read agree for seat B');

  // Arming for seat B returns the set's record carrying the SAME
  // credential reference — and the resolve actually lands, because
  // dispatch presents the provenance seat's provider id to the
  // vault-shaped credential service.
  const armedB = await w.arm('gemini');
  assert.equal(armedB.state, 'connected', 'seat B arms from the set');
  assert.equal(armedB.accountIdentity, 'Sync account');
  assert.equal(armedB.posture, 'read');
  assert.equal(armedB.accessToken, KEY_VALUE, 'seat B’s turn resolves the credential stored on seat A');
  assert.equal(armedB.tokenSource, 'connection');
  assert.deepEqual(armedB.snapshotTools.map((t) => t.name), ['lookup', 'update_record']);
  const resolveCalls = w.credentials.calls.filter(([n]) => n === 'resolveVaultCredential');
  assert.equal(resolveCalls.at(-1)[1], 'connector.claude.sync-header-svc', 'the resolve presents the PROVENANCE seat’s provider id');
  assert.equal(resolveCalls.at(-1)[2], expectedRef, 'the resolve carries the SAME credential reference');

  // (3) Change the posture via seat B → seat A reads the new one.
  const moved = await w.runWrite('posture', { seatId: 'gemini', entryId: ENTRY_ID, posture: 'low-risk' });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.connection.posture, 'low-risk');
  assert.equal(moved.json.connection.seatId, 'claude', 'the write landed on the set’s row — provenance unchanged');
  const rowA2 = await w.rowFor('claude');
  assert.equal(rowA2.stateDetail.posture, 'low-risk', 'seat A library read shows the posture set via seat B');

  // A tool-enable write via seat B lands on the same set row.
  const toolMoved = await w.runWrite('tool-enable', { seatId: 'gemini', entryId: ENTRY_ID, toolEnableMap: { lookup: false } });
  assert.equal(toolMoved.status, 200);
  const accessA2 = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, w.store);
  assert.equal(accessA2.tools.find((t) => t.name === 'lookup').enabled, false, 'seat A tool-access shows the tool setting written via seat B');
  assert.equal(accessA2.posture, 'low-risk');

  // (4) A fresh seat id — no connection rows of its own, ever —
  // reads and arms the set identically on first contact.
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('freshseat'));
  const rowF = await w.rowFor('freshseat');
  assert.equal(rowF.state, 'connected', 'fresh seat library read: connected from the set');
  assert.equal(rowF.accountIdentity, 'Sync account');
  assert.equal(rowF.stateDetail.posture, 'low-risk');
  const armedF = await w.arm('freshseat');
  assert.equal(armedF.state, 'connected', 'fresh seat arms from the set');
  assert.equal(armedF.accessToken, KEY_VALUE);
  assert.deepEqual(armedF.toolEnableMap, { lookup: false, update_record: true }, 'fresh seat arms with the set’s tool settings');

  // (5) Disconnect via seat B → the set is disconnected everywhere.
  const gone = await w.runWrite('disconnect', { seatId: 'gemini', entryId: ENTRY_ID });
  assert.equal(gone.status, 200);
  assert.equal(gone.json.connection.state, 'disconnected');
  assert.deepEqual(gone.json.revokedRefs, [expectedRef], 'disconnect revokes the set row’s references');
  const revokeCalls = w.credentials.calls.filter(([n]) => n === 'revokeVaultCredential');
  assert.deepEqual(revokeCalls, [['revokeVaultCredential', 'connector.claude.sync-header-svc', expectedRef]],
    'the revoke addressed the vault record under the PROVENANCE provider id — a seat-B provider id would have missed and refused the disconnect');
  assert.equal(w.credentials.vault.size, 0, 'the stored credential is revoked');

  const rowA3 = await w.rowFor('claude');
  assert.equal(rowA3.state, 'not-connected', 'seat A library read: not-connected after seat B’s disconnect');
  const armedA = await w.arm('claude');
  assert.equal(armedA.state, 'disconnected', 'arming for seat A refuses: the set’s connection is disconnected');
});

// ======================================================= the walls (6)
test('SYNC S1 walls — another person, another tenant, mirrors, and the agent accounts are untouched', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('gemini'));
  await w.store.createEntry(TENANT, SUBJECT, vendorEntry('claude'));
  await w.store.createEntry(TENANT, SUBJECT, vendorEntry('gemini'));
  await w.store.createEntry(TENANT_B, SUBJECT, headerEntry('claude', {}));

  await w.runWrite('connect/header', { seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read' });
  await w.store.freezeSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, TOOLS, SUBJECT);
  await w.store.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: VENDOR_ENTRY_ID, reportedState: 'connected', reportedAccountIdentity: 'troy@vendor.example.com',
  });

  // Wall 1: a different PERSON in the same tenant sees none of it.
  assert.equal(await w.store.getConnection(TENANT, { personId: OTHER_PERSON, seatId: 'gemini', entryId: ENTRY_ID }), null);
  const rowOther = await w.rowFor('gemini', OTHER_PERSON);
  assert.equal(rowOther.state, 'not-connected', 'other person: library read shows not-connected');
  const accessOther = await productionToolAccess(TENANT, { personId: OTHER_PERSON, seatId: 'gemini', entryId: ENTRY_ID }, w.store);
  assert.equal(accessOther.connected, false, 'other person: tool-access shows not connected');
  assert.equal((await w.arm('gemini', OTHER_PERSON)).state, 'not-connected', 'other person: arming refuses');

  // Wall 2: a different TENANT sees none of it.
  assert.equal(await w.store.getConnection(TENANT_B, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }), null);
  const viewB = await w.read.readSeatLibrary(TENANT_B, { personId: PERSON, seatId: 'claude' });
  assert.equal(viewB.rows.find((r) => r.entryId === ENTRY_ID).state, 'not-connected', 'other tenant: library read shows not-connected');
  assert.equal((await w.arm('claude', PERSON, TENANT_B)).state, 'not-connected', 'other tenant: arming refuses');

  // Wall 3: mirror rows are untouched by the set — a mirror
  // reported on seat A does NOT appear on seat B, and the set's
  // disconnect on the helmian entry leaves the mirror as reported.
  assert.equal(await w.store.getMirror(TENANT, { personId: PERSON, seatId: 'gemini', entryId: VENDOR_ENTRY_ID }), null, 'mirror does not sync across seats');
  assert.deepEqual(await w.store.listMirrors(TENANT, { personId: PERSON, seatId: 'gemini' }), []);
  await w.runWrite('disconnect', { seatId: 'gemini', entryId: ENTRY_ID });
  const mirrorAfter = await w.store.getMirror(TENANT, { personId: PERSON, seatId: 'claude', entryId: VENDOR_ENTRY_ID });
  assert.equal(mirrorAfter.reportedState, 'connected', 'the mirror row stands exactly as reported');
  assert.equal(mirrorAfter.reportedAccountIdentity, 'troy@vendor.example.com');

  // Wall 4: a seat that does not CARRY the entry shows nothing of
  // the set — the set joins onto entries a seat's library holds,
  // it does not invent rows on seats that lack the entry.
  assert.equal(await w.store.getConnection(TENANT, { personId: PERSON, seatId: 'neverstocked', entryId: ENTRY_ID }), null);

  // Wall 5: the per-seat AGENT accounts (the AI providers' own
  // logins) are a different system: nothing in this flow read or
  // wrote a provider-connection / agent-account table — the
  // library store's traffic names only its own four tables.
  const touched = new Set(w.pool.queries.flatMap((q) => [...q.text.matchAll(/(?:from|into|update)\s+helmion\.([a-z_]+)/g)].map((m) => m[1])));
  assert.deepEqual([...touched].sort(), ['connector_connections', 'connector_entries', 'connector_mirrors', 'connector_snapshots'],
    'only the connector library’s own tables were touched');
});

// ================================================== the collapse (7)
test('SYNC S1 collapse — pre-existing per-seat rows: the most recently updated row is the set’s row on every road', async () => {
  const w = makeWorld();
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('gemini'));

  const T1 = new Date('2026-11-01T10:00:00.000Z');
  const T2 = new Date('2026-11-05T10:00:00.000Z');
  const oldRef = refFor('claude');
  const newRef = refFor('gemini');
  // Two physical rows for one (person, entry), as production may
  // already hold: claude's older, gemini's newer, different
  // references, different accounts, different postures.
  w.pool.seedConnection({
    seat_id: 'claude', account_identity: 'Old account', access_token_ref: oldRef,
    posture: 'ask', updated_at: T1, created_at: T1,
  });
  const newer = w.pool.seedConnection({
    seat_id: 'gemini', account_identity: 'New account', access_token_ref: newRef,
    posture: 'all', updated_at: T2, created_at: T2,
  });
  const snap = w.pool.seedSnapshot({
    connection_id: newer.id,
    tools: [
      { name: 'lookup', description: 'Look a record up', inputSchemaHash: 'a'.repeat(64), annotation: 'read' },
      { name: 'update_record', description: 'Change a record', inputSchemaHash: 'b'.repeat(64), annotation: 'write' },
    ],
  });
  newer.tool_snapshot_ref = snap.id;
  // The newer row's credential lives under gemini's provider id.
  w.credentials.vault.set(`connector.gemini.sync-header-svc|${newRef}`, { apiKey: KEY_VALUE });

  for (const seatId of ['claude', 'gemini']) {
    const conn = await w.store.getConnection(TENANT, { personId: PERSON, seatId, entryId: ENTRY_ID });
    assert.equal(conn.accountIdentity, 'New account', `${seatId}: getConnection returns the most recent row`);
    assert.equal(conn.accessTokenRef, newRef, `${seatId}: the newer row’s reference wins`);
    assert.equal(conn.posture, 'all');
    assert.equal(conn.seatId, 'gemini', 'the winner’s seat is its provenance');
    const again = await w.store.getConnection(TENANT, { personId: PERSON, seatId, entryId: ENTRY_ID });
    assert.equal(again.id, conn.id, `${seatId}: the collapse is deterministic across reads`);
  }
  const listed = await w.store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' });
  assert.equal(listed.length, 1, 'the set lists ONE row for the entry');
  assert.equal(listed[0].accessTokenRef, newRef);

  const row = await w.rowFor('claude');
  assert.equal(row.state, 'connected');
  assert.equal(row.accountIdentity, 'New account', 'library read shows the winning row’s account');
  assert.equal(row.stateDetail.posture, 'all');

  const access = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, w.store);
  assert.equal(access.posture, 'all', 'tool-access reads the winning row');
  assert.deepEqual(access.tools.map((t) => t.name), ['lookup', 'update_record'], 'tool-access reads the winning row’s snapshot');

  const armed = await w.arm('claude');
  assert.equal(armed.state, 'connected', 'arming resolves the winning row');
  assert.equal(armed.accessToken, KEY_VALUE, 'arming resolves the WINNING row’s credential — the losing row’s reference is never resolved');
  const resolves = w.credentials.calls.filter(([n]) => n === 'resolveVaultCredential');
  assert.ok(resolves.every(([, , ref]) => ref === newRef), 'every resolve carried the winning reference only');
  assert.ok(!w.credentials.vault.has(`connector.claude.sync-header-svc|${oldRef}`), 'the losing row’s credential was never the set’s (it simply is not armed; nothing deleted it)');

  // Determinism under a tie: same updated_at → the higher row id wins.
  const T3 = new Date('2026-11-06T10:00:00.000Z');
  w.pool.seedConnection({ seat_id: 'claude', account_identity: 'Tie A', access_token_ref: oldRef, updated_at: T3, created_at: T3 });
  const tieWinner = w.pool.seedConnection({ seat_id: 'gemini', account_identity: 'Tie B', access_token_ref: newRef, updated_at: T3, created_at: T3 });
  const tied = await w.store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID });
  assert.equal(tied.id, tieWinner.id, 'a tie on updated_at breaks to the higher row id');
  assert.equal(tied.accountIdentity, 'Tie B');
});

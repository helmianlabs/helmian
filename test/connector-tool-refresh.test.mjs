// Tool-refresh review proof (M3 Gate G8, DESIGN §4.1(3)) — the
// Tool access panel's review act, driven on the real roads:
//   · the real write handler (createConnectorLibraryWriteHandler)
//     with the new tool-refresh action — preview lists the
//     server's tools fresh through the file's own roads (the
//     caller's brokered token + the prompts wire client for
//     stocked entries; the gate probe for custom entries) and
//     answers the diff against the frozen snapshot BY NAME,
//     writing nothing; confirm lists again and re-freezes;
//   · the real store (connector-library.mjs) on the established
//     fake-pool pattern (the same fake the tool-access route
//     suite carries), so the freeze's §1.7 merge is the real one;
//   · the real tool-access read (productionToolAccess) for the
//     post-confirm face state, and the real arming dispatch
//     (resolveArmingRecord) for the offerability claim: dispatch
//     reads exactly the snapshot + enable map the refresh writes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorLibraryStore } from '../src/cloud/connector-library.mjs';
import { productionToolAccess } from '../src/cloud/connector-library-read-route.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';

const TENANT = 'tenant-a';
const PERSON = 'user:troy';
const SUBJECT = PERSON;
const ENTRY_ID = 'sync-header-svc';
const VENDOR_ENTRY_ID = 'sync-vendor';
const CUSTOM_ENTRY_ID = 'custom-weather';
const KEY_VALUE = 'sk-sync-1234567890';

// The frozen list (what connect + the first freeze saved).
const TOOLS_V1 = [
  { name: 'lookup', description: 'Look a record up', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'update_record', description: 'Change a record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'archive_record', description: 'Archive a record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];
// The live list after the server drifted: lookup untouched,
// update_record's description changed, delete_record is new,
// archive_record is gone.
const TOOLS_V2 = [
  { name: 'lookup', description: 'Look a record up', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'update_record', description: 'Change a record in place', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'delete_record', description: 'Delete a record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];
const DRIFT_DIFF = { added: ['delete_record'], removed: ['archive_record'], changed: ['update_record'] };

// The custom entry's gate-probe lists: baseline, then drifted.
const GATE_V1 = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set an alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];
const GATE_V2 = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set a weather alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
  { name: 'rain_radar', description: 'Show the rain radar', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
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

// ------------------------------------------------------------- fixtures
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
const customEntry = (seatId, over = {}) => ({
  seatId, id: CUSTOM_ENTRY_ID, kind: 'custom', name: 'Weather', oneLiner: 'Weather tools',
  vendorName: 'Custom', trustLabel: 'custom', category: 'productivity', brokerMode: 'helmian',
  mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'none',
  addedBy: PERSON, ...over,
});

// The prompts wire client fake: the stocked road's listTools.
// Records every call (endpoint + the token it rode on) and
// answers the world's current live list.
function fakePromptsClient(liveTools) {
  const calls = [];
  return {
    calls,
    async listTools({ endpoint, accessToken }) {
      calls.push({ endpoint, accessToken });
      return { supported: true, tools: liveTools };
    },
    async listPrompts() { return { supported: false, prompts: [] }; },
    async getPrompt() { throw new Error('getPrompt is not on the refresh road'); },
  };
}

function makeWorld({ liveTools = TOOLS_V2, gateProbe = null } = {}) {
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  const credentials = fakeCredentials();
  const prompts = fakePromptsClient(liveTools);
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: null,
    credentialClient: credentials,
    oauthClientFor: () => null,
    promptsClient: prompts,
    ...(gateProbe ? { toolConnections: {}, gateProbe } : {}),
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
  return { pool, store, credentials, prompts, runWrite, actor };
}

const keyFor = (entryId) => ({ personId: PERSON, seatId: 'claude', entryId });

// A stocked entry, connected through the real connect/header
// road, with TOOLS_V1 frozen on it.
async function connectedWorld(opts) {
  const w = makeWorld(opts);
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  const landed = await w.runWrite('connect/header', {
    seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read',
  });
  assert.equal(landed.status, 201);
  await w.store.freezeSnapshot(TENANT, keyFor(ENTRY_ID), TOOLS_V1, SUBJECT);
  return w;
}

const snapshotInserts = (pool) => pool.queries.filter((q) => q.text.includes('insert into helmion.connector_snapshots')).length;

test('TOOL-REFRESH preview — names the added, changed, and removed tools and writes nothing', async () => {
  const w = await connectedWorld();
  const before = await w.store.getCurrentSnapshot(TENANT, keyFor(ENTRY_ID));
  const insertsBefore = snapshotInserts(w.pool);
  const mapBefore = (await w.store.getConnection(TENANT, keyFor(ENTRY_ID))).toolEnableMap;

  const out = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: true });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'tool-refresh-preview');
  assert.equal(out.json.hasSnapshot, true);
  assert.deepEqual(out.json.diff, DRIFT_DIFF, 'the diff is by name: delete_record added, archive_record removed, update_record changed');

  assert.equal(w.prompts.calls.length, 1, 'the fresh list was listed exactly once');
  assert.equal(w.prompts.calls[0].accessToken, KEY_VALUE, 'the list rode the caller’s own brokered token');
  assert.equal(w.prompts.calls[0].endpoint, 'https://sync.example.com/mcp');

  const after = await w.store.getCurrentSnapshot(TENANT, keyFor(ENTRY_ID));
  assert.equal(after.id, before.id, 'the frozen snapshot is untouched — the same row still stands');
  assert.equal(after.snapshotHash, before.snapshotHash);
  assert.equal(snapshotInserts(w.pool), insertsBefore, 'no snapshot row was written');
  assert.deepEqual((await w.store.getConnection(TENANT, keyFor(ENTRY_ID))).toolEnableMap, mapBefore, 'the enable map is untouched');
});

test('TOOL-REFRESH confirm — re-freezes OFF the new and changed, keeps the kept, drops the removed; enabling one makes it offerable on the next arming pass', async () => {
  const w = await connectedWorld();
  // The person's standing setting on an UNCHANGED tool: off.
  // The re-freeze must keep it off (kept means kept, both ways).
  const flipped = await w.runWrite('tool-enable', { seatId: 'claude', entryId: ENTRY_ID, toolEnableMap: { lookup: false } });
  assert.equal(flipped.status, 200);

  const out = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, confirm: true });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'tools-refreshed');
  assert.deepEqual(out.json.diff, DRIFT_DIFF);
  assert.deepEqual(out.json.snapshot.tools.map((t) => t.name), ['delete_record', 'lookup', 'update_record'],
    'the new frozen set is the live list — archive_record dropped out');
  assert.deepEqual(out.json.connection.toolEnableMap, { lookup: false, update_record: false, delete_record: false },
    'unchanged lookup kept the person’s off; changed update_record and added delete_record landed OFF');

  // The face's read of the same state (the read the panel renders).
  const read = await productionToolAccess(TENANT, keyFor(ENTRY_ID), w.store);
  assert.equal(read.snapshotHash, out.json.snapshot.snapshotHash);
  assert.deepEqual(read.tools.map((t) => [t.name, t.enabled]), [
    ['delete_record', false], ['lookup', false], ['update_record', false],
  ]);

  // Enabling one of the newly frozen tools — the panel's own
  // tool-enable write — makes it offerable on the next arming
  // pass: dispatch reads exactly this snapshot + map.
  const enabled = await w.runWrite('tool-enable', { seatId: 'claude', entryId: ENTRY_ID, toolEnableMap: { delete_record: true } });
  assert.equal(enabled.status, 200);
  const record = await resolveArmingRecord({
    store: w.store,
    credentials: w.credentials,
    listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
    operatorTokens: {},
    toolConnections: null,
    tenantId: TENANT, personId: PERSON, seatId: 'claude', entryId: ENTRY_ID,
  });
  assert.equal(record.state, 'connected');
  const offerable = record.snapshotTools.map((t) => t.name).filter((name) => record.toolEnableMap[name] !== false);
  assert.deepEqual(offerable, ['delete_record'], 'delete_record is offerable; the still-off update_record is in the frozen set but not offered');
  assert.equal(record.toolEnableMap.update_record, false);
});

test('TOOL-REFRESH — a connected entry with no saved list: preview names every live tool as added; confirm takes the first freeze (all on)', async () => {
  const w = makeWorld({ liveTools: TOOLS_V1 });
  await w.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  const landed = await w.runWrite('connect/header', {
    seatId: 'claude', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Sync account', posture: 'read',
  });
  assert.equal(landed.status, 201);

  const preview = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.hasSnapshot, false);
  assert.deepEqual(preview.json.diff, { added: ['archive_record', 'lookup', 'update_record'], removed: [], changed: [] });

  const confirm = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, confirm: true });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.status, 'tools-refreshed');
  assert.deepEqual(confirm.json.connection.toolEnableMap, { archive_record: true, lookup: true, update_record: true },
    'a first freeze enters the reviewed set ON — the connect-flow rule freezeSnapshot already keeps');
});

test('TOOL-REFRESH — the request shape refusals, in the route’s own voice', async () => {
  const w = await connectedWorld();
  const neither = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID });
  assert.equal(neither.status, 400);
  assert.match(neither.json.error, /exactly one of preview or confirm/);

  const both = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: true, confirm: true });
  assert.equal(both.status, 400);
  assert.match(both.json.error, /exactly one of preview or confirm/);

  const wordy = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: 'yes' });
  assert.equal(wordy.status, 400, 'a non-true preview flag is not a preview — it is no flag at all');

  const cred = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: true, apiKey: 'sk-nope' });
  assert.equal(cred.status, 400);
  assert.match(cred.json.error, /credential values never ride this road/);

  const missing = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: 'no-such-entry', preview: true });
  assert.equal(missing.status, 404);
  assert.equal(w.prompts.calls.length, 0, 'no refusal ever listed a tool');
});

test('TOOL-REFRESH — auditor, vendor-brokered, and unconnected refusals', async () => {
  const w = await connectedWorld();
  await w.store.createEntry(TENANT, SUBJECT, vendorEntry('claude'));

  const auditor = await w.runWrite('tool-refresh',
    { seatId: 'claude', entryId: ENTRY_ID, preview: true },
    { ...w.actor, role: 'auditor' });
  assert.equal(auditor.status, 403, 'auditors never write — the whole route refuses before the action runs');

  const vendor = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: VENDOR_ENTRY_ID, preview: true });
  assert.equal(vendor.status, 400);
  assert.equal(vendor.json.code, 'VENDOR_MANAGED');

  const bare = makeWorld();
  await bare.store.createEntry(TENANT, SUBJECT, headerEntry('claude'));
  const unconnected = await bare.runWrite('tool-refresh', { seatId: 'claude', entryId: ENTRY_ID, preview: true });
  assert.equal(unconnected.status, 409);
  assert.equal(unconnected.json.code, 'NOT_CONNECTED');
  assert.equal(bare.prompts.calls.length, 0, 'an unconnected refresh never reaches the server');
});

test('TOOL-REFRESH custom — the fresh list rides the gate probe, never the credentialed list road', async () => {
  const probeCalls = [];
  const gateProbe = async ({ entry }) => {
    probeCalls.push(entry.id);
    return { state: 'verified', tools: GATE_V2, row: null };
  };
  const w = makeWorld({ gateProbe });
  // The credentialed road is a tripwire in this world: if the
  // refresh ever lists with a token, the prompts fake says so.
  w.prompts.listTools = async () => { throw new Error('the credentialed list road must never serve a custom entry'); };

  await w.store.createEntry(TENANT, SUBJECT, customEntry('claude'));
  await w.store.createConnection(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: CUSTOM_ENTRY_ID, accountIdentity: 'Weather account',
  });
  await w.store.freezeSnapshot(TENANT, keyFor(CUSTOM_ENTRY_ID), GATE_V1, SUBJECT);

  const preview = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: CUSTOM_ENTRY_ID, preview: true });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.diff, { added: ['rain_radar'], removed: [], changed: ['set_alert'] });
  assert.deepEqual(probeCalls, [CUSTOM_ENTRY_ID], 'the probe took the fresh list');

  const confirm = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: CUSTOM_ENTRY_ID, confirm: true });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.status, 'tools-refreshed');
  assert.deepEqual(probeCalls, [CUSTOM_ENTRY_ID, CUSTOM_ENTRY_ID], 'confirm re-probes — the freeze is the probed list, listed again');
  assert.deepEqual(confirm.json.connection.toolEnableMap, { read_weather: true, set_alert: false, rain_radar: false },
    'the probe list froze by the same merge: unchanged kept on, changed and added OFF');
  assert.equal(w.credentials.calls.filter((c) => c[0] === 'resolveVaultCredential').length, 0,
    'no credential was ever resolved for the custom refresh');
});

test('TOOL-REFRESH custom — an unconnected custom entry refuses before any probe runs', async () => {
  const probeCalls = [];
  const gateProbe = async ({ entry }) => {
    probeCalls.push(entry.id);
    return { state: 'verified', tools: GATE_V2, row: null };
  };
  const w = makeWorld({ gateProbe });
  await w.store.createEntry(TENANT, SUBJECT, customEntry('claude'));
  const out = await w.runWrite('tool-refresh', { seatId: 'claude', entryId: CUSTOM_ENTRY_ID, preview: true });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'NOT_CONNECTED');
  assert.deepEqual(probeCalls, [], 'the probe never ran for a connection that does not exist');
});

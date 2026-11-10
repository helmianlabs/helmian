// Connector library — SPEC §3/§4 Bite 2 gate.
//
// The gate, from the spec:
//   (1) for each live seat, the library read returns that seat's
//       entries with all five row fields populated (§1.2);
//   (2) the existing GitHub tool-connection's verified state appears
//       as the Helmian-native entry's state without a second
//       connection being created — asserted here as: the read performs
//       ZERO writes and the connector_connections table is untouched.
// Plus the bite's own laws: brokerMode set per §3.1 (default vendor),
// refresh updates descriptive fields but never brokerMode and never
// touches connections/mirrors/snapshots, state joins per source, and
// §3.4 seat isolation through the read.
//
// Both REAL stores run over one in-memory fake pool (the repo's
// established pattern): bite 1's connector-library store and the
// existing tool-connections store, so the GitHub join is exercised
// across the two stores exactly as production will run it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorLibraryStore, buildConnectorTokenRef } from '../src/cloud/connector-library.mjs';
import { createToolConnectionsStore } from '../src/cloud/tool-connections.mjs';
import {
  LIVE_SEATS,
  CONNECTOR_CATALOG,
  catalogEntriesForSeat,
  createCatalogRefresh,
  runCatalogRefreshOnce,
} from '../src/cloud/connector-catalog.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';

const TENANT = 'tenant-a';
const SUBJECT = 'user:troy';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';
const NOW = Date.now();

// ---------------------------------------------------------------- fake pool
// Bite 1's fake (connector_* tables) extended with helmion.tool_connections
// selects for the real tool-connections store, a writes log, and seed
// helpers for the tool-connection rows.
function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  const mirrors = new Map();
  const toolConnections = new Map();
  const queries = [];
  const writes = [];
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;
  const tcKey = (sk, si, sv) => `${tenant}|${sk}|${si}|${sv}`;
  const now = () => new Date();

  return {
    queries,
    writes,
    connectorConnectionCount: () => connections.size,
    seedToolConnection(row) {
      const full = {
        id: toolConnections.size + 1, tenant_id: tenant ?? TENANT,
        kind: 'mcp-http', server_ref: 'github-mcp', credential_reference: null,
        account_label: null, granted_scopes: [], probe_method: 'tools/list',
        last_tools_count: null, last_error: null, updated_by_subject: SUBJECT,
        created_at: now(), updated_at: now(), ...row,
      };
      toolConnections.set(tcKey(full.scope_kind, full.scope_id, full.service_id), full);
      return full;
    },
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
          if (/insert into|update helmion\.|delete from/.test(text)) writes.push(text);
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

          // ---- tool_connections (list only — the read's only road in)
          if (text.includes('from helmion.tool_connections')) {
            let out = [...toolConnections.values()].filter((r) => r.tenant_id === tenant);
            let i = 0;
            if (text.includes('scope_kind = $')) { const v = vals[i++]; out = out.filter((r) => r.scope_kind === v); }
            if (text.includes('scope_id = $')) { const v = vals[i++]; out = out.filter((r) => r.scope_id === v); }
            out.sort((a, b) => `${a.service_id}|${a.scope_kind}|${a.scope_id}`.localeCompare(`${b.service_id}|${b.scope_kind}|${b.scope_id}`));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }

          // ---- connector_entries
          if (text.includes('insert into helmion.connector_entries')) {
            const [seatId, id, kind, name, oneLiner, iconRef, vendorName, trustLabel, category,
              brokerMode, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary,
              addedBy, workspaceProvisioned] = vals;
            const row = {
              tenant_id: tenant, seat_id: seatId, id, kind, name, one_liner: oneLiner,
              icon_ref: iconRef, vendor_name: vendorName, trust_label: trustLabel, category,
              broker_mode: brokerMode, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              added_by: addedBy, added_at: now(), workspace_provisioned: workspaceProvisioned,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            entries.delete(entryKey(vals[0], vals[1]));
            for (const [k, c] of connections) if (c.seat_id === vals[0] && c.entry_id === vals[1] && c.tenant_id === tenant) { connections.delete(k); for (const [sid, s] of snapshots) if (s.connection_id === c.id) snapshots.delete(sid); }
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
            const [, , name, oneLiner, iconRef, vendorName, trustLabel, category, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary, workspaceProvisioned] = vals;
            Object.assign(row, {
              name, one_liner: oneLiner, icon_ref: iconRef, vendor_name: vendorName,
              trust_label: trustLabel, category, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              workspace_provisioned: workspaceProvisioned, updated_at: now(),
            });
            return { rows: [{ ...row }], rowCount: 1 };
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
            const row = {
              id: ++snapSeq, tenant_id: tenant, connection_id: vals[0],
              taken_at: now(), tools: JSON.parse(vals[1]), snapshot_hash: vals[2],
            };
            snapshots.set(row.id, row);
            return { rows: [{ ...row }], rowCount: 1 };
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
            const row = existing ?? {
              tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId, created_at: now(),
            };
            row.reported_state = reportedState;
            row.reported_account_identity = reportedAccount;
            row.reported_at = reportedAt ? new Date(reportedAt) : now();
            row.updated_at = now();
            mirrors.set(key, row);
            return { rows: [{ ...row }], rowCount: 1 };
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

function makeWorld() {
  const pool = fakePool();
  const libraryStore = createConnectorLibraryStore(pool);
  const toolConnectionsStore = createToolConnectionsStore(pool);
  const refresh = createCatalogRefresh({ libraryStore, subject: SUBJECT });
  const read = createSeatLibraryRead({ libraryStore, toolConnectionsStore });
  return { pool, libraryStore, toolConnectionsStore, refresh, read };
}

const refFor = (seatId, entryId, personId = PERSON, tokenKind = 'access') =>
  buildConnectorTokenRef({ tenantId: TENANT, seatId, entryId, personId, tokenKind });

// ------------------------------------------------------------ catalog data
test('catalog data: every seat’s definitions are well-formed, unique per seat, and carry an explicit brokerMode', () => {
  assert.equal(CONNECTOR_CATALOG.length, LIVE_SEATS.reduce((n, s) => n + catalogEntriesForSeat(s).length, 0));
  for (const seatId of LIVE_SEATS) {
    const defs = catalogEntriesForSeat(seatId);
    const ids = new Set(defs.map((d) => d.id));
    assert.equal(ids.size, defs.length, `${seatId}: duplicate entry id in one seat's library`);
    for (const def of defs) {
      assert.notEqual(def.kind, 'custom', `${seatId}/${def.id}: catalog data never carries custom entries`);
      assert.ok(['helmian', 'vendor'].includes(def.brokerMode), `${seatId}/${def.id}: brokerMode set explicitly`);
      if (def.brokerMode === 'vendor') {
        assert.ok(def.vendorConnectorRef?.manageUrl?.startsWith('https://'), `${seatId}/${def.id}: vendor mirror carries its manage link`);
        assert.equal(def.mcpEndpointUrl, undefined, `${seatId}/${def.id}: a mirror has no Helmian pipe`);
      } else {
        assert.ok(def.mcpEndpointUrl?.startsWith('https://'), `${seatId}/${def.id}: helmian entry carries its endpoint`);
      }
      // The native is in every seat's library (§3.2) — and the cut
      // Scribe entry is in none of them (Scribe × Helmian separation).
      assert.ok(ids.has('helmian-github') && !ids.has('helmian-scribe'), `${seatId}: native present, scribe absent`);
    }
  }
});

test('brokerMode follows §3.1: vendor-brokered ecosystems mirror; only reachable MCP pipes are helmian', () => {
  const byId = (seat, id) => catalogEntriesForSeat(seat).find((d) => d.id === id);
  // Anthropic and OpenAI broker from their clouds → every Source 1
  // mirror is vendor. Source 3 registry imports (def.registryName)
  // are a different source with their own §3.1 ruling — a reachable
  // public pipe is 'helmian' — and are pinned in mcp-registry.test.
  // Source 4 vendor-published servers (def.vendorPublished) carry
  // the same §3.1 ruling — the vendor's own published MCP endpoint
  // is a reachable pipe Helmian brokers — and are pinned in
  // connector-vercel.test.
  for (const seat of ['claude', 'chatgpt', 'gemini']) {
    for (const def of catalogEntriesForSeat(seat)) {
      if (def.kind === 'catalog' && !def.registryName && !def.vendorPublished) assert.equal(def.brokerMode, 'vendor', `${seat}/${def.id}`);
    }
  }
  // xAI built-ins + catalog are brokered by xAI — except GitHub, whose
  // public MCP endpoint Helmian can handshake directly.
  assert.equal(byId('grok', 'github').brokerMode, 'helmian');
  assert.equal(byId('grok', 'github').mcpEndpointUrl, 'https://api.githubcopilot.com/mcp/');
  assert.equal(byId('grok', 'gmail').brokerMode, 'vendor');
  assert.equal(byId('grok', 'vercel').brokerMode, 'vendor');
  // Cloudflare's published MCP catalog is plain reachable servers.
  assert.equal(byId('cloudflare', 'cloudflare-docs').brokerMode, 'helmian');
  // Natives are Helmian's own pipes.
  assert.equal(byId('owner', 'helmian-github').brokerMode, 'helmian');
  // Seats with no documented vendor library seed Source 2 plus the
  // seat-agnostic Source 3 shelf (today: the weather pick) — no
  // Source 1 mirror is ever invented for them.
  for (const seat of ['mistral', 'groq', 'nvidia', 'openrouter', 'qwen', 'muse', 'maestro', 'helm', 'owner']) {
    const defs = catalogEntriesForSeat(seat);
    assert.ok(defs.every((d) => d.kind === 'helmian-native' || d.registryName), `${seat}: natives + registry shelf only`);
    assert.equal(defs.filter((d) => d.kind === 'helmian-native').length, 1, `${seat}: exactly the one native`);
  }
});

// ------------------------------------------------------- GATE 1: the rows
test('GATE 1 — for each live seat, the library read returns that seat’s entries with all five row fields populated', async () => {
  const { refresh, read } = makeWorld();
  const summary = await refresh.refreshAll(TENANT);
  for (const seat of summary.seats) assert.deepEqual(seat.conflicts, [], `${seat.seatId}: clean seed`);

  const STATES = ['not-connected', 'connected', 'needs-reconnect', 'disabled-by-owner'];
  const TRUST = ['verified', 'community', 'custom'];
  for (const seatId of LIVE_SEATS) {
    const { rows, connectedCount } = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId, now: NOW });
    assert.equal(rows.length, catalogEntriesForSeat(seatId).length, `${seatId}: every catalog entry reads back`);
    assert.equal(connectedCount, 0, `${seatId}: nothing connected before anyone connects`);
    for (const row of rows) {
      assert.ok(typeof row.iconRef === 'string' && row.iconRef.length > 0, `${seatId}/${row.entryId}: field 1 icon`);
      assert.ok(typeof row.name === 'string' && row.name.length > 0, `${seatId}/${row.entryId}: field 2 name`);
      assert.ok(typeof row.oneLiner === 'string' && row.oneLiner.length > 0, `${seatId}/${row.entryId}: field 3 one-liner`);
      assert.ok(row.vendorLabel.startsWith('Connector by ') && row.vendorLabel.length > 'Connector by '.length, `${seatId}/${row.entryId}: field 4 vendor label`);
      assert.ok(TRUST.includes(row.trustLabel), `${seatId}/${row.entryId}: field 4 trust label`);
      assert.ok(STATES.includes(row.state), `${seatId}/${row.entryId}: field 5 state`);
      assert.equal(row.state, 'not-connected', `${seatId}/${row.entryId}: no state invented at seed time`);
    }
  }
});

// ------------------------------------------------- GATE 2: the GitHub join
test('GATE 2 — the verified GitHub tool-connection surfaces on the native entry; the read creates NO connection record and writes nothing', async () => {
  const { pool, refresh, read } = makeWorld();
  await refresh.refreshAll(TENANT);
  const tc = pool.seedToolConnection({
    scope_kind: 'workspace', scope_id: 'workspace', service_id: 'github',
    state: 'verified', last_verified_at: new Date(NOW - 60_000),
    account_label: 'helmianlabs', last_tools_count: 26,
  });

  const writesBefore = pool.writes.length;
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', now: NOW });
  const github = view.rows.find((r) => r.entryId === 'helmian-github');
  assert.equal(github.state, 'connected');
  assert.equal(github.accountIdentity, 'helmianlabs', 'the account the provider-side connection already holds');
  assert.equal(github.stateDetail.toolStatus, 'connected');
  assert.equal(github.stateDetail.lastToolsCount, 26);
  assert.equal(view.connectedCount, 1);
  assert.equal(view.rows[0].entryId, 'helmian-github', 'connected rows sort first');

  // The read minted nothing: no connector_connections row, no writes
  // of any kind against any table while reading.
  assert.equal(pool.connectorConnectionCount(), 0, 'no second connection was created for the surfaced state');
  assert.equal(pool.writes.length, writesBefore, 'the library read performs zero writes');
  const again = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', now: NOW });
  assert.equal(again.rows.find((r) => r.entryId === 'helmian-github').state, 'connected');
  assert.equal(pool.writes.length, writesBefore, 'repeat reads still write nothing');

  // A stale receipt no longer reads Connected — the receipt's own
  // honesty rule — and the headline stays inside §1.2's vocabulary
  // while stateDetail carries the precise truth.
  tc.last_verified_at = new Date(NOW - 2 * 60 * 60 * 1000);
  const stale = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', now: NOW });
  const staleRow = stale.rows.find((r) => r.entryId === 'helmian-github');
  assert.equal(staleRow.state, 'not-connected');
  assert.equal(staleRow.stateDetail.toolStatus, 'stale');

  // A failed probe reads as failed underneath, never as connected.
  tc.state = 'failed'; tc.last_verified_at = null; tc.last_error = 'probe timed out';
  const failed = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', now: NOW });
  const failedRow = failed.rows.find((r) => r.entryId === 'helmian-github');
  assert.equal(failedRow.state, 'not-connected');
  assert.equal(failedRow.stateDetail.toolStatus, 'failed');
  assert.equal(failedRow.stateDetail.lastError, 'probe timed out');
});

test('GATE 2b — the GitHub join takes the strongest scope truth: a fresh agent-scope receipt beats a failed workspace row', async () => {
  const { pool, refresh, read } = makeWorld();
  await refresh.refreshAll(TENANT);
  pool.seedToolConnection({
    scope_kind: 'workspace', scope_id: 'workspace', service_id: 'github',
    state: 'failed', last_verified_at: null, last_error: 'workspace probe failed',
  });
  pool.seedToolConnection({
    scope_kind: 'agent', scope_id: 'claude', service_id: 'github',
    state: 'verified', last_verified_at: new Date(NOW - 30_000), account_label: 'helmianlabs',
  });
  // An unrelated service's row must not leak into the GitHub join.
  pool.seedToolConnection({
    scope_kind: 'workspace', scope_id: 'workspace', service_id: 'slack',
    state: 'failed', last_verified_at: null,
  });
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini', now: NOW });
  const github = view.rows.find((r) => r.entryId === 'helmian-github');
  assert.equal(github.state, 'connected');
  assert.equal(github.stateDetail.scopeKind, 'agent');
  assert.equal(pool.connectorConnectionCount(), 0);
});

// ------------------------------------------------------------- refresh road
test('refresh updates descriptive fields, never flips brokerMode, and reports the conflict', async () => {
  const { libraryStore, refresh } = makeWorld();
  // A stored entry whose one-liner is out of date refreshes in place.
  await libraryStore.createEntry(TENANT, SUBJECT, {
    seatId: 'claude', id: 'linear', kind: 'catalog', name: 'Linear',
    oneLiner: 'OLD LINE', vendorName: 'Linear', trustLabel: 'verified',
    brokerMode: 'vendor',
    vendorConnectorRef: { ref: 'anthropic:linear', manageUrl: 'https://claude.ai/settings/connectors' },
    authMode: 'oauth', addedBy: 'system',
  });
  // A stored entry whose brokerMode disagrees with the catalog is a
  // data bug: refresh must refuse the flip and say so.
  await libraryStore.createEntry(TENANT, SUBJECT, {
    seatId: 'claude', id: 'gmail', kind: 'catalog', name: 'Gmail',
    oneLiner: 'WRONG PIPE', vendorName: 'Google', trustLabel: 'verified',
    brokerMode: 'helmian', mcpEndpointUrl: 'https://gmail.example.com/mcp',
    authMode: 'oauth', addedBy: 'system',
  });
  const result = await refresh.refreshSeat(TENANT, 'claude');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].entryId, 'gmail');
  assert.ok(!result.applied.includes('gmail'));
  const linear = await libraryStore.getEntry(TENANT, 'claude', 'linear');
  assert.notEqual(linear.oneLiner, 'OLD LINE', 'descriptive fields refresh');
  const gmail = await libraryStore.getEntry(TENANT, 'claude', 'gmail');
  assert.equal(gmail.brokerMode, 'helmian', 'the stored pipe survives a disagreeing refresh');
  assert.equal(gmail.oneLiner, 'WRONG PIPE', 'a refused refresh leaves the entry untouched');
});

test('refresh never touches connections, mirrors, or snapshots', async () => {
  const { pool, libraryStore, refresh, read } = makeWorld();
  await refresh.refreshAll(TENANT);
  const key = { personId: PERSON, seatId: 'grok', entryId: 'github' };
  await libraryStore.createConnection(TENANT, SUBJECT, {
    ...key, accountIdentity: 'troy@github',
    accessTokenRef: refFor('grok', 'github'), refreshTokenRef: refFor('grok', 'github', PERSON, 'refresh'),
    grantedScopes: ['repo'],
  });
  const snap = await libraryStore.freezeSnapshot(TENANT, key, [
    { name: 'list_repos', description: 'List repositories', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ], SUBJECT);
  await libraryStore.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail',
    reportedState: 'connected', reportedAccountIdentity: 'troy@example.com',
  });
  const before = await libraryStore.getConnection(TENANT, key);

  await refresh.refreshAll(TENANT);
  await refresh.refreshAll(TENANT); // idempotent: a second pass changes nothing either

  const after = await libraryStore.getConnection(TENANT, key);
  assert.deepEqual(after, before, 'the connection record is byte-identical across refreshes');
  assert.equal(after.toolSnapshotRef, snap.id);
  const mirror = await libraryStore.getMirror(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'gmail' });
  assert.equal(mirror.reportedState, 'connected');
  assert.equal(pool.connectorConnectionCount(), 1);
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok', now: NOW });
  assert.equal(view.rows.find((r) => r.entryId === 'github').state, 'connected');
});

test('runCatalogRefreshOnce runs the job shape for a tenant list', async () => {
  const { libraryStore } = makeWorld();
  const results = await runCatalogRefreshOnce({ tenantIds: [TENANT], subject: SUBJECT, libraryStore });
  assert.equal(results.length, 1);
  assert.equal(results[0].seats.length, LIVE_SEATS.length);
  assert.ok(results[0].seats.every((s) => s.conflicts.length === 0));
  assert.equal((await libraryStore.listEntries(TENANT, 'grok')).length, catalogEntriesForSeat('grok').length);
});

// ------------------------------------------------------------ state joining
test('the read joins each source honestly: connection, needs-reconnect, mirror, disabled-by-owner', async () => {
  const { libraryStore, refresh, read } = makeWorld();
  await refresh.refreshAll(TENANT);

  // Helmian connection → connected with posture in the detail.
  const grokGithub = { personId: PERSON, seatId: 'grok', entryId: 'github' };
  await libraryStore.createConnection(TENANT, SUBJECT, {
    ...grokGithub, accountIdentity: 'troy@github',
    accessTokenRef: refFor('grok', 'github'), refreshTokenRef: refFor('grok', 'github', PERSON, 'refresh'),
  });
  // Needs-reconnect is its own headline state.
  const cloudflareDocs = { personId: PERSON, seatId: 'cloudflare', entryId: 'cloudflare-docs' };
  await libraryStore.createConnection(TENANT, SUBJECT, { ...cloudflareDocs, accountIdentity: 'anon' });
  await libraryStore.markNeedsReconnect(TENANT, cloudflareDocs, SUBJECT);
  // Vendor mirror → connected only as reported, with provenance.
  await libraryStore.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail',
    reportedState: 'connected', reportedAccountIdentity: 'troy@example.com',
    reportedAt: '2026-11-08T15:00:00.000Z',
  });

  const grok = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok', now: NOW });
  const gh = grok.rows.find((r) => r.entryId === 'github');
  assert.equal(gh.state, 'connected');
  assert.equal(gh.accountIdentity, 'troy@github');
  assert.equal(gh.stateDetail.posture, 'ask');
  assert.equal(grok.rows[0].entryId, 'github', 'connected first');

  const cf = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'cloudflare', now: NOW });
  assert.equal(cf.rows.find((r) => r.entryId === 'cloudflare-docs').state, 'needs-reconnect');

  const claude = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude', now: NOW });
  const gmail = claude.rows.find((r) => r.entryId === 'gmail');
  assert.equal(gmail.state, 'connected');
  assert.equal(gmail.accountIdentity, 'troy@example.com');
  assert.equal(gmail.stateDetail.managedBy, 'vendor');
  assert.equal(gmail.stateDetail.manageUrl, 'https://claude.ai/settings/connectors');

  // The owner's disable wins over a live connection.
  await libraryStore.setEntryState(TENANT, 'grok', 'github', 'disabled-by-owner', SUBJECT);
  const disabled = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'grok', now: NOW });
  assert.equal(disabled.rows.find((r) => r.entryId === 'github').state, 'disabled-by-owner');
});

test('§3.4 through the read: one seat’s state never leaks into another seat’s library', async () => {
  const { libraryStore, refresh, read } = makeWorld();
  await refresh.refreshAll(TENANT);
  await libraryStore.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail', reportedState: 'connected',
    reportedAccountIdentity: 'troy@example.com',
  });
  await libraryStore.createConnection(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'grok', entryId: 'github', accountIdentity: 'troy@github',
    accessTokenRef: refFor('grok', 'github'), refreshTokenRef: refFor('grok', 'github', PERSON, 'refresh'),
  });

  // Gemini has its own Gmail mirror entry — claude's report says
  // nothing about it.
  const gemini = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini', now: NOW });
  assert.equal(gemini.rows.find((r) => r.entryId === 'gmail').state, 'not-connected');
  // And another person in the SAME seat sees none of it either.
  const stranger = await read.readSeatLibrary(TENANT, { personId: OTHER_PERSON, seatId: 'claude', now: NOW });
  assert.equal(stranger.rows.find((r) => r.entryId === 'gmail').state, 'not-connected');
  assert.equal(stranger.connectedCount, 0);
  const strangerGrok = await read.readSeatLibrary(TENANT, { personId: OTHER_PERSON, seatId: 'grok', now: NOW });
  assert.equal(strangerGrok.rows.find((r) => r.entryId === 'github').state, 'not-connected');
});

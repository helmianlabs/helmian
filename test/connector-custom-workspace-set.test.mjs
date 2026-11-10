// Workspace CUSTOM entries (SYNC S2a) — the entry-level proof.
//
// Troy's design, the half S1 named as its remainder: a custom
// connector a person creates while using ONE agent is part of
// their workspace set — it exists in their other agents' libraries
// too (one entry, the same id, its creating seat recorded as
// provenance), a new agent inherits it, and S1's connection set
// then syncs under it by S1's own rule.
//
// Exercised here on the REAL paths, production-shaped:
//   · the real connector library store (connector-library.mjs)
//     over an in-memory fake pool simulating the sql/074 tables
//     (the repo's established pattern), extended with the S2a
//     query shapes and a direct seedEntry road for legacy rows;
//   · the real write handler (connector-library-write-route.mjs) —
//     entries create / connect / connect/header / entries/remove
//     all land through it, on whichever seat the action names;
//   · the real library read (connector-library-read.mjs), the real
//     tool-access read (productionToolAccess), and the real arming
//     dispatch (resolveArmingRecord);
//   · the real custom-gate module's keying, over a fake
//     tool-connections store shaped like sql/061 (unique key:
//     tenant, scope_kind, scope_id, service_id) with a switchable
//     probe that writes receipts through the store's own roads —
//     the connector-custom-gate.test.mjs pattern.
// The credential fake is shaped like the real vault (records keyed
// (provider_id, credential_reference)), so a resolve addressed
// under the wrong seat's provider id misses, exactly as in S1.

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
import { customGateKey } from '../src/cloud/connector-custom-gate.mjs';
import { PROBE_METHOD_TOOLS_LIST } from '../src/cloud/tool-connections.mjs';

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
const ENTRY_ID = 'custom-weather-tools';
const KEY_VALUE = 'sk-weather-1234567890';

const GATE_TOOLS = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set an alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];

// ---------------------------------------------------------------- fake pool
// Simulates the sql/074 tables with a monotonic clock (S1's pool),
// plus the S2a query shapes (custom rows by id / by owner, the
// group delete, the summary enrichment) and seedEntry for planting
// legacy physical rows directly.
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
    seedEntry(row) {
      const full = {
        tenant_id: tenant ?? TENANT, seat_id: 'claude', id: 'custom-seeded', kind: 'custom',
        name: 'Seeded', one_liner: 'Seeded custom', icon_ref: null, vendor_name: 'Custom',
        trust_label: 'custom', category: null, broker_mode: 'helmian',
        mcp_endpoint_url: 'https://seeded.example.com/mcp', vendor_connector_ref: null,
        auth_mode: 'header', client_identity: null, scopes_summary: null,
        added_by: PERSON, added_at: now(), workspace_provisioned: false,
        installed_path: null, config_snippet: null, baseline_fingerprint: null,
        state: 'available', created_at: now(), updated_at: now(), ...row,
      };
      entries.set(entryKey(full.seat_id, full.id), full);
      return full;
    },
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
          // The S2a group delete: every physical row for (id, owner).
          if (text.includes('delete from helmion.connector_entries') && text.includes('added_by = $3')) {
            const deleted = [];
            for (const [k, row] of entries) {
              if (row.tenant_id === tenant && row.id === vals[1] && row.kind === 'custom' && row.added_by === vals[2]) {
                deleted.push(row);
                entries.delete(k);
                for (const [ck, c] of connections) if (c.seat_id === row.seat_id && c.entry_id === row.id && c.tenant_id === tenant) connections.delete(ck);
                for (const [mk, m] of mirrors) if (m.seat_id === row.seat_id && m.entry_id === row.id && m.tenant_id === tenant) mirrors.delete(mk);
              }
            }
            return { rows: deleted.map((r) => ({ ...r })), rowCount: deleted.length };
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
          // The S2a summary enrichment: owner + updated_at per row.
          if (text.includes('select seat_id, id, added_by, updated_at from helmion.connector_entries')) {
            const out = [...entries.values()].filter((r) => r.tenant_id === tenant);
            return { rows: out.map((r) => ({ seat_id: r.seat_id, id: r.id, added_by: r.added_by, updated_at: r.updated_at })), rowCount: out.length };
          }
          // The S2a custom rows by id (any seat, any owner).
          if (text.includes('from helmion.connector_entries') && text.includes("kind = 'custom'") && text.includes('id = $2')) {
            const out = [...entries.values()]
              .filter((r) => r.tenant_id === tenant && r.id === vals[1] && r.kind === 'custom')
              .sort((a, b) => (new Date(b.updated_at) - new Date(a.updated_at)) || (a.seat_id < b.seat_id ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          // The S2a custom rows by owner (any seat).
          if (text.includes('from helmion.connector_entries') && text.includes("kind = 'custom'") && text.includes('added_by = $1')) {
            const out = [...entries.values()]
              .filter((r) => r.tenant_id === tenant && r.kind === 'custom' && r.added_by === vals[0])
              .sort((a, b) => (new Date(b.updated_at) - new Date(a.updated_at)) || (a.seat_id < b.seat_id ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
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
          if (text.includes('from helmion.connector_connections') && text.includes('entry_id = $3') && !text.includes('seat_id = $2')) {
            const out = [...connections.values()]
              .filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.entry_id === vals[2])
              .sort((a, b) => (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
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

// ------------------------------------------------- fake tool-connections
// The gate's store, shaped like sql/061: rows keyed (scopeKind,
// scopeId, serviceId); register writes intent only; the probe
// receipt roads are the only writers of 'verified' / 'failed'
// (the connector-custom-gate.test.mjs fake, carried over).
function fakeToolConnections() {
  const rows = new Map();
  const calls = [];
  const keyOf = (k) => `${k.scopeKind}|${k.scopeId}|${k.serviceId}`;
  return {
    rows, calls,
    async register(tenantId, subject, input) {
      calls.push(['register', input, subject]);
      if ('state' in input) throw Object.assign(new Error('state cannot be set at registration'), { status: 400 });
      const k = keyOf(input);
      const existing = rows.get(k);
      const changed = Boolean(existing) && (existing.kind !== input.kind || existing.serverRef !== input.serverRef);
      const row = {
        scopeKind: input.scopeKind, scopeId: input.scopeId, serviceId: input.serviceId,
        kind: input.kind, serverRef: input.serverRef,
        credentialReference: input.credentialReference ?? null,
        accountLabel: input.accountLabel ?? null, grantedScopes: [],
        state: changed ? 'registered' : (existing?.state ?? 'registered'),
        lastVerifiedAt: changed ? null : (existing?.lastVerifiedAt ?? null),
        probeMethod: changed ? null : (existing?.probeMethod ?? null),
        lastToolsCount: changed ? null : (existing?.lastToolsCount ?? null),
        lastError: changed ? null : (existing?.lastError ?? null),
        updatedBySubject: subject, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date(),
      };
      rows.set(k, row);
      return row;
    },
    async get(tenantId, key) { calls.push(['get', key]); return rows.get(keyOf(key)) ?? null; },
    async list() { return [...rows.values()]; },
    async beginProbe(tenantId, key, subject) {
      const row = rows.get(keyOf(key));
      if (!row || row.state === 'revoked') throw Object.assign(new Error('tool connection not found, or revoked'), { status: 404 });
      row.state = 'probing'; row.updatedBySubject = subject;
      return row;
    },
    async recordProbeReceipt(tenantId, key, receipt, subject) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'verified'; row.lastVerifiedAt = new Date(); row.probeMethod = receipt.method;
      row.lastToolsCount = receipt.toolsCount; row.lastError = null; row.updatedBySubject = subject;
      return row;
    },
    async recordProbeFailure(tenantId, key, failure, subject) {
      const row = rows.get(keyOf(key));
      if (!row) throw Object.assign(new Error('tool connection not found'), { status: 404 });
      row.state = 'failed'; row.probeMethod = failure.method ?? PROBE_METHOD_TOOLS_LIST; row.lastError = failure.error;
      row.lastVerifiedAt = null; row.lastToolsCount = null; row.updatedBySubject = subject;
      return row;
    },
  };
}

// A gate probe that always verifies, writing its receipts through
// the real store roads the route hands it — keyed by the entry AS
// PRESENTED (entry.seatId), exactly as the production probe keys
// by customGateKey(entry.seatId, entry.id).
function verifiedGateProbe() {
  return async ({ tenantId, entry, toolConnections }) => {
    const key = customGateKey(entry.seatId, entry.id);
    await toolConnections.beginProbe(tenantId, key, 'system:tool-probe');
    const row = await toolConnections.recordProbeReceipt(tenantId, key, { method: PROBE_METHOD_TOOLS_LIST, toolsCount: GATE_TOOLS.length }, 'system:tool-probe');
    return { probed: true, state: 'verified', toolsCount: GATE_TOOLS.length, tools: GATE_TOOLS, row };
  };
}

// ------------------------------------------------- fake credential service
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

function makeWorld() {
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  const credentials = fakeCredentials();
  const tc = fakeToolConnections();
  const read = createSeatLibraryRead({ libraryStore: store, toolConnectionsStore: tc });
  const handler = createConnectorLibraryWriteHandler({
    store,
    pendingStore: null,
    credentialClient: credentials,
    oauthClientFor: () => null,
    toolConnections: tc,
    gateProbe: verifiedGateProbe(),
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const actor = { subject: PERSON, tenantId: TENANT, role: 'owner', sessionId: 'sess-1', requestId: 'req-1' };
  const otherActor = { subject: OTHER_PERSON, tenantId: TENANT, role: 'owner', sessionId: 'sess-2', requestId: 'req-2' };
  const tenantBActor = { subject: PERSON, tenantId: TENANT_B, role: 'owner', sessionId: 'sess-3', requestId: 'req-3' };
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
  const arm = (seatId, personId = PERSON, tenantId = TENANT, entryId = ENTRY_ID) => resolveArmingRecord({
    store,
    credentials,
    listTools: async () => { throw new Error('listTools tripwire: the snapshot is already frozen'); },
    operatorTokens: {},
    toolConnections: tc,
    tenantId, personId, seatId, entryId,
  });
  const rowFor = async (seatId, personId = PERSON, tenantId = TENANT, entryId = ENTRY_ID) => {
    const view = await read.readSeatLibrary(tenantId, { personId, seatId });
    return view.rows.find((r) => r.entryId === entryId) ?? null;
  };
  return { pool, store, credentials, tc, read, runWrite, arm, rowFor, actor, otherActor, tenantBActor };
}

const refFor = (seatId, entryId = ENTRY_ID) =>
  buildConnectorTokenRef({ tenantId: TENANT, seatId, entryId, personId: PERSON, tokenKind: 'access' });

// ============================================ the headline flow (1–4)
test('SYNC S2a — a custom entry created on seat A is stocked in every seat’s library, connects via seat B under S1’s set, and removes everywhere via seat B', async () => {
  const w = makeWorld();

  // (1) Create the custom entry through seat A (claude) via the
  // real write handler — the entries road, gate probe included.
  const created = await w.runWrite('entries', {
    seatId: 'claude', name: 'Weather Tools', mcpEndpointUrl: 'https://weather.example.com/mcp', authMode: 'header',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.entry.id, ENTRY_ID);
  assert.equal(created.json.entry.seatId, 'claude');
  assert.equal(created.json.entry.provenanceSeatId, 'claude', 'the creating seat is recorded as provenance');
  assert.equal(created.json.entry.workspaceCustom, true);
  assert.equal(created.json.gate.state, 'verified', 'the gate probed the creating seat’s row at create');

  // The gate is per (seat, entry): creation verified CLAUDE's gate
  // row only. Gemini holds no gate row for this entry — the
  // verified state did not travel.
  assert.equal((await w.tc.get(TENANT, customGateKey('claude', ENTRY_ID)))?.state, 'verified');
  assert.equal(await w.tc.get(TENANT, customGateKey('gemini', ENTRY_ID)), null, 'no gate row exists for gemini — the gate did not travel');

  // WITHOUT touching seat B: seat B's library read lists the entry
  // — same id, one record, marked as the person's own workspace
  // custom, provenance named.
  const rowB = await w.rowFor('gemini');
  assert.ok(rowB, 'seat B library read lists the custom entry');
  assert.equal(rowB.entryId, ENTRY_ID, 'same entry id on seat B — one entry, not a copy');
  assert.equal(rowB.name, 'Weather Tools');
  assert.equal(rowB.kind, 'custom');
  assert.equal(rowB.workspaceCustom, true, 'marked as the person’s own custom entry');
  assert.equal(rowB.provenanceSeatId, 'claude', 'provenance is the creating seat');
  assert.equal(rowB.seatId, 'gemini', 'the row answers in the reading seat’s name');
  // Gate truth on B: no gate row for (gemini, entry) → the row
  // reads not-connected with the gate missing, whatever claude's
  // gate row says.
  assert.equal(rowB.state, 'not-connected');
  assert.equal(rowB.stateDetail.gate.state, 'missing', 'seat B’s gate state is its own row: missing');
  assert.equal(rowB.stateDetail.gate.passed, false);

  // Seat A's own read carries CLAUDE's gate row: verified.
  const rowA = await w.rowFor('claude');
  assert.equal(rowA.stateDetail.gate.state, 'verified', 'seat A’s gate state is its own row: verified');
  assert.equal(rowA.stateDetail.gate.passed, true);

  // The store-level roads agree with the read.
  const listedB = await w.store.listEntries(TENANT, 'gemini', { personId: PERSON });
  assert.deepEqual(listedB.map((e) => e.id), [ENTRY_ID], 'store list for seat B carries the entry for its owner');
  const fetchedB = await w.store.getEntry(TENANT, 'gemini', ENTRY_ID, { personId: PERSON });
  assert.equal(fetchedB.provenanceSeatId, 'claude');
  assert.equal(fetchedB.addedBy, PERSON);

  // A fresh seat inherits the entry on first read.
  const rowF = await w.rowFor('freshseat');
  assert.ok(rowF, 'a fresh seat’s library read lists the entry');
  assert.equal(rowF.entryId, ENTRY_ID);
  assert.equal(rowF.provenanceSeatId, 'claude');

  // Level 1 counts: the entry counts on every live seat for its
  // owner (entryCount), connected nowhere yet.
  const counts = await w.read.readSeatCounts(TENANT, { personId: PERSON });
  assert.equal(counts.seats.find((s) => s.seatId === 'claude')?.entryCount, 1, 'counts: claude counts the entry');
  assert.equal(counts.seats.find((s) => s.seatId === 'gemini')?.entryCount, 1, 'counts: gemini counts the same one entry');
  assert.equal(counts.seats.find((s) => s.seatId === 'gemini')?.connectedCount, 0);

  // (2) Connect it through seat B (gemini) — the header road.
  const start = await w.runWrite('connect', { seatId: 'gemini', entryId: ENTRY_ID });
  assert.equal(start.status, 200);
  assert.equal(start.json.status, 'needs-credential');
  const provenanceRef = refFor('claude');
  assert.equal(start.json.accessTokenRef, provenanceRef,
    'the reference is minted under the PROVENANCE seat — the seat the connection row lands on');
  assert.equal(start.json.providerId, 'connector.claude.custom-weather-tools');

  const landed = await w.runWrite('connect/header', {
    seatId: 'gemini', entryId: ENTRY_ID, apiKey: KEY_VALUE, accountLabel: 'Weather key',
  });
  assert.equal(landed.status, 201);
  assert.equal(landed.json.connection.seatId, 'claude', 'the connection landed on the entry’s provenance seat (S1’s set row)');
  assert.equal(landed.json.connection.accessTokenRef, provenanceRef);
  assert.equal(landed.json.connection.posture, 'ask', 'a custom connection lands at the gate’s default posture');
  assert.equal(landed.json.gate.state, 'verified');
  assert.equal(landed.json.gate.frozen, true, 'the gate probe’s tool list froze onto the set connection');
  assert.deepEqual(w.credentials.calls.filter(([n]) => n === 'storeCredential'),
    [['storeCredential', 'connector.claude.custom-weather-tools', provenanceRef]],
    'the key was stored under the provenance provider id and reference');

  // The connect through B ran B's OWN gate: gemini's gate row now
  // exists, verified by its own probe — not copied from claude.
  const gateB = await w.tc.get(TENANT, customGateKey('gemini', ENTRY_ID));
  assert.equal(gateB?.state, 'verified', 'seat B’s gate row was probed and verified on B’s own connect');
  const registerB = w.tc.calls.filter(([n, input]) => n === 'register' && input.scopeId === 'gemini');
  assert.equal(registerB.length, 1, 'the intent for gemini’s gate row was registered when B first consulted it');

  // S1 composition, proven not rebuilt: the SAME set connection
  // now reads connected on seat A (whose gate row passed at
  // create) and on seat B (whose gate row passed at connect).
  const rowA2 = await w.rowFor('claude');
  assert.equal(rowA2.state, 'connected', 'seat A shows the connection made via seat B');
  assert.equal(rowA2.accountIdentity, 'Weather key');
  assert.equal(rowA2.stateDetail.posture, 'ask');
  const rowB2 = await w.rowFor('gemini');
  assert.equal(rowB2.state, 'connected', 'seat B shows its own connection');
  assert.equal(rowB2.accountIdentity, 'Weather key');

  const accessA = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }, w.store);
  const accessB = await productionToolAccess(TENANT, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID }, w.store);
  assert.equal(accessA.connected, true);
  assert.equal(accessB.connected, true, 'tool-access on B reads the set connection');
  assert.equal(accessB.snapshotHash, accessA.snapshotHash, 'the same frozen snapshot on both seats');
  assert.deepEqual(accessB.tools.map((t) => t.name), ['read_weather', 'set_alert'], 'the frozen tools are the gate probe’s list');

  // Arming from seat B resolves the set's credential under the
  // provenance rules S1 established (the connection row's seat).
  const armedB = await w.arm('gemini');
  assert.equal(armedB.state, 'connected', 'seat B arms the custom entry');
  assert.equal(armedB.accessToken, KEY_VALUE, 'the credential stored via B resolves for B’s turn');
  assert.deepEqual(armedB.snapshotTools.map((t) => t.name), ['read_weather', 'set_alert']);
  const armedA = await w.arm('claude');
  assert.equal(armedA.state, 'connected', 'seat A arms it too');
  assert.equal(armedA.accessToken, KEY_VALUE);

  // (3) The gate's per-seat keying, stated as behaviour: a FRESH
  // seat inherits the entry and the connection set, but holds no
  // gate row of its own, so it cannot arm — its gate is missing
  // until a connect road through that seat runs its probe.
  const armedF = await w.arm('freshseat');
  assert.equal(armedF.state, 'not-gated', 'a fresh seat’s gate is its own row: missing → not-gated');
  const rowF2 = await w.rowFor('freshseat');
  assert.equal(rowF2.state, 'not-connected', 'the fresh seat’s row is capped by its own missing gate');
  assert.equal(rowF2.stateDetail.gate.state, 'missing');

  // (4) Remove it through seat B → gone from every seat, and its
  // set connection is gone everywhere with it.
  const removed = await w.runWrite('entries/remove', { seatId: 'gemini', entryId: ENTRY_ID });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.entry.id, ENTRY_ID);
  assert.equal(await w.store.getEntry(TENANT, 'claude', ENTRY_ID, { personId: PERSON }), null, 'gone from the creating seat');
  assert.equal(await w.store.getEntry(TENANT, 'gemini', ENTRY_ID, { personId: PERSON }), null, 'gone from seat B');
  assert.equal(await w.rowFor('claude'), null, 'seat A’s library no longer lists it');
  assert.equal(await w.rowFor('gemini'), null, 'seat B’s library no longer lists it');
  assert.equal(await w.store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: ENTRY_ID }), null, 'its connection is gone on seat A');
  assert.equal(await w.store.getConnection(TENANT, { personId: PERSON, seatId: 'gemini', entryId: ENTRY_ID }), null, 'its connection is gone on seat B');
  assert.deepEqual(await w.store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' }), [], 'no connection rows remain for the person');
});

// ======================================================= the walls (5)
test('SYNC S2a walls — another person, another tenant, catalog stocking, the duplicate-name rule, and the agent accounts', async () => {
  const w = makeWorld();

  // Troy creates Alpha on claude; the other person creates their
  // OWN Alpha (same name, same derived id) on gemini — allowed:
  // the duplicate rule compares against the creator's own stock.
  const alphaA = await w.runWrite('entries', { seatId: 'claude', name: 'Alpha', mcpEndpointUrl: 'https://alpha.example.com/mcp', authMode: 'header' });
  assert.equal(alphaA.status, 201);
  assert.equal(alphaA.json.entry.id, 'custom-alpha');
  const alphaOther = await w.runWrite('entries', { seatId: 'gemini', name: 'Alpha', mcpEndpointUrl: 'https://alpha-two.example.com/mcp', authMode: 'header' }, w.otherActor);
  assert.equal(alphaOther.status, 201, 'another person’s same-name custom on another seat is their own entry, not a collision');
  assert.equal(alphaOther.json.entry.id, 'custom-alpha');
  assert.equal(alphaOther.json.entry.addedBy, OTHER_PERSON);

  // Wall 1: another person's customs never appear. Each person's
  // read of the shared id shows THEIR entry (its provenance gives
  // it away); an entry only Troy created is absent from the other
  // person's reads on every seat.
  const troyGemini = await w.rowFor('gemini', PERSON, TENANT, 'custom-alpha');
  assert.equal(troyGemini.provenanceSeatId, 'claude', 'Troy’s gemini read shows TROY’s Alpha (provenance claude), not the physical gemini row');
  assert.equal(troyGemini.vendorLabel, 'Connector by Custom');
  const otherGemini = await w.rowFor('gemini', OTHER_PERSON, TENANT, 'custom-alpha');
  assert.equal(otherGemini.provenanceSeatId, 'gemini', 'the other person’s gemini read shows THEIR Alpha');
  const otherClaude = await w.rowFor('claude', OTHER_PERSON, TENANT, 'custom-alpha');
  assert.equal(otherClaude.provenanceSeatId, 'gemini', 'the other person’s entry projects to claude for them alone');

  const beta = await w.runWrite('entries', { seatId: 'claude', name: 'Beta', mcpEndpointUrl: 'https://beta.example.com/mcp', authMode: 'header' });
  assert.equal(beta.status, 201);
  assert.ok(await w.rowFor('gemini', PERSON, TENANT, 'custom-beta'), 'Troy’s Beta projects to gemini for Troy');
  assert.equal(await w.rowFor('gemini', OTHER_PERSON, TENANT, 'custom-beta'), null, 'Troy’s Beta never appears for the other person (seat B)');
  assert.equal(await w.rowFor('claude', OTHER_PERSON, TENANT, 'custom-beta'), null, 'Troy’s Beta never appears for the other person (seat A)');
  assert.equal(await w.store.getEntry(TENANT, 'gemini', 'custom-beta', { personId: OTHER_PERSON }), null, 'the store refuses the other person’s fetch of Troy’s custom');
  assert.equal((await w.arm('gemini', OTHER_PERSON, TENANT, 'custom-beta')).state, 'unknown-entry', 'arming treats another person’s custom as an unknown entry');

  // Wall 2: another tenant never appears — the same person, the
  // same seat names, a different tenant: nothing crosses.
  const gammaB = await w.runWrite('entries', { seatId: 'claude', name: 'Gamma', mcpEndpointUrl: 'https://gamma.example.com/mcp', authMode: 'header' }, w.tenantBActor);
  assert.equal(gammaB.status, 201);
  assert.equal(await w.rowFor('gemini', PERSON, TENANT, 'custom-gamma'), null, 'tenant B’s custom never appears in tenant A');
  assert.ok(await w.rowFor('gemini', PERSON, TENANT_B, 'custom-gamma'), 'and it projects normally inside its own tenant');
  assert.equal(await w.rowFor('claude', PERSON, TENANT_B, 'custom-beta'), null, 'tenant A’s customs never appear in tenant B either');

  // Wall 3: catalog entries are untouched — stocking stays
  // per-seat, in shape and in count. A catalog entry created on
  // claude alone does not appear on gemini by any road.
  await w.store.createEntry(TENANT, SUBJECT, {
    seatId: 'claude', id: 'catalog-solo', kind: 'catalog', name: 'Solo Catalog', oneLiner: 'Stocked per seat',
    vendorName: 'Solo Co', trustLabel: 'verified', category: 'productivity', brokerMode: 'helmian',
    mcpEndpointUrl: 'https://solo.example.com/mcp', authMode: 'header', addedBy: 'system',
  });
  assert.equal(await w.store.getEntry(TENANT, 'gemini', 'catalog-solo'), null, 'a catalog entry is still absent from a seat that does not stock it');
  assert.equal(await w.rowFor('gemini', PERSON, TENANT, 'catalog-solo'), null, 'the library read does not project catalog entries');
  const claudeIds = (await w.store.listEntries(TENANT, 'claude', { personId: PERSON })).map((e) => e.id);
  assert.ok(claudeIds.includes('catalog-solo'), 'and it stands on its own seat exactly as before');

  // Wall 4: the duplicate-name rule. The write road derives the
  // entry id from the name; a create whose name collides with the
  // creator's OWN workspace stock is refused on ANY seat now
  // (the comparison set widened from per-seat to per-person
  // workspace — the new truth the projection creates).
  const deltaA = await w.runWrite('entries', { seatId: 'claude', name: 'Delta', mcpEndpointUrl: 'https://delta.example.com/mcp', authMode: 'header' });
  assert.equal(deltaA.status, 201);
  const deltaSameSeat = await w.runWrite('entries', { seatId: 'claude', name: 'Delta', mcpEndpointUrl: 'https://delta.example.com/mcp', authMode: 'header' });
  assert.equal(deltaSameSeat.status, 409, 'same seat, same name: refused, as before');
  const deltaOtherSeat = await w.runWrite('entries', { seatId: 'gemini', name: 'Delta', mcpEndpointUrl: 'https://delta.example.com/mcp', authMode: 'header' });
  assert.equal(deltaOtherSeat.status, 409, 'another seat, same name, same person: refused — the workspace entry already exists');
  const deltaOtherPerson = await w.runWrite('entries', { seatId: 'chatgpt', name: 'Delta', mcpEndpointUrl: 'https://delta.example.com/mcp', authMode: 'header' }, w.otherActor);
  assert.equal(deltaOtherPerson.status, 201, 'another person’s same name is their own entry, not Troy’s collision');

  // Wall 5: the per-seat AGENT accounts system is untouched —
  // the whole flow's store traffic names only the connector
  // library's own four tables.
  const touched = new Set(w.pool.queries.flatMap((q) => [...q.text.matchAll(/(?:from|into|update)\s+helmion\.([a-z_]+)/g)].map((m) => m[1])));
  assert.deepEqual([...touched].sort(), ['connector_connections', 'connector_entries', 'connector_mirrors'],
    'only the connector library’s own tables were touched (this flow freezes no snapshot, so that table has no traffic)');
});

// ============================================ the entry collapse rule
test('SYNC S2a collapse — legacy per-seat duplicate custom rows: one workspace entry (most recently updated wins), removal deletes the whole group', async () => {
  const w = makeWorld();
  const T1 = new Date('2026-11-01T10:00:00.000Z');
  const T2 = new Date('2026-11-05T10:00:00.000Z');
  // Two physical rows for one (person, custom id), as production
  // may already hold from before the projection: claude's older,
  // gemini's newer, different names.
  w.pool.seedEntry({ seat_id: 'claude', id: 'custom-legacy', name: 'Legacy Old', updated_at: T1, created_at: T1 });
  w.pool.seedEntry({ seat_id: 'gemini', id: 'custom-legacy', name: 'Legacy New', updated_at: T2, created_at: T2 });

  const fetched = await w.store.getEntry(TENANT, 'chatgpt', 'custom-legacy', { personId: PERSON });
  assert.equal(fetched.name, 'Legacy New', 'the most recently updated row is the workspace entry');
  assert.equal(fetched.provenanceSeatId, 'gemini', 'its provenance is the winning row’s seat');
  const listed = await w.store.listEntries(TENANT, 'chatgpt', { personId: PERSON });
  assert.deepEqual(listed.filter((e) => e.id === 'custom-legacy').map((e) => e.name), ['Legacy New'], 'one entry lists, not two');
  const row = await w.rowFor('chatgpt', PERSON, TENANT, 'custom-legacy');
  assert.equal(row.name, 'Legacy New', 'the library read shows the winner');

  // A tie on updated_at breaks to the smallest seat id.
  const T3 = new Date('2026-11-06T10:00:00.000Z');
  w.pool.seedEntry({ seat_id: 'gemini', id: 'custom-tie', name: 'Tie Gemini', updated_at: T3, created_at: T3 });
  w.pool.seedEntry({ seat_id: 'claude', id: 'custom-tie', name: 'Tie Claude', updated_at: T3, created_at: T3 });
  const tied = await w.store.getEntry(TENANT, 'chatgpt', 'custom-tie', { personId: PERSON });
  assert.equal(tied.name, 'Tie Claude', 'a tie on updated_at breaks to the smallest seat id');
  assert.equal(tied.provenanceSeatId, 'claude');

  // Removal through a third seat deletes the WHOLE (id, owner)
  // group — no losing row resurrects the entry on the next read.
  const removed = await w.store.removeEntry(TENANT, 'chatgpt', 'custom-legacy', PERSON);
  assert.equal(removed.name, 'Legacy New');
  assert.equal(await w.store.getEntry(TENANT, 'claude', 'custom-legacy', { personId: PERSON }), null, 'the older physical row is gone too');
  assert.equal(await w.store.getEntry(TENANT, 'gemini', 'custom-legacy', { personId: PERSON }), null);
  assert.deepEqual((await w.store.listEntries(TENANT, 'claude')).filter((e) => e.id === 'custom-legacy'), [], 'no physical row remains on claude');
  assert.deepEqual((await w.store.listEntries(TENANT, 'gemini')).filter((e) => e.id === 'custom-legacy'), [], 'no physical row remains on gemini');
});

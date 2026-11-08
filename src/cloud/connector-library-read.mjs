// Connector library READ (connector-library SPEC §1.2/§3.2, build
// bite 2): the one read that assembles a seat's library for a person —
// the catalog/native entries from the library store, with live state
// joined from wherever that state honestly lives:
//
//   - helmian-brokered entries  → the person's connection record
//     (connector-library.mjs);
//   - vendor-brokered entries   → the person's mirror record — only
//     ever what the seat's vendor side last reported (§1.5);
//   - the Helmian-native GitHub entry → the EXISTING tool-connections
//     store (sql/061), joined by service id through the narrow adapter
//     below. The tool-connections store is the room's established truth
//     for that connection — its probe receipt earned the state, and
//     this read mints NO second connection record for it (§3.2).
//
// THE READ NEVER WRITES. Every store call below is a read; the bite's
// gate asserts zero writes against the library tables during a read,
// and that a read leaves the connections table exactly as it found it.
//
// Row shape: the five §1.2 fields first — iconRef, name, oneLiner,
// vendorLabel ("Connector by <vendor>") + trustLabel, state — then the
// supporting fields the surfaces need (ids, kind, brokerMode, category,
// accountIdentity, and a stateDetail carrying posture / mirror
// provenance / the native surface's own status words). State is
// exactly one of §1.2's four: 'not-connected', 'connected',
// 'needs-reconnect', 'disabled-by-owner'.

import { isVerifiedFresh } from './tool-connections.mjs';
import { NATIVE_STATE_SOURCES } from './connector-catalog.mjs';

// How long a tool-connections probe receipt still counts as Connected
// — the same window the room's surfaces already use
// (CONNECTION_FRESH_MS in web/marketing/app/app-model.mjs).
export const CONNECTOR_LIBRARY_FRESH_MS = 60 * 60 * 1000;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  return value.trim();
}

// ------------------------------------------------- tool-connections join
// The narrow read adapter over the existing store. The join point the
// repo already has: createToolConnectionsStore(pool).list(tenantId, {})
// — the same read GET /api/admin/tool-connections serves
// (src/cloud/tool-connections-read.mjs). A service can hold rows in
// several scopes (workspace + per-agent); the adapter returns the
// strongest truth any of them earned, ranked exactly as the room's
// surfaces rank it (app-model.mjs bestToolConnectionStatus): a live
// verified receipt first, then a failure (a broken connection is worth
// saying out loud), then staleness, then never-checked, then revoked.
const TOOL_STATUS_RANK = Object.freeze({ connected: 5, failed: 4, stale: 3, unchecked: 2, revoked: 1, none: 0 });

export function toolConnectionSurfaceStatus(row, { now = Date.now(), maxAgeMs = CONNECTOR_LIBRARY_FRESH_MS } = {}) {
  if (!row) return { status: 'none', connected: false };
  if (row.state === 'verified' && row.lastVerifiedAt) {
    return isVerifiedFresh(row, { now, maxAgeMs })
      ? { status: 'connected', connected: true }
      : { status: 'stale', connected: false };
  }
  if (row.state === 'failed') return { status: 'failed', connected: false };
  if (row.state === 'revoked') return { status: 'revoked', connected: false };
  // 'registered' / 'probing': intent on file, never proven either way.
  return { status: 'unchecked', connected: false };
}

export function createToolConnectionSurface(toolConnectionsStore) {
  if (!toolConnectionsStore || typeof toolConnectionsStore.list !== 'function') {
    throw Object.assign(new Error('createToolConnectionSurface needs the tool-connections store'), { status: 500 });
  }
  return {
    /**
     * The strongest surface status for one service in this tenant, or
     * 'none' when the store holds no row for it. Read-only: list() is
     * the store's only method this adapter calls.
     */
    async surfaceFor(tenantId, serviceId, opts = {}) {
      const rows = await toolConnectionsStore.list(tenantId, {});
      let best = { status: 'none', connected: false, row: null };
      for (const row of rows) {
        if (String(row?.serviceId ?? '') !== serviceId) continue;
        const status = toolConnectionSurfaceStatus(row, opts);
        if (TOOL_STATUS_RANK[status.status] > TOOL_STATUS_RANK[best.status]) {
          best = { ...status, row };
        }
      }
      return best;
    },
  };
}

// ------------------------------------------------------------ state joins

// Headline state for a surfaced native entry, from the tool-connections
// surface status. Only a verified+fresh receipt reads 'connected' —
// the honesty rule the tool-connections store exists to enforce
// (app-model.mjs: rows keep connected=true only for verified+fresh).
// Every other surface status reads 'not-connected' at the headline —
// §1.2 has no "stale" state, and 'needs-reconnect' is defined for a
// failed token refresh, which a probe receipt is not — while the
// precise truth (stale / failed / unchecked, the receipt's timestamp
// and tool count) rides in stateDetail for the surfaces to word.
function nativeRowState(surface) {
  if (!surface || surface.status === 'none') {
    return { state: 'not-connected', accountIdentity: null, detail: { source: 'tool-connections', toolStatus: 'none' } };
  }
  const detail = {
    source: 'tool-connections',
    toolStatus: surface.status,
    scopeKind: surface.row?.scopeKind ?? null,
    lastVerifiedAt: surface.row?.lastVerifiedAt ?? null,
    lastToolsCount: surface.row?.lastToolsCount ?? null,
    lastError: surface.row?.lastError ?? null,
  };
  if (surface.status === 'connected') {
    return { state: 'connected', accountIdentity: surface.row?.accountLabel ?? null, detail };
  }
  return { state: 'not-connected', accountIdentity: null, detail };
}

function joinedState(entry, { connection, mirror, nativeSurface }) {
  // The owner's disable wins over every other state (§1.2's fourth
  // state is entry-level, §2.1).
  if (entry.state === 'disabled-by-owner') {
    return { state: 'disabled-by-owner', accountIdentity: null, detail: null };
  }
  const source = NATIVE_STATE_SOURCES[entry.id];
  if (source?.stateSource === 'tool-connections') {
    return nativeRowState(nativeSurface);
  }
  if (entry.brokerMode === 'vendor') {
    if (!mirror) return { state: 'not-connected', accountIdentity: null, detail: null };
    return {
      state: mirror.reportedState === 'connected' ? 'connected' : 'not-connected',
      accountIdentity: mirror.reportedAccountIdentity ?? null,
      detail: { managedBy: 'vendor', manageUrl: entry.vendorConnectorRef?.manageUrl ?? null, reportedAt: mirror.reportedAt ?? null },
    };
  }
  if (source?.stateSource === 'helmian-service') {
    // Scribe: Helmian's own service. Until a connection or seat-side
    // report exists for this person, the honest row is not-connected —
    // the read never invents a state nobody recorded.
    if (!connection || connection.state === 'disconnected') {
      return { state: 'not-connected', accountIdentity: null, detail: { source: 'helmian-service' } };
    }
  }
  if (!connection || connection.state === 'disconnected') {
    return { state: 'not-connected', accountIdentity: null, detail: null };
  }
  if (connection.state === 'needs-reconnect') {
    return { state: 'needs-reconnect', accountIdentity: connection.accountIdentity ?? null, detail: null };
  }
  return {
    state: 'connected',
    accountIdentity: connection.accountIdentity ?? null,
    detail: { posture: connection.posture, lastUsedAt: connection.lastUsedAt ?? null },
  };
}

const STATE_RANK = Object.freeze({ connected: 0, 'needs-reconnect': 1, 'not-connected': 2, 'disabled-by-owner': 3 });

function rowOf(entry, joined) {
  return {
    // The five §1.2 fields, in order.
    iconRef: entry.iconRef ?? null,
    name: entry.name,
    oneLiner: entry.oneLiner,
    vendorLabel: `Connector by ${entry.vendorName}`,
    trustLabel: entry.trustLabel,
    state: joined.state,
    // Supporting fields for the surfaces (Bites 3/5) — not row fields.
    entryId: entry.id,
    seatId: entry.seatId,
    kind: entry.kind,
    brokerMode: entry.brokerMode,
    category: entry.category ?? null,
    accountIdentity: joined.accountIdentity,
    stateDetail: joined.detail,
  };
}

// ------------------------------------------------------------------- read

export function createSeatLibraryRead({ libraryStore, toolConnectionsStore } = {}) {
  if (!libraryStore
    || typeof libraryStore.listEntries !== 'function'
    || typeof libraryStore.listConnections !== 'function'
    || typeof libraryStore.listMirrors !== 'function') {
    throw Object.assign(new Error('createSeatLibraryRead needs the connector library store'), { status: 500 });
  }
  const surface = toolConnectionsStore ? createToolConnectionSurface(toolConnectionsStore) : null;

  return {
    /**
     * One person's view of one seat's library: every entry in that
     * seat's library, state joined, sorted connected-first then by
     * name (§1.2's browse rule). Person and seat are both required —
     * there is no cross-seat or cross-person read (§3.4).
     */
    async readSeatLibrary(tenantId, { personId, seatId, now = Date.now(), verifiedMaxAgeMs = CONNECTOR_LIBRARY_FRESH_MS } = {}) {
      const person = requireString(personId ?? '', 'personId');
      const seat = requireString(seatId ?? '', 'seatId');
      const [entries, connections, mirrors] = await Promise.all([
        libraryStore.listEntries(tenantId, seat),
        libraryStore.listConnections(tenantId, { personId: person, seatId: seat }),
        libraryStore.listMirrors(tenantId, { personId: person, seatId: seat }),
      ]);
      const connectionByEntry = new Map(connections.map((c) => [c.entryId, c]));
      const mirrorByEntry = new Map(mirrors.map((m) => [m.entryId, m]));

      // Join the surfaced natives from the tool-connections store —
      // one list read per surfaced service, shared across the entries
      // that name it (today: GitHub only).
      const nativeSurfaces = new Map();
      if (surface) {
        for (const entry of entries) {
          const source = NATIVE_STATE_SOURCES[entry.id];
          if (source?.stateSource === 'tool-connections' && !nativeSurfaces.has(source.serviceId)) {
            nativeSurfaces.set(source.serviceId, await surface.surfaceFor(tenantId, source.serviceId, { now, maxAgeMs: verifiedMaxAgeMs }));
          }
        }
      }

      const rows = entries.map((entry) => {
        const source = NATIVE_STATE_SOURCES[entry.id];
        const nativeSurface = source?.stateSource === 'tool-connections'
          ? nativeSurfaces.get(source.serviceId) ?? null
          : null;
        return rowOf(entry, joinedState(entry, {
          connection: connectionByEntry.get(entry.id) ?? null,
          mirror: mirrorByEntry.get(entry.id) ?? null,
          nativeSurface,
        }));
      });
      rows.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
      return {
        seatId: seat,
        personId: person,
        connectedCount: rows.filter((row) => row.state === 'connected').length,
        rows,
      };
    },
  };
}

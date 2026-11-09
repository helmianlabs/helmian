// Connector library READ (connector-library SPEC §1.2/§3.2, build
// bite 2): the one read that assembles a seat's library for a person —
// the catalog/native entries from the library store, with live state
// joined from wherever that state honestly lives:
//
//   - helmian-brokered entries  → the person's connection record
//     (connector-library.mjs);
//   - vendor-brokered entries   → the person's mirror record — only
//     ever what the seat's vendor side last reported (§1.5);
//   - the Helmian-native GitHub entry → joined from the two places
//     that truth already lives, through the two narrow adapters below:
//     the workspace's per-channel repo links (the envoy store's
//     channels list — a channel whose config carries github.repo is
//     linked, and that link is the connection the room lives by), and
//     the EXISTING tool-connections store (sql/061), joined by service
//     id. Either source reading connected makes the row connected;
//     this read mints NO second connection record for it (§3.2).
//
// THE READ WRITES EXACTLY ONE THING, EXACTLY ONCE: the first read for
// a tenant whose library holds ZERO catalog entries seeds that
// tenant's catalog (seed-on-first-read — see maybeSeedTenant below),
// because the catalog otherwise exists only as data in code and a
// fresh workspace's library would sit empty until someone ran the
// refresh by hand. The seed goes through the catalog refresh road
// (connector-catalog.mjs), which writes ENTRIES ONLY — never
// connections, mirrors, or snapshots — and reports brokerMode
// conflicts instead of forcing them. Every other read path is
// read-only: a read of a tenant holding any entries performs zero
// writes, and a read never touches the connections table.
//
// Row shape: the five §1.2 fields first — iconRef, name, oneLiner,
// vendorLabel ("Connector by <vendor>") + trustLabel, state — then the
// supporting fields the surfaces need (ids, kind, brokerMode, category,
// accountIdentity, and a stateDetail carrying posture / mirror
// provenance / the native surface's own status words). State is
// exactly one of §1.2's four: 'not-connected', 'connected',
// 'needs-reconnect', 'disabled-by-owner'.

import { isVerifiedFresh } from './tool-connections.mjs';
import { NATIVE_STATE_SOURCES, LIVE_SEATS, createCatalogRefresh } from './connector-catalog.mjs';

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

// ------------------------------------------------------- seed-on-first-read
// In-flight seed promises, keyed by tenant, at MODULE level — on
// purpose. The live route builds a fresh read object per request
// (connector-library-read-route.mjs productionRead), so a closure-level
// map would give every concurrent request its own seed. Module level
// means every read object in this process shares one in-flight seed
// per tenant: two simultaneous first reads await the SAME refresh and
// the refresh runs once. The entry is removed when the seed settles —
// a failed seed on a still-empty tenant may be retried by a later
// read; a settled seed is never needed again because the tenant then
// holds entries and the zero-check keeps every later read out of here.
// Cross-process races (two server processes seeding at once) are
// covered differently: the refresh upserts entry by entry, and a
// uniqueness collision (23505) lands in the same catch as any other
// seed failure — the read continues and serves whatever has landed.
const seedInFlightByTenant = new Map();

const SEED_NOT_ATTEMPTED = Object.freeze({ attempted: false, seeded: false, conflicts: Object.freeze([]) });

// Flatten a refresh summary's brokerMode conflicts, whichever job
// shape produced it: refreshAll → { seats: [{ conflicts }] },
// runCatalogRefreshOnce → [{ seats: [...] }]. Conflicts are how the
// refresh says "this stored entry disagrees; I skipped it" — the seed
// surfaces them, it never forces the entry (§3.1).
function collectSeedConflicts(summary) {
  const perTenant = Array.isArray(summary) ? summary : [summary];
  const conflicts = [];
  for (const tenantSummary of perTenant) {
    for (const seatSummary of tenantSummary?.seats ?? []) {
      for (const conflict of seatSummary?.conflicts ?? []) conflicts.push(conflict);
    }
  }
  return conflicts;
}

function seedErrorShape(error) {
  return {
    message: String(error?.message ?? error ?? 'catalog seed failed'),
    code: error?.code ?? null,
    status: error?.status ?? null,
  };
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

// ------------------------------------------- channel repo-link join
// The second GitHub truth, and the one the room lives by: the
// per-channel repo link. A channel's config (the latest
// 'system:envoy-config' record for the channel, parsed by
// envoy-agents.mjs) carries github.repo once an owner links a repo to
// that channel; the rail's GITHUB section, the channel header badge,
// and the GitHub webhook's commit/PR stream all read that same link.
//
// The adapter wraps the envoy store's channels-list-with-config read
// (createEnvoyStore(pool).listChannels in envoy-chat.mjs — the read
// the rail's channel list is built from, whose attachChannelLinks
// puts the parsed config's github link on each channel). No second
// link store exists or is created here: the config records remain
// the only place a link lives, and this adapter only reads them.
//
// Tenant scope is the ACTOR's own: listChannels runs inside the
// actor's tenant transaction behind the active-membership check, so
// the links it returns are that tenant's and no other's — the read
// cannot be aimed at another workspace's channels.
export function createChannelRepoLinkSurface(envoyStore) {
  if (!envoyStore || typeof envoyStore.listChannels !== 'function') {
    throw Object.assign(new Error('createChannelRepoLinkSurface needs the envoy store'), { status: 500 });
  }
  return {
    /**
     * Every repo link in the actor's tenant: one entry per channel
     * whose config links a repo, in a deterministic order (channel
     * display name, then repo) so the headline link is stable.
     * Read-only: listChannels is the only store method called.
     */
    async linksFor(actor) {
      const { channels } = await envoyStore.listChannels(actor);
      const links = [];
      for (const channel of channels ?? []) {
        const repo = String(channel?.github?.repo ?? '').trim();
        if (!repo) continue;
        links.push({
          channelId: String(channel.id),
          slug: channel.slug ?? null,
          title: channel.title ?? null,
          repo,
          linkedAt: channel.github?.linkedAt ?? null,
        });
      }
      links.sort((a, b) => channelDisplayName(a).localeCompare(channelDisplayName(b)) || a.repo.localeCompare(b.repo));
      return links;
    },
  };
}

// How a linked channel is named in state details: '#Team' — the
// title the room shows, falling back to the slug.
export function channelDisplayName(link) {
  return `#${link?.title || link?.slug || 'channel'}`;
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

// Headline state for the Helmian-native GitHub entry, from BOTH of
// its sources. Ranking, honestly:
//   · A repo link is CONNECTED, full stop. The link is live config
//     the room acts on continuously — the header badge renders from
//     it and commits/PRs stream through it — not a probe receipt, so
//     no freshness window applies to it, and it outranks even a
//     failed or stale tool-connections row (the probe's opinion of a
//     different road cannot unplug the link the room is using).
//   · No link → the tool-connections surface decides, exactly as
//     nativeRowState has always ruled it (verified+fresh only).
// When both fire, the detail names the link as the source and still
// records the agreeing receipt underneath.
function nativeGithubState({ surface, repoLinks }) {
  const links = Array.isArray(repoLinks) ? repoLinks : [];
  if (!links.length) return nativeRowState(surface);
  const first = links[0];
  const via = channelDisplayName(first);
  const detail = {
    source: 'channel-repo-links',
    repo: first.repo,
    repos: [...new Set(links.map((link) => link.repo))],
    viaChannel: via,
    channelCount: links.length,
    channels: links.map((link) => ({ channel: channelDisplayName(link), repo: link.repo })),
    summary: links.length === 1
      ? `${first.repo} via ${via}`
      : `${first.repo} via ${via} +${links.length - 1} more channel${links.length === 2 ? '' : 's'}`,
  };
  if (surface?.status === 'connected') {
    detail.toolStatus = 'connected';
    detail.toolAccountLabel = surface.row?.accountLabel ?? null;
  }
  return { state: 'connected', accountIdentity: first.repo, detail };
}

function joinedState(entry, { connection, mirror, nativeSurface, repoLinks }) {
  // The owner's disable wins over every other state (§1.2's fourth
  // state is entry-level, §2.1).
  if (entry.state === 'disabled-by-owner') {
    return { state: 'disabled-by-owner', accountIdentity: null, detail: null };
  }
  const source = NATIVE_STATE_SOURCES[entry.id];
  if (source?.repoLinks === true) {
    return nativeGithubState({ surface: nativeSurface, repoLinks });
  }
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

export function createSeatLibraryRead({
  libraryStore,
  toolConnectionsStore,
  envoyStore = null,
  seedCatalog = null,
  catalogRefresh = null,
  seedSubject = 'system',
  seedLogger = null,
} = {}) {
  if (!libraryStore
    || typeof libraryStore.listEntries !== 'function'
    || typeof libraryStore.listConnections !== 'function'
    || typeof libraryStore.listMirrors !== 'function') {
    throw Object.assign(new Error('createSeatLibraryRead needs the connector library store'), { status: 500 });
  }
  if (seedCatalog !== null && typeof seedCatalog !== 'function') {
    throw Object.assign(new Error('seedCatalog must be an async (tenantId) => refreshSummary function when given'), { status: 500 });
  }
  if (catalogRefresh !== null && typeof catalogRefresh?.refreshAll !== 'function') {
    throw Object.assign(new Error('catalogRefresh must be a createCatalogRefresh result when given'), { status: 500 });
  }
  const surface = toolConnectionsStore ? createToolConnectionSurface(toolConnectionsStore) : null;
  const repoLinkSurface = envoyStore ? createChannelRepoLinkSurface(envoyStore) : null;

  // The default seed IS the existing catalog refresh machinery, built
  // on the same store this read reads through — no second seeding road.
  const runSeedCatalog = seedCatalog ?? (async (tenantId) => {
    const refresh = catalogRefresh ?? createCatalogRefresh({ libraryStore, subject: seedSubject });
    return refresh.refreshAll(tenantId);
  });

  function logSeedFailure(tenantId, error) {
    const line = `[connector-library] catalog seed failed for tenant ${tenantId}: ${error?.message ?? error}`;
    try {
      if (typeof seedLogger === 'function') seedLogger(line, error);
      else if (seedLogger && typeof seedLogger.error === 'function') seedLogger.error(line);
      else console.error(line);
    } catch { /* a logger must never break the read either */ }
  }

  // Run the seed for one tenant, sharing one in-flight run per tenant
  // across every read object in the process (see the map above). The
  // first caller's refresh is the run; concurrent callers join it.
  // NEVER rejects: the outcome — seeded, or failed with the error's
  // shape — is data the read returns, not an exception it throws.
  function runSeedOnce(tenantId) {
    const inFlight = seedInFlightByTenant.get(tenantId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const summary = await runSeedCatalog(tenantId);
        return { attempted: true, seeded: true, conflicts: collectSeedConflicts(summary) };
      } catch (error) {
        // Includes the cross-process uniqueness race (23505): another
        // seeder's rows are landing (or have landed) — say so in the
        // metadata and let the read serve what exists.
        logSeedFailure(tenantId, error);
        return { attempted: true, seeded: false, conflicts: [], error: seedErrorShape(error) };
      }
    })();
    seedInFlightByTenant.set(tenantId, promise);
    promise.then(() => {
      if (seedInFlightByTenant.get(tenantId) === promise) seedInFlightByTenant.delete(tenantId);
    });
    return promise;
  }

  // Seed only when the TENANT holds zero catalog entries — not merely
  // when this seat is empty (a partly-seeded or partly-deleted tenant
  // is a state a human refresh decides about, never a read). The probe
  // covers the requested seat (already listed by the caller) plus the
  // catalog seats; it runs only on the empty-seat path, so a populated
  // read pays nothing for it.
  async function maybeSeedTenant(tenantId, seatId, entriesForSeat) {
    if (entriesForSeat.length > 0) return SEED_NOT_ATTEMPTED;
    for (const otherSeat of LIVE_SEATS) {
      if (otherSeat === seatId) continue;
      const other = await libraryStore.listEntries(tenantId, otherSeat);
      if (other.length > 0) return SEED_NOT_ATTEMPTED;
    }
    return runSeedOnce(tenantId);
  }

  return {
    /**
     * One person's view of one seat's library: every entry in that
     * seat's library, state joined, sorted connected-first then by
     * name (§1.2's browse rule). Person and seat are both required —
     * there is no cross-seat or cross-person read (§3.4).
     */
    async readSeatLibrary(tenantId, { personId, seatId, now = Date.now(), verifiedMaxAgeMs = CONNECTOR_LIBRARY_FRESH_MS, actor = null } = {}) {
      const person = requireString(personId ?? '', 'personId');
      const seat = requireString(seatId ?? '', 'seatId');
      let [entries, connections, mirrors] = await Promise.all([
        libraryStore.listEntries(tenantId, seat),
        libraryStore.listConnections(tenantId, { personId: person, seatId: seat }),
        libraryStore.listMirrors(tenantId, { personId: person, seatId: seat }),
      ]);
      // Seed-on-first-read: a tenant with zero catalog entries gets
      // one refresh, then the read re-lists and serves the seeded
      // rows. A failed seed never fails the read — the listings are
      // re-read (another seeder may have landed rows meanwhile) and
      // the failure rides in the result's `seed` metadata.
      const seed = await maybeSeedTenant(tenantId, seat, entries);
      if (seed.attempted) {
        [entries, connections, mirrors] = await Promise.all([
          libraryStore.listEntries(tenantId, seat),
          libraryStore.listConnections(tenantId, { personId: person, seatId: seat }),
          libraryStore.listMirrors(tenantId, { personId: person, seatId: seat }),
        ]);
      }
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

      // Join the tenant's per-channel repo links for the natives
      // that name them (today: helmian-github), one channels read per
      // library read. The envoy store's list is membership-checked
      // against the ACTOR, so the join needs the caller's actor; a
      // read without one (a test, a non-route caller) simply leaves
      // this source silent and the tool-connections surface decides —
      // it never guesses at links it could not read.
      let tenantRepoLinks = null;
      if (repoLinkSurface && actor && entries.some((entry) => NATIVE_STATE_SOURCES[entry.id]?.repoLinks === true)) {
        tenantRepoLinks = await repoLinkSurface.linksFor(actor);
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
          repoLinks: tenantRepoLinks,
        }));
      });
      rows.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
      return {
        seatId: seat,
        personId: person,
        connectedCount: rows.filter((row) => row.state === 'connected').length,
        rows,
        // Seed metadata: { attempted, seeded, conflicts } plus, on
        // failure, error { message, code, status }. attempted:false
        // is the normal read — the tenant already held entries.
        seed,
      };
    },
  };
}

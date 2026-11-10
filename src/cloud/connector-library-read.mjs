// Connector library READ (connector-library SPEC §1.2/§3.2, build
// bite 2): the one read that assembles a seat's library for a person —
// the catalog/native entries from the library store, with live state
// joined from wherever that state honestly lives:
//
//   - helmian-brokered entries  → the person's connection record
//     (connector-library.mjs);
//   - CUSTOM entries additionally join their GATE row from the
//     tool-connections store (connector-custom-gate.mjs, pipeline
//     map G1): the null-credential probe receipt that says whether
//     the entry may connect and arm at all. The gate rides in the
//     row's stateDetail, and an entry whose gate has not passed
//     never reads 'connected' here — a connection recorded before
//     the gate existed does not outrank it.
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
// THE READ WRITES IN EXACTLY TWO CASES, both through the same
// one-flight catalog refresh road (connector-catalog.mjs), which
// writes ENTRIES ONLY — never connections, mirrors, or snapshots —
// and reports brokerMode conflicts instead of forcing them:
//   1. SEED — the first read for a tenant whose library holds ZERO
//      catalog entries seeds that tenant's catalog
//      (seed-on-first-read — see maybeSeedTenant below), because the
//      catalog otherwise exists only as data in code and a fresh
//      workspace's library would sit empty until someone ran the
//      refresh by hand.
//   2. HEAL — a read for a seat that already holds catalog entries
//      but lacks ids the code catalog has since gained runs the
//      refresh once (see maybeHealCatalog below), because a
//      populated tenant otherwise never refreshes and a new catalog
//      entry — Idiolect, added by bite M2 — would never reach its
//      library at all (the M2 live-walk defect C).
// Every other read path is read-only: a read whose seat library is
// current performs ZERO writes, and a read never touches the
// connections table.
//
// Row shape: the five §1.2 fields first — iconRef, name, oneLiner,
// vendorLabel ("Connector by <vendor>") + trustLabel, state — then the
// supporting fields the surfaces need (ids, kind, brokerMode, category,
// accountIdentity, and a stateDetail carrying posture / mirror
// provenance / the native surface's own status words). State is
// exactly one of §1.2's four: 'not-connected', 'connected',
// 'needs-reconnect', 'disabled-by-owner'.

import { isVerifiedFresh } from './tool-connections.mjs';
import { customGateDetail, customGateKey } from './connector-custom-gate.mjs';
import { NATIVE_STATE_SOURCES, LIVE_SEATS, createCatalogRefresh, catalogEntriesForSeat, catalogStarterActions } from './connector-catalog.mjs';

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

function joinedStateInner(entry, { connection, mirror, nativeSurface, repoLinks }) {
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

// The gate wrapper (G1): for a custom entry whose gate row was
// read (gateRow present — a row object, or null when the store
// holds none), a gate that has not passed caps the row at
// 'not-connected' with the gate as its detail, whatever the
// connection record says; a passed gate rides in the detail beside
// the joined state. The owner's disable is ruled first inside the
// inner join and keeps its own headline here too — the wrapper
// steps aside for it. Entries the gate does not govern, and reads
// whose store could not answer the gate (gateRow undefined), take
// the inner join untouched.
//
// Exported because the Level 1 counts read (readSeatCounts below)
// rules every entry through this same join — the counts are the
// rows' states counted, never a second, drifting state logic.
export function joinedState(entry, deps) {
  const gateRow = deps?.gateRow;
  if (entry.kind !== 'custom' || gateRow === undefined || entry.state === 'disabled-by-owner') {
    return joinedStateInner(entry, deps);
  }
  const gate = customGateDetail(gateRow);
  if (!gate.passed) {
    return { state: 'not-connected', accountIdentity: null, detail: { gate } };
  }
  const inner = joinedStateInner(entry, deps);
  return { ...inner, detail: { ...(inner.detail ?? {}), gate } };
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
    // Catalog starter actions (mirror-design §4, bite M2): the
    // vendor-published quick actions the catalog carries a copy of
    // for this entry, joined from the catalog data — never stored
    // state. Absent (not empty) when the catalog holds none.
    ...(catalogStarterActions(entry.seatId, entry.id)
      ? { starterActions: catalogStarterActions(entry.seatId, entry.id) }
      : {}),
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
  // when this seat is empty (a partly-seeded tenant — some seats
  // seeded, this one empty — is a state a human refresh decides
  // about, never a read; the heal below covers the different case of
  // a populated seat missing additions). The probe covers the
  // requested seat (already listed by the caller) plus the catalog
  // seats; it runs only on the empty-seat path, so a populated read
  // pays nothing for it.
  async function maybeSeedTenant(tenantId, seatId, entriesForSeat) {
    if (entriesForSeat.length > 0) return SEED_NOT_ATTEMPTED;
    for (const otherSeat of LIVE_SEATS) {
      if (otherSeat === seatId) continue;
      const other = await libraryStore.listEntries(tenantId, otherSeat);
      if (other.length > 0) return SEED_NOT_ATTEMPTED;
    }
    return runSeedOnce(tenantId);
  }

  // Heal for catalog ADDITIONS: a seat that already holds catalog
  // entries but lacks ids the code catalog now holds for that seat
  // runs the same one-flight refresh, and the read then re-lists.
  // This is the durable half of the Idiolect fix (M2 walk defect C):
  // the catalog gained an entry in code, populated tenants never
  // refreshed, and the entry — plus the starter actions that ride
  // under it — never reached the menu.
  //
  // The trigger is deliberately narrow:
  //   · the seat must already hold at least one catalog/native entry
  //     (a wholly empty seat in a populated tenant stays the seed
  //     gate's settled case above — a human refresh decides);
  //   · only ids the CATALOG holds and the store lacks count —
  //     stored ids the catalog no longer holds never trigger, and
  //     the refresh never removes anything;
  //   · custom entries count toward neither set: the refresh writes
  //     catalog/native entries only and cannot touch a custom.
  //
  // THE DELETION TRADE-OFF, chosen deliberately (FIX-C report): the
  // refresh only ever adds/updates, so a catalog entry a person
  // deliberately removed from a populated seat RETURNS on that
  // seat's next read. Catalog entries are operator-curated — they
  // mirror a vendor's published catalog — and resurrection-on-read
  // is the accepted behaviour for them; the entry-level disable
  // ('disabled-by-owner') is the durable way to keep one out of the
  // way, and a refresh preserves it. Recording deletions
  // (tombstones) is the future fix if deleting catalog entries ever
  // becomes a real product act.
  async function maybeHealCatalog(tenantId, seatId, entriesForSeat) {
    if (!LIVE_SEATS.includes(seatId)) return SEED_NOT_ATTEMPTED;
    const storedCatalogIds = new Set(
      entriesForSeat
        .filter((entry) => entry.kind === 'catalog' || entry.kind === 'helmian-native')
        .map((entry) => entry.id),
    );
    if (storedCatalogIds.size === 0) return SEED_NOT_ATTEMPTED;
    const missing = catalogEntriesForSeat(seatId)
      .map((entry) => entry.id)
      .filter((id) => !storedCatalogIds.has(id));
    if (missing.length === 0) return SEED_NOT_ATTEMPTED;
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
      // rows. Heal-on-read: a populated seat missing catalog
      // additions gets the same one refresh (maybeHealCatalog). A
      // failed run never fails the read — the listings are re-read
      // (another seeder may have landed rows meanwhile) and the
      // failure rides in the result's `seed` metadata.
      let seed = await maybeSeedTenant(tenantId, seat, entries);
      if (!seed.attempted) seed = await maybeHealCatalog(tenantId, seat, entries);
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

      // Join the custom entries' gate rows (G1) — one get per
      // custom entry, only when the tool-connections store can
      // answer gets (the production store can; a list-only fake
      // leaves gateRow undefined and the join silent, the same
      // discipline as the repo-link join without an actor).
      const gateRows = new Map();
      if (toolConnectionsStore && typeof toolConnectionsStore.get === 'function') {
        for (const entry of entries) {
          if (entry.kind !== 'custom') continue;
          gateRows.set(entry.id, await toolConnectionsStore.get(tenantId, customGateKey(entry.seatId, entry.id)));
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
          repoLinks: tenantRepoLinks,
          gateRow: gateRows.has(entry.id) ? gateRows.get(entry.id) : undefined,
        }));
      });
      rows.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
      return {
        seatId: seat,
        personId: person,
        connectedCount: rows.filter((row) => row.state === 'connected').length,
        rows,
        // Seed metadata: { attempted, seeded, conflicts } plus, on
        // failure, error { message, code, status }. attempted:true
        // covers the empty-tenant seed AND the additions heal — both
        // are the same one-flight refresh. attempted:false is the
        // normal read — the tenant held entries and this seat's
        // catalog is current, so the read wrote nothing.
        seed,
      };
    },

    /**
     * Level 1 (SPEC §1.1): every live seat's counts for this person —
     * entryCount and connectedCount — the seats read the composer
     * panel and the Manage surface's seat tabs are picked from.
     *
     * This exists because the counts are ALL that read needs, and
     * producing them from readSeatLibrary cost a full library read
     * per seat: three list transactions plus the two tenant-level
     * joins (the tool-connections surface list and the envoy
     * channels list, which exist to state ONE native row) — times
     * fourteen seats, sequentially, for two numbers per seat (the
     * 2026-11-09 live walks measured that fan-out at ~20 seconds).
     * Here the listings are made once for the whole tenant (the
     * store's summary reads, connector-library.mjs), the two joins
     * are resolved once (they are tenant facts, identical for every
     * seat), and each entry is ruled through the SAME joinedState
     * the row read uses — so a seat's connectedCount here is its
     * rows' connected states counted, by construction, not by a
     * parallel approximation.
     *
     * Seed/heal parity with readSeatLibrary, tenant-wide: an empty
     * tenant seeds once; a populated seat missing catalog additions
     * heals once (the same one-flight refresh either way); the
     * entries are then re-listed. Connections and mirrors are not
     * re-read after a refresh — it writes entries only.
     *
     * Stores without the summary reads (test fakes, older wirings)
     * fall back to assembling the same listings per seat; the joins
     * still resolve once. The route keeps its own legacy fallback
     * for read objects without this method at all.
     */
    async readSeatCounts(tenantId, { personId, now = Date.now(), verifiedMaxAgeMs = CONNECTOR_LIBRARY_FRESH_MS, actor = null } = {}) {
      const person = requireString(personId ?? '', 'personId');
      const summaryReads = typeof libraryStore.listEntriesForTenant === 'function'
        && typeof libraryStore.listConnectionsForTenant === 'function'
        && typeof libraryStore.listMirrorsForTenant === 'function';
      const listAll = async () => {
        if (summaryReads) {
          return Promise.all([
            libraryStore.listEntriesForTenant(tenantId),
            libraryStore.listConnectionsForTenant(tenantId, { personId: person }),
            libraryStore.listMirrorsForTenant(tenantId, { personId: person }),
          ]);
        }
        const entries = [];
        const connections = [];
        const mirrors = [];
        for (const seatId of LIVE_SEATS) {
          entries.push(...await libraryStore.listEntries(tenantId, seatId));
          connections.push(...await libraryStore.listConnections(tenantId, { personId: person, seatId }));
          mirrors.push(...await libraryStore.listMirrors(tenantId, { personId: person, seatId }));
        }
        return [entries, connections, mirrors];
      };
      let [entries, connections, mirrors] = await listAll();

      // The seed/heal triggers, tenant-wide (readSeatLibrary's two
      // gates aggregated over the seats it would check one by one):
      // seed only when the tenant holds no entries at all on the
      // live seats; heal when a populated live seat lacks catalog
      // ids (custom entries count toward neither set, exactly as
      // in maybeHealCatalog).
      let seed = SEED_NOT_ATTEMPTED;
      const liveEntries = entries.filter((entry) => LIVE_SEATS.includes(entry.seatId));
      if (liveEntries.length === 0) {
        seed = await runSeedOnce(tenantId);
      } else {
        const heldBySeat = new Map();
        for (const entry of liveEntries) {
          if (entry.kind !== 'catalog' && entry.kind !== 'helmian-native') continue;
          if (!heldBySeat.has(entry.seatId)) heldBySeat.set(entry.seatId, new Set());
          heldBySeat.get(entry.seatId).add(entry.id);
        }
        const anyMissing = LIVE_SEATS.some((seatId) => {
          const held = heldBySeat.get(seatId);
          if (!held || held.size === 0) return false;
          return catalogEntriesForSeat(seatId).some((def) => !held.has(def.id));
        });
        if (anyMissing) seed = await runSeedOnce(tenantId);
      }
      if (seed.attempted) {
        // The refresh writes entries only; re-list just those.
        entries = summaryReads
          ? await libraryStore.listEntriesForTenant(tenantId)
          : (await Promise.all(LIVE_SEATS.map((seatId) => libraryStore.listEntries(tenantId, seatId)))).flat();
      }

      // The tenant-level joins, once: the tool-connections surfaces
      // for the services any entry names, and the channel repo
      // links — the same sources, the same conditions as the row
      // read (no actor → the link source stays silent).
      const nativeSurfaces = new Map();
      if (surface) {
        for (const entry of entries) {
          const source = NATIVE_STATE_SOURCES[entry.id];
          if (source?.stateSource === 'tool-connections' && !nativeSurfaces.has(source.serviceId)) {
            nativeSurfaces.set(source.serviceId, await surface.surfaceFor(tenantId, source.serviceId, { now, maxAgeMs: verifiedMaxAgeMs }));
          }
        }
      }
      let tenantRepoLinks = null;
      if (repoLinkSurface && actor && entries.some((entry) => NATIVE_STATE_SOURCES[entry.id]?.repoLinks === true)) {
        tenantRepoLinks = await repoLinkSurface.linksFor(actor);
      }

      const connectionBySeatEntry = new Map(connections.map((c) => [`${c.seatId} ${c.entryId}`, c]));
      const mirrorBySeatEntry = new Map(mirrors.map((m) => [`${m.seatId} ${m.entryId}`, m]));

      // Gate rows only where they can change a count: a custom
      // entry whose connection reads connected (an unpassed gate
      // caps exactly that case at not-connected; every other case
      // is ruled the same with or without the row).
      const gateRows = new Map();
      if (toolConnectionsStore && typeof toolConnectionsStore.get === 'function') {
        for (const entry of entries) {
          if (entry.kind !== 'custom') continue;
          const connection = connectionBySeatEntry.get(`${entry.seatId} ${entry.id}`);
          if (!connection || connection.state !== 'connected') continue;
          gateRows.set(`${entry.seatId} ${entry.id}`, await toolConnectionsStore.get(tenantId, customGateKey(entry.seatId, entry.id)));
        }
      }

      const seats = [];
      for (const seatId of LIVE_SEATS) {
        const seatEntries = entries.filter((entry) => entry.seatId === seatId);
        if (!seatEntries.length) continue;
        let connectedCount = 0;
        for (const entry of seatEntries) {
          const source = NATIVE_STATE_SOURCES[entry.id];
          const joined = joinedState(entry, {
            connection: connectionBySeatEntry.get(`${seatId} ${entry.id}`) ?? null,
            mirror: mirrorBySeatEntry.get(`${seatId} ${entry.id}`) ?? null,
            nativeSurface: source?.stateSource === 'tool-connections'
              ? nativeSurfaces.get(source.serviceId) ?? null
              : null,
            repoLinks: tenantRepoLinks,
            gateRow: gateRows.has(`${seatId} ${entry.id}`) ? gateRows.get(`${seatId} ${entry.id}`) : undefined,
          });
          if (joined.state === 'connected') connectedCount += 1;
        }
        seats.push({ seatId, entryCount: seatEntries.length, connectedCount });
      }
      return { seats, seed };
    },
  };
}

// Connector library READ routes (connector-library SPEC §1.1/§1.2,
// build bite 3): the two reads Surface A — the composer "+" panel —
// runs on:
//
//   GET /api/admin/connector-library/seats
//     → { valid: true, seats: [{ seatId, connectedCount, entryCount }] }
//     Level 1 (pick the seat): every seat whose library holds entries
//     in the caller's tenant, with that person's connected count.
//
//   GET /api/admin/connector-library?seat=<seatId>
//     → { valid: true, seatId, connectedCount, rows }
//     Level 2 (that seat's library): the Bite 2 read's rows for the
//     caller — the five §1.2 fields plus the surface's supporting
//     fields (connector-library-read.mjs). The caller's person id is
//     never returned.
//
//   GET /api/admin/connector-library/tool-access (per-entry snapshot read —
//   see productionToolAccess below)
//   GET /api/admin/connector-library/arming-baseline?seat=<seatId>&entry=<entryId>
//     → { valid: true, seatId, entryId, export }
//     The ledger join's export (pipeline map G2, direction 2): the
//     caller's own connection's arming baseline — its FIRST frozen
//     snapshot — beside its current snapshot, with the drift verdict
//     between them, as a `helmian-arming-baseline` document
//     (connector-arming-baseline.mjs) a person can carry to the
//     machine whose install pipeline consumes it
//     (mcp-install-ledger.mjs checkToolListAgainstArmingBaseline).
//     `export` is null with a named `reason` when there is nothing
//     to export yet (no entry, no connection, no freeze) — the read
//     never fabricates a baseline. Tools and hashes only: no token
//     reference, no credential, rides this read.
//
// Both reads are scoped exactly like the sibling admin reads
// (tool-connections-read.mjs): member auth via activeTenantActor, the
// tenant from the actor's membership, the person from the actor's
// subject. There is NO person or tenant selector on the wire — a
// request naming one is refused (400), never honoured — so a caller
// can only ever read their own library in their own workspace (§3.4).
//
// The actor threads into every read: the native GitHub entry's
// repo-link join reads the tenant's channels through the envoy
// store's membership-checked list, which is keyed to the actor —
// there is no tenant-aimed channel read on the wire either.
//
// Wiring note: same shape as tool-connections-read.mjs — live-admin.mjs
// is frozen at the push size limit, so the route hangs off the
// envoy-ably delegate hook with its own lazy pool (same env var, same
// ssl rule). The read self-seeds a tenant whose library holds zero
// catalog entries (seed-on-first-read, connector-library-read.mjs);
// when a seed was attempted its outcome rides in the response's `seed`
// metadata — including a failure, which still answers 200 with what
// exists. When sql/074 has not been applied yet the library store
// answers empty (42P01-safe) and the seed attempt fails into that same
// metadata, so the response is an honest empty library — never a
// guess, never a crash.
import { Pool } from 'pg';
import { createConnectorLibraryStore, effectiveToolAnnotation } from './connector-library.mjs';
import { buildArmingBaselineExport } from './connector-arming-baseline.mjs';
import { createToolConnectionsStore } from './tool-connections.mjs';
import { createSeatLibraryRead } from './connector-library-read.mjs';
import { LIVE_SEATS } from './connector-catalog.mjs';
import { createEnvoyStore } from './envoy-chat.mjs';
import { createGithubFileRead, CONNECTOR_GITHUB_FILE_PATH } from './connector-github-file.mjs';

export const CONNECTOR_LIBRARY_PATH = '/api/admin/connector-library';
export const CONNECTOR_LIBRARY_SEATS_PATH = '/api/admin/connector-library/seats';
export const CONNECTOR_LIBRARY_TOOL_ACCESS_PATH = '/api/admin/connector-library/tool-access';
export const CONNECTOR_LIBRARY_ARMING_BASELINE_PATH = '/api/admin/connector-library/arming-baseline';

// Authority selectors are never accepted on these reads: the tenant is
// the actor's membership and the person is the actor's subject. A
// person selector is refused on the same terms as a tenant one —
// naming another person must not become a way to read their library.
const AUTHORITY_SELECTORS = Object.freeze([
  'tenant_id', 'tenantId', 'organization_id', 'plant_id', 'facility_id',
  'person_id', 'personId', 'subject',
]);

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

function productionRead() {
  const pool = getPool();
  return createSeatLibraryRead({
    libraryStore: createConnectorLibraryStore(pool),
    toolConnectionsStore: createToolConnectionsStore(pool),
    // The envoy store is the channel-config store of record: its
    // listChannels is where the native GitHub entry's per-channel
    // repo links join from (connector-library-read.mjs).
    envoyStore: createEnvoyStore(pool),
  });
}

// The Tool access read (mirror-design §3.1, bite M2): the caller's
// OWN connection for one entry — its posture, and the tools of its
// frozen snapshot with their annotations and the person's on/off
// map. Token references never ride this read: the answer is built
// field by field from the connection record, and the reference
// columns are not among the fields.
async function productionToolAccess(tenantId, { personId, seatId, entryId }) {
  const store = createConnectorLibraryStore(getPool());
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
}

// The arming-baseline export (pipeline map G2): the caller's OWN
// connection's first frozen snapshot — its baseline, recorded at
// connect or first arm — beside its current snapshot. Field by
// field from the entry and snapshot records (through
// buildArmingBaselineExport): tools and hashes only, the same
// no-token-references discipline as the Tool access read above.
async function productionArmingBaseline(tenantId, { personId, seatId, entryId }) {
  const store = createConnectorLibraryStore(getPool());
  const entry = await store.getEntry(tenantId, seatId, entryId);
  if (!entry) return { export: null, reason: 'entry-not-found' };
  const key = { personId, seatId, entryId };
  const connection = await store.getConnection(tenantId, key);
  if (!connection) return { export: null, reason: 'not-connected' };
  const baselineSnapshot = await store.getFirstSnapshot(tenantId, key);
  if (!baselineSnapshot) return { export: null, reason: 'no-frozen-snapshot' };
  const currentSnapshot = await store.getCurrentSnapshot(tenantId, key);
  return { export: buildArmingBaselineExport({ entry, baselineSnapshot, currentSnapshot }) };
}

function productionGithubFile() {
  // No token provider is wired (FIX-A, Step 0): the operator
  // GITHUB_TOKEN that web/marketing/api/download-count.js reads
  // lives in this same Vercel project's env IF it is set for
  // production — its presence could not be established from any
  // reachable env listing, the one live consumer answers 500
  // today, and the credential vault holds no GitHub credential at
  // all. The read therefore runs on the public API budget until
  // the env fact is settled (the provider then wires here in one
  // line) or M3's per-person GitHub connection lands and the
  // token resolves through the credential service instead
  // (the write route's brokeredToken road).
  return createGithubFileRead({ envoyStore: createEnvoyStore(getPool()) });
}

// Route delegate. GET only (member auth via activeTenantActor, like the
// sibling reads). Returns false when the request is not ours. `read` is
// injectable for tests; production builds it from the lazy pool.
export async function handleConnectorLibraryRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  read = null,
  toolAccess = null,
  armingBaseline = null,
  githubFile = null,
} = {}) {
  const isSeats = requestUrl?.pathname === CONNECTOR_LIBRARY_SEATS_PATH;
  const isLibrary = requestUrl?.pathname === CONNECTOR_LIBRARY_PATH;
  const isToolAccess = requestUrl?.pathname === CONNECTOR_LIBRARY_TOOL_ACCESS_PATH;
  const isArmingBaseline = requestUrl?.pathname === CONNECTOR_LIBRARY_ARMING_BASELINE_PATH;
  const isGithubFile = requestUrl?.pathname === CONNECTOR_GITHUB_FILE_PATH;
  if (!isSeats && !isLibrary && !isToolAccess && !isArmingBaseline && !isGithubFile) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    if (AUTHORITY_SELECTORS.some((key) => requestUrl.searchParams.has(key))) {
      throw Object.assign(new Error('authority selector is not accepted'), { status: 400, code: 'CONNECTOR_LIBRARY_SELECTOR_INVALID' });
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    const actor = await activeTenantActor(request);
    const personId = actor.subject;
    if (isToolAccess) {
      const seatId = String(requestUrl.searchParams.get('seat') ?? '').trim();
      const entryId = String(requestUrl.searchParams.get('entry') ?? '').trim();
      if (!seatId || !entryId) {
        throw Object.assign(new Error('seat and entry are required'), { status: 400, code: 'CONNECTOR_LIBRARY_TOOL_ACCESS_INVALID' });
      }
      const result = await (toolAccess ?? productionToolAccess)(actor.tenantId, { personId, seatId, entryId });
      send(response, 200, JSON.stringify({ valid: true, seatId, entryId, ...result }));
      return true;
    }
    if (isArmingBaseline) {
      const seatId = String(requestUrl.searchParams.get('seat') ?? '').trim();
      const entryId = String(requestUrl.searchParams.get('entry') ?? '').trim();
      if (!seatId || !entryId) {
        throw Object.assign(new Error('seat and entry are required'), { status: 400, code: 'CONNECTOR_LIBRARY_ARMING_BASELINE_INVALID' });
      }
      const result = await (armingBaseline ?? productionArmingBaseline)(actor.tenantId, { personId, seatId, entryId });
      send(response, 200, JSON.stringify({ valid: true, seatId, entryId, ...result }));
      return true;
    }
    if (isGithubFile) {
      const repo = String(requestUrl.searchParams.get('repo') ?? '').trim();
      const path = String(requestUrl.searchParams.get('path') ?? '');
      const readFile = githubFile ?? productionGithubFile();
      const result = await readFile(actor, { repo, path });
      send(response, 200, JSON.stringify({ valid: true, ...result }));
      return true;
    }
    const library = read ?? productionRead();
    if (isSeats) {
      // One read per catalog seat; a seat with no entries in this
      // tenant has no library to pick, so it is not a Level 1 row.
      // The first read on an unseeded tenant runs the one seed; its
      // outcome (at most one attempt happens) is surfaced once here.
      const seats = [];
      let seed = null;
      for (const seatId of LIVE_SEATS) {
        const result = await library.readSeatLibrary(actor.tenantId, { personId, seatId, actor });
        if (!seed && result.seed?.attempted) seed = result.seed;
        if (result.rows.length) seats.push({ seatId, connectedCount: result.connectedCount, entryCount: result.rows.length });
      }
      send(response, 200, JSON.stringify({ valid: true, seats, ...(seed ? { seed } : {}) }));
      return true;
    }
    const seatId = String(requestUrl.searchParams.get('seat') ?? '').trim();
    if (!seatId) {
      throw Object.assign(new Error('seat is required'), { status: 400, code: 'CONNECTOR_LIBRARY_SEAT_REQUIRED' });
    }
    const result = await library.readSeatLibrary(actor.tenantId, { personId, seatId, actor });
    send(response, 200, JSON.stringify({
      valid: true,
      seatId: result.seatId,
      connectedCount: result.connectedCount,
      rows: result.rows,
      ...(result.seed?.attempted ? { seed: result.seed } : {}),
    }));
  } catch (error) {
    // Errors that carry their own status + code (the github-file
    // read's refusals: not-linked 404, too-big 413, upstream 502)
    // pass through with their words; the library reads keep the
    // long-standing mapping (400 stays 400, anything else 503).
    const passthrough = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 && typeof error?.code === 'string';
    const status = membershipError(error) ? 403 : passthrough ? error.status : error?.status === 400 ? 400 : 503;
    send(response, status, JSON.stringify({
      valid: false,
      code: status === 403 ? 'CONNECTOR_LIBRARY_MEMBERSHIP_REQUIRED' : error?.code ?? (status === 400 ? 'CONNECTOR_LIBRARY_INVALID' : 'CONNECTOR_LIBRARY_READ_FAILED'),
      ...(passthrough ? { error: error.message } : {}),
    }));
  }
  return true;
}

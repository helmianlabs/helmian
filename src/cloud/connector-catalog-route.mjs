// Connector catalog ROUTES (connector-catalog brief §(e), bite 2):
// the two reads the per-seat Connectors view runs on.
//
//   GET /api/admin/connector-catalog?seat=<seatId>
//     → { valid: true, seatId, featured, browse, totals }
//     The cards: the featured shelf (the curation layer's hand-named
//     picks joined to their bite 1 mirror rows) and the first page
//     of the curated mirror. Seat defaults to the first live seat;
//     an unknown seat is a 400, never a guess.
//
//   GET /api/admin/connector-catalog/tools?name=<registryName>
//     → { valid: true, registryName, state, tools, fetchedAt }
//     One listing's tool list, fetched LIVE from its server at view
//     time. The name is a catalog key, never an address: the read
//     resolves the endpoint from the catalog row itself, so this
//     route can only ever call a server the catalog carries. A name
//     the catalog does not carry is a 404.
//
// Both reads are member-gated exactly like the sibling library read
// (activeTenantActor); the catalog itself is global reference data
// (sql/098), so no tenant filter applies to the rows. Authority
// selectors are refused, as on the library reads. Read-only: this
// bite has no connect flow, no credential handling, no writes.
import { createCatalogRead, fetchServerTools } from './connector-catalog-read.mjs';
import { LIVE_SEATS } from './connector-catalog.mjs';

export const CONNECTOR_CATALOG_PATH = '/api/admin/connector-catalog';
export const CONNECTOR_CATALOG_TOOLS_PATH = '/api/admin/connector-catalog/tools';

const AUTHORITY_SELECTORS = Object.freeze([
  'tenant_id', 'tenantId', 'organization_id', 'plant_id', 'facility_id',
  'person_id', 'personId', 'subject',
]);

let sharedPool = null;
async function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3, connectionTimeoutMillis: 5_000 });
  }
  return sharedPool;
}

async function productionRead() {
  return createCatalogRead({ pool: await getPool() });
}

// Route delegate. GET only (member auth via activeTenantActor, like
// the sibling reads). Returns false when the request is not ours.
// `read` and `tools` are injectable for tests; production builds
// them from the lazy pool and the live fetch.
export async function handleConnectorCatalogRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  read = null,
  tools = null,
} = {}) {
  const isCards = requestUrl?.pathname === CONNECTOR_CATALOG_PATH;
  const isTools = requestUrl?.pathname === CONNECTOR_CATALOG_TOOLS_PATH;
  if (!isCards && !isTools) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  const sendError = (error, { membershipApplies = false } = {}) => {
    const status = membershipApplies && membershipError(error) ? 403 : error?.status === 400 ? 400 : error?.status === 404 ? 404 : 503;
    if (status === 503) {
      try {
        console.error(`[connector-catalog] read failed (${requestUrl?.pathname ?? 'connector-catalog'}): ${error?.message ?? error}${typeof error?.code === 'string' ? ` [pg code ${error.code}]` : ''}`);
      } catch { /* a logger must never break the read */ }
    }
    send(response, status, JSON.stringify({
      valid: false,
      code: status === 403 ? 'CONNECTOR_CATALOG_MEMBERSHIP_REQUIRED' : error?.code ?? (status === 400 ? 'CONNECTOR_CATALOG_INVALID' : status === 404 ? 'CONNECTOR_CATALOG_NOT_FOUND' : 'CONNECTOR_CATALOG_READ_FAILED'),
    }));
  };
  try {
    if (AUTHORITY_SELECTORS.some((key) => requestUrl.searchParams.has(key))) {
      throw Object.assign(new Error('authority selector is not accepted'), { status: 400, code: 'CONNECTOR_CATALOG_SELECTOR_INVALID' });
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
  } catch (error) {
    sendError(error);
    return true;
  }
  try {
    await activeTenantActor(request);
  } catch (error) {
    sendError(error, { membershipApplies: true });
    return true;
  }
  try {
    const catalog = read ?? await productionRead();
    if (isTools) {
      const name = String(requestUrl.searchParams.get('name') ?? '').trim();
      if (!name) {
        throw Object.assign(new Error('name is required'), { status: 400, code: 'CONNECTOR_CATALOG_NAME_REQUIRED' });
      }
      const endpoint = await catalog.readToolsEndpoint(name);
      if (!endpoint) {
        throw Object.assign(new Error('the catalog does not carry that listing'), { status: 404, code: 'CONNECTOR_CATALOG_NOT_FOUND' });
      }
      const result = await (tools ?? fetchServerTools)(endpoint);
      send(response, 200, JSON.stringify({ valid: true, registryName: name, state: result.state, tools: result.tools ?? [], fetchedAt: new Date().toISOString() }));
      return true;
    }
    const seatId = String(requestUrl.searchParams.get('seat') ?? LIVE_SEATS[0]).trim();
    if (!LIVE_SEATS.includes(seatId)) {
      throw Object.assign(new Error('unknown seat'), { status: 400, code: 'CONNECTOR_CATALOG_SEAT_INVALID' });
    }
    const result = await catalog.readCards({ seatId });
    send(response, 200, JSON.stringify({ valid: true, seatId, ...result }));
  } catch (error) {
    sendError(error);
  }
  return true;
}

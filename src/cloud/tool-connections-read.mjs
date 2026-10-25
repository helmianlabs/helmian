// Tool connections READ path (bite 1b): the one route the app surfaces
// read connection truth from — GET /api/admin/tool-connections returns the
// caller's tenant rows from helmion.tool_connections (sql/061), in the
// store's row shape (serviceId, scope, state, lastVerifiedAt,
// lastToolsCount, lastError). Registration and probing live elsewhere
// (src/cloud/tool-connections.mjs, src/agent/tool-connection-probe.mjs);
// this route only reads, so a surface can never talk itself into a state
// the probe didn't earn.
//
// Wiring note: same shape as runner-presence.mjs — live-admin.mjs is
// frozen at the push size limit, so the route hangs off the envoy-ably
// delegate hook with its own lazy pool (same env var, same ssl rule).
// When sql/061 has not been applied yet the store answers [] (42P01-safe),
// and the surfaces fall back to their older sources — never to a guess.
import { Pool } from 'pg';
import { createToolConnectionsStore } from './tool-connections.mjs';

export const TOOL_CONNECTIONS_PATH = '/api/admin/tool-connections';

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

// Route delegate. GET only (member auth via activeTenantActor, like the
// sibling reads). Returns false when the request is not ours. `store` is
// injectable for tests; production builds it from the lazy pool.
export async function handleToolConnectionsRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  store = null,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== TOOL_CONNECTIONS_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    if (['tenant_id', 'organization_id', 'plant_id', 'facility_id'].some((key) => requestUrl.searchParams.has(key))) {
      throw Object.assign(new Error('authority selector is not accepted'), { status: 400, code: 'TOOL_CONNECTIONS_SELECTOR_INVALID' });
    }
    if (request.method !== 'GET') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    const actor = await activeTenantActor(request);
    const connections = await (store ?? createToolConnectionsStore(getPool())).list(actor.tenantId, {});
    send(response, 200, JSON.stringify({ valid: true, connections }));
  } catch (error) {
    const status = membershipError(error) ? 403 : error?.status === 400 ? 400 : 503;
    send(response, status, JSON.stringify({
      valid: false,
      code: status === 403 ? 'TOOL_CONNECTIONS_MEMBERSHIP_REQUIRED' : error?.code ?? (status === 400 ? 'TOOL_CONNECTIONS_INVALID' : 'TOOL_CONNECTIONS_READ_FAILED'),
    }));
  }
  return true;
}

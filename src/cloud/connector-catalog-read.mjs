// Connector catalog READ (connector-catalog brief §(e), bite 2): the
// read path behind the per-seat Connectors view. Cards come from the
// bite 1 mirror tables (helmion.connector_catalog_servers) — never
// from the public registry live — in two shelves:
//
//   featured — the hand-named shelf: REGISTRY_PICKS from the curation
//     layer (mcp-registry-curation.mjs), joined to their mirror rows
//     on registry_name. A pick is a person's editorial choice, so it
//     renders whether or not the nightly funnel kept its row curated
//     (a bulk publisher or a missing source link excludes a row from
//     the browse shelf, never from the shelf a person named); the
//     card carries the row's catalog state plainly either way.
//   browse — the curated mirror itself: rows the funnel kept
//     (curated = true), capped for the view.
//
// And the view-time mechanic the brief names: a featured server's
// tool list is fetched LIVE from that server when the view asks —
// an MCP initialize handshake followed by tools/list against the
// endpoint the catalog row carries. The endpoint always comes from
// the catalog row, never from the request: the tools read names a
// registry listing, and the server side resolves where it lives.
// States are honest: 'open' (the server answered with its tools),
// 'auth' (it asked for a sign-in — 401/403 — so its tools are not
// public), 'unreachable' (no answer at all), 'error' (it answered
// but not as an MCP server). Nothing here connects anything: no
// credentials are held, sent, or stored in this bite.

import { registryPicksForSeat } from './mcp-registry-curation.mjs';

export const CATALOG_BROWSE_LIMIT = 48;

function remoteUrlOf(remotes) {
  const list = Array.isArray(remotes) ? remotes : [];
  const streamable = list.find((r) => r?.transport === 'streamable-http');
  return streamable?.url ?? list[0]?.url ?? null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** One featured card: the pick's editorial fields over its mirror row. */
export function featuredCardFromPick(pick, row) {
  const endpoint = remoteUrlOf(row?.remotes) ?? pick.endpoint ?? null;
  return {
    kind: 'featured',
    entryId: pick.entryId,
    registryName: pick.registryName,
    name: pick.name,
    vendorName: pick.vendorName,
    oneLiner: pick.oneLiner,
    category: pick.category,
    icon: pick.icon,
    authMode: pick.authMode,
    trustLabel: 'community',
    endpoint,
    endpointHost: hostOf(endpoint),
    sourceUrl: row?.repository_url ?? row?.website_url ?? pick.repositoryUrl ?? null,
    version: row?.version ?? pick.registryVersion ?? null,
    inCatalog: Boolean(row),
    curated: row?.curated === true,
    endpointLive: row?.endpoint_live ?? null,
  };
}

/** One browse card: a curated mirror row, shaped for the grid. */
export function browseCardFromRow(row) {
  const endpoint = remoteUrlOf(row?.remotes);
  const fallbackName = String(row?.registry_name ?? '').split('/').pop() ?? '';
  return {
    kind: 'browse',
    registryName: row.registry_name,
    name: row.title || fallbackName,
    publisher: row.publisher,
    description: row.description ?? '',
    sourceUrl: row.repository_url ?? row.website_url ?? null,
    sourceKind: row.source_kind,
    version: row.version ?? null,
    endpointHost: hostOf(endpoint),
    endpointLive: row.endpoint_live ?? null,
  };
}

/**
 * The catalog read over the bite 1 tables. The catalog is global
 * reference data (sql/098's header: the application reads it through
 * its own owner connection), so the read takes no tenant — the
 * caller's membership is the route's gate, not a filter here.
 */
export function createCatalogRead({ pool }) {
  return {
    async readCards({ seatId } = {}) {
      const picks = registryPicksForSeat(seatId);
      const pickNames = picks.map((pick) => pick.registryName);
      const featuredRows = pickNames.length
        ? (await pool.query(
          'select registry_name, repository_url, website_url, version, remotes, curated, endpoint_live from helmion.connector_catalog_servers where registry_name = any($1)',
          [pickNames],
        )).rows
        : [];
      const rowByName = new Map(featuredRows.map((row) => [row.registry_name, row]));
      const featured = picks.map((pick) => featuredCardFromPick(pick, rowByName.get(pick.registryName) ?? null));
      const browseRows = (await pool.query(
        `select registry_name, publisher, title, description, repository_url, website_url,
                source_kind, version, remotes, endpoint_live
           from helmion.connector_catalog_servers
          where curated = true
          order by publisher, registry_name
          limit $1`,
        [CATALOG_BROWSE_LIMIT],
      )).rows;
      const totals = (await pool.query(
        'select count(*)::int as listings, count(*) filter (where curated)::int as curated from helmion.connector_catalog_servers',
      )).rows[0];
      return { featured, browse: browseRows.map(browseCardFromRow), totals };
    },
    /** The endpoint a tools fetch may use for one listing, or null. */
    async readToolsEndpoint(registryName) {
      const rows = (await pool.query(
        'select remotes from helmion.connector_catalog_servers where registry_name = $1',
        [registryName],
      )).rows;
      if (!rows.length) return null;
      return remoteUrlOf(rows[0].remotes);
    },
  };
}

/** Parse an MCP response body, JSON or SSE, into its payload object. */
export function parseMcpPayload(text, contentType) {
  if (typeof text !== 'string' || !text) return null;
  if (String(contentType ?? '').includes('text/event-stream')) {
    let found = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed && (parsed.result || parsed.error)) found = parsed;
        } catch { /* a non-JSON data line is not the payload */ }
      }
    }
    return found;
  }
  try { return JSON.parse(text); } catch { return null; }
}

const MCP_HEADERS = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
});

/**
 * Fetch one server's tool list live: initialize, the initialized
 * notification, tools/list — the standard streamable-HTTP handshake.
 * fetchImpl is injectable for tests. Never throws; the state object
 * is the result.
 */
export async function fetchServerTools(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const post = async (body, sessionId) => {
    const headers = { ...MCP_HEADERS };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    return { response, text: await response.text() };
  };
  try {
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'helmian-catalog', version: '1.0.0' } },
    });
    if (init.response.status === 401 || init.response.status === 403) return { state: 'auth', tools: [] };
    if (init.response.status < 200 || init.response.status >= 300) return { state: 'error', tools: [], detail: `HTTP ${init.response.status}` };
    const sessionId = init.response.headers?.get?.('mcp-session-id') ?? null;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => {});
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
    if (list.response.status === 401 || list.response.status === 403) return { state: 'auth', tools: [] };
    if (list.response.status < 200 || list.response.status >= 300) return { state: 'error', tools: [], detail: `HTTP ${list.response.status}` };
    const payload = parseMcpPayload(list.text, list.response.headers?.get?.('content-type'));
    const tools = payload?.result?.tools;
    if (!Array.isArray(tools)) return { state: 'error', tools: [], detail: 'no tool list in the answer' };
    return {
      state: 'open',
      tools: tools.map((tool) => ({ name: String(tool?.name ?? ''), description: String(tool?.description ?? '').slice(0, 240) })).filter((tool) => tool.name),
    };
  } catch (error) {
    return { state: 'unreachable', tools: [], detail: String(error?.message ?? error).slice(0, 200) };
  }
}

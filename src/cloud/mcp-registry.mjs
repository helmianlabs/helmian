// MCP Registry client (research pass 2026-11-10, report §2/§5): the
// read road to the OFFICIAL MCP Registry
// (registry.modelcontextprotocol.io) — the public, unauthenticated,
// read-only catalog of public MCP servers. This module is the pull
// half of the documented AGGREGATOR pattern: a curation pass polls
// the registry, persists what it keeps in Helmian's own catalog
// data (connector-catalog.mjs, Source 3), and the product serves
// THAT — host surfaces never consume the raw feed, and no request
// path calls this client. Registry metadata is CC0 (public domain);
// the servers it points at keep their own licenses and their own
// trust stories, so a candidate here is a listing lead, never a
// trust decision: trust labels are ruled at curation time
// (mcp-registry-curation.mjs) and 'verified' is never minted from
// registry data.
//
// Honesty rules, enforced below:
//   - A failed pull is a thrown McpRegistryError with a named code —
//     never a silent empty list a caller could mistake for "the
//     registry has nothing". A truncated pull says so (truncated).
//   - listServers EXCLUDES entries the registry itself marks
//     'deprecated' or 'deleted' — the shelf is built from live
//     listings only. getServer is the fact-checking road and returns
//     the record as it stands, status visible, whatever it is.

export const MCP_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
export const MCP_REGISTRY_API_PATH = '/v0.1/servers';

// The registry-managed metadata block on every record.
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

export class McpRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpRegistryError';
    this.code = code;
  }
}

function officialMeta(raw, server) {
  return raw?._meta?.[OFFICIAL_META_KEY] ?? server?._meta?.[OFFICIAL_META_KEY] ?? {};
}

/**
 * One raw registry record (a list item `{ server, _meta }`, a
 * versions/latest body of the same shape, or a bare server object)
 * → the normalized candidate the curation layer works with, or null
 * when the record carries no server name to key on. Remotes keep
 * their declared transport; `remoteUrl` is the first Streamable
 * HTTP remote — the transport a cloud surface can reach — or null
 * when the listing offers packages only (software someone must run
 * somewhere; not a cloud shelf candidate).
 */
export function normalizeRegistryEntry(raw) {
  const server = raw?.server ?? raw;
  if (!server || typeof server !== 'object' || typeof server.name !== 'string' || !server.name) {
    return null;
  }
  const meta = officialMeta(raw, server);
  const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
    .filter((remote) => remote && typeof remote.url === 'string' && remote.url)
    .map((remote) => ({ transport: String(remote.type ?? ''), url: remote.url }));
  const streamable = remotes.find((remote) => remote.transport === 'streamable-http');
  return {
    registryName: server.name,
    title: typeof server.title === 'string' ? server.title : null,
    description: typeof server.description === 'string' ? server.description : '',
    version: typeof server.version === 'string' ? server.version : null,
    status: typeof meta.status === 'string' ? meta.status : null,
    isLatest: meta.isLatest === true,
    publishedAt: typeof meta.publishedAt === 'string' ? meta.publishedAt : null,
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null,
    repositoryUrl: typeof server.repository?.url === 'string' ? server.repository.url : null,
    websiteUrl: typeof server.websiteUrl === 'string' ? server.websiteUrl : null,
    remotes,
    remoteUrl: streamable ? streamable.url : null,
    packages: (Array.isArray(server.packages) ? server.packages : [])
      .filter((pkg) => pkg && typeof pkg.identifier === 'string' && pkg.identifier)
      .map((pkg) => ({ registryType: String(pkg.registryType ?? ''), identifier: pkg.identifier })),
  };
}

/** The shelf-building rule: deprecated and deleted listings are out. */
export function isRegistryCandidateExcluded(candidate) {
  return candidate?.status === 'deprecated' || candidate?.status === 'deleted';
}

export function createMcpRegistryClient({ fetchImpl, baseUrl = MCP_REGISTRY_BASE_URL } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new McpRegistryError('MCP_REGISTRY_NO_FETCH', 'the MCP Registry client needs a fetch implementation');
  }
  const base = String(baseUrl).replace(/\/+$/, '');

  async function fetchJson(url, what) {
    let response;
    try {
      response = await doFetch(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new McpRegistryError('MCP_REGISTRY_UNREACHABLE', `the MCP Registry could not be reached for ${what}: ${error?.message ?? error}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new McpRegistryError('MCP_REGISTRY_HTTP_ERROR', `the MCP Registry answered HTTP ${response.status} for ${what}`);
    }
    try {
      return await response.json();
    } catch {
      throw new McpRegistryError('MCP_REGISTRY_BAD_RESPONSE', `the MCP Registry answered ${what} with a body that is not JSON`);
    }
  }

  return {
    /**
     * Page through the registry's latest-version listings (the
     * aggregator pull), optionally narrowed by the registry's own
     * `search` filter. Returns { candidates, pages, truncated }:
     * candidates are normalized and exclude deprecated/deleted
     * records; truncated is true when maxPages stopped the walk
     * with pages still outstanding — a partial pull, said out loud,
     * never dressed as the whole registry.
     */
    async listServers({ search = null, limit = 100, maxPages = 25 } = {}) {
      const candidates = [];
      let cursor = null;
      let pages = 0;
      let truncated = false;
      do {
        const params = new URLSearchParams({ version: 'latest', limit: String(limit) });
        if (search) params.set('search', String(search));
        if (cursor) params.set('cursor', cursor);
        const body = await fetchJson(`${base}${MCP_REGISTRY_API_PATH}?${params}`, 'the server list');
        if (!body || !Array.isArray(body.servers)) {
          throw new McpRegistryError('MCP_REGISTRY_BAD_RESPONSE', 'the MCP Registry server list did not carry a servers array');
        }
        pages += 1;
        for (const item of body.servers) {
          const candidate = normalizeRegistryEntry(item);
          if (candidate && !isRegistryCandidateExcluded(candidate)) candidates.push(candidate);
        }
        cursor = typeof body.metadata?.nextCursor === 'string' && body.metadata.nextCursor
          ? body.metadata.nextCursor
          : null;
        if (cursor && pages >= maxPages) truncated = true;
      } while (cursor && pages < maxPages);
      return { candidates, pages, truncated };
    },

    /**
     * The fact-checking road: one server's latest record, normalized
     * AS IT STANDS (a deprecated pick must be visible to curation,
     * not filtered away). Null when the registry has no such server.
     */
    async getServer(registryName) {
      const name = String(registryName ?? '');
      if (!name) throw new McpRegistryError('MCP_REGISTRY_BAD_NAME', 'getServer needs a registry server name');
      const body = await fetchJson(`${base}${MCP_REGISTRY_API_PATH}/${encodeURIComponent(name)}/versions/latest`, `server ${name}`);
      if (body === null) return null;
      const candidate = normalizeRegistryEntry(body);
      if (!candidate) {
        throw new McpRegistryError('MCP_REGISTRY_BAD_RESPONSE', `the MCP Registry record for ${name} carried no server name`);
      }
      return candidate;
    },
  };
}

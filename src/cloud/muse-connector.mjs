// The Muse connector: Helmian's own MCP entrance for Muse
// (Muse-to-Helmian connector, Bite 1, 2026-11-12).
//
//   POST https://helmian.cloud/mcp   (JSON-RPC, streamable HTTP shape)
//
// Muse (Troy's personal agent in the Muse app) reads Troy's own
// Helmian account through this endpoint — the agents in his
// workspace and their health — with proper tools instead of browser
// pages and server probes. It NEVER runs through Scribe: Scribe and
// Helmian are separate across the board, no connections anywhere,
// and nothing here touches a Scribe surface, store, or credential.
//
// Shape of the road, following the house pattern for new routes:
// live-admin.mjs is frozen at the push size limit, so this route
// hangs off the existing envoy-ably hook (envoy-ably.mjs delegates
// here), the same road watch-tickets.mjs and runner-presence.mjs
// took. vercel.json rewrites /mcp into the admin function and
// helmian-admin.js restorePath admits exactly that one path.
//
// AUTH — a tenant-scoped API key (sql/087), not an inbound OAuth
// authorization server. The codebase has no inbound OAuth AS to
// ride: connector-oauth-dcr.mjs is Helmian acting as an OAuth
// CLIENT to outbound MCP servers, the admin console delegates to an
// external OIDC issuer, and member sign-in rides Clerk. A key is one
// table and one hash lookup, and it keeps every guarantee:
//   - The tenant is fixed by the key row on the server side. No
//     tool takes a tenant or user parameter, and a tools/call whose
//     arguments carry a tenant selector is refused outright, the
//     same rule every sibling route keeps.
//   - Only the key's SHA-256 hash is stored. The plaintext exists
//     once, at mint (bin/mint-muse-connector-key.mjs), on its way
//     into Muse's secure connection storage; it is never stored,
//     logged, or read back here.
//   - READ-ONLY is enforced HERE, not by the caller's manners: the
//     endpoint exposes exactly the tools in MUSE_CONNECTOR_TOOLS
//     and every one of them only reads. An unknown tool name is an
//     error; an unknown method is an error; there is no
//     write-shaped call to make.
//   - Revocation lives inside Helmian: disabling the key's row
//     (enabled = false / revoked_at) ends its access on the next
//     call.
//   - Fail-soft until sql/087 lands, like the watch-ticket signer:
//     a missing table answers 503 and serves nothing.
//
// THE TOOLS read through the app's existing data paths only:
//   - list_agents: the tenant's agent roster (envoy-agents.mjs
//     AGENT_PROVIDERS + AGENT_NAMES) joined with the runner presence
//     store (helmion.runner_provider_presence, via
//     runner-presence.mjs) — name, kind, present or not, last seen.
//   - agent_health: per agent, what the SERVER already knows —
//     presence, last answered, recent live-activity events and the
//     failures among them (helmion.runner_activity), provider
//     connections and their lifecycle (helmion.provider_connections
//     — provider and lifecycle only; the credential reference never
//     leaves that store), and connected tool accounts by NAME
//     (helmion.tool_connections account_label — never its server or
//     credential references). Voice state is NOT among this data:
//     voice runs on the Hillsboro box and in the desk's browser, the
//     cloud records no per-agent voice state, so the answer says
//     exactly that instead of inventing one.
//
// BITE 2 (2026-11-13) adds the shared memory tools, over the shared
// notebook — helmion.context_entries, the store envoy-notebook.mjs
// reads into every seat's prompt at dispatch and the librarian
// (envoy-librarian.mjs) files dispatched asks into. That notebook
// is Helmian's shared memory: the Neon store the agents themselves
// use. Scoping decisions, all deliberate:
//   - The notebook's own seat read includes the NULL-slug platform
//     rows (project_slug IS NULL — rows every tenant has always
//     read). This endpoint serves ONLY the key tenant's own rows
//     (project_slug = the key's tenant): the connector's law is
//     tenant-only, and the shared rows are a named exclusion, not
//     an oversight. Another tenant's rows can never appear.
//   - The librarian knowledge base (helmion.librarian_incidents)
//     and the blockers/lessons pile are memory-adjacent stores with
//     their own surfaces; they are NOT the shared notebook and are
//     not served here.
//   - context_entries carries no credential columns: the only
//     columns that exist are id, project_slug, key, value,
//     updated_at, and the reads project id, key, value, updated_at
//     — the tenant slug itself never rides an answer. The value is
//     the tenant's own memory content, served whole on read exactly
//     as the seats themselves see it.
//   - shared_memory_search matches the query as literal text
//     against the entry key and the entry value's text rendering,
//     newest first, bounded at SHARED_MEMORY_SEARCH_LIMIT results.
//     shared_memory_read takes the numeric id a search returned;
//     an id that belongs to another tenant answers exactly like an
//     id that does not exist — no existence leak.
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { AGENT_NAMES, AGENT_PROVIDERS, normalizeProvider } from './envoy-agents.mjs';
import { createRunnerPresenceStore } from './runner-presence.mjs';
import { renderNotebookValue } from './envoy-notebook.mjs';

export const MUSE_CONNECTOR_PATH = '/mcp';
export const MUSE_CONNECTOR_KEY_PREFIX = 'hlm_muse_';
export const MUSE_CONNECTOR_PROTOCOL_VERSION = '2025-03-26';
export const MUSE_CONNECTOR_SERVER_INFO = Object.freeze({ name: 'helmian-muse-connector', version: '1.1.0' });
// Shared memory bounds (Bite 2): a search answers at most this many
// entries, and a search snippet carries at most this many characters
// of the entry's rendered value around the match. Both bounds are
// named in the tool descriptions, so the caller can see them.
export const SHARED_MEMORY_SEARCH_LIMIT = 20;
export const SHARED_MEMORY_SNIPPET_MAX_CHARS = 240;
// The whole v1 scope: these tools read, nothing else exists to call.
export const MUSE_CONNECTOR_SCOPES = Object.freeze(['read']);

export const MUSE_CONNECTOR_TOOLS = Object.freeze([
  Object.freeze({
    name: 'list_agents',
    description: 'List the agents in your Helmian workspace: name, kind, whether each is present (a runner reports it connected), and when it was last seen. Takes no arguments; the workspace is fixed by the connection.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),
  }),
  Object.freeze({
    name: 'agent_health',
    description: 'Per-agent health from what the Helmian server itself has recorded: presence, last answered time, recent activity and failures, provider connection state, and connected tool account names. Voice state is not recorded on the server and is reported as such. Optional argument: provider (one agent id, e.g. "mistral") to read a single agent.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ provider: Object.freeze({ type: 'string', description: 'Optional single agent id to read.' }) }),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'shared_memory_search',
    description: 'Search your workspace shared memory (the Helmian shared notebook the agents read and write) for entries whose key or text matches the query. Returns at most 20 entries, newest first, each with its id, key, a snippet around the match, and when it was last updated. Read one in full with shared_memory_read. The workspace is fixed by the connection; only this workspace\'s own entries are searched.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ query: Object.freeze({ type: 'string', description: 'The text to look for in entry keys and entry text.' }) }),
      required: Object.freeze(['query']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'shared_memory_read',
    description: 'Read one shared memory entry in full by the id a shared_memory_search returned: its key, its full value, and when it was last updated. An id that is not part of this workspace answers exactly like an id that does not exist.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ id: Object.freeze({ type: 'integer', description: 'The entry id from a shared_memory_search result.' }) }),
      required: Object.freeze(['id']),
      additionalProperties: false,
    }),
  }),
]);
const TOOL_NAMES = new Set(MUSE_CONNECTOR_TOOLS.map((tool) => tool.name));
// A tools/call argument naming any of these is a tenant/user
// selector, and selectors are refused, never honoured (house law).
// The project-slug spellings joined in Bite 2: the shared notebook
// is keyed by project_slug and the tenant id IS the slug, so naming
// a slug is naming a tenant.
const SELECTOR_KEYS = new Set(['tenant', 'tenantId', 'tenant_id', 'organization', 'organizationId', 'organization_id', 'user', 'userId', 'user_id', 'subject', 'workspace', 'workspaceId', 'workspace_id', 'project', 'projectSlug', 'project_slug', 'slug']);

// --- the key: mint, hash, verify shape ---

export function generateMuseConnectorKey() {
  return `${MUSE_CONNECTOR_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashMuseConnectorKey(key) {
  return createHash('sha256').update(String(key ?? ''), 'utf8').digest('hex');
}

export function isMuseConnectorKeyShape(value) {
  return typeof value === 'string' && /^hlm_muse_[A-Za-z0-9_-]{40,64}$/.test(value);
}

function notConfiguredError() {
  return Object.assign(new Error('muse connector is not configured'), { status: 503, code: 'MUSE_CONNECTOR_NOT_CONFIGURED' });
}
const isMissingTable = (error) => error?.code === '42P01';

// --- the key store (sql/087) ---
//
// Plain pool queries, no tenant transaction: the tenant is what the
// lookup FINDS, so no tenant context can exist before it. The table
// is owner-only (RLS, no policies), like watch_ticket_secret.
export function createMuseConnectorKeyStore(pool) {
  return Object.freeze({
    // Mints a key for one tenant. The plaintext is returned exactly
    // once, in this result, and only its hash reaches the database.
    async mint(tenantId, label) {
      const tenant = String(tenantId ?? '').trim();
      if (!tenant) throw new TypeError('muse connector key tenant is required');
      const name = String(label ?? '').trim();
      if (!name) throw new TypeError('muse connector key label is required');
      const key = generateMuseConnectorKey();
      const id = `mck_${randomBytes(12).toString('base64url')}`;
      try {
        const r = await pool.query(
          'insert into helmion.muse_connector_keys (id, tenant_id, label, key_hash) values ($1, $2, $3, $4) returning id, tenant_id, label, created_at',
          [id, tenant, name, hashMuseConnectorKey(key)],
        );
        const row = r.rows[0];
        return Object.freeze({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          label: String(row.label),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          key,
        });
      } catch (error) {
        if (isMissingTable(error)) throw notConfiguredError();
        throw error;
      }
    },

    // Resolves a presented key to its tenant, or null. Disabled and
    // revoked keys resolve to null exactly like unknown ones: from
    // the caller's side a dead key is no key.
    async resolve(key) {
      if (!isMuseConnectorKeyShape(key)) return null;
      let r;
      try {
        r = await pool.query(
          'select id, tenant_id, label, enabled, revoked_at from helmion.muse_connector_keys where key_hash = $1',
          [hashMuseConnectorKey(key)],
        );
      } catch (error) {
        if (isMissingTable(error)) throw notConfiguredError();
        throw error;
      }
      const row = r.rows[0];
      if (!row || row.enabled !== true || row.revoked_at) return null;
      return Object.freeze({ id: String(row.id), tenantId: String(row.tenant_id), label: String(row.label) });
    },

    // Best-effort last-used stamp; a failure here never fails a call.
    async touch(id) {
      try {
        await pool.query('update helmion.muse_connector_keys set last_used_at = clock_timestamp() where id = $1', [String(id)]);
      } catch { /* the stamp is a courtesy, never a gate */ }
    },

    // The revocation road inside Helmian: the row is disabled and
    // stamped, and the key stops resolving on the next call.
    async disable(id) {
      try {
        const r = await pool.query(
          'update helmion.muse_connector_keys set enabled = false, revoked_at = clock_timestamp() where id = $1 returning id',
          [String(id)],
        );
        return (r.rowCount ?? 0) > 0;
      } catch (error) {
        if (isMissingTable(error)) throw notConfiguredError();
        throw error;
      }
    },
  });
}

// --- the data the tools serve ---

const withTenant = async (pool, tenantId, fn) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
};

async function safeRows(client, sql, params) {
  try { return (await client.query(sql, params)).rows; }
  catch (error) { if (isMissingTable(error)) return []; throw error; }
}

// One snapshot of everything the two tools serve, read through the
// existing stores and tables. The projections are deliberate:
// provider_connections contributes provider + lifecycle ONLY (its
// credential_reference column is never selected), and
// tool_connections contributes service + account NAME + state ONLY
// (its server_ref and credential_reference are never selected).
export function createMuseConnectorData(pool) {
  const presenceStore = createRunnerPresenceStore(pool);
  return Object.freeze({
    async snapshot(tenantId) {
      const [presence, activity, stored] = await Promise.all([
        presenceStore.list(tenantId),
        typeof presenceStore.listActivity === 'function' ? presenceStore.listActivity(tenantId) : [],
        withTenant(pool, tenantId, async (client) => {
          const connections = await safeRows(client,
            'select provider_id, lifecycle from helmion.provider_connections where tenant_id = current_setting(\'helmion.tenant_id\', true) order by provider_id', []);
          const toolAccounts = await safeRows(client,
            'select scope_id, service_id, account_label, state from helmion.tool_connections where tenant_id = current_setting(\'helmion.tenant_id\', true) and scope_kind = \'agent\' order by service_id', []);
          return { connections, toolAccounts };
        }),
      ]);
      return { presence, activity, connections: stored.connections, toolAccounts: stored.toolAccounts };
    },

    // The shared notebook (helmion.context_entries), the Bite 2
    // tools' store. The table predates tenants and carries no RLS:
    // the WHERE clause is the whole isolation story, exactly as in
    // envoy-notebook.mjs — except the seat read there also includes
    // the NULL-slug platform rows, and this endpoint deliberately
    // does not (see the header). The projection is id, key, value,
    // updated_at only: project_slug is the isolation column, never
    // payload. A missing table reads as an empty notebook, the
    // store's own fail-soft.
    async searchMemory(tenantId, query) {
      const pattern = `%${escapeLikePattern(query)}%`;
      return safeRows(pool,
        `select id, key, value, updated_at from helmion.context_entries
          where project_slug = $1 and (key ilike $2 escape '!' or value::text ilike $2 escape '!')
          order by updated_at desc, key
          limit ${SHARED_MEMORY_SEARCH_LIMIT}`,
        [String(tenantId), pattern]);
    },

    async readMemory(tenantId, id) {
      const rows = await safeRows(pool,
        'select id, key, value, updated_at from helmion.context_entries where project_slug = $1 and id = $2',
        [String(tenantId), id]);
      return rows[0] ?? null;
    },
  });
}

// LIKE patterns with '!' as the escape character: the caller's
// query is literal text, so its own %, _ and ! are escaped before
// the %…% wrap — a query can never widen its own match.
export function escapeLikePattern(text) {
  return String(text ?? '').replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

// The roster: the built-in agents in catalogue order, then any
// further provider a runner has reported presence for. `present` is
// the presence store's own affirmative signal — a device report of
// connected === true; a bare sync stamp row is a last-seen time, not
// a presence claim (tenant-agent-state's honesty rule).
export function assembleAgents({ presence = [] } = {}) {
  const byProvider = new Map();
  for (const row of presence) {
    const id = normalizeProvider(row?.provider) ?? String(row?.provider ?? '').trim().toLowerCase();
    if (id) byProvider.set(id, row);
  }
  const ids = [...AGENT_PROVIDERS];
  for (const id of byProvider.keys()) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => {
    const row = byProvider.get(id);
    return {
      id,
      name: AGENT_NAMES[id] ?? id,
      kind: id === 'maestro' ? 'router' : 'agent',
      present: row?.connected === true,
      lastSeenAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      lastAnsweredAt: row?.lastAnsweredAt ? new Date(row.lastAnsweredAt).toISOString() : null,
    };
  });
}

// Health per agent, from the same snapshot. Recent failures are the
// 'failed' stage events the workers themselves posted to the
// activity feed — the errors the server has actually recorded, not
// an inference from silence.
export function assembleAgentHealth(snapshot, providerFilter = null) {
  const agents = assembleAgents(snapshot);
  const byProvider = new Map();
  for (const row of snapshot?.connections ?? []) {
    const id = normalizeProvider(row?.provider_id) ?? String(row?.provider_id ?? '').trim().toLowerCase();
    if (id) byProvider.set(id, { provider: id, lifecycle: String(row?.lifecycle ?? '') });
  }
  const accountsByProvider = new Map();
  for (const row of snapshot?.toolAccounts ?? []) {
    const id = normalizeProvider(row?.scope_id);
    if (!id) continue;
    const list = accountsByProvider.get(id) ?? [];
    // Names only: the account label is the one human-facing string
    // the tool-connections store carries, and it is all that rides.
    list.push({ serviceId: String(row?.service_id ?? ''), accountLabel: row?.account_label ?? null, state: String(row?.state ?? '') });
    accountsByProvider.set(id, list);
  }
  const activityByProvider = new Map();
  for (const event of snapshot?.activity ?? []) {
    const id = normalizeProvider(event?.provider) ?? String(event?.provider ?? '').trim().toLowerCase();
    if (!id) continue;
    const list = activityByProvider.get(id) ?? [];
    list.push(event);
    activityByProvider.set(id, list);
  }
  return agents
    .filter((agent) => !providerFilter || agent.id === providerFilter)
    .map((agent) => {
      const events = activityByProvider.get(agent.id) ?? [];
      const shape = (event) => ({
        stage: String(event?.stage ?? ''),
        channelId: String(event?.channelId ?? ''),
        at: event?.at ? new Date(event.at).toISOString() : null,
        detail: event?.detail && typeof event.detail === 'object' ? event.detail : {},
      });
      return {
        ...agent,
        // Voice runs on the Hillsboro box and in the desk's browser;
        // the server records no per-agent voice state, and this
        // answer says so rather than dressing a guess up as one.
        voice: { state: 'not_recorded_server_side' },
        providerConnection: byProvider.get(agent.id) ?? null,
        toolAccounts: accountsByProvider.get(agent.id) ?? [],
        recentActivity: events.slice(0, 5).map(shape),
        recentFailures: events.filter((event) => event?.stage === 'failed').slice(0, 5).map(shape),
      };
    });
}

// --- the shared memory tools' assembly (pure) ---

// One line of memory text: control-free, whitespace-collapsed — the
// notebook's own rendering discipline (envoy-notebook.mjs), without
// its per-line cap; the snippet bound below does the capping.
function memoryOneLine(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A bounded window of the entry's rendered value around the first
// match of the query, so the caller sees WHY the entry matched.
// When the match lives only in the key, the window is the value's
// head. The ellipsis marks a cut on that side, honestly.
export function sharedMemorySnippet(value, query) {
  const text = memoryOneLine(renderNotebookValue(value));
  if (!text) return '';
  if (text.length <= SHARED_MEMORY_SNIPPET_MAX_CHARS) return text;
  const needle = memoryOneLine(query).toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return `${text.slice(0, SHARED_MEMORY_SNIPPET_MAX_CHARS)}…`;
  const start = Math.max(0, at - Math.floor((SHARED_MEMORY_SNIPPET_MAX_CHARS - needle.length) / 2));
  const slice = text.slice(start, start + SHARED_MEMORY_SNIPPET_MAX_CHARS);
  return `${start > 0 ? '…' : ''}${slice}${start + SHARED_MEMORY_SNIPPET_MAX_CHARS < text.length ? '…' : ''}`;
}

// Search rows in the store's shape → the wire shape. The projection
// is the guarantee: exactly these four fields ride, so no tenant
// slug, no store-internal column, nothing else can appear.
export function assembleMemorySearchResults(rows, query) {
  return (rows ?? []).slice(0, SHARED_MEMORY_SEARCH_LIMIT).map((row) => ({
    id: Number(row?.id),
    key: String(row?.key ?? ''),
    snippet: sharedMemorySnippet(row?.value, query),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}

// One entry read in full: the value rides whole, exactly as stored
// (a string stays a string; structured JSON stays structured) — the
// same rendering contract the notebook's own reads keep.
export function assembleMemoryEntry(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    key: String(row.key ?? ''),
    value: row.value ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// The id a read accepts: the integer a search returned (a numeric
// string of the same digits is the same id). Anything else —
// fractions, words, zero, negatives, numbers beyond the safe range —
// is refused before any data is read.
export function parseMemoryId(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

// --- the JSON-RPC surface (MCP streamable HTTP, stateless) ---

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });

function selectorKeyIn(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return Object.keys(args).find((key) => SELECTOR_KEYS.has(key)) ?? null;
}

// Builds the dispatcher for one authenticated tenant. Pure over the
// injected data snapshot reader, so proofs exercise this exact code
// with fixture data wired to the real stores' shapes.
export function createMuseConnectorRpc({ data } = {}) {
  if (!data || typeof data.snapshot !== 'function') throw new TypeError('muse connector data reader is required');
  return async function handleRpc({ tenantId, message } = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { status: 400, body: rpcError(message?.id, -32600, 'Invalid request: a single JSON-RPC 2.0 message is required.') };
    }
    const id = message.id;
    const isNotification = id === undefined || id === null || message.method.startsWith('notifications/');
    if (isNotification) return { status: 202, body: null };
    switch (message.method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion;
        return {
          status: 200,
          body: rpcResult(id, {
            protocolVersion: typeof asked === 'string' && asked ? asked : MUSE_CONNECTOR_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { ...MUSE_CONNECTOR_SERVER_INFO },
          }),
        };
      }
      case 'ping':
        return { status: 200, body: rpcResult(id, {}) };
      case 'tools/list':
        return { status: 200, body: rpcResult(id, { tools: MUSE_CONNECTOR_TOOLS }) };
      case 'tools/call': {
        const name = String(message.params?.name ?? '');
        if (!TOOL_NAMES.has(name)) {
          // Read-only enforcement: there is no other tool to call.
          return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name || '(empty)'}. This endpoint is read-only and offers only: ${[...TOOL_NAMES].join(', ')}.`) };
        }
        const args = message.params?.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          return { status: 200, body: rpcError(id, -32602, 'Tool arguments must be an object.') };
        }
        const selector = selectorKeyIn(args);
        if (selector) {
          return { status: 200, body: rpcError(id, -32602, `The argument "${selector}" is a tenant selector and is not accepted; the workspace is fixed by the connection.`) };
        }
        const allowed = new Set(({ agent_health: ['provider'], shared_memory_search: ['query'], shared_memory_read: ['id'] })[name] ?? []);
        const extra = Object.keys(args).find((key) => !allowed.has(key));
        if (extra) {
          return { status: 200, body: rpcError(id, -32602, `Unknown argument for ${name}: ${extra}.`) };
        }
        // The shared memory tools validate their one argument
        // BEFORE any data is read, in plain words: an empty search
        // or a malformed id is the caller's fix to make, and a
        // refused call reads nothing.
        let memoryQuery = null;
        let memoryId = null;
        if (name === 'shared_memory_search') {
          memoryQuery = typeof args.query === 'string' ? args.query.trim() : '';
          if (!memoryQuery) {
            return { status: 200, body: rpcError(id, -32602, 'shared_memory_search needs a query: one non-empty string of text to look for.') };
          }
        }
        if (name === 'shared_memory_read') {
          memoryId = parseMemoryId(args.id);
          if (memoryId === null) {
            return { status: 200, body: rpcError(id, -32602, 'shared_memory_read needs an id: the integer entry id a shared_memory_search returned.') };
          }
        }
        try {
          let payload;
          if (name === 'shared_memory_search') {
            if (typeof data.searchMemory !== 'function') throw Object.assign(new Error('memory search is not available'), { status: 503 });
            const rows = await data.searchMemory(tenantId, memoryQuery);
            payload = { results: assembleMemorySearchResults(rows, memoryQuery) };
          } else if (name === 'shared_memory_read') {
            if (typeof data.readMemory !== 'function') throw Object.assign(new Error('memory read is not available'), { status: 503 });
            const entry = assembleMemoryEntry(await data.readMemory(tenantId, memoryId));
            if (!entry) {
              // One answer for a foreign id and a missing id alike:
              // the read confirms nothing about other workspaces.
              return { status: 200, body: rpcError(id, -32602, 'No shared memory entry with that id exists in this workspace.') };
            }
            payload = { entry };
          } else {
            const snapshot = await data.snapshot(tenantId);
            if (name === 'list_agents') {
              payload = { agents: assembleAgents(snapshot) };
            } else {
              let filter = null;
              if (args.provider !== undefined) {
                filter = normalizeProvider(args.provider);
                if (!filter) return { status: 200, body: rpcError(id, -32602, `Unknown provider: ${String(args.provider)}`) };
              }
              payload = { agents: assembleAgentHealth(snapshot, filter) };
            }
          }
          return {
            status: 200,
            body: rpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              structuredContent: payload,
              isError: false,
            }),
          };
        } catch (error) {
          if (error?.status === 503) return { status: 503, body: rpcError(id, -32000, 'Helmian data is not available right now.') };
          return { status: 200, body: rpcError(id, -32000, 'The read failed on the server side.') };
        }
      }
      default:
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${message.method}. This endpoint answers initialize, ping, tools/list and tools/call only.`) };
    }
  };
}

// --- the HTTP route delegate (envoy-ably hook) ---

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw notConfiguredError();
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

function bearerOf(request) {
  const header = String(request?.headers?.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Route delegate: POST /mcp. Auth is the connector key itself — this
// route never consults the member session or a device token, and it
// runs before any tenant check because the key IS the tenant check.
// `keyStore` / `data` / `rpc` are injectable for tests and proofs.
// Returns false when the request is not ours.
export async function handleMuseConnectorRoute({
  request,
  response,
  requestUrl,
  send,
  readJson,
  keyStore = null,
  rpc = null,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== MUSE_CONNECTOR_PATH) return false;
  const reply = (status, payload) => {
    send(response, status, payload === null ? '' : JSON.stringify(payload));
    return true;
  };
  if (request?.method !== 'POST') {
    return reply(405, rpcError(null, -32600, 'Method not allowed: this endpoint answers POST only.'));
  }
  let keys = keyStore;
  let handleRpc = rpc;
  try {
    if (!keys || !handleRpc) {
      const pool = getPool();
      keys = keys ?? createMuseConnectorKeyStore(pool);
      handleRpc = handleRpc ?? createMuseConnectorRpc({ data: createMuseConnectorData(pool) });
    }
  } catch (error) {
    if (error?.status === 503) return reply(503, rpcError(null, -32000, 'The Muse connector is not configured.'));
    throw error;
  }
  let resolved;
  try {
    resolved = await keys.resolve(bearerOf(request));
  } catch (error) {
    if (error?.status === 503) return reply(503, rpcError(null, -32000, 'The Muse connector is not configured.'));
    return reply(503, rpcError(null, -32000, 'The Muse connector could not verify the key.'));
  }
  if (!resolved) {
    return reply(401, rpcError(null, -32001, 'Unauthorized: a valid Muse connector key is required.'));
  }
  let message;
  try {
    message = await readJson(request);
  } catch {
    return reply(400, rpcError(null, -32700, 'Parse error: the request body must be one JSON-RPC message.'));
  }
  const { status, body } = await handleRpc({ tenantId: resolved.tenantId, message });
  await keys.touch(resolved.id);
  return reply(status, body);
}

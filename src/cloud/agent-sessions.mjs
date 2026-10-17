// Agent sessions: named agent rows per tenant (migration 058). The Maestro is
// just an agent with provider='maestro'. The Agents panel reads this for the
// roster, live status colors, and per-session Guard filtering.
//
// Wired by delegation from handleEnvoyAblyRoute (live-admin.mjs is frozen).
// 42P01-safe: returns [] / 503 when the table is missing.

import { Pool } from 'pg';

const SESSIONS_PATH = '/api/admin/envoy/agents/sessions';

const PROVIDERS = new Set(['maestro', 'claude', 'openai', 'grok', 'gemini']);
const TIERS = new Set(['auto', 'fast', 'standard', 'deep']);
const STATUSES = new Set(['idle', 'active', 'warning', 'error']);

let pool = null;
function getPool() {
  if (pool) return pool;
  const url = process.env.HELMION_DATABASE_URL;
  if (!url) throw Object.assign(new Error('database not configured'), { status: 503 });
  pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  return pool;
}

const isMissingTable = (e) => e?.code === '42P01';
const missing = () => Object.assign(new Error('agent sessions store unavailable'), { status: 503 });

function createSessionsStore(dbPool) {
  const withTenant = async (tenantId, fn) => {
    const client = await dbPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* ignore */ }
      if (isMissingTable(error)) throw missing();
      throw error;
    } finally {
      client.release();
    }
  };

  const row = (r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    routingTier: r.routing_tier,
    status: r.status,
    lastMessage: r.last_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  return {
    async list(tenantId) {
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `select * from helmion.workspace_agent_sessions order by created_at asc`
        );
        return rows.map(row);
      });
    },
    async create(tenantId, { name, provider, routingTier }) {
      const n = String(name ?? '').trim().slice(0, 64);
      const p = String(provider ?? '').toLowerCase();
      const t = String(routingTier ?? 'auto').toLowerCase();
      if (!n) throw Object.assign(new Error('name is required'), { status: 400 });
      if (!PROVIDERS.has(p)) throw Object.assign(new Error('unknown provider'), { status: 400 });
      if (!TIERS.has(t)) throw Object.assign(new Error('unknown routing tier'), { status: 400 });
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `insert into helmion.workspace_agent_sessions(tenant_id, name, provider, routing_tier)
           values (current_setting('helmion.tenant_id', true), $1, $2, $3)
           returning *`,
          [n, p, t]
        );
        return row(rows[0]);
      });
    },
    async update(tenantId, id, { status, lastMessage }) {
      return withTenant(tenantId, async (client) => {
        const sets = [];
        const vals = [];
        if (status !== undefined) {
          const s = String(status).toLowerCase();
          if (!STATUSES.has(s)) throw Object.assign(new Error('unknown status'), { status: 400 });
          vals.push(s);
          sets.push(`status = $${vals.length}`);
        }
        if (lastMessage !== undefined) {
          vals.push(String(lastMessage).slice(0, 2000));
          sets.push(`last_message = $${vals.length}`);
        }
        if (sets.length === 0) throw Object.assign(new Error('nothing to update'), { status: 400 });
        vals.push(id);
        sets.push(`updated_at = clock_timestamp()`);
        const { rows } = await client.query(
          `update helmion.workspace_agent_sessions set ${sets.join(', ')} where id = $${vals.length} returning *`,
          vals
        );
        if (rows.length === 0) throw Object.assign(new Error('session not found'), { status: 404 });
        return row(rows[0]);
      });
    },
    async close(tenantId, id) {
      return withTenant(tenantId, async (client) => {
        const { rowCount } = await client.query(
          `delete from helmion.workspace_agent_sessions where id = $1`,
          [id]
        );
        if (rowCount === 0) throw Object.assign(new Error('session not found'), { status: 404 });
        return { closed: true };
      });
    },
  };
}

async function readJson(request) {
  try {
    const text = await new Promise((resolve, reject) => {
      let data = '';
      request.on('data', (c) => { data += c; });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

export async function handleAgentSessionsRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError }) {
  if (!requestUrl || !requestUrl.pathname.startsWith(SESSIONS_PATH)) return false;
  const sendJson = (status, obj) => send(response, status, JSON.stringify(obj));

  try {
    const actor = await activeTenantActor(request);
    // List/create are member-level; the bridge (device token) updates status.
    const store = createSessionsStore(getPool());
    const id = requestUrl.pathname.slice(SESSIONS_PATH.length).replace(/^\//, '') || null;

    if (request.method === 'GET' && !id) {
      const sessions = await store.list(actor.tenantId);
      return sendJson(200, { valid: true, sessions }), true;
    }
    if (request.method === 'POST' && !id) {
      const body = await readJson(request);
      const session = await store.create(actor.tenantId, body);
      return sendJson(201, { valid: true, session }), true;
    }
    if ((request.method === 'PATCH' || request.method === 'PUT') && id) {
      const body = await readJson(request);
      const session = await store.update(actor.tenantId, id, body);
      return sendJson(200, { valid: true, session }), true;
    }
    if (request.method === 'DELETE' && id) {
      await store.close(actor.tenantId, id);
      return sendJson(200, { valid: true, closed: true }), true;
    }
    return sendJson(405, { valid: false, code: 'AGENT_SESSIONS_METHOD_NOT_ALLOWED' }), true;
  } catch (error) {
    if (error instanceof TenantAuthorizationError || error?.name === 'TenantAuthorizationError') {
      return sendJson(403, { valid: false, code: 'AGENT_SESSIONS_FORBIDDEN' }), true;
    }
    const status = error?.status === 503 ? 503 : (error?.status ?? 400);
    return sendJson(status, {
      valid: false,
      code: 'AGENT_SESSIONS_FAILED',
      detail: error?.message ?? String(error),
    }), true;
  }
}

export { createSessionsStore };

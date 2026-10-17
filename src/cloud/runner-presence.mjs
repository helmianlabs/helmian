// Runner provider presence: presence-only booleans for the Settings UI.
// The cloud never holds provider credentials (migration 019 contract); this
// module carries connected true/false plus a timestamp, nothing secret.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the existing envoy-ably hook (envoy-ably.mjs delegates
// here). Device-token auth applies because the path lives under
// /api/admin/envoy/.
import { Pool } from 'pg';
import { PROVIDER_KEY_ENV } from '../runner/vault.mjs';

export const RUNNER_PRESENCE_PATH = '/api/admin/envoy/runner/presence';

// Own lazy pool: live-admin.mjs owns the primary pool and cannot pass it
// through the frozen hook. Same env var, same ssl rule.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const PROVIDERS = new Set(Object.keys(PROVIDER_KEY_ENV));

function isMissingTable(error) {
  return error?.code === '42P01';
}

// Minimal store over helmion.runner_provider_presence. 42P01-safe: when the
// migration has not been applied yet, reads return [] and writes report
// unavailable instead of throwing.
export function createRunnerPresenceStore(pool) {
  const withTenant = async (tenantId, fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
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

  return {
    async list(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            'select provider_name, connected, updated_at from helmion.runner_provider_presence where tenant_id = current_setting(\'helmion.tenant_id\', true)'
          );
          return r.rows.map((row) => ({
            provider: String(row.provider_name),
            connected: row.connected === true,
            updatedAt: row.updated_at,
          }));
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    // Upsert presence for one provider. Called by the bridge (device token).
    async report(tenantId, provider, connected) {
      const p = String(provider || '').toLowerCase();
      if (!PROVIDERS.has(p)) throw Object.assign(new Error('unknown provider'), { status: 400 });
      try {
        await withTenant(tenantId, async (client) => {
          await client.query(
            `insert into helmion.runner_provider_presence(tenant_id, provider_name, connected, updated_at)
             values (current_setting('helmion.tenant_id', true), $1, $2, clock_timestamp())
             on conflict (tenant_id, provider_name)
             do update set connected = excluded.connected, updated_at = clock_timestamp()`,
            [p, connected === true]
          );
        });
        return { ok: true, provider: p, connected: connected === true };
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('presence store unavailable'), { status: 503 });
        throw error;
      }
    },
  };
}

// Route delegate. GET lists presence (member auth); POST reports presence
// (device-token auth via activeTenantActor, same as other envoy paths).
// Returns false when the request is not ours.
export async function handleRunnerPresenceRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== RUNNER_PRESENCE_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  const store = createRunnerPresenceStore(getPool());
  try {
    const actor = await activeTenantActor(request);
    if (request.method === 'GET') {
      const presence = await store.list(actor.tenantId);
      send(response, 200, JSON.stringify({ valid: true, presence }));
    } else if (request.method === 'POST') {
      let body = {};
      try { body = (await readJson(request)) ?? {}; } catch {}
      const result = await store.report(actor.tenantId, body.provider, body.connected);
      send(response, 200, JSON.stringify({ valid: true, ...result }));
    } else {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
    }
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status === 503 ? 503 : 400);
    send(response, status, JSON.stringify({ valid: false, code: 'RUNNER_PRESENCE_FAILED', detail: error?.message ?? String(error) }));
  }
  return true;
}

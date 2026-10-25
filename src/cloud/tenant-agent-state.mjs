// Tenant agent state: whether a workspace's agents can actually answer,
// in one place, in plain words.
//
// A tenant's agents answer only when BOTH halves exist for that tenant:
//   (i)  a registered runner — a desktop link whose code was exchanged
//        for a device token (helmion.desktop_links), and
//   (ii) a provider credential — either a runner-vault presence report
//        saying the runner holds that provider's key
//        (helmion.runner_provider_presence, connected = true), or a
//        stored provider connection carrying a vault:// credential
//        reference for the tenant (helmion.provider_connections — the
//        reference's presence is the signal; today's connection code
//        never advances lifecycle past 'pending').
// With neither half, messages sit unanswered. The state names that
// honestly instead of letting the workspace stay silent.
//
// Wiring note: live-admin.mjs is frozen, so the route hangs off the
// existing envoy-ably hook, like runner-presence. GET
// /api/admin/envoy/agent-state returns the signed-in member's tenant
// state; the mesh consults the same computation when handing out work.
import { Pool } from 'pg';
import { normalizeProvider } from './envoy-agents.mjs';

export const TENANT_AGENT_STATE_PATH = '/api/admin/envoy/agent-state';

export const ASLEEP_NO_PROVIDER_LINE = 'Your agents wake up when you connect a subscription.';
export const ASLEEP_NO_RUNNER_LINE = 'Your agents wake up when your computer connects — open Helmian on your PC to bring them online.';

// provider_connections.provider_id -> the envoy agent vocabulary.
const CONNECTION_PROVIDER_MAP = Object.freeze({ openai_codex: 'openai', chatgpt: 'openai' });
export function connectionProvider(providerId) {
  const raw = String(providerId ?? '').trim().toLowerCase();
  return CONNECTION_PROVIDER_MAP[raw] ?? normalizeProvider(raw);
}

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * Pure state computation from the tenant's three signal sets:
 *   runners:     count of registered runners (exchanged desktop links)
 *   presence:    [{ provider, connected }] runner-vault presence rows
 *   connections: [{ provider_id, credential_reference }] stored connections
 * `gated` says whether the tenant has ANY readiness signal at all. A
 * tenant with no signals is a hand-wired/legacy tenant (the operator's
 * own): the claim path leaves it exactly as it behaves today, and this
 * state is only its report — never a new restriction invented for it.
 */
export function computeTenantAgentState({ runners = 0, presence = [], connections = [] } = {}) {
  const hasRunner = Number(runners) > 0;
  const presenceProviders = uniq(presence.filter((p) => p?.connected !== false).map((p) => normalizeProvider(p?.provider ?? p?.providerName)));
  const connectionProviders = uniq(connections
    .filter((c) => String(c?.credential_reference ?? c?.credentialReference ?? '').startsWith('vault://'))
    .map((c) => connectionProvider(c?.provider_id ?? c?.providerId)));
  const connectedProviders = uniq([...presenceProviders, ...connectionProviders]);
  const signals = {
    runner: hasRunner,
    presence: presence.length > 0,
    connections: connections.length > 0,
  };
  const gated = signals.runner || signals.presence || signals.connections;
  const awake = hasRunner && connectedProviders.length > 0;
  const reason = awake ? null : (!connectedProviders.length ? 'no-provider' : 'no-runner');
  const line = awake ? null : (reason === 'no-provider' ? ASLEEP_NO_PROVIDER_LINE : ASLEEP_NO_RUNNER_LINE);
  return Object.freeze({
    state: awake ? 'awake' : 'asleep',
    awake,
    hasRunner,
    connectedProviders: Object.freeze(connectedProviders),
    gated,
    reason,
    line,
  });
}

/**
 * The providers a claiming runner may be handed work for, or null when
 * claiming is not gated for this tenant (no readiness signals — the
 * hand-wired case, unchanged). Maestro rides on a real seat's
 * credential, so any connected provider makes Maestro answerable too.
 */
export function claimGateFor(state) {
  if (!state?.gated) return null;
  const gate = new Set(state.connectedProviders);
  if (gate.size) gate.add('maestro');
  return gate;
}

const isMissingTable = (error) => error?.code === '42P01';
async function safeRows(client, sql, params) {
  try { return (await client.query(sql, params)).rows; }
  catch (error) { if (isMissingTable(error)) return []; throw error; }
}

/** The state read on any query-capable client (mesh tx, store tx, tests). */
export async function tenantAgentStateOn(client, tenantId) {
  const id = String(tenantId);
  const runnerRows = await safeRows(client,
    'select count(*)::int as n from helmion.desktop_links where tenant_id=$1 and token_hash is not null and revoked_at is null', [id]);
  const presence = await safeRows(client,
    'select provider_name as provider, connected from helmion.runner_provider_presence where tenant_id=$1', [id]);
  const connections = await safeRows(client,
    'select provider_id, credential_reference from helmion.provider_connections where tenant_id=$1', [id]);
  return computeTenantAgentState({ runners: runnerRows[0]?.n ?? 0, presence, connections });
}

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

export function createTenantAgentStateStore(pool) {
  return Object.freeze({
    async stateFor(tenantId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
        const state = await tenantAgentStateOn(client, tenantId);
        await client.query('commit');
        return state;
      } catch (error) {
        try { await client.query('rollback'); } catch {}
        throw error;
      } finally { client.release(); }
    },
  });
}

// Route delegate (envoy-ably hook): the signed-in member reads their own
// tenant's state. Returns false when the request is not ours.
export async function handleTenantAgentStateRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError } = {}) {
  if (!requestUrl || requestUrl.pathname !== TENANT_AGENT_STATE_PATH) return false;
  try {
    const actor = await activeTenantActor(request);
    if (request.method !== 'GET') { send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' })); return true; }
    const state = await createTenantAgentStateStore(getPool()).stateFor(actor.tenantId);
    send(response, 200, JSON.stringify({ valid: true, agentState: state }));
  } catch (error) {
    const status = error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : (error?.status === 503 ? 503 : 400);
    send(response, status, JSON.stringify({ valid: false, code: 'TENANT_AGENT_STATE_FAILED' }));
  }
  return true;
}

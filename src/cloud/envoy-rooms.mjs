// Private agent rooms: one channel of kind 'agent' per agent in a tenant,
// created lazily the first time someone opens that agent's room — the
// Agent Chat pane in /app does, via POST /api/admin/envoy/agent-room.
//
// A room is ordinary Envoy storage (slug `agent-<provider>`, the agent's
// display name as its title), so messages, realtime and the channel list
// treat it like any other channel. What makes it a room is its mesh
// config, seeded once by envoy-mesh.mjs (seedRoomAgent): the roster is
// exactly that one agent, so prompts posted in the room route to it and
// its replies land there, away from the shared channels. No new
// migration: kind 'agent' has been in the envoy_channels check constraint
// since sql/009, and channel config reuses the envoy_messages store.
//
// Wired by delegation from handleEnvoyAblyRoute (live-admin.mjs is
// frozen), the same hook as envoy-mesh and agent-sessions.
import { Pool } from 'pg';
import { AGENT_NAMES, normalizeProvider } from './envoy-agents.mjs';
import { createEnvoyStore } from './envoy-chat.mjs';
import { createEnvoyMesh } from './envoy-mesh.mjs';

export const AGENT_ROOM_PATH = '/api/admin/envoy/agent-room';

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });

export function agentRoomSlug(provider) {
  const p = normalizeProvider(provider);
  return p ? `agent-${p}` : null;
}

// The channel definition for one provider's room, or null when the
// provider is unsupported.
export function agentRoomChannel(provider) {
  const p = normalizeProvider(provider);
  if (!p) return null;
  return Object.freeze({ slug: `agent-${p}`, title: AGENT_NAMES[p], kind: 'agent' });
}

export function createAgentRooms({ pool, chat = null, mesh = null } = {}) {
  const store = chat ?? createEnvoyStore(pool);
  const meshStore = mesh ?? createEnvoyMesh({ pool });
  return Object.freeze({
    // Get-or-create the room for `providerInput` in the actor's tenant
    // and make sure its roster is seeded. Idempotent: repeat calls return
    // the same channel with inserted/seeded false.
    async ensureRoom(actor, providerInput) {
      const provider = normalizeProvider(providerInput);
      if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      const { channel, inserted } = await store.createChannel(actor, agentRoomChannel(provider));
      const { seeded } = await meshStore.seedRoomAgent(actor, channel.id, provider);
      return { channel, inserted, seeded, provider };
    },
  });
}

export async function handleAgentRoomsRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson, rooms = null } = {}) {
  if (requestUrl?.pathname !== AGENT_ROOM_PATH) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error, fallback) => {
    const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? fallback });
  };
  let store;
  try { store = rooms ?? createAgentRooms({ pool: getPool() }); }
  catch { reply(503, { valid: false, code: 'ENVOY_ROOM_UNAVAILABLE' }); return true; }
  if (request.method !== 'POST') { reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' }); return true; }
  try {
    const body = (await readJson(request)) ?? {};
    // Only `provider` is accepted — tenant/authority selectors are refused
    // like every other Envoy route.
    if (Object.keys(body).some((key) => key !== 'provider')) throw fail(400, 'ENVOY_ROOM_INPUT_INVALID');
    const actor = await activeTenantActor(request);
    reply(200, { valid: true, ...await store.ensureRoom(actor, body.provider) });
  } catch (error) { failure(error, 'ENVOY_ROOM_FAILED'); }
  return true;
}

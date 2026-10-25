// The Maestro desk: the human's manager seat — one channel per tenant
// (slug 'maestro-desk', kind 'team', title 'Maestro'), created lazily the
// first time the manager enters the seat — the Envoy workspace in /app
// does, via POST /api/admin/envoy/maestro-desk.
//
// Maestro is the human. There is no agent behind this seat and nothing
// here answers anybody: the desk is ordinary Envoy storage, so channels,
// messages and realtime treat it like any other channel. What makes it
// the desk is its mesh config, seeded once by envoy-mesh.mjs (seedDesk):
// desk:true plus the roster of agents the manager can dispatch to. In
// the desk, the manager's sends are dispatches — @all broadcasts to
// every agent on the desk, @name picks the named agents, an unnamed send
// reaches the whole desk — and each agent's reply lands in the desk
// under its own name. No new migration: kind 'team' predates this file
// and channel config reuses the envoy_messages store.
//
// Wired by delegation from handleEnvoyAblyRoute (live-admin.mjs is
// frozen), the same hook as envoy-mesh, envoy-rooms and agent-sessions.
import { Pool } from 'pg';
import { MAESTRO_DESK_SLUG } from './envoy-agents.mjs';
import { createEnvoyStore } from './envoy-chat.mjs';
import { createEnvoyMesh } from './envoy-mesh.mjs';

export const MAESTRO_DESK_PATH = '/api/admin/envoy/maestro-desk';

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

// The one channel definition for the desk.
export function maestroDeskChannel() {
  return Object.freeze({ slug: MAESTRO_DESK_SLUG, title: 'Maestro', kind: 'team' });
}

export function createMaestroDesk({ pool, chat = null, mesh = null } = {}) {
  const store = chat ?? createEnvoyStore(pool);
  const meshStore = mesh ?? createEnvoyMesh({ pool });
  return Object.freeze({
    // Get-or-create the tenant's desk and make sure its dispatch config
    // is seeded. Idempotent: repeat calls return the same channel with
    // inserted/seeded false.
    async ensureDesk(actor) {
      const { channel, inserted } = await store.createChannel(actor, maestroDeskChannel());
      const { seeded, agents } = await meshStore.seedDesk(actor, channel.id);
      return { channel, inserted, seeded, agents };
    },
  });
}

export async function handleMaestroDeskRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson, desk = null } = {}) {
  if (requestUrl?.pathname !== MAESTRO_DESK_PATH) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error, fallback) => {
    const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? fallback });
  };
  let store;
  try { store = desk ?? createMaestroDesk({ pool: getPool() }); }
  catch { reply(503, { valid: false, code: 'ENVOY_DESK_UNAVAILABLE' }); return true; }
  if (request.method !== 'POST') { reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' }); return true; }
  try {
    const body = (await readJson(request)) ?? {};
    // The desk takes no input at all — tenant/authority selectors are
    // refused like every other Envoy route.
    if (Object.keys(body).length) throw fail(400, 'ENVOY_DESK_INPUT_INVALID');
    const actor = await activeTenantActor(request);
    reply(200, { valid: true, ...await store.ensureDesk(actor) });
  } catch (error) { failure(error, 'ENVOY_DESK_FAILED'); }
  return true;
}

// Envoy seat faces (emoji bite 5, 2026-11-04): the built-in provider
// seats' character faces. A custom agent's face rides its record in
// the channel config (Qwen's crab renders everywhere from it); the
// five provider seats had no record to ride — the desk drew a stock
// PNG per provider and that was the whole identity. This store gives
// each seat ONE face per workspace (helmion.workspace_agent_faces,
// sql/069), set by the owner or an admin in the Agents panel, read by
// every member, so a seat wears the same face on its messages, its
// panel card and its activity rows for the whole room.
//
// The write rule matches the surface Troy asked from: changing a
// seat's face is a workspace-identity act, so owner/admin only —
// the same gate the channel link actions use in the mesh
// (ENVOY_ADMIN_REQUIRED there; here ENVOY_FACE_FORBIDDEN so the desk
// can word it). Reads are every member's: a face nobody can see is
// not an identity.
//
// Faces are stored as the Unicode character, like every other face in
// the system (custom agents, member profiles, the 055 icons): Unicode
// stays the data, and the desk renders the character through bite 1's
// map to Helmian's own art. Validation is the map itself — a face
// must be one emoji token the shipped set draws (isFaceEmoji), so a
// stored face can never point at art that does not exist. A seat with
// no row wears its shipped default (AGENT_FACE_DEFAULTS in the same
// map); the GET answers the EFFECTIVE faces, so no client hardcodes
// the defaults to render a seat.
//
// Per-viewer re-skins stay where they already live: the 055
// workspace_agent_icons are a member's private override in the /app
// shell and are untouched by this store.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so
// this route hangs off the envoy-ably hook (envoy-ably.mjs delegates
// here), like reactions and runner presence.
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { normalizeProvider } from './envoy-agents.mjs';
import { AGENT_FACE_DEFAULTS, AGENT_FACE_PROVIDERS, isFaceEmoji } from '../../web/marketing/app/emoji-map.mjs';

export const AGENT_FACES_PATH = '/api/admin/envoy/agent-faces';
export { AGENT_FACE_DEFAULTS, AGENT_FACE_PROVIDERS };

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const isMissingTable = (error) => error?.code === '42P01';
const FACE_WRITERS = new Set(['owner', 'admin']);

// A seat face write names one of the five provider seats. Aliases
// resolve through the same vocabulary the mesh routes with
// ('chatgpt' -> 'openai'); 'maestro' is refused outright — Maestro is
// the human's seat and never wears an agent face. Custom-agent
// handles are refused too: their faces live on their own records.
export function normalizeFaceProvider(input) {
  const raw = String(input ?? '').trim().toLowerCase().replace(/^@/, '');
  if (raw === 'maestro' || raw === 'manager') throw fail(400, 'ENVOY_FACE_NOT_A_SEAT');
  const provider = normalizeProvider(raw);
  if (!provider || !AGENT_FACE_PROVIDERS.includes(provider)) throw fail(400, 'ENVOY_FACE_PROVIDER_UNSUPPORTED');
  return provider;
}

// The face a write carries: one drawn emoji token, stored as the
// character itself. null/'' is the clear — the seat goes back to its
// shipped default.
export function normalizeFaceEmoji(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const emoji = String(input).trim();
  if ([...emoji].length > 8 || !isFaceEmoji(emoji)) throw fail(400, 'ENVOY_FACE_EMOJI_UNSUPPORTED');
  return emoji;
}

// The effective face map: shipped defaults under whatever the
// workspace stored. Pure, so the read shape is testable without a db.
export function effectiveFaces(storedRows = []) {
  const faces = { ...AGENT_FACE_DEFAULTS };
  for (const row of storedRows ?? []) {
    const provider = String(row?.provider ?? '');
    const emoji = String(row?.emoji ?? '');
    if (AGENT_FACE_PROVIDERS.includes(provider) && isFaceEmoji(emoji)) faces[provider] = emoji;
  }
  return faces;
}

// Own lazy pool, same env var and ssl rule as the sibling envoy
// stores: live-admin.mjs owns the primary pool and cannot pass it
// through the frozen hook.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

export function createEnvoyFacesStore(pool) {
  const contextFor = (actor) => ({
    tenantId: actor.tenantId,
    actorSubject: actor.subject,
    actorRole: actor.role,
    sessionId: randomUUID(),
    requestId: randomUUID(),
  });
  const tx = (actor, work) => withTenantTransaction(pool, contextFor(actor), async (client, context) => {
    await requireActiveTenantMembership(client, context);
    return work(client);
  });

  const storedFaces = async (client, tenantId) => {
    const r = await client.query(
      'select provider, emoji from helmion.workspace_agent_faces where tenant_id=$1',
      [tenantId],
    );
    return r.rows;
  };

  return Object.freeze({
    // Every member reads the tenant's effective faces. Before sql/069
    // the read is the defaults, exactly like presence before its
    // migration: the desk renders the shipped faces and nothing else
    // changes.
    async facesFor(actor) {
      try {
        return await tx(actor, async (client) => ({ faces: effectiveFaces(await storedFaces(client, actor.tenantId)) }));
      } catch (error) {
        if (isMissingTable(error)) return { faces: effectiveFaces([]) };
        throw error;
      }
    },

    // One seat's face change. Owner/admin only (checked before the
    // write transaction opens, on the verified actor's role — never a
    // client-supplied one). emoji null clears the row, returning the
    // seat to its default. The answer carries the full effective map
    // after the change, so the caller renders from the answer alone.
    async setFace(actor, input) {
      if (!FACE_WRITERS.has(String(actor?.role ?? ''))) throw fail(403, 'ENVOY_FACE_FORBIDDEN');
      const provider = normalizeFaceProvider(input?.provider);
      const emoji = normalizeFaceEmoji(input?.emoji);
      try {
        return await tx(actor, async (client) => {
          if (emoji === null) {
            await client.query(
              'delete from helmion.workspace_agent_faces where tenant_id=$1 and provider=$2',
              [actor.tenantId, provider],
            );
          } else {
            await client.query(
              `insert into helmion.workspace_agent_faces(tenant_id, provider, emoji, updated_by_subject, updated_at)
               values ($1,$2,$3,$4, now())
               on conflict (tenant_id, provider) do update set emoji=excluded.emoji, updated_by_subject=excluded.updated_by_subject, updated_at=now()`,
              [actor.tenantId, provider, emoji, actor.subject],
            );
          }
          return { provider, emoji, faces: effectiveFaces(await storedFaces(client, actor.tenantId)) };
        });
      } catch (error) {
        if (isMissingTable(error)) throw fail(503, 'ENVOY_FACES_UNAVAILABLE');
        throw error;
      }
    },
  });
}

// Route delegate. GET lists the tenant's effective faces; POST applies
// one seat's change. Member auth via activeTenantActor, same as the
// reaction and presence routes. Returns false when not ours.
export async function handleEnvoyFacesRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store: injectedStore,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== AGENT_FACES_PATH) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error) => {
    const status = error?.status && error.status >= 400 && error.status < 600
      ? error.status
      : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? 'ENVOY_FACES_FAILED' });
  };
  let store;
  try {
    store = injectedStore ?? createEnvoyFacesStore(getPool());
  } catch {
    reply(503, { valid: false, code: 'ENVOY_FACES_UNAVAILABLE' });
    return true;
  }
  try {
    const actor = await activeTenantActor(request);
    if (request.method === 'GET') {
      reply(200, { valid: true, ...await store.facesFor(actor) });
    } else if (request.method === 'POST') {
      let body;
      try { body = (await readJson(request)) ?? {}; } catch { throw fail(400, 'ENVOY_BODY_INVALID'); }
      reply(200, { valid: true, ...await store.setFace(actor, body) });
    } else {
      reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' });
    }
  } catch (error) {
    failure(error);
  }
  return true;
}

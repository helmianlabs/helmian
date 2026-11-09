// Skill library routes (slash-skills DESIGN §2/§6 bite S2): the
// authoring API over the S1 store (src/cloud/skill-library.mjs) —
//
//   GET    /api/admin/skills        → { valid: true, skills: [row] }
//     The actor's tenant's list. A row is { id, name, description,
//     scope, seatIds, state } — NO bodies in the list (DESIGN S2);
//     the list is what the "/" menu's Skills group renders (§4.1).
//   GET    /api/admin/skills/:id    → { valid: true, skill }
//     The full record, body included — the editor's read.
//   POST   /api/admin/skills        → { valid: true, skill }
//     Author a skill. A duplicate id is the store's 409.
//   PUT    /api/admin/skills/:id    → { valid: true, skill }
//     Edit in place (DESIGN §2.4): fields present are written, absent
//     fields keep the stored values, the merged record is validated
//     as a whole by the store.
//   DELETE /api/admin/skills/:id    → { valid: true, removed: row }
//     Hard delete; deleting a ghost is a 404.
//
// Scoping, exactly like the sibling library reads
// (connector-library-read-route.mjs): member auth via
// activeTenantActor, the tenant from the actor's membership, the
// author from the actor's subject. There is NO tenant or person
// selector on the wire — a request naming one, in the query or in
// the body, is refused (400), never honoured. Writes refuse the
// auditor role (403), the envoy config-write law (envoy-mesh.mjs
// changeConfig): an auditor reads, never authors.
//
// SEAT VALIDATION lives here, not in the store (DESIGN §2.3/S1
// split): a 'seats'-scoped skill's seatIds must name seats this
// workspace knows — the library seats (connector-catalog.mjs
// LIVE_SEATS) plus the custom-agent handles in the tenant's channel
// configs. An unknown seat id is a 400, never a stored no-op. On
// PUT the MERGED record is validated (the scope/seatIds the edit
// would leave standing), so a scope-only edit cannot strand a
// skill on seats it never had, and a seatIds-only edit is checked
// against the standing scope.
//
// THE PASTE LIFT: authoring accepts a pasted Claude-Code skill file
// whole. When the body's head is frontmatter, the lift runs the
// established parseFrontmatter rules (src/agent/commands.mjs — the
// same parser slash-commands.mjs already imports cloud-side): the
// frontmatter block is stripped from the stored body, and its
// `name` / `description` fill those fields when the caller did not
// provide them; a frontmatter name that is already a valid skill
// slug also fills an absent id (a SKILL.md's name IS its slug —
// no derivation algorithm is invented here; the typed road's slug
// derivation lives in the editor, DESIGN §2.3/S3). Explicit fields
// always win. No frontmatter → the paste is the body, verbatim.
// The store then validates the result like any other input — caps,
// slug, credential-shaped keys refused by name.
//
// Wiring note: same shape as the sibling routes — live-admin.mjs is
// frozen at the push size limit, so the route hangs off the
// envoy-ably delegate hook with its own lazy pool (same env var,
// same ssl rule), beside handleConnectorLibraryRoute.
import { Pool } from 'pg';
import { createSkillLibraryStore, SKILL_ID_PATTERN } from './skill-library.mjs';
import { LIVE_SEATS } from './connector-catalog.mjs';
import { CONFIG_SUBJECT, parseConfig } from './envoy-agents.mjs';
import { parseFrontmatter } from '../agent/commands.mjs';

export const SKILLS_PATH = '/api/admin/skills';
const SKILL_ITEM_PREFIX = `${SKILLS_PATH}/`;

// Authority selectors are never accepted on these routes: the tenant
// is the actor's membership and the author is the actor's subject.
const AUTHORITY_SELECTORS = Object.freeze([
  'tenant_id', 'tenantId', 'organization_id', 'plant_id', 'facility_id',
  'person_id', 'personId', 'subject',
]);

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

// The list row: everything the picker shows, never the body.
function skillRow(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? null,
    scope: skill.scope,
    seatIds: Array.isArray(skill.seatIds) ? skill.seatIds : [],
    state: skill.state,
  };
}

/**
 * The paste lift (see the header): frontmatter at the head of a
 * pasted body is stripped and fills the fields the caller left
 * absent. Returns the input unchanged when there is no frontmatter
 * to lift — a plain-text paste is the body, exactly as pasted.
 */
export function liftSkillPaste(input) {
  if (!input || typeof input !== 'object' || typeof input.body !== 'string') return input;
  const parsed = parseFrontmatter(input.body);
  if (!parsed.frontmatterPresent) return input;
  const out = { ...input, body: parsed.body };
  const metaName = typeof parsed.meta?.name === 'string' ? parsed.meta.name.trim() : '';
  const metaDescription = typeof parsed.meta?.description === 'string' ? parsed.meta.description.trim() : '';
  if (out.name === undefined && metaName) out.name = metaName;
  if (out.description === undefined && metaDescription) out.description = metaDescription;
  if (out.id === undefined && metaName && SKILL_ID_PATTERN.test(metaName)) out.id = metaName;
  return out;
}

// The seats a 'seats'-scoped skill may name in this tenant: the
// library seats, plus the custom-agent handles the tenant's channel
// configs carry. The envoy store's listChannels projects only the
// link fields (discord/slack/github/avatar) onto each channel, so
// the rosters are read here from the config records themselves —
// the newest config per channel, the same read envoy-chat.mjs runs
// for its links. Tenant-scoped twice over: the RLS setting and the
// explicit tenant filter, and the actor's membership was already
// established by activeTenantActor before this runs.
async function productionKnownSeats(pool, actor) {
  const seats = new Set(LIVE_SEATS);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [actor.tenantId]);
    const r = await client.query(
      `select distinct on (channel_id) body from helmion.envoy_messages
        where tenant_id=$1 and author_subject=$2
        order by channel_id, created_at desc, id desc`,
      [actor.tenantId, CONFIG_SUBJECT],
    );
    for (const row of r.rows) {
      const config = parseConfig(row.body);
      for (const agent of config?.customAgents ?? []) {
        const handle = agent?.handle || agent?.id;
        if (handle) seats.add(String(handle));
      }
    }
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
  return seats;
}

async function assertKnownSeats(knownSeatsFor, actor, scope, seatIds) {
  if (scope !== 'seats' || !Array.isArray(seatIds)) return;
  const known = await knownSeatsFor(actor);
  for (const seatId of seatIds) {
    if (!known.has(String(seatId))) {
      throw fail(400, 'SKILL_SEAT_UNKNOWN', `seatIds names a seat this workspace does not have: "${seatId}"`);
    }
  }
}

// Route delegate. Returns false when the request is not ours.
// `store` and `knownSeats` are injectable for tests; production
// builds them from the lazy pool.
export async function handleSkillLibraryRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store = null,
  knownSeats = null,
} = {}) {
  const path = requestUrl?.pathname ?? '';
  const isList = path === SKILLS_PATH;
  let itemId = null;
  if (!isList && path.startsWith(SKILL_ITEM_PREFIX)) {
    const rest = path.slice(SKILL_ITEM_PREFIX.length);
    if (rest && !rest.includes('/')) itemId = rest;
  }
  if (!isList && itemId === null) return false;

  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error) => {
    const knownStatus = [400, 403, 404, 409, 503].includes(error?.status) ? error.status : null;
    const status = knownStatus ?? (error instanceof TenantAuthorizationError ? 403 : 503);
    const code = error?.code ?? (status === 403 ? 'SKILLS_MEMBERSHIP_REQUIRED'
      : status === 404 ? 'SKILL_NOT_FOUND'
      : status === 409 ? 'SKILL_CONFLICT'
      : status === 503 ? 'SKILLS_UNAVAILABLE'
      : status === 400 ? 'SKILL_INVALID' : 'SKILLS_FAILED');
    reply(status, { valid: false, code });
  };

  let skills;
  let knownSeatsFor;
  try {
    const pool = store && knownSeats ? null : getPool();
    skills = store ?? createSkillLibraryStore(pool);
    knownSeatsFor = knownSeats ?? ((actor) => productionKnownSeats(getPool(), actor));
  } catch { reply(503, { valid: false, code: 'SKILLS_UNAVAILABLE' }); return true; }

  const allowed = isList ? ['GET', 'POST'] : ['GET', 'PUT', 'DELETE'];
  if (!allowed.includes(request.method)) { reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' }); return true; }

  try {
    if (AUTHORITY_SELECTORS.some((key) => requestUrl.searchParams.has(key))) {
      throw fail(400, 'SKILLS_SELECTOR_INVALID', 'authority selector is not accepted');
    }
    let input = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      try { input = (await readJson(request)) ?? {}; }
      catch { throw fail(400, 'SKILL_BODY_INVALID', 'request body is not valid JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw fail(400, 'SKILL_BODY_INVALID', 'request body must be an object');
      }
      if (AUTHORITY_SELECTORS.some((key) => key in input)) {
        throw fail(400, 'SKILLS_SELECTOR_INVALID', 'authority selector is not accepted');
      }
    }
    const actor = await activeTenantActor(request);
    const write = request.method !== 'GET';
    if (write && String(actor.role ?? '').toLowerCase() === 'auditor') {
      throw fail(403, 'SKILL_ROLE_FORBIDDEN', 'an auditor reads skills but does not author them');
    }

    if (isList && request.method === 'GET') {
      const rows = await skills.listSkills(actor.tenantId);
      reply(200, { valid: true, skills: rows.map(skillRow) });
      return true;
    }
    if (isList && request.method === 'POST') {
      const lifted = liftSkillPaste(input);
      await assertKnownSeats(knownSeatsFor, actor, lifted.scope, lifted.seatIds);
      const skill = await skills.createSkill(actor.tenantId, actor.subject, lifted);
      reply(200, { valid: true, skill });
      return true;
    }
    // Item routes: the record must exist before it can be read,
    // edited, validated against, or removed. A malformed id is the
    // store's own 400, raised on this read.
    const existing = await skills.getSkill(actor.tenantId, itemId);
    if (!existing) throw fail(404, 'SKILL_NOT_FOUND', 'skill not found');
    if (request.method === 'GET') {
      reply(200, { valid: true, skill: existing });
      return true;
    }
    if (request.method === 'PUT') {
      const lifted = liftSkillPaste(input);
      // Seat validation runs on the record the edit would leave
      // standing (the store merges the same way), not just on the
      // fields the caller happened to send.
      const mergedScope = lifted.scope !== undefined ? lifted.scope : existing.scope;
      const mergedSeatIds = lifted.seatIds !== undefined ? lifted.seatIds : existing.seatIds;
      await assertKnownSeats(knownSeatsFor, actor, mergedScope, mergedSeatIds);
      const skill = await skills.updateSkill(actor.tenantId, itemId, lifted);
      reply(200, { valid: true, skill });
      return true;
    }
    // DELETE
    const removed = await skills.removeSkill(actor.tenantId, itemId);
    if (!removed) throw fail(404, 'SKILL_NOT_FOUND', 'skill not found');
    reply(200, { valid: true, removed: skillRow(removed) });
    return true;
  } catch (error) { failure(error); }
  return true;
}

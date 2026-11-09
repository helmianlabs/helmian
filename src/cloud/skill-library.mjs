// Skill library (slash-skills DESIGN §2, build bite S1): the store
// over helmion.skills (sql/075) — Helmian's own skills, the instruction
// text a workspace's people author and attach to messages for one
// agent or for every agent.
//
// A SIBLING of connector-library.mjs, not part of it, by shape: that
// store's records carry broker modes, connections and frozen tool
// snapshots; a skill is one record of text with a scope, and none of
// those laws apply. Both stores share the same pool, the same
// tenant-transaction discipline, the same helmion schema and the same
// plain-words error idiom — one database, one custody pattern.
//
// THE LAWS, enforced here in code, not by convention:
//   - One record per (tenant, skill): a skill is authored once per
//     workspace and its targets are data on the record (scope /
//     seatIds). There are no per-seat copies — one edit updates the
//     skill for every seat it targets.
//   - A duplicate id is a 409, never a silent overwrite: remove it or
//     rename it. Editing is in place (updateSkill): no connections or
//     snapshots hang off a skill, so the connector library's
//     remove-and-re-add law does not apply here (DESIGN §2.4).
//   - Scope lives on the record and is the ceiling for every message
//     that attaches the skill: dispatch (envoy-mesh.mjs) clamps a
//     message's target to the record, so a seat-scoped skill can
//     never be widened by a message. This store only keeps the record
//     honest; the clamp is dispatch's.
//   - seatIds are DATA at this layer: shape-validated (seat-id slugs),
//     never resolved against the tenant's channel config. Whether a
//     seat id names a seat the tenant actually has is the route
//     layer's check (bite S2), where the config is in hand.
//   - A body is inert text: stored verbatim and later injected into a
//     turn as fenced context (src/agent/attachments.mjs). No field on
//     this record can hold a credential, and credential-shaped input
//     keys are refused by name, the connector store's discipline.

export const SKILL_SCOPES = Object.freeze(['blanket', 'seats']);
export const SKILL_STATES = Object.freeze(['available', 'disabled-by-owner']);
export const SKILL_ID_MAX_CHARS = 64;
export const SKILL_NAME_MAX_CHARS = 120;
export const SKILL_DESCRIPTION_MAX_CHARS = 200;
export const SKILL_BODY_MAX_CHARS = 24_000;
// Single segment, no colon: a colon would collide with the
// plugin-namespaced command names (plugin:skill) the composer's
// by-name road already validates (DESIGN §2.1).
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// Seat ids (library seats and custom-agent handles share this slug
// shape — the connector toggles' pattern in envoy-agents.mjs).
const SEAT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

// Field names that would mean the caller is handing us a credential
// VALUE. A skill has no credential fields at all; refused by name
// wherever skill-shaped input is accepted — the same discipline as
// connector-library.mjs.
const CREDENTIAL_VALUE_KEYS = Object.freeze(['accessToken', 'refreshToken', 'token', 'secret', 'password', 'apiKey', 'api_key', 'credential', 'value']);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}
function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}
function isMissingTable(error) {
  return error?.code === '42P01';
}
function storeUnavailable(error) {
  if (isMissingTable(error)) return Object.assign(new Error('skill library store unavailable'), { status: 503 });
  return error;
}

function requireSubject(subject) {
  if (!subject || typeof subject !== 'string') throw badRequest('author subject is required');
  return subject;
}
function refuseCredentialValues(input) {
  for (const key of CREDENTIAL_VALUE_KEYS) {
    if (key in input) {
      throw badRequest(`"${key}" carries a credential value — a skill holds instruction text only`);
    }
  }
}

// One display line: control characters stripped, whitespace collapsed.
// The name and description cleaning rule (DESIGN §2.1 — the
// fileAttachmentName discipline in envoy-agents.mjs).
function cleanLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function validateSkillId(value) {
  const id = String(value ?? '');
  if (id.length > SKILL_ID_MAX_CHARS || !SKILL_ID_PATTERN.test(id)) {
    throw badRequest('skill id is invalid: a lowercase slug of at most 64 characters, no colon');
  }
  return id;
}

function validateSeatIds(value, scope) {
  // A blanket skill's targets are every agent; a stored seat list
  // would be a second, contradicting fact, so it normalizes to empty.
  if (scope === 'blanket') return [];
  if (!Array.isArray(value) || !value.length) {
    throw badRequest('seatIds must name at least one seat when scope is "seats"');
  }
  const out = [];
  for (const raw of value) {
    const id = String(raw ?? '');
    if (!SEAT_ID_PATTERN.test(id)) throw badRequest('seatIds entries must be seat ids');
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Raw skill input → the canonical record fields, or a thrown 400. */
function validateSkillInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('skill input is invalid');
  refuseCredentialValues(input);
  const name = cleanLine(input.name);
  if (!name) throw badRequest('name is required');
  if (name.length > SKILL_NAME_MAX_CHARS) throw badRequest('name is too long');
  const description = cleanLine(input.description);
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) throw badRequest('description is too long');
  if (typeof input.body !== 'string' || !input.body.trim()) throw badRequest('body is required');
  if (input.body.length > SKILL_BODY_MAX_CHARS) throw badRequest('body is too long');
  if (!SKILL_SCOPES.includes(input.scope)) {
    throw badRequest(`scope must be one of ${SKILL_SCOPES.join(', ')}`);
  }
  const state = input.state === undefined ? 'available' : input.state;
  if (!SKILL_STATES.includes(state)) {
    throw badRequest(`state must be one of ${SKILL_STATES.join(', ')}`);
  }
  return {
    name,
    description: description || null,
    body: input.body,
    scope: input.scope,
    seatIds: validateSeatIds(input.seatIds, input.scope),
    state,
  };
}

// ------------------------------------------------------------------ row map

function skillOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    body: row.body,
    scope: row.scope,
    seatIds: Array.isArray(row.seat_ids) ? row.seat_ids : [],
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --------------------------------------------------------------------- store

export function createSkillLibraryStore(pool) {
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

  const whereSkill = `tenant_id = current_setting('helmion.tenant_id', true) and id = $1`;

  async function readSkill(client, skillId) {
    const r = await client.query(
      `select * from helmion.skills where ${whereSkill}`,
      [skillId],
    );
    return r.rows[0] ?? null;
  }

  return {
    /**
     * Author a skill in the tenant's workspace. A duplicate id is a
     * 409 — remove it or rename it; creation never overwrites.
     */
    async createSkill(tenantId, subject, input = {}) {
      requireSubject(subject);
      const id = validateSkillId(input?.id);
      const skill = validateSkillInput(input);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readSkill(client, id);
          if (existing) {
            throw conflict('a skill with this id already exists in this workspace — remove it or rename it');
          }
          const r = await client.query(
            `insert into helmion.skills
               (tenant_id, id, name, description, body, scope, seat_ids, state, created_by)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8)
             returning *`,
            [id, skill.name, skill.description, skill.body, skill.scope, skill.seatIds, skill.state, subject],
          );
          return skillOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** One skill by id, or null. Another tenant's record reads as absent. */
    async getSkill(tenantId, skillId) {
      const id = validateSkillId(skillId);
      try {
        return await withTenant(tenantId, async (client) => skillOf(await readSkill(client, id)));
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** The workspace's whole skill list, by id. Starts empty and honest. */
    async listSkills(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.skills
              where tenant_id = current_setting('helmion.tenant_id', true)
              order by id`,
          );
          return r.rows.map(skillOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /**
     * Edit a skill in place (DESIGN §2.4): fields present in the input
     * are written, absent fields keep the stored values, and the
     * merged record is validated as a whole — so a scope change to
     * "seats" without any seat named is refused, and a change to
     * "blanket" clears the seat list. Authorship (created_by) never
     * changes. Messages already sent name only the id, so an edit
     * reaches future turns and any turn not yet dispatched.
     */
    async updateSkill(tenantId, skillId, input = {}) {
      const id = validateSkillId(skillId);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('skill input is invalid');
      refuseCredentialValues(input);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readSkill(client, id);
          if (!existing) throw notFound('skill not found');
          const before = skillOf(existing);
          const skill = validateSkillInput({
            name: input.name !== undefined ? input.name : before.name,
            description: input.description !== undefined ? input.description : before.description,
            body: input.body !== undefined ? input.body : before.body,
            scope: input.scope !== undefined ? input.scope : before.scope,
            seatIds: input.seatIds !== undefined ? input.seatIds : before.seatIds,
            state: input.state !== undefined ? input.state : before.state,
          });
          const r = await client.query(
            `update helmion.skills
               set name = $2, description = $3, body = $4, scope = $5,
                   seat_ids = $6, state = $7, updated_at = now()
             where ${whereSkill} returning *`,
            [id, skill.name, skill.description, skill.body, skill.scope, skill.seatIds, skill.state],
          );
          return skillOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * Remove a skill outright. Returns the removed record, or null
     * when there was nothing to remove. A message that still names the
     * id resolves at dispatch to an honest missing line (DESIGN §2.4)
     * — never a silent drop, never a claim it ran.
     */
    async removeSkill(tenantId, skillId) {
      const id = validateSkillId(skillId);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `delete from helmion.skills where ${whereSkill} returning *`,
            [id],
          );
          return skillOf(r.rows[0] ?? null);
        });
      } catch (error) { throw storeUnavailable(error); }
    },
  };
}

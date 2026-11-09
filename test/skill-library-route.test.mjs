// Skill library routes — slash-skills DESIGN §6 bite S2 gate.
//
// The delegate is exercised with the REAL S1 store
// (createSkillLibraryStore) over an in-memory fake pool in the
// repo's pattern (the fake keys every row by the tenant the
// transaction set, so tenant isolation is exercised the way RLS
// enforces it), a fake actor, and a fake known-seats resolver.
// Store semantics themselves (validation, merged edits, the 409
// law) are pinned by test/skill-library.test.mjs; what is pinned
// HERE is the route layer's own work:
//
//   - the tenant and the author come from the actor, never from the
//     request: authority selectors in the query OR the body are
//     refused (400), and one tenant's skills never answer another
//     tenant on any of the five routes;
//   - writes refuse the auditor role (403), reads do not;
//   - seat validation is the route's (DESIGN §2.3 split): an
//     unknown seat id is a 400 on create, and on edit the MERGED
//     record is validated;
//   - the paste lift: a pasted SKILL.md lands with its frontmatter
//     stripped and its name/description filled, explicit fields win,
//     and a plain-text paste is stored verbatim;
//   - the list carries no bodies; the single read does;
//   - method matrix, membership failure, foreign paths.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkillLibraryStore } from '../src/cloud/skill-library.mjs';
import { SKILLS_PATH, handleSkillLibraryRoute, liftSkillPaste } from '../src/cloud/skill-library-route.mjs';

class TenantAuthorizationError extends Error {}

const ACTOR = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const OTHER_ACTOR = { subject: 'user:other', tenantId: 'tenant-b', role: 'owner' };
const AUDITOR = { subject: 'user:audit', tenantId: 'tenant-a', role: 'auditor' };
// The seats this workspace knows: two library seats plus one
// custom-agent handle from a channel config.
const KNOWN_SEATS = ['claude', 'chatgpt', 'grok', 'wash-boss'];

// ---------------------------------------------------------------- fake pool
// The S1 store test's fake, trimmed to the skills table.
function fakePool() {
  const skills = new Map();
  let tenant = null;
  const key = (id) => `${tenant}|${id}`;
  const now = () => new Date();
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (text.includes('insert into helmion.skills')) {
            const [id, name, description, body, scope, seatIds, state, createdBy] = vals;
            const row = { tenant_id: tenant, id, name, description, body, scope, seat_ids: [...seatIds], state, created_by: createdBy, created_at: now(), updated_at: now() };
            skills.set(key(id), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.skills')) {
            const [id, name, description, body, scope, seatIds, state] = vals;
            const row = skills.get(key(id));
            if (!row) return { rows: [], rowCount: 0 };
            Object.assign(row, { name, description, body, scope, seat_ids: [...seatIds], state, updated_at: now() });
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.skills')) {
            const row = skills.get(key(vals[0]));
            if (!row) return { rows: [], rowCount: 0 };
            skills.delete(key(vals[0]));
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.skills') && text.includes('order by id')) {
            const out = [...skills.values()].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.id < b.id ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.skills')) {
            const row = skills.get(key(vals[0]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`unexpected query: ${text}`);
        },
        release() {},
      };
    },
  };
}

function harness({ actor = ACTOR, actorError = null } = {}) {
  const sent = [];
  const store = createSkillLibraryStore(fakePool());
  const knownSeats = async () => new Set(KNOWN_SEATS);
  return {
    sent,
    store,
    async run(path, { method = 'GET', body = undefined, badJson = false } = {}) {
      const requestUrl = new URL(path, 'http://local');
      const handled = await handleSkillLibraryRoute({
        request: { method },
        response: {},
        requestUrl,
        activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
        send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
        TenantAuthorizationError,
        readJson: async () => { if (badJson) throw new Error('not json'); return body ?? {}; },
        store,
        knownSeats,
      });
      return handled;
    },
  };
}

const SKILL = { id: 'deep-research', name: 'Deep Research', description: 'Dig before answering.', body: 'Research the question from primary sources.', scope: 'seats', seatIds: ['claude'] };

// ------------------------------------------------------------ happy paths

test('create → read → list → edit → delete, the full authoring round trip', async () => {
  const h = harness();

  await h.run(SKILLS_PATH, { method: 'POST', body: SKILL });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.valid, true);
  assert.equal(h.sent[0].body.skill.id, 'deep-research');
  assert.equal(h.sent[0].body.skill.body, SKILL.body);
  assert.equal(h.sent[0].body.skill.createdBy, 'user:troy');
  assert.deepEqual(h.sent[0].body.skill.seatIds, ['claude']);

  // The list row carries the picker's fields and NO body.
  await h.run(SKILLS_PATH);
  assert.equal(h.sent[1].status, 200);
  assert.deepEqual(h.sent[1].body.skills, [{
    id: 'deep-research', name: 'Deep Research', description: 'Dig before answering.',
    scope: 'seats', seatIds: ['claude'], state: 'available',
  }]);
  assert.equal('body' in h.sent[1].body.skills[0], false);

  // The single read is the editor's: body included.
  await h.run(`${SKILLS_PATH}/deep-research`);
  assert.equal(h.sent[2].status, 200);
  assert.equal(h.sent[2].body.skill.body, SKILL.body);

  // Edit in place: rename + new body; untouched fields stand.
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { name: 'Deep Research v2', body: 'Dig deeper.' } });
  assert.equal(h.sent[3].status, 200);
  assert.equal(h.sent[3].body.skill.name, 'Deep Research v2');
  assert.equal(h.sent[3].body.skill.body, 'Dig deeper.');
  assert.equal(h.sent[3].body.skill.description, 'Dig before answering.');
  assert.equal(h.sent[3].body.skill.createdBy, 'user:troy');

  // Delete answers the body-less row; the skill is then gone.
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'DELETE' });
  assert.equal(h.sent[4].status, 200);
  assert.equal(h.sent[4].body.removed.id, 'deep-research');
  assert.equal('body' in h.sent[4].body.removed, false);
  await h.run(`${SKILLS_PATH}/deep-research`);
  assert.equal(h.sent[5].status, 404);
  assert.equal(h.sent[5].body.code, 'SKILL_NOT_FOUND');
  await h.run(SKILLS_PATH);
  assert.deepEqual(h.sent[6].body.skills, []);
});

test('duplicate create is the store\'s 409, never an overwrite', async () => {
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: SKILL });
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, body: 'A different body.' } });
  assert.equal(h.sent[1].status, 409);
  assert.equal(h.sent[1].body.code, 'SKILL_CONFLICT');
  const got = await h.store.getSkill('tenant-a', 'deep-research');
  assert.equal(got.body, SKILL.body);
});

test('editing or deleting a ghost is a 404', async () => {
  const h = harness();
  await h.run(`${SKILLS_PATH}/ghost`, { method: 'PUT', body: { name: 'Nope' } });
  assert.equal(h.sent[0].status, 404);
  assert.equal(h.sent[0].body.code, 'SKILL_NOT_FOUND');
  await h.run(`${SKILLS_PATH}/ghost`, { method: 'DELETE' });
  assert.equal(h.sent[1].status, 404);
});

// ------------------------------------------------------------- validation

test('slug rules: no capitals, no colon, at most 64 characters', async () => {
  for (const id of ['Has-Caps', 'plugin:skill', 'a'.repeat(65), '-leading-dash', '']) {
    const h = harness();
    await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, id } });
    assert.equal(h.sent[0].status, 400, JSON.stringify(id));
    assert.equal(h.sent[0].body.code, 'SKILL_INVALID');
  }
  const ok = harness();
  await ok.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, id: 'a'.repeat(64) } });
  assert.equal(ok.sent[0].status, 200);
});

test('caps: description 200 and body 24,000 are the ceilings, inclusive', async () => {
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, description: 'd'.repeat(201) } });
  assert.equal(h.sent[0].status, 400);
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, body: 'b'.repeat(24_001) } });
  assert.equal(h.sent[1].status, 400);
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, description: 'd'.repeat(200), body: 'b'.repeat(24_000) } });
  assert.equal(h.sent[2].status, 200);
  // A missing or blank body and an unknown scope are refused too.
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, id: 'other', body: '   ' } });
  assert.equal(h.sent[3].status, 400);
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, id: 'other', scope: 'everyone' } });
  assert.equal(h.sent[4].status, 400);
});

test('credential-shaped keys are refused by name, through the route', async () => {
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, token: 'sk-live-whatever' } });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'SKILL_INVALID');
  await h.run(SKILLS_PATH);
  assert.deepEqual(h.sent[1].body.skills, []);
});

// --------------------------------------------------------- seat validation

test('seat validation: unknown seats refused on create; known seats and custom handles pass', async () => {
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, seatIds: ['claude', 'ghost-seat'] } });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'SKILL_SEAT_UNKNOWN');
  await h.run(SKILLS_PATH);
  assert.deepEqual(h.sent[1].body.skills, []);

  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, seatIds: ['wash-boss'] } });
  assert.equal(h.sent[2].status, 200);
  assert.deepEqual(h.sent[2].body.skill.seatIds, ['wash-boss']);

  // A blanket skill names no seats; a stray list is discarded by the
  // store, not validated into a refusal.
  const b = harness();
  await b.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, scope: 'blanket', seatIds: ['ghost-seat'] } });
  assert.equal(b.sent[0].status, 200);
  assert.deepEqual(b.sent[0].body.skill.seatIds, []);
});

test('seat validation on edit runs on the merged record', async () => {
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, scope: 'blanket', seatIds: [] } });
  assert.equal(h.sent[0].status, 200);
  // Scope-only edit to 'seats' with a seatIds list naming a ghost.
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { scope: 'seats', seatIds: ['ghost-seat'] } });
  assert.equal(h.sent[1].status, 400);
  assert.equal(h.sent[1].body.code, 'SKILL_SEAT_UNKNOWN');
  // SeatIds-only edit against the standing 'blanket' scope: the list
  // is discarded by the merge, so there is nothing to refuse.
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { seatIds: ['ghost-seat'] } });
  assert.equal(h.sent[2].status, 200);
  assert.deepEqual(h.sent[2].body.skill.seatIds, []);
  // The same edit once the record stands at 'seats' IS validated.
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { scope: 'seats', seatIds: ['claude'] } });
  assert.equal(h.sent[3].status, 200);
  await h.run(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { seatIds: ['ghost-seat'] } });
  assert.equal(h.sent[4].status, 400);
  assert.equal(h.sent[4].body.code, 'SKILL_SEAT_UNKNOWN');
});

// ------------------------------------------------------------- paste lift

test('paste lift: a full SKILL.md lands as id, name, description and a clean body', async () => {
  const h = harness();
  const pasted = ['---', 'name: deep-research', 'description: Dig before answering.', '---', '', 'Research the question from primary sources.'].join('\n');
  await h.run(SKILLS_PATH, { method: 'POST', body: { body: pasted, scope: 'seats', seatIds: ['claude'] } });
  assert.equal(h.sent[0].status, 200);
  const skill = h.sent[0].body.skill;
  assert.equal(skill.id, 'deep-research');
  assert.equal(skill.name, 'deep-research');
  assert.equal(skill.description, 'Dig before answering.');
  assert.equal(skill.body, 'Research the question from primary sources.');
});

test('paste lift: a plain-text paste is stored verbatim', async () => {
  const h = harness();
  const body = 'Just instructions.\n\nNo frontmatter here — even with a --- rule below.\n\n---\n';
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, body } });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.skill.body, body);
});

test('paste lift: frontmatter without a name lifts the description only', async () => {
  const h = harness();
  const pasted = ['---', 'description: From the file.', '---', 'The body.'].join('\n');
  await h.run(SKILLS_PATH, { method: 'POST', body: { id: 'named-by-caller', name: 'Caller Name', body: pasted, scope: 'blanket' } });
  assert.equal(h.sent[0].status, 200);
  const skill = h.sent[0].body.skill;
  assert.equal(skill.id, 'named-by-caller');
  assert.equal(skill.name, 'Caller Name');
  assert.equal(skill.description, 'From the file.');
  assert.equal(skill.body, 'The body.');
});

test('paste lift: explicit fields win over the frontmatter', async () => {
  const h = harness();
  const pasted = ['---', 'name: file-name', 'description: File description.', '---', 'The body.'].join('\n');
  await h.run(SKILLS_PATH, { method: 'POST', body: { id: 'caller-id', name: 'Caller Name', description: 'Caller description.', body: pasted, scope: 'blanket' } });
  assert.equal(h.sent[0].status, 200);
  const skill = h.sent[0].body.skill;
  assert.equal(skill.id, 'caller-id');
  assert.equal(skill.name, 'Caller Name');
  assert.equal(skill.description, 'Caller description.');
  assert.equal(skill.body, 'The body.');
});

test('liftSkillPaste: no frontmatter, no change — the same object rides through', () => {
  const input = { id: 'x', body: 'plain' };
  assert.equal(liftSkillPaste(input), input);
  const lifted = liftSkillPaste({ body: '---\nname: a-b\ndescription: D\n---\nB' });
  assert.deepEqual(lifted, { body: 'B', name: 'a-b', description: 'D', id: 'a-b' });
});

// ---------------------------------------------------------- tenant isolation

test('tenant isolation on every route: tenant B never sees tenant A\'s skill', async () => {
  const a = harness();
  await a.run(SKILLS_PATH, { method: 'POST', body: SKILL });
  assert.equal(a.sent[0].status, 200);

  // Same store (same pool), another tenant's actor.
  const sent = [];
  const runAs = async (actor, path, { method = 'GET', body = undefined } = {}) => {
    const handled = await handleSkillLibraryRoute({
      request: { method },
      response: {},
      requestUrl: new URL(path, 'http://local'),
      activeTenantActor: async () => actor,
      send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
      TenantAuthorizationError,
      readJson: async () => body ?? {},
      store: a.store,
      knownSeats: async () => new Set(KNOWN_SEATS),
    });
    assert.equal(handled, true);
  };

  await runAs(OTHER_ACTOR, SKILLS_PATH);
  assert.deepEqual(sent[0].body.skills, []);
  await runAs(OTHER_ACTOR, `${SKILLS_PATH}/deep-research`);
  assert.equal(sent[1].status, 404);
  await runAs(OTHER_ACTOR, `${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { name: 'Hijacked' } });
  assert.equal(sent[2].status, 404);
  await runAs(OTHER_ACTOR, `${SKILLS_PATH}/deep-research`, { method: 'DELETE' });
  assert.equal(sent[3].status, 404);
  // The same id is tenant B's to author independently…
  await runAs(OTHER_ACTOR, SKILLS_PATH, { method: 'POST', body: { ...SKILL, body: 'Tenant B\'s own body.' } });
  assert.equal(sent[4].status, 200);
  // …and tenant A's record never moved.
  const got = await a.store.getSkill('tenant-a', 'deep-research');
  assert.equal(got.name, 'Deep Research');
  assert.equal(got.body, SKILL.body);
});

// ------------------------------------------------------------------- roles

test('the auditor reads but never authors', async () => {
  const h = harness({ actor: AUDITOR });
  await h.run(SKILLS_PATH, { method: 'POST', body: SKILL });
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.sent[0].body.code, 'SKILL_ROLE_FORBIDDEN');
  await h.run(SKILLS_PATH);
  assert.equal(h.sent[1].status, 200);
  assert.deepEqual(h.sent[1].body.skills, []);

  const owner = harness();
  await owner.run(SKILLS_PATH, { method: 'POST', body: SKILL });
  const auditSent = [];
  const runRead = async (path, { method = 'GET', body = undefined } = {}) => handleSkillLibraryRoute({
    request: { method },
    response: {},
    requestUrl: new URL(path, 'http://local'),
    activeTenantActor: async () => AUDITOR,
    send: (response, status, text) => { auditSent.push({ status, body: JSON.parse(text) }); },
    TenantAuthorizationError,
    readJson: async () => body ?? {},
    store: owner.store,
    knownSeats: async () => new Set(KNOWN_SEATS),
  });
  await runRead(`${SKILLS_PATH}/deep-research`);
  assert.equal(auditSent[0].status, 200);
  assert.equal(auditSent[0].body.skill.body, SKILL.body);
  await runRead(`${SKILLS_PATH}/deep-research`, { method: 'PUT', body: { name: 'Nope' } });
  assert.equal(auditSent[1].status, 403);
  assert.equal(auditSent[1].body.code, 'SKILL_ROLE_FORBIDDEN');
  await runRead(`${SKILLS_PATH}/deep-research`, { method: 'DELETE' });
  assert.equal(auditSent[2].status, 403);
});

// -------------------------------------------------------------- route shape

test('authority selectors are refused, in the query and in the body alike', async () => {
  for (const path of [`${SKILLS_PATH}?tenant_id=tenant-b`, `${SKILLS_PATH}?personId=user:other`, `${SKILLS_PATH}/deep-research?subject=user:other`]) {
    const h = harness();
    await h.run(path);
    assert.equal(h.sent[0].status, 400, path);
    assert.equal(h.sent[0].body.code, 'SKILLS_SELECTOR_INVALID');
  }
  const h = harness();
  await h.run(SKILLS_PATH, { method: 'POST', body: { ...SKILL, tenantId: 'tenant-b' } });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'SKILLS_SELECTOR_INVALID');
  await h.run(SKILLS_PATH);
  assert.deepEqual(h.sent[1].body.skills, []);
});

test('route shape: methods, membership, bad JSON, and foreign paths', async () => {
  const putList = harness();
  await putList.run(SKILLS_PATH, { method: 'PUT', body: {} });
  assert.equal(putList.sent[0].status, 405);
  assert.equal(putList.sent[0].body.code, 'METHOD_NOT_ALLOWED');

  const postItem = harness();
  await postItem.run(`${SKILLS_PATH}/deep-research`, { method: 'POST', body: SKILL });
  assert.equal(postItem.sent[0].status, 405);

  const badJson = harness();
  await badJson.run(SKILLS_PATH, { method: 'POST', badJson: true });
  assert.equal(badJson.sent[0].status, 400);
  assert.equal(badJson.sent[0].body.code, 'SKILL_BODY_INVALID');

  const denied = harness({ actorError: new TenantAuthorizationError('membership required') });
  await denied.run(SKILLS_PATH);
  assert.equal(denied.sent[0].status, 403);
  assert.equal(denied.sent[0].body.code, 'SKILLS_MEMBERSHIP_REQUIRED');

  const foreign = harness();
  const handled = await foreign.run('/api/admin/connector-library');
  assert.equal(handled, false);
  assert.deepEqual(foreign.sent, []);

  const nested = harness();
  const nestedHandled = await nested.run(`${SKILLS_PATH}/a/b`);
  assert.equal(nestedHandled, false);
  assert.deepEqual(nested.sent, []);
});

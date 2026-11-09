// Skill library (sql/075) — slash-skills DESIGN §2 records, bite S1 gate.
//
// The store is exercised against an in-memory fake pool that simulates
// the one table (the repo's established pattern — see
// connector-library.test.mjs). The fake keys every row by the tenant
// the transaction set, so tenant isolation is exercised the way RLS
// enforces it in production.
//
// Deliberate split, stated so it is not mistaken for a gap: seat ids
// are DATA at this layer. Whether a seat id names a seat the tenant
// actually has is the route layer's check (bite S2), where the
// channel config is in hand — the store tests below pin that a
// shape-valid but unknown seat id is accepted here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSkillLibraryStore,
  SKILL_ID_PATTERN,
} from '../src/cloud/skill-library.mjs';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const SUBJECT = 'user:troy';

// ---------------------------------------------------------------- fake pool
function fakePool() {
  const skills = new Map();
  const queries = [];
  let tenant = null;
  const key = (id) => `${tenant}|${id}`;
  const now = () => new Date();

  return {
    queries,
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

          if (text.includes('insert into helmion.skills')) {
            const [id, name, description, body, scope, seatIds, state, createdBy] = vals;
            const row = {
              tenant_id: tenant, id, name, description, body, scope,
              seat_ids: [...seatIds], state, created_by: createdBy,
              created_at: now(), updated_at: now(),
            };
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
            const out = [...skills.values()]
              .filter((r) => r.tenant_id === tenant)
              .sort((a, b) => (a.id < b.id ? -1 : 1));
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

function brokenPool() {
  const error = Object.assign(new Error('relation "helmion.skills" does not exist'), { code: '42P01' });
  return {
    async connect() {
      return {
        async query(text) {
          if (text.includes("set_config('helmion.tenant_id'")) return { rows: [], rowCount: 0 };
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          throw error;
        },
        release() {},
      };
    },
  };
}

const blanket = (over = {}) => ({
  id: 'deep-research',
  name: 'Deep Research',
  description: 'Research a topic thoroughly before answering.',
  body: 'Break the question down, check three sources, then answer.',
  scope: 'blanket',
  ...over,
});

test('CRUD round-trip: create, read, list, edit in place, remove', async () => {
  const store = createSkillLibraryStore(fakePool());
  const created = await store.createSkill(TENANT, SUBJECT, blanket());
  assert.equal(created.id, 'deep-research');
  assert.equal(created.name, 'Deep Research');
  assert.equal(created.scope, 'blanket');
  assert.deepEqual(created.seatIds, [], 'a blanket skill stores no seat list');
  assert.equal(created.state, 'available');
  assert.equal(created.createdBy, SUBJECT);

  assert.deepEqual(await store.getSkill(TENANT, 'deep-research'), created);
  assert.deepEqual((await store.listSkills(TENANT)).map((s) => s.id), ['deep-research']);
  assert.equal(await store.getSkill(TENANT, 'not-there'), null);

  const edited = await store.updateSkill(TENANT, 'deep-research', {
    body: 'Check five sources. Cite them.',
    description: 'Now with citations.',
  });
  assert.equal(edited.body, 'Check five sources. Cite them.');
  assert.equal(edited.description, 'Now with citations.');
  assert.equal(edited.name, 'Deep Research', 'absent fields keep the stored values');
  assert.equal(edited.createdBy, SUBJECT, 'an edit never changes authorship');

  const removed = await store.removeSkill(TENANT, 'deep-research');
  assert.equal(removed.id, 'deep-research');
  assert.equal(await store.getSkill(TENANT, 'deep-research'), null);
  assert.deepEqual(await store.listSkills(TENANT), []);
  assert.equal(await store.removeSkill(TENANT, 'deep-research'), null, 'removing what is not there is a null, not an error');
});

test('scope and seatIds: seats round-trip deduped, blanket clears, merged edits validate as a whole', async () => {
  const store = createSkillLibraryStore(fakePool());
  const seated = await store.createSkill(TENANT, SUBJECT, blanket({
    id: 'wash-check',
    scope: 'seats',
    seatIds: ['claude', 'grok', 'claude'],
  }));
  assert.deepEqual(seated.seatIds, ['claude', 'grok'], 'seat ids dedupe');

  const widened = await store.updateSkill(TENANT, 'wash-check', { scope: 'blanket' });
  assert.deepEqual(widened.seatIds, [], 'a change to blanket clears the seat list');

  // The merged record is validated: narrowing back to seats without
  // naming any is refused, and the stored record is untouched.
  await assert.rejects(store.updateSkill(TENANT, 'wash-check', { scope: 'seats' }), /at least one seat/);
  assert.equal((await store.getSkill(TENANT, 'wash-check')).scope, 'blanket');

  const narrowed = await store.updateSkill(TENANT, 'wash-check', { scope: 'seats', seatIds: ['gemini'] });
  assert.deepEqual(narrowed.seatIds, ['gemini']);

  // Seat ids are data at this layer (see the header): a shape-valid
  // id the tenant may not have is the route layer's refusal, not the
  // store's.
  const unknown = await store.createSkill(TENANT, SUBJECT, blanket({ id: 'future-seat', scope: 'seats', seatIds: ['no-such-seat'] }));
  assert.deepEqual(unknown.seatIds, ['no-such-seat']);
});

test('validation refusals: slug, caps, scope, body, credential-shaped keys', async () => {
  const store = createSkillLibraryStore(fakePool());
  const refuses = (input, pattern) => assert.rejects(store.createSkill(TENANT, SUBJECT, input), pattern);
  await refuses(blanket({ id: 'Deep Research' }), /skill id is invalid/);
  await refuses(blanket({ id: 'plugin:skill' }), /skill id is invalid/, 'a colon would collide with plugin:skill names');
  await refuses(blanket({ id: '' }), /skill id is invalid/);
  await refuses(blanket({ id: 'a'.repeat(65) }), /skill id is invalid/);
  await refuses(blanket({ id: '-leading-dash' }), /skill id is invalid/);
  await refuses(blanket({ name: '   ' }), /name is required/);
  await refuses(blanket({ name: 'n'.repeat(121) }), /name is too long/);
  await refuses(blanket({ description: 'd'.repeat(201) }), /description is too long/);
  await refuses(blanket({ body: '   ' }), /body is required/);
  await refuses(blanket({ body: 'b'.repeat(24_001) }), /body is too long/);
  await refuses(blanket({ scope: 'everywhere' }), /scope must be one of/);
  await refuses(blanket({ scope: 'seats' }), /at least one seat/);
  await refuses(blanket({ scope: 'seats', seatIds: [] }), /at least one seat/);
  await refuses(blanket({ scope: 'seats', seatIds: ['bad seat!'] }), /seatIds entries/);
  await refuses(blanket({ state: 'gone' }), /state must be one of/);
  await refuses(blanket({ accessToken: 'raw-value' }), /credential value/);
  await assert.rejects(store.createSkill(TENANT, null, blanket()), /subject is required/);
  // Boundary values pass.
  const edge = await store.createSkill(TENANT, SUBJECT, blanket({ id: 'a'.repeat(64), body: 'b'.repeat(24_000) }));
  assert.equal(edge.id.length, 64);
  assert.equal(edge.body.length, 24_000);
  assert.ok(SKILL_ID_PATTERN.test(edge.id));
});

test('a duplicate id is a 409, never a silent overwrite', async () => {
  const store = createSkillLibraryStore(fakePool());
  await store.createSkill(TENANT, SUBJECT, blanket());
  await assert.rejects(
    store.createSkill(TENANT, SUBJECT, blanket({ body: 'a different body' })),
    (error) => error.status === 409 && /remove it or rename it/.test(error.message),
  );
  assert.equal((await store.getSkill(TENANT, 'deep-research')).body, blanket().body, 'the original stands');
});

test('editing a skill that does not exist is a 404', async () => {
  const store = createSkillLibraryStore(fakePool());
  await assert.rejects(
    store.updateSkill(TENANT, 'ghost', { body: 'x' }),
    (error) => error.status === 404,
  );
});

test('tenant isolation: one workspace’s skills are invisible to another', async () => {
  const store = createSkillLibraryStore(fakePool());
  await store.createSkill(TENANT, SUBJECT, blanket());
  assert.equal(await store.getSkill(OTHER_TENANT, 'deep-research'), null);
  assert.deepEqual(await store.listSkills(OTHER_TENANT), []);
  // The same id in the other tenant is its own record, not a conflict.
  const theirs = await store.createSkill(OTHER_TENANT, 'user:someone-else', blanket({ body: 'their words, not ours' }));
  assert.equal(theirs.body, 'their words, not ours');
  assert.equal((await store.getSkill(TENANT, 'deep-research')).body, blanket().body);
  // Writes in one tenant never touch the other's record.
  await store.updateSkill(OTHER_TENANT, 'deep-research', { body: 'edited elsewhere' });
  assert.equal((await store.getSkill(TENANT, 'deep-research')).body, blanket().body);
  await store.removeSkill(OTHER_TENANT, 'deep-research');
  assert.ok(await store.getSkill(TENANT, 'deep-research'), 'still here');
});

test('name and description are cleaned to one line; the body is stored verbatim', async () => {
  const store = createSkillLibraryStore(fakePool());
  const created = await store.createSkill(TENANT, SUBJECT, blanket({
    name: '  Deep\n\tResearch  ',
    description: 'line one\nline two',
    body: '  keep my spacing  \n\nand my blank lines  ',
  }));
  assert.equal(created.name, 'Deep Research');
  assert.equal(created.description, 'line one line two');
  assert.equal(created.body, '  keep my spacing  \n\nand my blank lines  ', 'instruction text is saved exactly as written');
});

test('missing table (sql/075 not applied): reads fail soft, writes refuse 503', async () => {
  const store = createSkillLibraryStore(brokenPool());
  assert.equal(await store.getSkill(TENANT, 'deep-research'), null);
  assert.deepEqual(await store.listSkills(TENANT), []);
  await assert.rejects(store.createSkill(TENANT, SUBJECT, blanket()), (error) => error.status === 503);
  await assert.rejects(store.updateSkill(TENANT, 'deep-research', { body: 'x' }), (error) => error.status === 503);
  await assert.rejects(store.removeSkill(TENANT, 'deep-research'), (error) => error.status === 503);
});

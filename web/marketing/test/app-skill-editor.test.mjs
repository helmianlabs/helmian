import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SKILL_BODY_MAX_CHARS, SKILL_NAME_MAX_CHARS, applySkillPaste, cleanSkillLine, deriveSkillId,
  emptySkillDraft, parseSkillFrontmatter, skillDraftFromRecord, skillDraftId, skillPastePrefill,
  skillSavePayload, validateSkillDraft,
} from '../app/skill-editor.mjs';

// The skill editor's pure half (slash-skills DESIGN §2.3/§4.3, bite
// S3): slug derivation, the paste prefill, draft validation against
// the store's mirrored rules, and the S2-route save payloads. The
// editor itself (envoy-workspace.js) is DOM; everything decidable
// lives in skill-editor.mjs and is proven here.

const PASTED_SKILL = '---\nname: deep-research\ndescription: Runs the full research pass\n---\n\nDo the research. Cite everything.\n';
const PASTED_FANCY_NAME = '---\nname: "Deep Research Pass"\ndescription: "Slow, cited research"\n---\nBody after the block.\n';

test('deriveSkillId slugs a typed name the way the store accepts', () => {
  assert.equal(deriveSkillId('Deep Research'), 'deep-research');
  assert.equal(deriveSkillId('  Wash-check, Food Grade! '), 'wash-check-food-grade');
  assert.equal(deriveSkillId('--Leads with junk'), 'leads-with-junk');
  assert.equal(deriveSkillId('Keep_underscores and-dashes'), 'keep_underscores-and-dashes');
  assert.equal(deriveSkillId(''), null);
  assert.equal(deriveSkillId('!!!'), null);
  const long = deriveSkillId('a '.repeat(50));
  assert.ok(long.length <= 64 && !long.endsWith('-'), 'capped at 64 with no trailing dash');
  assert.equal(cleanSkillLine(' a\tb\n c '), 'a b c');
});

test('the frontmatter port reads the prefill fields — and only a closed block counts', () => {
  assert.deepEqual(parseSkillFrontmatter(PASTED_SKILL), { present: true, name: 'deep-research', description: 'Runs the full research pass' });
  assert.deepEqual(parseSkillFrontmatter(PASTED_FANCY_NAME), { present: true, name: 'Deep Research Pass', description: 'Slow, cited research' }, 'quoted values read plainly');
  assert.equal(parseSkillFrontmatter('---\nname: never-closed\nBody without a closing line\n').present, false, 'an unclosed block is no frontmatter — the whole text is body');
  assert.equal(parseSkillFrontmatter('No frontmatter here.\n').present, false);
  const crlf = parseSkillFrontmatter('\ufeff---\r\nname: crlf-skill\r\ndescription: Line endings\r\n---\r\nBody\r\n');
  assert.deepEqual(crlf, { present: true, name: 'crlf-skill', description: 'Line endings' }, 'BOM + CRLF tolerated');
  assert.deepEqual(parseSkillFrontmatter('---\nname: only-name\n---\n'), { present: true, name: 'only-name', description: null });
});

test('skillPastePrefill offers the id only when the frontmatter name is already a slug', () => {
  assert.deepEqual(skillPastePrefill(PASTED_SKILL), { name: 'deep-research', description: 'Runs the full research pass', id: 'deep-research' });
  assert.deepEqual(skillPastePrefill(PASTED_FANCY_NAME), { name: 'Deep Research Pass', description: 'Slow, cited research' }, 'a human name prefills the name field but no id — the id derives from it at save');
  assert.deepEqual(skillPastePrefill('plain body, no frontmatter'), {});
});

test('applySkillPaste keeps the body byte for byte and fills only empty fields', () => {
  const blank = applySkillPaste(emptySkillDraft(), PASTED_SKILL);
  assert.equal(blank.body, PASTED_SKILL, 'the raw paste rides — the route lift strips it server-side; the editor never rewrites it');
  assert.equal(blank.name, 'deep-research');
  assert.equal(blank.id, 'deep-research');
  const typed = applySkillPaste({ ...emptySkillDraft(), name: 'My own name', description: 'Mine' }, PASTED_SKILL);
  assert.equal(typed.name, 'My own name', 'what the person typed wins over what they pasted');
  assert.equal(typed.description, 'Mine');
  assert.equal(typed.id, 'deep-research', 'an unfilled id still takes the paste slug');
  assert.equal(skillDraftFromRecord({ id: 'x', name: 'X', description: null, body: 'B', scope: 'seats', seatIds: ['claude'] }).description, '');
  assert.deepEqual(skillDraftFromRecord({ id: 'x', name: 'X', body: 'B', scope: 'seats', seatIds: ['claude'] }), { id: 'x', name: 'X', description: '', body: 'B', scope: 'seats', seatIds: ['claude'] });
  assert.deepEqual(skillDraftFromRecord(null), emptySkillDraft());
});

test('validateSkillDraft mirrors the store rules, boundaries included', () => {
  const good = { id: 'deep-research', name: 'Deep research', description: '', body: 'Do it.', scope: 'blanket', seatIds: [] };
  assert.deepEqual(validateSkillDraft(good), { ok: true, errors: {} });
  assert.equal(validateSkillDraft({ ...good, name: '' }).errors.name, 'Give the skill a name.');
  assert.equal(validateSkillDraft({ ...good, id: '', name: '' }).ok, false, 'no name means no derivable id either');
  assert.equal(validateSkillDraft({ ...good, body: '   ' }).ok, false, 'a whitespace body is no skill');
  assert.equal(validateSkillDraft({ ...good, body: 'x'.repeat(SKILL_BODY_MAX_CHARS) }).ok, true, 'exactly at the body cap stands');
  assert.equal(validateSkillDraft({ ...good, body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 1) }).ok, false, 'one over the body cap is refused, never truncated');
  assert.equal(validateSkillDraft({ ...good, name: 'n'.repeat(SKILL_NAME_MAX_CHARS) }).ok, true);
  assert.equal(validateSkillDraft({ ...good, name: 'n'.repeat(SKILL_NAME_MAX_CHARS + 1) }).ok, false);
  assert.equal(validateSkillDraft({ ...good, scope: 'seats', seatIds: [] }).errors.seatIds, 'Pick at least one agent, or choose Every agent.');
  assert.equal(validateSkillDraft({ ...good, scope: 'seats', seatIds: ['claude'] }).ok, true);
  assert.equal(validateSkillDraft({ ...good, scope: 'seats', seatIds: ['Not A Seat'] }).ok, false);
  assert.equal(validateSkillDraft({ ...good, scope: 'nobody' }).ok, false);
  assert.equal(skillDraftId({ id: '', name: 'Wash Check' }), 'wash-check');
  assert.equal(skillDraftId({ id: 'kept-id', name: 'Anything' }), 'kept-id');
});

test('skillSavePayload: create carries the id, an edit never does; the body rides verbatim', () => {
  const typed = skillSavePayload({ id: '', name: 'Deep Research', description: '', body: 'Do it.', scope: 'blanket', seatIds: ['claude'] });
  assert.deepEqual(typed, { id: 'deep-research', name: 'Deep Research', body: 'Do it.', scope: 'blanket' }, 'create derives the id, omits an empty description (the lift may fill it) and omits seatIds for a blanket skill');
  const pasted = skillSavePayload(applySkillPaste(emptySkillDraft(), PASTED_SKILL));
  assert.equal(pasted.id, 'deep-research', 'the pasted slug is the create id');
  assert.equal(pasted.body, PASTED_SKILL, 'the frontmatter still rides in the payload — one lift, server-side');
  assert.equal(pasted.description, 'Runs the full research pass');
  const seats = skillSavePayload({ id: 'wash', name: 'Wash', description: 'd', body: 'b', scope: 'seats', seatIds: ['claude', 'grok'] });
  assert.deepEqual(seats.seatIds, ['claude', 'grok']);
  const edit = skillSavePayload({ id: 'wash', name: 'Wash v2', description: '', body: 'new body', scope: 'blanket', seatIds: [] }, { editing: true });
  assert.deepEqual(edit, { name: 'Wash v2', body: 'new body', scope: 'blanket' }, 'an edit payload has no id key — the id travels in the PUT URL');
});

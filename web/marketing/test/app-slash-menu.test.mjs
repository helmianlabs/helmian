import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSlashCommands, filterSlashSkills, moveSlashHighlight, slashInsertValue, slashMenuModel, slashPickList, slashSkillBadge, slashSkillScopeModel, slashTokenOf } from '../app/slash-menu.mjs';

const COMMANDS = [
  { name: 'deploy', description: 'Ship the current branch', origin: 'workspace' },
  { name: 'frontend:component', description: 'Scaffold a component', origin: 'workspace' },
  { name: 'kit:announce', description: 'Announce to the channel', origin: 'plugin' },
  { name: 'standup', description: 'Write my standup note', origin: 'personal' },
];

test('a slash token is a lone unfinished token at the start of the input', () => {
  assert.deepEqual(slashTokenOf('/'), { token: '' });
  assert.deepEqual(slashTokenOf('/dep'), { token: 'dep' });
  assert.deepEqual(slashTokenOf('/frontend:comp'), { token: 'frontend:comp' });
  assert.equal(slashTokenOf(''), null);
  assert.equal(slashTokenOf('deploy'), null);
  assert.equal(slashTokenOf(' /dep'), null);
  // A space ends the token: the menu closes whether the command matched or not.
  assert.equal(slashTokenOf('/deploy '), null);
  assert.equal(slashTokenOf('/nope '), null);
  assert.equal(slashTokenOf('/deploy to prod'), null);
});

test('the menu opens on "/" with the real list and filters as you type', () => {
  const all = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/' });
  assert.deepEqual(all.rows.map((r) => r.name), ['deploy', 'frontend:component', 'kit:announce', 'standup']);
  assert.equal(all.empty, null);

  const dep = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/dep' });
  assert.deepEqual(dep.rows.map((r) => r.name), ['deploy']);

  // A bare base name finds its namespaced command.
  const comp = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/comp' });
  assert.deepEqual(comp.rows.map((r) => r.name), ['frontend:component']);

  // Case does not matter.
  const upper = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/DEP' });
  assert.deepEqual(upper.rows.map((r) => r.name), ['deploy']);
});

test('an unknown command shows the honest no-match state, and an empty workspace says so', () => {
  const none = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/zzz' });
  assert.deepEqual(none.rows, []);
  assert.equal(none.empty, 'no-match');
  const empty = slashMenuModel({ commands: [], loaded: true, value: '/' });
  assert.equal(empty.empty, 'no-commands');
});

test('no menu before the list has loaded, and none once the token is gone', () => {
  assert.equal(slashMenuModel({ commands: COMMANDS, loaded: false, value: '/' }), null);
  assert.equal(slashMenuModel({ commands: COMMANDS, loaded: true, value: 'hello' }), null);
  assert.equal(slashMenuModel({ commands: COMMANDS, loaded: true, value: '/deploy now' }), null);
});

test('filtering caps the rows and ranks full-name prefixes before base-name ones', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${String(i).padStart(2, '0')}`, description: '', origin: 'workspace' }));
  assert.equal(filterSlashCommands(many, 'cmd').length, 12);
  const ranked = filterSlashCommands([
    { name: 'zz:alpha', description: '', origin: 'plugin' },
    { name: 'alpha', description: '', origin: 'workspace' },
  ], 'alp');
  assert.deepEqual(ranked.map((r) => r.name), ['alpha', 'zz:alpha']);
});

test('picking a row inserts "/name " — the whole input, ready for arguments, never a send', () => {
  assert.equal(slashInsertValue('deploy'), '/deploy ');
  assert.equal(slashInsertValue('kit:announce'), '/kit:announce ');
});

test('highlight movement wraps and an empty menu has no highlight', () => {
  assert.equal(moveSlashHighlight(0, 1, 3), 1);
  assert.equal(moveSlashHighlight(2, 1, 3), 0);
  assert.equal(moveSlashHighlight(0, -1, 3), 2);
  assert.equal(moveSlashHighlight(-1, 1, 3), 1);
  assert.equal(moveSlashHighlight(0, 1, 0), -1);
});

// ---- The Helmian skills group (slash-skills DESIGN §4.1, bite S3).
// ---- The store's list rows (no bodies) become a second group in the
// ---- same menu: "/skill" addresses the group, other tokens filter
// ---- it by id prefix, and the pick list walks commands, then
// ---- skills, then the New skill row.

const SKILLS = [
  { id: 'wash-check', name: 'Wash check', description: 'Food-grade wash rules', scope: 'seats', seatIds: ['claude', 'grok'], state: 'available' },
  { id: 'deep-research', name: 'Deep research', description: 'Runs the full pass', scope: 'blanket', seatIds: [], state: 'available' },
  { id: 'old-habit', name: 'Old habit', description: '', scope: 'blanket', seatIds: [], state: 'disabled-by-owner' },
];
const skillLabel = (id) => ({ claude: 'Claude', grok: 'Grok' })[id] ?? id;
const withSkills = (value, extra = {}) => slashMenuModel({ commands: COMMANDS, loaded: true, value, skills: SKILLS, skillsLoaded: true, seatLabel: skillLabel, ...extra });

test('the skills group lists the store rows sorted by id, with scope badges', () => {
  const m = withSkills('/');
  assert.deepEqual(m.skillRows.map((r) => r.id), ['deep-research', 'old-habit', 'wash-check']);
  assert.deepEqual(m.skillRows.map((r) => r.badge), ['all agents', 'Turned off', 'Claude · Grok'], 'blanket, disabled and seats badges read off the record');
  assert.equal(m.skillsEmpty, null);
  assert.equal(m.showNewSkill, true, 'the New skill row stands whenever the group is live');
  assert.equal(slashSkillBadge({ scope: 'blanket', seatIds: [] }, skillLabel), 'all agents');
  assert.equal(slashSkillBadge({ scope: 'seats', seatIds: ['grok'] }, skillLabel), 'Grok');
  assert.equal(slashSkillBadge({ scope: 'seats', seatIds: ['helmian'] }, skillLabel), 'helmian', 'an unknown seat id stands as itself');
  assert.equal(slashSkillBadge({ scope: 'blanket', state: 'disabled-by-owner' }, skillLabel), 'Turned off');
});

test('typing /skill addresses the whole group; other tokens filter it by id prefix', () => {
  for (const value of ['/', '/s', '/sk', '/skill']) {
    assert.deepEqual(withSkills(value).skillRows.map((r) => r.id), ['deep-research', 'old-habit', 'wash-check'], `${value} lists every skill`);
  }
  assert.deepEqual(withSkills('/skill').rows.map((r) => r.name), [], 'no command is named skill — and none is invented for the group');
  assert.deepEqual(withSkills('/deep').skillRows.map((r) => r.id), ['deep-research']);
  assert.deepEqual(withSkills('/wash').skillRows.map((r) => r.id), ['wash-check']);
  const none = withSkills('/zzz');
  assert.deepEqual(none.skillRows, []);
  assert.equal(none.skillsEmpty, 'no-match');
  const emptyStore = withSkills('/', { skills: [] });
  assert.deepEqual(emptyStore.skillRows, []);
  assert.equal(emptyStore.skillsEmpty, 'no-skills');
  assert.equal(emptyStore.showNewSkill, true, 'the New row is how the FIRST skill gets made');
  assert.deepEqual(filterSlashSkills([{ id: 'has spaces', name: 'x' }, { id: 'ok', name: 'y' }], '', skillLabel).map((r) => r.id), ['has spaces', 'ok'], 'rows pass through the store shape untouched — the store owns id validity');
});

test('until the skills list has loaded the model is the commands-only model it always was', () => {
  const m = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/', skills: SKILLS });
  assert.deepEqual(m.skillRows, []);
  assert.equal(m.showNewSkill, false);
  assert.equal(m.skillsEmpty, null);
  assert.deepEqual(slashPickList(m).map((e) => e.type), ['command', 'command', 'command', 'command']);
});

test('the pick list walks commands, then skills, then the New skill row', () => {
  const m = withSkills('/');
  const picks = slashPickList(m);
  assert.deepEqual(picks.map((e) => e.type), ['command', 'command', 'command', 'command', 'skill', 'skill', 'skill', 'new-skill']);
  assert.deepEqual(picks.filter((e) => e.type === 'skill').map((e) => e.id), ['deep-research', 'old-habit', 'wash-check']);
  assert.equal(slashPickList(null).length, 0);
});

test('the skills group is capped on its own, never starved by a long command list', () => {
  const manySkills = Array.from({ length: 15 }, (_, i) => ({ id: `skill-${String(i).padStart(2, '0')}`, name: `Skill ${i}`, scope: 'blanket', seatIds: [] }));
  const m = slashMenuModel({ commands: COMMANDS, loaded: true, value: '/', skills: manySkills, skillsLoaded: true, seatLabel: skillLabel });
  assert.equal(m.rows.length, 4, 'the commands keep their rows');
  assert.equal(m.skillRows.length, 12, 'the skills cap at their own twelve');
});

const CHANNEL_SEATS = [
  { seatId: 'claude', name: 'Claude' },
  { seatId: 'grok', name: 'Grok' },
  { seatId: 'chatgpt', name: 'ChatGPT' },
];

test('the scope step: a blanket skill offers Every agent plus every channel seat', () => {
  const scope = slashSkillScopeModel(SKILLS.find((s) => s.id === 'deep-research'), CHANNEL_SEATS);
  assert.equal(scope.skillId, 'deep-research');
  assert.equal(scope.disabled, false);
  assert.deepEqual(scope.rows.map((r) => r.seatId), ['all', 'claude', 'grok', 'chatgpt']);
  assert.equal(scope.rows[0].name, 'Every agent');
});

test('the scope step: a seats-scoped skill offers only its recorded seats — the record is the ceiling', () => {
  const scope = slashSkillScopeModel(SKILLS.find((s) => s.id === 'wash-check'), CHANNEL_SEATS);
  assert.deepEqual(scope.rows.map((r) => r.seatId), ['claude', 'grok'], 'chatgpt is in the channel but not the record — it is not offered');
  const goneSeat = slashSkillScopeModel({ id: 'x', name: 'X', scope: 'seats', seatIds: ['retired-seat'] }, CHANNEL_SEATS);
  assert.deepEqual(goneSeat.rows, [], 'a recorded seat no longer in the channel offers nothing');
});

test('the scope step: an owner-disabled skill offers no attach rows', () => {
  const scope = slashSkillScopeModel(SKILLS.find((s) => s.id === 'old-habit'), CHANNEL_SEATS);
  assert.equal(scope.disabled, true);
  assert.deepEqual(scope.rows, []);
  assert.equal(slashSkillScopeModel(null, CHANNEL_SEATS), null);
});

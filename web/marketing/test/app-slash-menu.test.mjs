import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSlashCommands, moveSlashHighlight, slashInsertValue, slashMenuModel, slashTokenOf } from '../app/slash-menu.mjs';

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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAWERS,
  THEMES,
  connectionRequirement,
  normalizeDrawer,
  normalizeMobilePane,
  normalizeTheme,
} from '../herald/shell-state.js';

test('the shell exposes every promised workspace destination', () => {
  assert.deepEqual(DRAWERS, [
    'projects', 'browser', 'canvas', 'preview', 'create', 'integrations',
    'guard', 'history', 'help', 'troubleshooting',
  ]);
  assert.equal(normalizeDrawer('guard'), 'guard');
  assert.equal(normalizeDrawer('credentials'), null);
});

test('Herald stores the full presentation theme set including light themes', () => {
  assert.deepEqual(THEMES, [
    'midnight', 'black', 'white', 'paper', 'ocean', 'glass', 'warm', 'forest',
  ]);
  assert.equal(normalizeTheme('black'), 'black');
  assert.equal(normalizeTheme('white'), 'white');
  assert.equal(normalizeTheme('paper'), 'paper');
  assert.equal(normalizeTheme('unknown'), 'midnight');
});

test('mobile pane and connection requirements fail honestly', () => {
  assert.equal(normalizeMobilePane('conversation'), 'conversation');
  assert.equal(normalizeMobilePane('other'), 'team');
  assert.match(connectionRequirement('send'), /Connect Helmian Desktop/);
  assert.match(connectionRequirement('project'), /project endpoint/);
  assert.match(connectionRequirement('provider'), /verified connection/);
  assert.match(connectionRequirement('provider', 'Slack'), /Slack is not connected/);
  assert.match(connectionRequirement('provider', 'Discord'), /Discord is not connected/);
  assert.match(connectionRequirement('provider', 'Discord'), /account and credential setup are not available/);
  assert.doesNotMatch(connectionRequirement('send'), /sent|delivered|connected desktop/i);
});

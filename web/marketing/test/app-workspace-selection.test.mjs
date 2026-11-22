import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');

test('the app stamps the server-selected workspace so admin writes present a selection', () => {
  // The admin deriver for writes such as project create requires a
  // presented selection (signed cookie or header); reads resolve a
  // default without one. The memberships load must therefore stamp the
  // selected row through the existing select route.
  assert.match(appJs, /wsState\.memberships\.find\(\(row\) => row\?\.selected\)/);
  assert.match(appJs, /post\('\/api\/admin\/workspace\/select', \{ tenantId: selectedRow\.tenantId \}\)/);
});

test('the stamp is guarded to once per page load and retries after a failure', () => {
  assert.match(appJs, /selectionStamped: false/);
  assert.match(appJs, /!wsState\.selectionStamped/);
  assert.match(appJs, /catch\(\(\) => \{ wsState\.selectionStamped = false; \}\)/);
});

// Herald bite H1: the Team pane's live Envoy feed fires on SIGN-IN, not on
// desktop enrollment, and it authenticates with the shell's own identity —
// the Clerk session Bearer, as the pc-approvals mount in the same shell
// already does. shell.js runs in a browser, so these are source-level
// assertions in the cloud-admin-shell.test.mjs style; the route half of
// the leg (Bearer acceptance on the two feed reads, refusal without any
// identity) is covered behaviorally in test/envoy-chat-route.test.mjs.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shell = await readFile(new URL('../web/marketing/herald/shell.js', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = shell.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = shell.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return shell.slice(start, end);
}

test('Herald Team feed fires from the signed-in account state, not only after enrollment', () => {
  const apply = section('async function applyAccountState', 'async function refreshDesktopList');
  assert.match(apply, /void loadHeraldEnvoyFeed\(\);/);
  // Sign-out clears the feed, so one account's messages never linger into
  // the next account's session.
  assert.match(apply, /envoyFeedBox\.replaceChildren\(\)/);
  assert.match(apply, /envoyFeedBox\.hidden = true/);
});

test('Herald Team feed refreshes on the approvals 15-second cadence, no new timer', () => {
  const cadence = section('setInterval(() => {', '}, 15000);');
  assert.match(cadence, /pcApprovals\.refresh\(\)/);
  assert.match(cadence, /loadHeraldEnvoyFeed\(\)/);
  // Exactly one interval exists in the shell: the feed rides it.
  assert.equal(shell.split('setInterval(').length - 1, 1);
});

test('Herald Team feed authenticates with the Clerk session Bearer, like pc-approvals', () => {
  const feed = shell.slice(shell.indexOf('async function loadHeraldEnvoyFeed'));
  assert.match(feed, /clerk\.session\?\.getToken/);
  assert.match(feed, /authorization: `Bearer \$\{token\}`/);
  assert.match(feed, /credentials: 'same-origin'/);
  // The old cookie-only leg (which silently 401'd a /herald-only sign-in)
  // is gone.
  assert.doesNotMatch(feed, /credentials: 'include'/);
  // Signed out, the feed does not fire at all.
  assert.match(feed, /if \(!token\) return;/);
});

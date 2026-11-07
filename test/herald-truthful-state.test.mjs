// Herald bite H2: a truthful connected-to-cloud state. The Herald page's
// own connection is the helmian.cloud account session — signed in reads as
// connected in the header chip and the banner, desktop or no desktop. The
// Desktop session's state is stated only in the surfaces that use it (the
// Projects drawer's Desktop list/empty state, the console's session
// label). shell.js runs in a browser, so these are source-level
// assertions in the herald-envoy-feed.test.mjs style; the end-to-end live
// proof is owed after merge, in those words.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shell = await readFile(new URL('../web/marketing/herald/shell.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../web/marketing/herald/index.html', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = shell.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = shell.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return shell.slice(start, end);
}

test('Header chip renders the cloud session state, never the Desktop state', () => {
  const render = section('function renderConnectionState', 'function setRemoteStatus');
  assert.match(render, /cloudSignedIn \? ' Connected to helmian\.cloud' : ' Not signed in'/);
  assert.match(render, /classList\.toggle\('live', cloudSignedIn\)/);
  // setRemoteStatus drives the chip from the cloud state on every call.
  const status = section('function setRemoteStatus', 'function resetRemoteUi');
  assert.match(status, /renderConnectionState\(\);/);
  // The old conflation — chip text derived from the Desktop transport —
  // is gone from the shell entirely.
  assert.doesNotMatch(shell, /Desktop not connected/);
});

test('Signed in with no Desktop session, the banner carries the cloud state', () => {
  // The desktop-absence headline is gone.
  assert.doesNotMatch(shell, /No live Desktop session is connected to this account\./);
  const list = section('async function refreshDesktopList', 'async function selectRemoteSession');
  assert.match(list, /setRemoteStatus\('Connected to helmian\.cloud\.', false\)/);
  // The Desktop list result itself still renders in the Projects drawer,
  // whose empty state keeps the Desktop fact in the Desktop's own area.
  assert.match(list, /\$\('#desktopEmpty'\)\.hidden = list\.childElementCount > 0/);
  assert.match(html, /id="desktopEmpty"/);
  assert.match(html, /No connected Desktop/);
});

test('Cloud sign-in state is tracked separately from the Desktop session', () => {
  const apply = section('async function applyAccountState', 'async function refreshDesktopList');
  assert.match(apply, /cloudSignedIn = false;/);
  assert.match(apply, /cloudSignedIn = true;/);
  const reset = section('function resetRemoteUi', 'function escapeHtml');
  assert.match(reset, /cloudSignedIn = false;/);
});

test('Conversation pane states the cloud fact and the Desktop fact separately', () => {
  const status = section('function setRemoteStatus', 'function resetRemoteUi');
  // The intro card's state label is the Desktop session's, labeled as such.
  assert.match(status, /live \? 'Desktop session live' : 'No desktop session'/);
  // Its copy names the cloud state behind the page.
  assert.match(status, /Signed in to helmian\.cloud — the live cloud conversation is in the Team pane\./);
  assert.match(status, /This console sends through a Desktop session, and none is selected\./);
  // The pane header's session label is labeled, and selection fills it in.
  assert.match(html, /id="desktopSessionStatus">Desktop session: none selected</);
  const select = section('async function selectRemoteSession', 'async function sendRemoteInstruction');
  assert.match(select, /sessionStatus\.textContent = `Desktop session: \$\{desktop\.displayName\}`/);
  assert.doesNotMatch(html, />Desktop offline</);
});

test('Draft notice states the send road, not a connection state', () => {
  assert.match(html, /Drafts stay on this device\. This composer sends through a Desktop session, so a draft sends once one is selected\./);
  assert.doesNotMatch(html, /Drafts stay on this device until a desktop is connected\./);
});

test('Team placeholder hides when the feed loads with content, returns on sign-out', () => {
  assert.match(html, /<section class="empty-hero" id="teamPlaceholder">/);
  const feed = shell.slice(shell.indexOf('async function loadHeraldEnvoyFeed'));
  assert.match(feed, /teamPlaceholder\.hidden = msgs\.length > 0/);
  const apply = section('async function applyAccountState', 'async function refreshDesktopList');
  assert.match(apply, /teamPlaceholder\.hidden = false/);
  // The honestly-labeled future provider stubs stay in the pane footer.
  assert.match(html, /aria-label="Future team provider choices"/);
  assert.match(html, /Connect Slack/);
  assert.match(html, /Connect Discord/);
});

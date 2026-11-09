// The stale-shell lever (2026-11-09). The /app service worker is sound
// (network-first, cache:'no-cache' — see sw-shell-revalidate.test.mjs),
// but it only speaks on the next load: a tab that stays open keeps
// running the app.js it loaded with, and on 2026-11-08 a tab ran a
// pre-fix build all evening that way. The fix is a nudge, not a
// takeover: a small in-app "A new version is ready" notice with one
// Reload button, shown once per update, never reloading on its own and
// never taking focus away from typing. The old deploy watch did the
// opposite — it reloaded silently whenever nothing was being typed.
// These tests pin the new contract in the shell sources, in the same
// source-reading style as the voice lockstep tests (app.js cannot be
// executed whole under a harness).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
const shared = await readFile(new URL('../../shared/voice-dictation.mjs', import.meta.url), 'utf8');

// The shell section: everything from the PWA comment to end of file.
const shellStart = js.indexOf('// Installable PWA');
assert.ok(shellStart > 0, 'the shell section exists in app.js');
const shell = js.slice(shellStart);

test('the notice lives in the shell markup, hidden, with one Reload button', () => {
  assert.match(html, /id="update-nudge"[^>]*hidden/, 'the nudge starts hidden');
  assert.ok(html.includes('A new version is ready'), 'plain words on the notice');
  assert.match(html, /<button id="update-reload"[^>]*>Reload<\/button>/, 'one Reload button');
  assert.match(css, /\.update-nudge \{/, 'the nudge is styled');
  assert.match(css, /\.update-nudge\[hidden\] \{ display:none; \}/, 'hidden really hides it');
});

test('the nudge is shown by the shell code, once per update, and reloads only from its button', () => {
  assert.ok(shell.includes("$('#update-nudge')"), 'the shell finds the notice');
  assert.ok(shell.includes("$('#update-reload')"), 'the shell finds the Reload button');
  assert.ok(shell.includes('if (nudgedFor !== null) return;'), 'one showing per update — later voices for the same update are latched out');
  assert.ok(shell.includes('nudge.hidden = false'), 'showing is unhiding the notice, nothing more');
  const reloads = [...shell.matchAll(/location\.reload\(\)/g)].length;
  assert.equal(reloads, 1, 'exactly one reload call in the whole shell section');
  assert.ok(shell.includes("reloadBtn.addEventListener('click', () => location.reload())"), 'and it hangs off the Reload button click — the code never reloads on its own');
  assert.ok(!shell.includes('.focus('), 'the notice never takes focus, so typing is never interrupted');
});

test('the old silent takeover is gone', () => {
  assert.ok(!js.includes('loads itself when you are done typing'), 'no more "loads itself" toast');
  assert.ok(!js.includes('Reload silently'), 'no more silent-reload comment standing as the design');
});

test('the service worker registration is kept, and its update events feed the same nudge', () => {
  assert.ok(shell.includes("navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' })"), 'same worker, same scope as before');
  assert.ok(shell.includes("addEventListener('controllerchange'"), 'a new worker taking over shows the notice');
  assert.ok(shell.includes("addEventListener('updatefound'"), 'an update found while the app is open shows the notice');
  assert.ok(shell.includes("worker.state === 'installed'"), 'the updatefound path waits for the installed state');
  assert.ok(shell.includes('const hadController = !!navigator.serviceWorker.controller'), 'the first install is told apart from a takeover');
  assert.ok(shell.includes('if (!hadController) return;'), 'a first visit gets no update notice');
  assert.ok(shell.includes("showUpdateNudge('sw-takeover')"), 'takeover feeds the shared nudge');
  assert.ok(shell.includes("showUpdateNudge('sw-update')"), 'updatefound feeds the shared nudge');
});

test('the deploy watch still feeds the nudge (ETag changes are the other voice)', () => {
  assert.ok(shell.includes('const DEPLOY_WATCH'), 'the watch set stands');
  assert.ok(shell.includes('showUpdateNudge(now)'), 'a changed ETag set shows the notice under its own key');
  assert.ok(shell.includes('setInterval(check, 5 * 60 * 1000)'), 'the watch keeps its rhythm');
});

test('the Kokoro import carries the graph version in both controller copies', () => {
  for (const [name, src] of [['app.js', js], ['shared module', shared]]) {
    assert.ok(src.includes("const KOKORO_GRAPH_VERSION = '2026-11-09.1'"), `${name}: the graph version constant stands beside the import`);
    assert.ok(src.includes('const KOKORO_LOCAL_URL = `/kokoro-js/kokoro-js@1.2.1.mjs?v=${KOKORO_GRAPH_VERSION}`'), `${name}: the version rides the import as a query, so a cached 404 for the bare path is never reused`);
    assert.ok(!src.includes("const KOKORO_LOCAL_URL = '/kokoro-js/kokoro-js@1.2.1.mjs'"), `${name}: the bare, cacheable path is gone`);
  }
});

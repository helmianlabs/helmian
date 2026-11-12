import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Optimization bite 6 (2026-11-12): a loading state for the
// app-shell stage — the closing fix of the programme. Bite 4's
// desk proof showed its blank room gone, but both loads still
// began with an earlier blank stage the workspace cannot cover:
// the shell paints (left nav, the "Console" title) while app.js,
// the session read and the workspace module are still in flight,
// and the workspace section then unhid over empty areas until
// mountWorkspace painted bite 4's card. STRUCTURAL guard in this
// suite's source-assertion idiom: it pins the shell stage's new
// shape — a static boot loader shipped in the markup, the
// workspace's own loading look shipped inside its two areas, and
// a guarded hand-off on every path that paints content first.
// The behavioral claim (no blank interval, no stacked loading
// states, both themes) rests on the Playwright harness recorded
// in the bite report — the full shell boot is not driven here.
const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
const envoyJs = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const gateJs = await readFile(new URL('../app/maestro-activation.mjs', import.meta.url), 'utf8');

test('shell boot: the markup ships a visible boot loader in the main area', () => {
  const main = html.indexOf('<main id="main"');
  const boot = html.indexOf('<section id="boot-loading" class="boot-loading" role="status"><p>Loading…</p></section>');
  const signedOut = html.indexOf('<section id="signed-out"');
  assert.ok(main !== -1 && boot > main, 'the boot loader lives in the main area');
  assert.ok(signedOut !== -1 && boot < signedOut, 'the boot loader precedes the view sections — it is what the first paint shows');
  assert.ok(!/<section id="boot-loading"[^>]*\bhidden\b/.test(html),
    'the boot loader ships visible: hiding it is the hand-off, not the start');
});

test('shell boot: the workspace areas ship the same loading look mountWorkspace paints', () => {
  assert.ok(html.includes('<div id="ew-messages" class="ew-messages" role="log" aria-live="polite"><div class="ew-empty">Loading…</div></div>'),
    'the message list ships bite 4\'s Loading… card, so the unhidden section is never blank while the module loads');
  assert.ok(html.includes('<div class="ew-crew-list" id="ew-crew-list"><p class="ew-note">Loading…</p></div>'),
    'the crew rail ships its Loading… note');
  // The shipped shapes are the painted shapes, not lookalikes:
  // paintBootLoading builds exactly these two nodes, skips areas
  // that already hold them, and the first real renders evict them.
  assert.ok(envoyJs.includes("h('div', { class: 'ew-empty' }, 'Loading…')"), 'the painted card matches the shipped card');
  assert.ok(envoyJs.includes("h('p', { class: 'ew-note' }, 'Loading…')"), 'the painted crew note matches the shipped note');
});

test('shell boot: the loader is styled by the head stylesheet, in the theme, and hides cleanly', () => {
  assert.match(css, /\.boot-loading \{[^}]*display:flex[^}]*color:var\(--muted\)/,
    'centered muted words in the saved theme — theme-init has run, the vars resolve');
  assert.match(css, /\.boot-loading\[hidden\] \{ display:none; \}/,
    'the explicit hidden rule stands: the flex display would otherwise beat the UA\'s [hidden]');
});

test('shell boot: app.js hands off through one guarded hide, on the view and signed-out paths', () => {
  assert.ok(appJs.includes("function hideBootLoading() { const b = $('#boot-loading'); if (b) b.hidden = true; }"),
    'the hide is the guarded lookup — a markup change can never break the boot');
  const showAt = appJs.indexOf('function show(view)');
  const showFn = appJs.slice(showAt, appJs.indexOf('// ---- workbench panel tabs', showAt));
  assert.ok(showFn.includes('hideBootLoading();'), 'the first view paint hides the loader in the same task as the unhide');
  const bootAt = appJs.indexOf('async function boot()');
  const memberAt = appJs.indexOf('state.actor = model.actor;', bootAt);
  const bootHead = appJs.slice(bootAt, memberAt);
  assert.ok(bootHead.includes("$('#signed-out').hidden = false; hideBootLoading();"),
    'the signed-out path hands off too — it returns before any show()');
  assert.ok(!appJs.includes("$('#boot-loading').hidden = false") && !appJs.includes('boot-loading\'); if (b) b.hidden = false'),
    'nothing ever unhides the loader: later view switches keep their own loading states');
});

test('shell boot: the Maestro gate hands off when it shows the ceremony', () => {
  const showAt = gateJs.indexOf('section.hidden = false;');
  const hideAt = gateJs.indexOf("getElementById('boot-loading')");
  assert.ok(showAt !== -1 && hideAt > showAt, 'the ceremony showing hides the boot loader — the two never stack');
  assert.ok(gateJs.includes('if (bootLoading) bootLoading.hidden = true;'), 'the gate\'s hide is null-guarded like its other lookups');
});

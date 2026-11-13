// Checks the things that decide whether Chrome will load this at all.
//
// A manifest pointing at a file that is not there, or a syntax error in a file
// Chrome parses before it runs anything, fails at load time with a message in a
// corner of chrome://extensions and nothing on the page. That is the exact
// silent-failure shape this extension exists to avoid, so it is checked here
// instead of being discovered in front of somebody.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...await listJsFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

const manifest = JSON.parse(await readFile(path.join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));

test('every JavaScript file in the extension parses', async () => {
  const files = await listJsFiles(EXTENSION_ROOT);
  assert.ok(files.length >= 8, `only found ${files.length} files to check`);
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
});

test('the manifest is Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('every file the manifest names actually exists', async () => {
  const referenced = [manifest.background.service_worker];
  for (const entry of manifest.content_scripts) {
    referenced.push(...(entry.js || []), ...(entry.css || []));
  }

  for (const relative of referenced) {
    const full = path.join(EXTENSION_ROOT, relative);
    await readFile(full); // throws if missing
  }
});

test('the service worker is a module, because it imports the copied kernel', () => {
  // Without type:module the import in worker.js is a syntax error at load and
  // the extension checks nothing at all.
  assert.equal(manifest.background.type, 'module');
});

test('the content scripts load in the order guard.js depends on', () => {
  // guard.js calls HelmionSanitize, HelmionExtract, HelmionStreamWatch and
  // HelmionUI at startup, and wires the Flags surface. If it loads first,
  // those are undefined and nothing runs. This list is the manifest's own
  // declared order, which is the order Chrome loads them in; 0.7.0 added
  // sanitize.js, flags.js and nudge.js to it.
  assert.deepEqual(manifest.content_scripts[0].js, [
    'content/prompt-risk.js',
    'content/sanitize.js',
    'content/flags.js',
    'content/extract.js',
    'content/stream-watch.js',
    'content/ui.js',
    'content/nudge.js',
    'content/guard.js',
  ]);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
});

test('it never asks for every site', () => {
  assert.ok(
    !JSON.stringify(manifest).includes('<all_urls>'),
    'the manifest asks for every site; it must not',
  );
});

test('it asks for exactly the permissions 0.7.0 declares, and the list cannot quietly grow', () => {
  // This check used to assert zero permissions, and it was right to. Phase 1
  // only read the page and ran a regular expression.
  //
  // It changed on 2026-07-30 by Troy's decision, and the decision was the one
  // background/scan.js had been waiting on in writing: "A QUEUE IS NOT A DURABLE
  // LOG… Closing that gap needs a decision from Troy — grant one permission, or
  // add a UI that drains this queue." He chose the permission, because a flag
  // that vanishes when Chrome evicts the service worker is not evidence.
  //
  // It changed again in 0.7.0, deliberately, because the product grew the
  // features Troy runs: alarms drives the approvals and Scribe polling,
  // idle drives the auto-nudge's idle detection. The one-permission property
  // itself is retired — that widening is real, and it is named here rather
  // than edited away quietly. What this test still guarantees is the part
  // that matters: the four lists below are pinned EXACTLY as the shipped
  // manifest declares them, so any future addition fails this test and has
  // to be argued for on purpose. Every extra permission asked for is trust
  // spent, and this test is what stops the list quietly growing.
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'idle']);
  // Optional permissions are not granted at install; the extension must ask
  // for them at the moment the feature is used (notifications for fresh-mail
  // alerts, identity for the Scribe sign-in).
  assert.deepEqual(manifest.optional_permissions, ['notifications', 'identity']);
  // Host permissions: the findings upload's helmian.cloud, plus
  // connect.helmian.cloud, the door the Executive Guard approvals and
  // Scribe clients talk to. Pinned to exactly these two hosts.
  assert.deepEqual(manifest.host_permissions, [
    'https://helmian.cloud/*',
    'https://connect.helmian.cloud/*',
  ]);
  // Optional host permissions, requested only when a feature needs them:
  // https for user-approved local policy endpoints, http for localhost
  // development endpoints. Pinned exactly as declared.
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://*/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ]);
});

test('the only thing that uses the storage permission is the ledger', async () => {
  // A permission is a promise about scope. If chrome.storage started appearing
  // in the content scripts or the scanners, that promise would be broader than
  // the test above implies.
  const files = (await listJsFiles(EXTENSION_ROOT)).filter(isShippedFile);
  const users = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/chrome\s*\.\s*storage/.test(source)) {
      users.push(path.relative(EXTENSION_ROOT, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(users, ['background/ledger.js'],
    `chrome.storage is used in ${users.join(', ')} — it belongs in the ledger and nowhere else`);
});

test('the popup the manifest points at exists, with its script and styles', async () => {
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  const html = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');
  await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.js'));
  await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.css'));

  // No inline script and no inline handlers: MV3's content security policy
  // refuses them, and the popup would silently do nothing.
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
    'the popup carries an inline <script>, which MV3 will refuse to run');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'the popup uses an inline event handler, which MV3 refuses');
});

test('page health UI is bounded and internal diagnostics are not user-facing', async () => {
  const ui = await readFile(path.join(EXTENSION_ROOT, 'content', 'ui.js'), 'utf8');
  const css = await readFile(path.join(EXTENSION_ROOT, 'content', 'guard.css'), 'utf8');
  const popup = await readFile(path.join(EXTENSION_ROOT, 'popup', 'popup.html'), 'utf8');

  assert.doesNotMatch(ui, /HELMION GUARD IS NOT (?:WATCHING|READING)/);
  assert.doesNotMatch(css, /\.helmion-guard-(?:advisory-)?banner\s*\{/);
  assert.match(css, /\.helmion-guard-health-alert\s*\{[\s\S]*?width:\s*min\(300px,/);
  assert.match(css, /\.helmion-guard-health-alert\s*\{[\s\S]*?max-height:/);
  assert.match(css, /\.helmion-guard-prompt-alert\s*\{[\s\S]*?width:\s*min\(320px,/);
  assert.match(css, /\.helmion-guard-prompt-alert\s*\{[\s\S]*?max-height:/);
  assert.match(popup, /id="guardStatus"/);
});

test('it runs on the four sites, still not on every site', () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://claude.ai/*',
    'https://chatgpt.com/*',
    'https://gemini.google.com/*',
    'https://grok.com/*',
  ]);
});

// Every way a page can reach off this machine, plus the two dynamic-code paths
// that could fetch something without naming it here.
//
// This list used to be four patterns and it let EventSource, a WebSocket built
// without `new`, dynamic import(), an Image beacon and native messaging through.
// Nothing in the extension used any of them, so the guard looked green while
// being much weaker than it read.
const NETWORK_PATTERNS = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bWebSocket\s*\(/,
  /\bEventSource\s*\(/,
  /navigator\s*\.\s*sendBeacon/,
  /\bimport\s*\(/,
  /\bnew\s+Image\s*\(/,
  /connectNative/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];

// A source file, i.e. one that ships. Everything under test/ and test-support/
// is fixtures. `includes(sep + 'test')` was used for this and it also swallowed
// test-support — same prefix — so a fixture could have carried a network call
// unnoticed. Match whole path segments instead.
function isShippedFile(file) {
  const segments = path.relative(EXTENSION_ROOT, file).split(/[\\/]/);
  return !segments.includes('test') && !segments.includes('test-support');
}

// The deliberate exceptions to the no-network rule. In 0.2.4 there was ONE:
// background/upload.js, the opt-in cloud upload for Guard findings (disabled
// by default, only runs when the user enables it in the popup settings AND
// provides a device token). 0.7.0 retired the no-network property itself:
// Scribe, Flags and the Executive Guard approvals loop are network features
// by design, and their clients live in the background worker. The property
// that replaces it, and the one this list enforces exactly: network calls
// happen ONLY in these seven background modules, never in a content script,
// never in the popup, and any eighth file reaching for the network fails
// the test below. This allowlist must never grow without the same level of
// deliberate review the first entry got.
//
// The seventh entry was added on purpose in the same change as the client
// itself (the Guard approvals pop-up build, 2026-11-12):
// background/pc-approvals-client.js is the Helmian proxy client for PC
// approvals. It holds no credential (the browser's own Helmian session
// rides along on its calls, or the call comes back 401), it talks only to
// helmian.cloud, whose host permission the manifest already grants, and it
// lives in the background worker like the other six. That is the review
// this list exists to force, recorded where the next addition will look.
const NETWORK_ALLOWLIST = [
  'background/approvals-client.js',
  'background/executive.js',
  'background/flags-client.js',
  'background/pc-approvals-client.js',
  'background/scribe-auth.js',
  'background/scribe-client.js',
  'background/upload.js',
];

function isAllowlisted(file) {
  const relative = path.relative(EXTENSION_ROOT, file).replace(/\\/g, '/');
  return NETWORK_ALLOWLIST.includes(relative);
}

test('nothing outside the seven background client modules calls out to the network', async () => {
  // 0.2.4 reached the network nowhere outside the opt-in upload. 0.7.0 talks
  // to Scribe, Flags and the Executive Guard from the background worker on
  // purpose. What must never happen quietly is a content script, the popup,
  // or an eighth background file starting to make requests — that is a
  // decision somebody should have to make on purpose, in this allowlist.
  const files = await listJsFiles(EXTENSION_ROOT);
  const shipped = files.filter(isShippedFile);
  assert.ok(shipped.length > 0, 'the file walk found nothing to check, so this test proves nothing');

  for (const file of shipped) {
    if (isAllowlisted(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const pattern of NETWORK_PATTERNS) {
      assert.ok(
        !pattern.test(source),
        `${path.relative(EXTENSION_ROOT, file)} matches ${pattern} — network calls belong only in the allowlisted background client modules`,
      );
    }
  }
});

test('the network allowlist holds exactly the seven background client modules', async () => {
  assert.deepEqual(NETWORK_ALLOWLIST, [
    'background/approvals-client.js',
    'background/executive.js',
    'background/flags-client.js',
    'background/pc-approvals-client.js',
    'background/scribe-auth.js',
    'background/scribe-client.js',
    'background/upload.js',
  ]);
  const files = await listJsFiles(EXTENSION_ROOT);
  const shipped = files.filter(isShippedFile).map((file) => path.relative(EXTENSION_ROOT, file).replace(/\\/g, '/'));
  for (const allowed of NETWORK_ALLOWLIST) {
    assert.ok(shipped.includes(allowed), `${allowed} is allowlisted but not a shipped file`);
  }
});

test('POSITIVE CONTROL: the network guard catches each way out', () => {
  // A guard nobody has watched reject anything is a guard nobody can trust.
  const samples = [
    'fetch("https://example.com")',
    'const x = new XMLHttpRequest();',
    'const s = new WebSocket("wss://example.com");',
    'const e = new EventSource("/stream");',
    'navigator.sendBeacon("/collect", data);',
    'const mod = await import("https://example.com/x.js");',
    'new Image().src = "https://example.com/pixel.gif";',
    'chrome.runtime.connectNative("com.example.host");',
    'eval(payload);',
    'const f = new Function("return 1");',
  ];
  for (const sample of samples) {
    assert.ok(
      NETWORK_PATTERNS.some((pattern) => pattern.test(sample)),
      `the network guard would not have caught: ${sample}`,
    );
  }
});

test('the shipped file list really includes the files that do the work', async () => {
  // isShippedFile decides what the guard above looks at. If it ever excluded
  // too much, that test would pass by checking nothing.
  const shipped = (await listJsFiles(EXTENSION_ROOT))
    .filter(isShippedFile)
    .map((file) => path.relative(EXTENSION_ROOT, file).replace(/\\/g, '/'));

  for (const required of ['content/guard.js', 'content/extract.js', 'background/scan.js', 'background/worker.js']) {
    assert.ok(shipped.includes(required), `${required} is not being checked for network calls`);
  }
  assert.ok(
    !shipped.some((file) => file.startsWith('test/') || file.startsWith('test-support/')),
    'test fixtures are being treated as shipped files',
  );
});

test('there is a README telling Troy how to load it', async () => {
  const readme = await readFile(path.join(EXTENSION_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /chrome:\/\/extensions/);
  assert.match(readme, /Load unpacked/i);
});

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
  // guard.js calls HelmionExtract, HelmionStreamWatch and HelmionUI at startup.
  // If it loads first, those are undefined and nothing runs.
  assert.deepEqual(manifest.content_scripts[0].js, [
    'content/extract.js',
    'content/stream-watch.js',
    'content/ui.js',
    'content/guard.js',
  ]);
});

test('it runs on exactly the three sites and nothing else', () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://claude.ai/*',
    'https://chatgpt.com/*',
    'https://gemini.google.com/*',
  ]);
  assert.ok(
    !JSON.stringify(manifest).includes('<all_urls>'),
    'the manifest asks for every site; it must not',
  );
});

test('it asks for no permissions at all', () => {
  // Phase 1 reads the page it is already on and runs a regular expression. It
  // needs no permission for that, and asking for one it does not use is how a
  // safety tool loses trust.
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
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

test('nothing in the extension calls out to the network', async () => {
  // Phase 1 is a local regular expression. If any of this ever starts making
  // requests, that is a decision somebody should have to make on purpose.
  const files = await listJsFiles(EXTENSION_ROOT);
  const shipped = files.filter(isShippedFile);
  assert.ok(shipped.length > 0, 'the file walk found nothing to check, so this test proves nothing');

  for (const file of shipped) {
    const source = await readFile(file, 'utf8');
    for (const pattern of NETWORK_PATTERNS) {
      assert.ok(
        !pattern.test(source),
        `${path.relative(EXTENSION_ROOT, file)} matches ${pattern} — phase 1 reaches the network nowhere`,
      );
    }
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

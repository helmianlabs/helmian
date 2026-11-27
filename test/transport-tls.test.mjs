// MITM check: every hard-coded service URL in runtime code is TLS
// (https:// or wss://). Plain http:// or ws:// is allowed only for
// loopback, a local bind address the process prints about itself
// (`http://${host}:${port}`), and documentation placeholders. A new
// plain-text URL to a real host fails here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'bin', 'web/marketing/app', 'web/marketing/api', 'web/cloud-admin', 'hands-mcp/src', 'executive-guard/src', 'executive-guard/bin', 'door/src', 'discord-bridge', 'slack-bridge', 'extension', 'pc-spoke'];
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'vendor', 'dist', 'build', '.git']);
const EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.json', '.html']);
const LOCAL = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|local|[\w-]+\.localhost|host\.docker\.internal)$/i;
const PLACEHOLDER = /^(?:\$\{|<|…)|(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/i;
const NAMESPACE = /^(?:www\.w3\.org|ns\.adobe\.com|schemas\.|purl\.org|json-schema\.org|xmlns\.com)/i;

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* files(full);
    else if (EXTS.has(extname(name)) && st.size < 2_000_000) yield full;
  }
}

test('runtime code calls remote services over TLS only', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of files(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) return;
        for (const m of line.matchAll(/\b(?:http|ws):\/\/([^\s'"`/:?#)]+)/g)) {
          const host = m[1];
          if (LOCAL.test(host) || PLACEHOLDER.test(host) || NAMESPACE.test(host)) continue;
          offenders.push(`${file}:${i + 1} ${m[0]}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `plain-text service URLs:\n${offenders.join('\n')}`);
});

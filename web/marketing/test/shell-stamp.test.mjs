// The shell stamp, pinned (2026-11-09, the speed fix). Three things
// must hold or the immutable shell becomes the next stale shell:
//  1. Every /app asset reference in the tree carries the stamp the
//     tree's own contents compute — a push that edits a shell file
//     without re-running scripts/shell-stamp.mjs fails here, in the
//     suite, instead of shipping an address whose bytes no longer
//     match its name.
//  2. The header rules are mutually exclusive: a /app URL carrying
//     ?v= serves immutable; one without serves revalidate. No third
//     /app rule may carry a Cache-Control that could blur the two.
//  3. The deploy watch watches the document, never a stamped file —
//     a stamped watch target's ETag can never move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShellStamp, stampReferences, staleReferences } from '../scripts/shell-stamp.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every shell reference in the tree carries the content-derived stamp', async () => {
  const { stamp, stale } = await checkShellStamp(siteDir);
  assert.match(stamp, /^[0-9a-f]{16}$/, 'the stamp is a content hash');
  assert.deepEqual(stale, [], `references not carrying stamp ${stamp}:\n${stale.join('\n')}\nrun: node scripts/shell-stamp.mjs`);
});

test('stamping rewrites import and absolute references — and nothing else', () => {
  const targets = new Set(['app.js', 'app-model.mjs', 'vendor/qrcode.mjs']);
  const src = [
    `import { x } from './app-model.mjs';`,
    `const m = await import('./vendor/qrcode.mjs');`,
    `const worker = '/app/sw.js';`,
    `const doc = '/app/';`,
    `const watch = ['/app'];`,
  ].join('\n');
  const out = stampReferences(src, '0123456789abcdef', targets);
  assert.ok(out.includes(`from './app-model.mjs?v=0123456789abcdef'`), 'a static import is stamped');
  assert.ok(out.includes(`import('./vendor/qrcode.mjs?v=0123456789abcdef')`), 'a dynamic import is stamped');
  assert.ok(out.includes(`'/app/sw.js'`), "the worker's own URL is never stamped (its target is excluded)");
  assert.ok(!out.includes('/app/?v='), 'the document is never stamped');
  assert.deepEqual(staleReferences(out, '0123456789abcdef', targets), [], 'a stamped tree reads clean');
  assert.equal(staleReferences(src, '0123456789abcdef', targets).length, 2, 'an unstamped tree reads stale');
});

test('the /app header rules split on the v query — immutable with it, revalidate without', async () => {
  const config = JSON.parse(await readFile(join(siteDir, 'vercel.json'), 'utf8'));
  const appRules = (config.headers ?? []).filter((r) => r.source === '/app/(.*)');
  const cacheValue = (r) => (r.headers ?? []).find((h) => h.key === 'Cache-Control')?.value;
  const stamped = appRules.filter((r) => (r.has ?? []).some((c) => c.type === 'query' && c.key === 'v'));
  const unstamped = appRules.filter((r) => (r.missing ?? []).some((c) => c.type === 'query' && c.key === 'v'));
  assert.equal(stamped.length, 1, 'exactly one stamped-assets rule');
  assert.equal(cacheValue(stamped[0]), 'public, max-age=31536000, immutable', 'stamped assets serve immutable');
  assert.equal(unstamped.length, 1, 'exactly one unstamped rule');
  assert.equal(cacheValue(unstamped[0]), 'public, max-age=0, must-revalidate', 'the document and unstamped paths still revalidate');
  assert.equal(appRules.filter((r) => cacheValue(r)).length, 2, 'no third /app Cache-Control rule can blur the split');
});

test('the deploy watch never names a stamped file', async () => {
  const appJs = await readFile(join(siteDir, 'app', 'app.js'), 'utf8');
  const watch = appJs.match(/const DEPLOY_WATCH = \[([^\]]*)\]/);
  assert.ok(watch, 'the deploy watch stands');
  assert.ok(!watch[1].includes('?v='), 'watch targets are unstamped — a stamped ETag can never move');
  assert.ok(watch[1].includes("'/app'"), 'the document is watched: it names the stamps, so its ETag moves on every shell deploy');
});

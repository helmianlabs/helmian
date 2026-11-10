// The /app shell stamp: one content-derived version for the whole app
// shell (speed fix, 2026-11-09 — the speed-pass report's closing build
// #3). Every /app code asset (js/mjs/css under app/) is referenced with
// `?v=<stamp>` — from index.html, from every module import inside the
// graph, and from the service worker's precache list — and vercel.json
// serves any /app URL carrying a `v` query with a long immutable
// Cache-Control. The document itself is never stamped: it stays
// revalidating and deploy-watched, and it is what names the current
// stamp, so a deploy changes the document, the document names new
// stamps, and new stamps fetch fresh. A returning visit whose document
// is unchanged opens every asset from cache at disk speed.
//
// The stamp is a hash of the shell files' own contents (with existing
// stamp values normalised out before hashing, so the value is stable
// across re-runs). It is NEVER hand-bumped: run this script after any
// change under app/ —
//
//   node scripts/shell-stamp.mjs           rewrite every reference
//   node scripts/shell-stamp.mjs --check   verify only (exit 1 on drift)
//
// — and web/marketing/test/shell-stamp.test.mjs recomputes the stamp
// from the tree and fails on any reference that does not carry it, so
// a push that changes a shell file without re-stamping fails the suite
// instead of shipping a stale immutable shell (the 2026-10-25 failure
// shape, inverted: there a stale copy outlived the fix; here a stale
// stamp would BE the copy).
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STAMP_RE = /\?v=[0-9a-f]{16}/g;
const STAMPED_ONCE_RE = /\?v=[0-9a-f]{16}/;

// The worker's own script is never a stamp target: its update road is
// the browser's byte-for-byte check of /app/sw.js itself, and a stamped
// registration URL would mint a new worker identity per deploy.
const NEVER_STAMPED = new Set(['sw.js']);

async function walk(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (/\.(?:js|mjs|css)$/.test(entry.name)) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

// Every code asset of the shell, as paths relative to app/, sorted.
export async function shellAssets(siteDir) {
  const appDir = join(siteDir, 'app');
  return (await walk(appDir, appDir, [])).sort();
}

function normalise(text) {
  return text.replace(STAMP_RE, '?v=');
}

// The stamp: first 16 hex of sha256 over the sorted asset set's
// (path, normalised content) pairs. Content-derived, deploy-stable,
// and identical for identical trees.
export async function computeShellStamp(siteDir) {
  const appDir = join(siteDir, 'app');
  const hash = createHash('sha256');
  for (const rel of await shellAssets(siteDir)) {
    hash.update(rel);
    hash.update('\n');
    hash.update(normalise(await readFile(join(appDir, rel), 'utf8')));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

// The reference shapes that carry the stamp. Each returns the target's
// path relative to app/ so the caller can check it against the set.
//  - absolute:  '/app/app.js'  /app/app.css  (index.html, sw.js SHELL)
//  - relative:  './app-model.mjs'  './vendor/qrcode.mjs'  (imports)
const ABS_REF_RE = /(['"])(\/app\/[^'"]+?\.(?:js|mjs|css))(\?v=[0-9a-f]{16})?\1/g;
const REL_REF_RE = /((?:from\s+|import\s*\(\s*|import\s+)['"])(\.\/[^'"]+?\.(?:js|mjs|css))(\?v=[0-9a-f]{16})?(['"])/g;

function relOf(absPath) {
  return absPath.slice('/app/'.length);
}

// Files whose references get stamped: the document, the worker, and
// every script asset (the import graph lives in those).
async function referenceFiles(siteDir) {
  const assets = await shellAssets(siteDir);
  const files = ['index.html', ...assets.filter((rel) => /\.(?:js|mjs)$/.test(rel))];
  return { assets, files };
}

function stampTargets(assets) {
  return new Set(assets.filter((rel) => !NEVER_STAMPED.has(rel)));
}

// Rewrite one file's references to the given stamp. Returns the new
// text (unchanged text when nothing needed doing).
export function stampReferences(text, stamp, targets) {
  const abs = text.replace(ABS_REF_RE, (m, q, path) =>
    targets.has(relOf(path)) ? `${q}${path}?v=${stamp}${q}` : m);
  return abs.replace(REL_REF_RE, (m, pre, path, _old, q) =>
    targets.has(path.slice('./'.length)) ? `${pre}${path}?v=${stamp}${q}` : m);
}

// Find every reference whose stamp is missing or wrong.
export function staleReferences(text, stamp, targets) {
  const stale = [];
  for (const m of text.matchAll(ABS_REF_RE)) {
    if (targets.has(relOf(m[2])) && m[3] !== `?v=${stamp}`) stale.push(m[2]);
  }
  for (const m of text.matchAll(REL_REF_RE)) {
    if (targets.has(m[2].slice('./'.length)) && m[3] !== `?v=${stamp}`) stale.push(m[2]);
  }
  return stale;
}

export async function applyShellStamp(siteDir) {
  const stamp = await computeShellStamp(siteDir);
  const { assets, files } = await referenceFiles(siteDir);
  const targets = stampTargets(assets);
  const changed = [];
  for (const rel of files) {
    const full = join(siteDir, 'app', rel);
    const before = await readFile(full, 'utf8');
    const after = stampReferences(before, stamp, targets);
    if (after !== before) {
      await writeFile(full, after);
      changed.push(rel);
    }
  }
  return { stamp, changed };
}

export async function checkShellStamp(siteDir) {
  const stamp = await computeShellStamp(siteDir);
  const { assets, files } = await referenceFiles(siteDir);
  const targets = stampTargets(assets);
  const stale = [];
  for (const rel of files) {
    const text = await readFile(join(siteDir, 'app', rel), 'utf8');
    for (const ref of staleReferences(text, stamp, targets)) stale.push(`${rel} -> ${ref}`);
  }
  return { stamp, stale };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const { stamp, stale } = await checkShellStamp(siteDir);
    if (stale.length) {
      console.error(`shell stamp ${stamp} is NOT what the tree carries:`);
      for (const s of stale) console.error(`  stale: ${s}`);
      console.error('run: node scripts/shell-stamp.mjs');
      process.exit(1);
    }
    console.log(`shell stamp ok: ${stamp}`);
  } else {
    const { stamp, changed } = await applyShellStamp(siteDir);
    console.log(`shell stamp ${stamp}; rewrote ${changed.length} file(s)${changed.length ? `: ${changed.join(', ')}` : ''}`);
  }
}

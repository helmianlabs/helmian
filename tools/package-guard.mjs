// Stages a Helmion Guard browser build and zips it.
//
//   node tools/package-guard.mjs --target chromium|chrome|edge|firefox [--out DIR] [--zip FILE]
//
// chrome and edge are both the Chromium manifest (manifest.json); edge is
// staged separately so each store gets its own artifact. firefox uses
// manifest.firefox.json. Output is UNSIGNED and NOT PUBLISHED: Chrome Web
// Store, Edge Add-ons and Mozilla AMO signing/submission are separate, manual,
// approved steps. No network access, no store API calls.

import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const TARGETS = Object.freeze({
  chromium: { manifest: 'manifest.json', store: 'Chrome Web Store or unpacked install' },
  chrome: { manifest: 'manifest.json', store: 'Chrome Web Store or unpacked install' },
  edge: { manifest: 'manifest.json', store: 'Microsoft Edge Add-ons or unpacked install' },
  firefox: { manifest: 'manifest.firefox.json', store: 'Mozilla AMO signing (web-ext) required' },
});
const SHIPPED_DIRS = ['background', 'content', 'generated', 'onboarding', 'popup'];
const SCRIBE_URL_LINE = /^export const SCRIBE_DEFAULT_URL = '[^']*'; \/\/ @build:scribe-url$/m;

/** Build-time Scribe server address: rewrites the one line in background/defaults.js. */
export async function applyScribeUrl(output, scribeUrl) {
  if (!scribeUrl) return null;
  const u = new URL(scribeUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('--scribe-url must be a plain https:// address');
  const clean = u.toString().replace(/\/+$/, '');
  if (clean.includes("'")) throw new Error('bad --scribe-url');
  const file = join(output, 'background', 'defaults.js');
  const text = await readFile(file, 'utf8');
  if (!SCRIBE_URL_LINE.test(text)) throw new Error('background/defaults.js has no @build:scribe-url line');
  await writeFile(file, text.replace(SCRIBE_URL_LINE, `export const SCRIBE_DEFAULT_URL = '${clean}'; // @build:scribe-url`));
  return clean;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function filesUnder(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...await filesUnder(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

// ─── a minimal, dependency-free ZIP writer (deflate, no zip64) ──────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(entries) {
  // Fixed timestamp (1980-01-01) so the same input gives the same bytes.
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export async function packageGuard({ target = 'chromium', out, zip, scribeUrl = process.env.HELMIAN_SCRIBE_URL } = {}) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unknown target ${target}; use ${Object.keys(TARGETS).join(', ')}`);
  const manifest = JSON.parse(await readFile(join(EXTENSION, spec.manifest), 'utf8'));
  const output = resolve(out || join(ROOT, 'artifacts', `helmion-guard-${target}`));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const entry of SHIPPED_DIRS) await cp(join(EXTENSION, entry), join(output, entry), { recursive: true });
  await cp(join(EXTENSION, spec.manifest), join(output, 'manifest.json'));
  await applyScribeUrl(output, scribeUrl);
  const files = await filesUnder(output);
  await writeFile(join(output, 'STAGING-MANIFEST.json'), `${JSON.stringify({
    target, version: manifest.version, manifest: spec.manifest, signed: false, public: false, signing: spec.store, files,
  }, null, 2)}\n`);

  const zipPath = resolve(zip || join(ROOT, 'artifacts', `helmion-guard-${target}-${manifest.version}.zip`));
  const allFiles = await filesUnder(output);
  const entries = [];
  for (const name of allFiles) entries.push({ name, data: await readFile(join(output, name)) });
  await mkdir(dirname(zipPath), { recursive: true });
  await writeFile(zipPath, zipFiles(entries));
  const { size } = await stat(zipPath);
  return {
    target, version: manifest.version, output, zip: zipPath, zipBytes: size, files: allFiles.length,
    manifestVersion: manifest.manifest_version, permissions: manifest.permissions,
    optionalHosts: manifest.optional_host_permissions || manifest.optional_permissions || [],
    hostMatches: manifest.content_scripts[0].matches, signing: spec.store,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageGuard({ target: arg('--target', 'chromium'), out: arg('--out'), zip: arg('--zip'), scribeUrl: arg('--scribe-url', process.env.HELMIAN_SCRIBE_URL) });
  console.log(JSON.stringify(result, null, 2));
}

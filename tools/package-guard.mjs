import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const TARGETS = Object.freeze({ chromium: 'manifest.json', firefox: 'manifest.firefox.json' });

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const target = arg('--target', 'chromium');
const manifestName = TARGETS[target];
if (!manifestName) throw new Error(`Unknown target ${target}; use chromium or firefox`);
const output = resolve(arg('--out', join(ROOT, 'artifacts', `helmion-guard-${target}`)));
const manifest = JSON.parse(await readFile(join(EXTENSION, manifestName), 'utf8'));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['background', 'content', 'generated', 'popup']) await cp(join(EXTENSION, entry), join(output, entry), { recursive: true });
await cp(join(EXTENSION, manifestName), join(output, 'manifest.json'));
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
await writeFile(join(output, 'STAGING-MANIFEST.json'), `${JSON.stringify({ target, manifest: manifestName, signed: false, public: false, signing: target === 'firefox' ? 'AMO/web-ext required' : 'store or unpacked install', files: await filesUnder(output) }, null, 2)}\n`);
console.log(JSON.stringify({ target, output, manifestVersion: manifest.manifest_version, permissions: manifest.permissions, hostMatches: manifest.content_scripts[0].matches, signing: target === 'firefox' ? 'AMO/web-ext signing required' : 'store or unpacked install' }, null, 2));

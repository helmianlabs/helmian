// Syntax gate: runs node --check over every .js/.mjs module under src/
// and bin/, enumerated from the tree instead of a hand-kept list, so a
// new module is checked without anyone editing package.json.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(full));
    else if (/\.(?:js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [];
for (const top of ['src', 'bin']) files.push(...await collect(join(root, top)));
files.sort((a, b) => a.localeCompare(b));

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: relative(root, file), error: result.stderr.trim() });
}

if (failures.length) {
  for (const failure of failures) console.error(`node --check failed: ${failure.file}\n${failure.error}`);
  console.error(`check: ${failures.length} of ${files.length} modules failed`);
  process.exit(1);
}
console.log(`check: ${files.length} modules OK`);

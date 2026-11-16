// Test gate runner: enumerates the test directories below instead of
// naming files by hand, so a new test file in a gated directory runs
// without anyone editing package.json.
//
// The gated directories are a deliberate, named list: every directory
// in the repo that holds *.test.mjs files and can run under the root
// install. One directory is deliberately NOT in this gate:
// hands-mcp/test belongs to the separately packaged hands-mcp
// component; its tests import that package's own dependency
// (@modelcontextprotocol/sdk), which the root install does not
// provide, so they cannot run here. They are gated by hands-mcp's own
// package.json test script after its own install.
//
// Exclusions live in test/exclusions.json and are the ONLY way a test
// stays out of this run: every entry there carries its reason, and the
// runner prints each exclusion before the suite starts. Nothing is
// skipped silently. Test exclusions match by exact test name in any
// gated directory; file exclusions match the repo-relative path, or
// the bare file name in any gated directory.
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const exclusions = JSON.parse(await readFile(join(testDir, 'exclusions.json'), 'utf8'));
const excludedFiles = new Map((exclusions.files ?? []).map((e) => [e.file, e.reason]));
const excludedTests = exclusions.tests ?? [];

const TEST_DIRS = ['test', 'web/marketing/test', 'extension/test', 'discord-bridge/test', 'slack-bridge/test'];

const files = [];
for (const dir of TEST_DIRS) {
  const names = (await readdir(join(root, dir)))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const rel = join(dir, name);
    if (excludedFiles.has(rel) || excludedFiles.has(name)) continue;
    files.push(rel);
  }
}

for (const [file, reason] of excludedFiles) {
  console.error(`[test gate] excluded file ${file}: ${reason}`);
}
for (const entry of excludedTests) {
  console.error(`[test gate] excluded test "${entry.name}": ${entry.reason}`);
}

const args = ['--test'];
if (excludedTests.length) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  args.push(`--test-skip-pattern=${excludedTests.map((e) => `^${escape(e.name)}$`).join('|')}`);
}
args.push(...process.argv.slice(2), ...files);

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

// The starter slash commands ride the deployment, pinned end to end.
//
// The five starters (standup, summarize, draft, plan, explain) are product
// content, not a local workspace: they live in the repo at
// web/marketing/.helmion/commands/ and reach the live "/" menu through
// the deployed admin function, whose workspace is its own working
// directory (HELMION_WORKSPACE_PATH is not set in production, so
// slashCommandsWorkspace falls back to process.cwd() — the project root,
// web/marketing). The files are read through fs at runtime, never
// imported, so the function only carries them because vercel.json's
// includeFiles glob names their folder. These tests pin both halves:
// the real lister, run the way the deployed function runs it, returns
// exactly the five starter rows; and the vercel.json glob, evaluated
// against the disk, matches exactly those files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSlashCommands, slashCommandsWorkspace } from '../src/cloud/slash-commands.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(repo, 'web', 'marketing');

const EXPECTED_ROWS = Object.freeze([
  { name: 'draft', description: 'Turn my rough notes into a clean message, ready to send', origin: 'workspace' },
  { name: 'explain', description: 'Explain the last technical thing here in plain words', origin: 'workspace' },
  { name: 'plan', description: 'Break a goal into small steps, one clear outcome each', origin: 'workspace' },
  { name: 'standup', description: 'Draft a short standup from what happened in this channel today', origin: 'workspace' },
  { name: 'summarize', description: "Summarize this channel's recent discussion in plain words", origin: 'workspace' },
]);

test('the deployed resolution lists exactly the five starter commands', async (t) => {
  // Run the lister the way the deployed function does: no
  // HELMION_WORKSPACE_PATH, cwd = the project root. HOME is pinned to an
  // empty directory so no personal (~/.helmion) commands leak in — the
  // served workspace's starters are the whole list.
  const emptyHome = await mkdtemp(join(tmpdir(), 'helmion-bundle-home-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevWorkspacePath = process.env.HELMION_WORKSPACE_PATH;
  t.after(async () => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevWorkspacePath === undefined) delete process.env.HELMION_WORKSPACE_PATH;
    else process.env.HELMION_WORKSPACE_PATH = prevWorkspacePath;
    await rm(emptyHome, { recursive: true, force: true });
  });
  delete process.env.HELMION_WORKSPACE_PATH;
  process.env.HOME = emptyHome;
  process.chdir(site);

  const workspace = slashCommandsWorkspace({});
  assert.equal(workspace, site, 'default resolution lands on the project root');
  const result = await listSlashCommands({ workspace });
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.commands, EXPECTED_ROWS);
  for (const row of result.commands) {
    assert.deepEqual(Object.keys(row).sort(), ['description', 'name', 'origin']);
  }
});

test('vercel.json carries the commands folder into the admin function', async () => {
  // A parse throw here is itself the structural check failing.
  const config = JSON.parse(await readFile(join(site, 'vercel.json'), 'utf8'));
  const fn = config.functions?.['api/helmian-admin.js'];
  assert.ok(fn, 'the admin function entry exists');
  // Vercel's documented shape: one glob pattern (a string), in the
  // node-glob dialect — braces are how a single pattern names two trees.
  assert.equal(typeof fn.includeFiles, 'string', 'includeFiles stays one glob pattern');
  assert.ok(
    fn.includeFiles.includes('helmian-admin'),
    'the bundled admin backend stays covered by the glob',
  );
  const matched = globSync(fn.includeFiles, { cwd: site })
    .map((p) => p.split(sep).join('/'))
    .sort();
  for (const row of EXPECTED_ROWS) {
    assert.ok(
      matched.includes(`.helmion/commands/${row.name}.md`),
      `includeFiles glob matches .helmion/commands/${row.name}.md`,
    );
  }
});

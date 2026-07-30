import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_PROJECT_TEMPLATES_ROOT,
  PARTIAL_PREFIX,
  SPRINT_TEMPLATE_PREFIX,
  applyProjectActions,
  defaultProjectDirectory,
  destinationFor,
  listProjectTemplates,
  loadProjectTemplates,
  partialToken,
  planProjectScaffold,
  renderProjectFiles,
  scaffoldProject,
  scanProjectTemplatesForIdentifyingContent,
  slugifyProjectName,
  sprintId,
} from '../src/core/project-scaffold.mjs';
import { scanForIdentifyingContent } from '../src/core/agent-os.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const DATE = '2026-01-15';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'project-scaffold-test-'));
}

/** The exact tree the scaffolder is contracted to produce. */
const EXPECTED_TREE = Object.freeze([
  'PROJECT.md',
  'docs/ARCHITECTURE.md',
  'docs/README.md',
  'docs/handoffs/HANDOFF_TEMPLATE.md',
  'planning/DECISIONS.md',
  'planning/RISKS.md',
  'planning/STATE.md',
  'planning/acceptance-criteria.md',
  'planning/blueprint.md',
  'planning/requirements.md',
  'prompts/architect.md',
  'prompts/builder.md',
  'sprints/README.md',
  'sprints/sprint-001/acceptance-criteria.md',
  'sprints/sprint-001/blueprint.md',
  'sprints/sprint-001/handoff-prompt.md',
  'sprints/sprint-001/requirements.md',
]);

// ── Naming ───────────────────────────────────────────────────────────────────

test('a typed project name becomes a safe slug', () => {
  assert.equal(slugifyProjectName('Invoice Importer'), 'invoice-importer');
  assert.equal(slugifyProjectName('  Order Sync  '), 'order-sync');
  assert.equal(slugifyProjectName('API v2.1 (beta)'), 'api-v2-1-beta');
  assert.equal(slugifyProjectName('../../etc/passwd'), 'etc-passwd', 'a traversal must not survive');
  assert.equal(slugifyProjectName('Alpha___Beta'), 'alpha-beta');
  assert.ok(slugifyProjectName('x'.repeat(200)).length <= 64);
});

test('a name with nothing sluggable is refused, not silently turned into a blank folder', () => {
  for (const name of ['', '   ', '///', '...', '---', null, undefined]) {
    assert.throws(
      () => slugifyProjectName(name),
      /cannot become a folder name/,
      `${JSON.stringify(name)} must be refused`,
    );
  }
});

test('sprint ids are zero-padded and reject nonsense', () => {
  assert.equal(sprintId(1), 'sprint-001');
  assert.equal(sprintId(2), 'sprint-002');
  assert.equal(sprintId(42), 'sprint-042');
  assert.equal(sprintId(137), 'sprint-137');
  for (const bad of [0, -1, 1.5, 'two', NaN, null]) {
    assert.throws(() => sprintId(bad), /positive integer/, `${bad} must be refused`);
  }
});

test('a partial file name maps to a usable token', () => {
  assert.equal(partialToken('partials/SOURCE_OF_TRUTH.md'), 'SOURCE_OF_TRUTH');
  assert.equal(partialToken('partials/process-bar.md'), 'PROCESS_BAR');
});

test('the sprint template directory is remapped and partials are dropped', () => {
  assert.equal(destinationFor('PROJECT.md', { sprint: 'sprint-001' }), 'PROJECT.md');
  assert.equal(
    destinationFor(`${SPRINT_TEMPLATE_PREFIX}blueprint.md`, { sprint: 'sprint-007' }),
    'sprints/sprint-007/blueprint.md',
  );
  assert.equal(destinationFor(`${PARTIAL_PREFIX}SOURCE_OF_TRUTH.md`, { sprint: 'sprint-001' }), null);
});

test('the default directory is the slug under the working directory', () => {
  assert.equal(
    defaultProjectDirectory('invoice-importer', join('/tmp', 'work')),
    join('/tmp', 'work', 'invoice-importer'),
  );
});

// ── Rendering ────────────────────────────────────────────────────────────────

test('the template tree is non-trivial and is all markdown', async () => {
  const files = await listProjectTemplates(DEFAULT_PROJECT_TEMPLATES_ROOT);
  assert.ok(files.length >= 15, `expected a real template tree, found ${files.length}`);
  for (const file of files) {
    assert.match(file, /\.md$/, `unexpected template file type: ${file}`);
  }
  assert.ok(
    files.some((file) => file.startsWith(PARTIAL_PREFIX)),
    'the partial mechanism must actually be in use',
  );
});

test('rendering produces exactly the contracted tree, with no placeholder left behind', async () => {
  const templates = await loadProjectTemplates();
  const files = renderProjectFiles({ templates, name: 'Invoice Importer', createdDate: DATE });

  assert.deepEqual(files.map((file) => file.path).sort(), [...EXPECTED_TREE]);

  for (const file of files) {
    assert.ok(
      !/\{\{[A-Z0-9_]+\}\}/.test(file.content),
      `${file.path} still carries an unresolved placeholder`,
    );
    assert.equal(file.ownership, 'user', `${file.path} must be user-owned`);
    assert.ok(file.content.endsWith('\n'), `${file.path} must end with a newline`);
  }
});

test('a partial file is never emitted as a file of its own', async () => {
  const templates = await loadProjectTemplates();
  const files = renderProjectFiles({ templates, name: 'Invoice Importer', createdDate: DATE });
  for (const file of files) {
    assert.ok(
      !file.path.startsWith(PARTIAL_PREFIX),
      `${file.path} is a partial and must not be written out`,
    );
  }
});

test('the scalar tokens really reach the output', async () => {
  const templates = await loadProjectTemplates();
  const files = renderProjectFiles({
    templates, name: 'Invoice Importer', createdDate: DATE, sprintNumber: 3,
  });
  const charter = files.find((file) => file.path === 'PROJECT.md').content;

  assert.match(charter, /# Invoice Importer/);
  assert.match(charter, /invoice-importer/);
  assert.match(charter, /2026-01-15/);
  assert.match(charter, /sprint-003/);
  assert.ok(
    files.some((file) => file.path === 'sprints/sprint-003/handoff-prompt.md'),
    '--sprint must move the pack, not just the label',
  );
});

test('a partial is injected into every file that references it, tokens resolved', async () => {
  const templates = await loadProjectTemplates();
  const files = renderProjectFiles({ templates, name: 'Invoice Importer', createdDate: DATE });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));

  // The source-of-truth header must open the handoff prompt, the handoff
  // template, and the builder role prompt — those are the three documents a
  // zero-context session reads first.
  for (const path of [
    'sprints/sprint-001/handoff-prompt.md',
    'docs/handoffs/HANDOFF_TEMPLATE.md',
    'prompts/builder.md',
  ]) {
    assert.match(byPath[path], /GATE 1 — SOURCE OF TRUTH/, `${path} is missing the header`);
    assert.match(byPath[path], /GATE 2 — FULL TRACING/, `${path} is missing the tracing gate`);
  }

  // And the process-quality bar must reach both acceptance-criteria files.
  for (const path of ['planning/acceptance-criteria.md', 'sprints/sprint-001/acceptance-criteria.md']) {
    assert.match(byPath[path], /process-quality bar/, `${path} is missing the process bar`);
    assert.match(byPath[path], /watched to FAIL/, `${path} is missing the test-first bar`);
  }
});

test('an unresolved token throws instead of shipping', async () => {
  const templatesRoot = await scratch();
  await writeFile(join(templatesRoot, 'PROJECT.md'), 'hello {{NOT_A_REAL_TOKEN}}\n', 'utf8');

  await assert.rejects(
    scaffoldProject({
      name: 'X', dir: join(templatesRoot, 'out'), templatesRoot, createdDate: DATE, apply: true,
    }),
    /Unresolved template placeholder \{\{NOT_A_REAL_TOKEN\}\}/,
  );
  assert.equal(existsSync(join(templatesRoot, 'out', 'PROJECT.md')), false, 'nothing may be written');

  await rm(templatesRoot, { recursive: true, force: true });
});

test('a token inside a partial is resolved before the partial is injected', async () => {
  // Two-stage rendering: without it, a partial carrying {{PROJECT_NAME}} would
  // be injected verbatim and the leftover check would throw on the parent.
  const templatesRoot = await scratch();
  await mkdir(join(templatesRoot, 'partials'), { recursive: true });
  await writeFile(join(templatesRoot, 'partials', 'GREETING.md'), 'hello {{PROJECT_NAME}}\n', 'utf8');
  await writeFile(join(templatesRoot, 'PROJECT.md'), '{{GREETING}}, slug {{PROJECT_SLUG}}\n', 'utf8');

  const templates = await loadProjectTemplates(templatesRoot);
  const files = renderProjectFiles({ templates, name: 'Order Sync', createdDate: DATE });

  assert.deepEqual(files.map((file) => file.path), ['PROJECT.md']);
  assert.equal(files[0].content, 'hello Order Sync, slug order-sync\n');

  await rm(templatesRoot, { recursive: true, force: true });
});

test('a bad created date is refused rather than written into every file', async () => {
  const templates = await loadProjectTemplates();
  for (const bad of ['', '15/01/2026', '2026-1-5', 'today', null]) {
    assert.throws(
      () => renderProjectFiles({ templates, name: 'X', createdDate: bad }),
      /createdDate must be YYYY-MM-DD/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

// ── Planning ─────────────────────────────────────────────────────────────────

test('the plan has exactly two actions and neither one overwrites', () => {
  const files = [
    { path: 'a.md', content: 'new a\n', ownership: 'user' },
    { path: 'b.md', content: 'new b\n', ownership: 'user' },
  ];
  const actions = planProjectScaffold({ files, existing: { 'b.md': 'the operator wrote this\n' } });

  assert.equal(actions[0].action, 'create');
  assert.equal(actions[1].action, 'preserve');
  assert.match(actions[1].reason, /yours/);

  const verbs = new Set(actions.map((action) => action.action));
  for (const verb of verbs) {
    assert.ok(['create', 'preserve'].includes(verb), `unexpected action "${verb}"`);
  }
});

// ── Writing, preserving, idempotency ─────────────────────────────────────────

test('a dry run reports the whole plan and writes nothing at all', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  const report = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: false,
  });

  assert.equal(report.applied, false);
  assert.equal(report.counts.create, EXPECTED_TREE.length);
  assert.equal(report.files.length, EXPECTED_TREE.length);
  assert.equal(existsSync(projectDir), false, 'a dry run must not even create the directory');

  await rm(dir, { recursive: true, force: true });
});

test('apply writes the whole tree at the reported paths', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  const report = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: true,
  });

  assert.equal(report.applied, true);
  assert.equal(report.directory, resolve(projectDir));
  assert.equal(report.slug, 'invoice-importer');
  assert.equal(report.sprint, 'sprint-001');

  for (const path of EXPECTED_TREE) {
    assert.ok(existsSync(join(projectDir, path)), `${path} was reported but never written`);
    const info = await stat(join(projectDir, path));
    assert.ok(info.size > 0, `${path} was written empty`);
  }

  await rm(dir, { recursive: true, force: true });
});

test('a second run is a complete no-op and says what it left alone', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');

  const first = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: true,
  });
  assert.equal(first.counts.create, EXPECTED_TREE.length);
  assert.equal(first.counts.preserve, undefined);

  const second = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: true,
  });
  assert.equal(second.counts.create, undefined, 'nothing may be created twice');
  assert.equal(second.counts.preserve, EXPECTED_TREE.length, 'every file must be reported preserved');
  assert.ok(
    second.files.every((file) => file.action === 'preserve' && /untouched/.test(file.reason)),
    'a re-run must report every file as preserved, by name',
  );

  await rm(dir, { recursive: true, force: true });
});

test('an existing file is preserved BYTE FOR BYTE and the run still succeeds', async () => {
  // Proven by side effect, not by the report: read the bytes before, read them
  // after, and compare buffers. This repo destroyed a real 5,512-byte rules
  // file twice by templating over it, so the sentinel is the point of the test.
  const dir = await scratch();
  const projectDir = join(dir, 'importer');

  const sentinels = {
    'PROJECT.md': '# MY OWN CHARTER\n\nsentinel-alpha\n\ntrailing spaces kept:   \n\n\n',
    'planning/requirements.md': 'sentinel-bravo — hours of my own reasoning\n',
    'planning/STATE.md': '\uFEFF# STATE\n\nsentinel-charlie with a BOM and no final newline',
    'sprints/sprint-001/handoff-prompt.md': 'sentinel-delta\r\nwindows line endings\r\n',
    'docs/handoffs/HANDOFF_TEMPLATE.md': '',
  };

  const before = {};
  for (const [path, body] of Object.entries(sentinels)) {
    const full = join(projectDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
    before[path] = await readFile(full);
  }

  const report = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: true,
  });

  // The command still succeeds and still creates everything else.
  assert.equal(report.applied, true);
  assert.equal(report.counts.preserve, Object.keys(sentinels).length);
  assert.equal(report.counts.create, EXPECTED_TREE.length - Object.keys(sentinels).length);

  for (const path of Object.keys(sentinels)) {
    const after = await readFile(join(projectDir, path));
    assert.deepEqual(
      after,
      before[path],
      `${path} was modified — the never-overwrite guarantee is broken`,
    );
    const entry = report.files.find((file) => file.path === path);
    assert.equal(entry.action, 'preserve', `${path} must be REPORTED as preserved, not silently kept`);
  }

  // And a file that did not exist was still written, so preserving one file
  // cannot abort the rest of the scaffold.
  assert.ok(existsSync(join(projectDir, 'planning', 'blueprint.md')));

  await rm(dir, { recursive: true, force: true });
});

test('an empty existing file counts as existing — zero bytes are still the operator\'s', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  await mkdir(join(projectDir, 'planning'), { recursive: true });
  await writeFile(join(projectDir, 'planning', 'RISKS.md'), '', 'utf8');

  const report = await scaffoldProject({
    name: 'Invoice Importer', dir: projectDir, createdDate: DATE, apply: true,
  });

  assert.equal((await stat(join(projectDir, 'planning', 'RISKS.md'))).size, 0);
  assert.equal(report.files.find((file) => file.path === 'planning/RISKS.md').action, 'preserve');

  await rm(dir, { recursive: true, force: true });
});

test('a file that appears between the plan and the write is preserved, not overwritten', async () => {
  // The plan is built from a read of the disk; another process can create the
  // file inside that window. The 'wx' write flag is what closes it.
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  await mkdir(join(projectDir, 'planning'), { recursive: true });
  await writeFile(join(projectDir, 'planning', 'STATE.md'), 'written by someone else\n', 'utf8');

  // A plan that has NOT seen that file — exactly what a stale read produces.
  const actions = planProjectScaffold({
    files: [
      { path: 'planning/STATE.md', content: 'template body\n', ownership: 'user' },
      { path: 'planning/RISKS.md', content: 'template body\n', ownership: 'user' },
    ],
    existing: {},
  });
  assert.equal(actions[0].action, 'create', 'the stale plan must really say create');

  await applyProjectActions({ projectDir, actions });

  assert.equal(
    await readFile(join(projectDir, 'planning', 'STATE.md'), 'utf8'),
    'written by someone else\n',
    'the racing writer\'s bytes must survive',
  );
  assert.equal(actions[0].action, 'preserve', 'the report must be corrected to what happened');
  assert.match(actions[0].reason, /appeared while scaffolding/);
  assert.equal(actions[1].action, 'create', 'the rest of the scaffold must still be written');

  await rm(dir, { recursive: true, force: true });
});

test('the default directory is the slug beside the working directory', async () => {
  const dir = await scratch();
  const report = await scaffoldProject({
    name: 'Invoice Importer', cwd: dir, createdDate: DATE, apply: true,
  });

  assert.equal(report.directory, resolve(join(dir, 'invoice-importer')));
  assert.ok(existsSync(join(dir, 'invoice-importer', 'PROJECT.md')));

  await rm(dir, { recursive: true, force: true });
});

// ── The pack is actually usable ───────────────────────────────────────────────

test('the sprint area carries the four architect-pack files', async () => {
  const dir = await scratch();
  await scaffoldProject({ name: 'Invoice Importer', dir, createdDate: DATE, apply: true });

  for (const file of ['requirements.md', 'blueprint.md', 'handoff-prompt.md', 'acceptance-criteria.md']) {
    assert.ok(
      existsSync(join(dir, 'sprints', 'sprint-001', file)),
      `the architect pack is missing ${file}`,
    );
  }

  const requirements = await readFile(join(dir, 'sprints', 'sprint-001', 'requirements.md'), 'utf8');
  assert.match(requirements, /Honest starting point/);
  assert.match(requirements, /Searched and found nothing/);
  assert.match(requirements, /Hypotheses — not causes/);
  assert.match(requirements, /Non-goals/);

  const blueprint = await readFile(join(dir, 'sprints', 'sprint-001', 'blueprint.md'), 'utf8');
  assert.match(blueprint, /plan document only/);
  for (const phase of [/reproduce/i, /diagnose/i, /fix/i, /verify/i, /document/i]) {
    assert.match(blueprint, phase, `the blueprint is missing a ${phase} phase`);
  }
  assert.match(blueprint, /Rollback/);
  assert.match(blueprint, /Files likely touched/);
  assert.match(blueprint, /Sequencing/);

  const criteria = await readFile(join(dir, 'sprints', 'sprint-001', 'acceptance-criteria.md'), 'utf8');
  assert.match(criteria, /Outcome A/);
  assert.match(criteria, /Outcome B/, 'both outcomes must be first-class or the builder is pressured to fabricate');
  assert.match(criteria, /did not reproduce/i);

  const prompt = await readFile(join(dir, 'sprints', 'sprint-001', 'handoff-prompt.md'), 'utf8');
  assert.match(prompt, /zero memory of any prior conversation/);
  assert.match(prompt, /Read these first/);
  assert.match(prompt, /Hard constraints/);
  assert.match(prompt, /What "done" looks like/);

  await rm(dir, { recursive: true, force: true });
});

test('every file the handoff prompt tells you to read is a file the scaffolder creates', async () => {
  // A reader pointed at a path nothing writes is a dead arrow: the handoff
  // looks complete and silently sends the next session to a missing file.
  const dir = await scratch();
  await scaffoldProject({ name: 'Invoice Importer', dir, createdDate: DATE, apply: true });

  const prompt = await readFile(join(dir, 'sprints', 'sprint-001', 'handoff-prompt.md'), 'utf8');
  const listed = [...prompt.matchAll(/^\d+\.\s+`([^`]+)`/gm)].map((match) => match[1]);
  assert.ok(listed.length >= 5, `expected a read-these-first list, found ${listed.length} entries`);
  for (const path of listed) {
    assert.ok(existsSync(join(dir, path)), `the handoff prompt points at ${path}, which is never created`);
  }

  // Same for every path the charter's map names.
  const charter = await readFile(join(dir, 'PROJECT.md'), 'utf8');
  const referenced = [...charter.matchAll(/`([A-Za-z0-9_./-]+(?:\.md|\/))`/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 10, `expected the charter to map the tree, found ${referenced.length}`);
  for (const path of referenced) {
    assert.ok(existsSync(join(dir, path)), `PROJECT.md names ${path}, which is never created`);
  }

  await rm(dir, { recursive: true, force: true });
});

test('the docs area explains itself and carries a handoff template in the house style', async () => {
  const dir = await scratch();
  await scaffoldProject({ name: 'Invoice Importer', dir, createdDate: DATE, apply: true });

  const template = await readFile(join(dir, 'docs', 'handoffs', 'HANDOFF_TEMPLATE.md'), 'utf8');
  assert.match(template, /The one thing to know first/);
  assert.match(template, /\| Thing \| State \| Proof \|/, 'the state table needs a Proof column');
  assert.match(template, /Corrections — do not re-inherit/);
  assert.match(template, /Still unverified/);
  assert.match(template, /What did NOT land/);

  await rm(dir, { recursive: true, force: true });
});

// ── Anonymization ────────────────────────────────────────────────────────────

test('no shipped project template contains identifying content', async () => {
  const findings = await scanProjectTemplatesForIdentifyingContent();
  assert.deepEqual(
    findings,
    [],
    `project templates leak identifying content:\n${findings.map((f) => `  ${f.path}:${f.line} [${f.rule}] ${f.excerpt}`).join('\n')}`,
  );
});

test('nothing the scaffolder WRITES contains identifying content either', async () => {
  // The templates being clean is not the same claim as the output being clean:
  // the rendered files carry the operator's project name and tokens the
  // templates never held.
  const dir = await scratch();
  const templates = await loadProjectTemplates();
  const files = renderProjectFiles({ templates, name: 'Invoice Importer', createdDate: DATE });
  const rendered = Object.fromEntries(files.map((file) => [file.path, file.content]));

  assert.deepEqual(scanForIdentifyingContent(rendered), []);
  await rm(dir, { recursive: true, force: true });
});

test('the scanner still fails on poisoned project content (positive control)', () => {
  // Pointing a denylist at a clean tree proves nothing unless the same denylist
  // is shown to catch the leaks it exists for. These are the shapes a planning
  // template would realistically leak.
  const poisoned = {
    'PROJECT.md': 'Owner: Troy. Ask before shipping.',
    'planning/requirements.md': 'Port the parser from the dairyforge console.',
    'planning/STATE.md': 'Blocked on the Chobani route file.',
    'planning/DECISIONS.md': 'Rules live in C:\\Users\\someone\\.claude\\CLAUDE.md',
    'planning/RISKS.md': 'Reach the owner at someone@example.com.',
    'docs/ARCHITECTURE.md': 'Reads postgres://user:pw@host.example.com:5432/db',
    'docs/handoffs/HANDOFF_TEMPLATE.md': 'Point it at endpoint ep-dry-fog-aku9i5gq first.',
    'prompts/architect.md': 'Big Sister runs in the terminal; Clyde runs in the editor.',
    'prompts/builder.md': 'export OPENAI_API_KEY=sk-abcdefghijklmnop1234',
    'sprints/sprint-001/requirements.md': 'Log it to the neon database for the advisors.',
    'sprints/sprint-001/blueprint.md': 'Run speak.ps1 -Who bigsister to report back.',
  };

  const findings = scanForIdentifyingContent(poisoned);
  const flagged = new Set(findings.map((finding) => finding.path));
  for (const path of Object.keys(poisoned)) {
    assert.ok(flagged.has(path), `${path} should have been flagged: ${poisoned[path]}`);
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('the CLI dry run writes nothing and names every file first', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  const { stdout } = await run(process.execPath, [
    join(repoRoot, 'bin', 'helmion.mjs'), 'project', 'init', 'Invoice Importer', '--dir', projectDir,
  ]);

  assert.match(stdout, /dry run/);
  for (const path of EXPECTED_TREE) assert.ok(stdout.includes(path), `${path} was not listed`);
  assert.equal(existsSync(projectDir), false, 'the dry run must not write');

  await rm(dir, { recursive: true, force: true });
});

test('the CLI emits machine-readable JSON and reports preserved files on a re-run', async () => {
  const dir = await scratch();
  const projectDir = join(dir, 'importer');
  const args = [
    join(repoRoot, 'bin', 'helmion.mjs'), 'project', 'init', 'Invoice Importer',
    '--dir', projectDir, '--yes', '--json',
  ];

  const first = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(first.applied, true);
  assert.equal(first.slug, 'invoice-importer');
  assert.equal(first.sprint, 'sprint-001');
  assert.equal(first.counts.create, EXPECTED_TREE.length);
  assert.ok(first.files.every((file) => typeof file.action === 'string'));
  assert.ok(existsSync(join(projectDir, 'PROJECT.md')));

  const second = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(second.counts.preserve, EXPECTED_TREE.length);
  assert.equal(second.counts.create, undefined);

  await rm(dir, { recursive: true, force: true });
});

test('the CLI honours --sprint', async () => {
  const dir = await scratch();
  const { stdout } = await run(process.execPath, [
    join(repoRoot, 'bin', 'helmion.mjs'), 'project', 'init', 'Order Sync',
    '--dir', dir, '--sprint', '4', '--yes', '--json',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.sprint, 'sprint-004');
  assert.ok(existsSync(join(dir, 'sprints', 'sprint-004', 'handoff-prompt.md')));

  await rm(dir, { recursive: true, force: true });
});

test('the CLI refuses a missing name, a flag used as a name, and an unknown subcommand', async () => {
  const cli = join(repoRoot, 'bin', 'helmion.mjs');
  await assert.rejects(
    run(process.execPath, [cli, 'project', 'init']),
    /project init requires a name/,
  );
  await assert.rejects(
    run(process.execPath, [cli, 'project', 'init', '--yes']),
    /project init requires a name/,
  );
  await assert.rejects(
    run(process.execPath, [cli, 'project', 'scaffold', 'X']),
    /project subcommand must be init/,
  );
});

test('the CLI help documents the command', async () => {
  const { stdout } = await run(process.execPath, [join(repoRoot, 'bin', 'helmion.mjs'), 'help']);
  assert.match(stdout, /helmion project init/);
  assert.match(stdout, /Never overwrites/i);
});

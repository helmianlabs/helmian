import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  AGENT_OS_MARKER_BEGIN,
  AGENT_OS_MARKER_END,
  AGENT_OS_TARGETS,
  DEFAULT_TEMPLATES_ROOT,
  ESTATE_CARGO,
  ESTATE_CARGO_FOLDERS,
  ESTATE_CARGO_TREES,
  ESTATE_TREE_FILE_MAX_BYTES,
  IDENTIFYING_PATTERNS,
  TARGET_SPECS,
  defaultTargetDirectory,
  installAgentOs,
  installAgentOsTargets,
  listTemplateFiles,
  loadAgentOsTemplates,
  loadEstateCargo,
  render,
  renderAgentOsFiles,
  renderEstateFiles,
  resolveTargets,
  scanForIdentifyingContent,
  scanTemplatesForIdentifyingContent,
} from '../src/core/agent-os.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function scratch() {
  return mkdtemp(join(tmpdir(), 'agent-os-test-'));
}

// ── Generation ───────────────────────────────────────────────────────────────

test('every target generates its own context file plus the companion set', async () => {
  const templates = await loadAgentOsTemplates();

  for (const target of AGENT_OS_TARGETS) {
    const files = renderAgentOsFiles({ target, templates, installDir: '/tmp/x' });
    const paths = files.map((file) => file.path);

    assert.ok(
      paths.includes(TARGET_SPECS[target].contextFile),
      `${target} must produce ${TARGET_SPECS[target].contextFile}`,
    );

    for (const companion of ['LESSONS.md', 'LEARNINGS.md', 'BLOCKERS.md', 'WINS.md', 'SESSION_BOARD.md', 'memory/MEMORY.md']) {
      assert.ok(paths.includes(companion), `${target} is missing ${companion}`);
    }

    assert.ok(paths.includes('agent-os/AGENT_OS.md'));
    assert.ok(paths.includes('agent-os/hooks/session-start-context.mjs'));
    assert.ok(paths.includes('agent-os/hooks/stop-capture.mjs'));

    // Placeholders must all be resolved; render() throws otherwise, but assert
    // on the output too so a silently-renamed token cannot slip through.
    for (const file of files) {
      assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(file.content), `${target}:${file.path} has an unresolved placeholder`);
    }
  }
});

test('the core rules reach the context file of all three targets', async () => {
  const templates = await loadAgentOsTemplates();
  for (const target of AGENT_OS_TARGETS) {
    const files = renderAgentOsFiles({ target, templates, installDir: '/tmp/x' });
    const context = files.find((file) => file.path === TARGET_SPECS[target].contextFile);
    assert.match(context.content, /Cite or say nothing/);
    assert.match(context.content, /Source of truth/);
    assert.match(context.content, /capture\s+->\s+propose\s+->\s+review\s+->\s+promote/);
  }
});

test('render throws rather than shipping an unresolved placeholder', () => {
  assert.throws(() => render('hello {{MISSING}}', {}), /Unresolved template placeholder/);
  assert.equal(render('hello {{NAME}}', { NAME: 'world' }), 'hello world');
});

test('resolveTargets validates input and defaults to all', () => {
  assert.deepEqual(resolveTargets(undefined), [...AGENT_OS_TARGETS]);
  assert.deepEqual(resolveTargets('all'), [...AGENT_OS_TARGETS]);
  assert.deepEqual(resolveTargets('claude,codex'), ['claude', 'codex']);
  assert.deepEqual(resolveTargets('claude,claude'), ['claude']);
  assert.throws(() => resolveTargets('emacs'), /Unknown target "emacs"/);
});

test('default directories follow each tool documented location', () => {
  const home = '/home/example';
  assert.equal(defaultTargetDirectory('claude', home), join(home, '.claude'));
  assert.equal(defaultTargetDirectory('codex', home), join(home, '.codex'));
  assert.equal(defaultTargetDirectory('gemini', home), join(home, '.gemini'));
});

// ── Writing, merging, idempotency ────────────────────────────────────────────

test('a dry run reports the full plan and writes nothing', async () => {
  const dir = await scratch();
  const result = await installAgentOs({ target: 'claude', dir, apply: false });

  assert.equal(result.applied, false);
  assert.ok(result.files.length >= 12);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false, 'dry run must not create files');
  await rm(dir, { recursive: true, force: true });
});

test('install writes every planned file and is idempotent on re-run', async () => {
  const dir = await scratch();

  const first = await installAgentOs({ target: 'claude', dir, apply: true });
  assert.equal(first.counts.create, first.files.length);
  assert.ok(existsSync(join(dir, 'CLAUDE.md')));
  assert.ok(existsSync(join(dir, 'agent-os', 'hooks', 'stop-capture.mjs')));

  const second = await installAgentOs({ target: 'claude', dir, apply: true });
  assert.equal(second.counts.create, undefined, 'nothing should be created twice');
  assert.equal(second.counts.append, undefined, 'nothing should be appended twice');
  assert.equal(second.counts.update, undefined, 'managed files should already be current');

  const settled = (second.counts.skip ?? 0) + (second.counts.unchanged ?? 0);
  assert.equal(settled, second.files.length, 'a re-run must be a no-op');

  await rm(dir, { recursive: true, force: true });
});

test('an existing context file is appended to, never overwritten', async () => {
  const dir = await scratch();
  const original = '# My own rules\n\nAlways use tabs. Never touch the deploy script.\n';
  await writeFile(join(dir, 'CLAUDE.md'), original, 'utf8');

  const result = await installAgentOs({ target: 'claude', dir, apply: true });

  const after = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(after.startsWith('# My own rules'), 'the user content must remain at the top');
  assert.match(after, /Always use tabs\. Never touch the deploy script\./);
  assert.ok(after.includes(AGENT_OS_MARKER_BEGIN), 'the agent OS block must be appended');

  const contextAction = result.files.find((file) => file.path === 'CLAUDE.md');
  assert.equal(contextAction.action, 'append');

  // And a second run must not append the block twice.
  await installAgentOs({ target: 'claude', dir, apply: true });
  const afterSecond = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  const occurrences = afterSecond.split(AGENT_OS_MARKER_BEGIN).length - 1;
  assert.equal(occurrences, 1, 'the block must be appended exactly once');

  await rm(dir, { recursive: true, force: true });
});

test('an existing companion file is left byte-for-byte alone', async () => {
  const dir = await scratch();
  const mine = '# LESSONS\n\n## 2026-01-01 - something I already learned\n\nDo not lose this.\n';
  await writeFile(join(dir, 'LESSONS.md'), mine, 'utf8');

  const result = await installAgentOs({ target: 'claude', dir, apply: true });

  assert.equal(await readFile(join(dir, 'LESSONS.md'), 'utf8'), mine);
  assert.equal(result.files.find((file) => file.path === 'LESSONS.md').action, 'skip');

  await rm(dir, { recursive: true, force: true });
});

test('the installer never writes a settings file', async () => {
  const dir = await scratch();
  for (const target of AGENT_OS_TARGETS) {
    const targetDir = join(dir, target);
    await mkdir(targetDir, { recursive: true });
    const result = await installAgentOs({ target, dir: targetDir, apply: true });

    assert.equal(result.hooksWired, false);
    assert.equal(
      existsSync(result.settingsFile),
      false,
      `${target}: ${TARGET_SPECS[target].settingsFile} must be left for the user to merge`,
    );
    assert.ok(existsSync(result.settingsSnippet), `${target}: the snippet must exist`);
  }
  await rm(dir, { recursive: true, force: true });
});

test('installing all targets into one directory keeps them separated', async () => {
  const dir = await scratch();
  const report = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], dir, apply: true });

  assert.equal(report.targets.length, AGENT_OS_TARGETS.length);
  assert.ok(existsSync(join(dir, '.claude', 'CLAUDE.md')));
  assert.ok(existsSync(join(dir, '.codex', 'AGENTS.md')));
  assert.ok(existsSync(join(dir, '.gemini', 'GEMINI.md')));
  assert.ok(existsSync(join(dir, '.grok', 'AGENTS.md')));

  await rm(dir, { recursive: true, force: true });
});

// ── Hook wiring snippets ─────────────────────────────────────────────────────

test('each hook snippet is valid JSON using that tool own event names', async () => {
  const dir = await scratch();
  const expectations = {
    claude: { turnEnd: 'Stop', settings: 'settings.json' },
    codex: { turnEnd: 'Stop', settings: 'hooks.json' },
    gemini: { turnEnd: 'AfterAgent', settings: 'settings.json' },
    grok: { turnEnd: 'Stop', settings: 'hooks/agent-os.json' },
  };

  // A target with no expectation row would otherwise throw a confusing
  // "cannot read properties of undefined" instead of naming what is missing.
  assert.deepEqual(
    Object.keys(expectations).sort(),
    [...AGENT_OS_TARGETS].sort(),
    'every target needs a documented turn-end event and settings file',
  );

  for (const target of AGENT_OS_TARGETS) {
    const targetDir = join(dir, target);
    await mkdir(targetDir, { recursive: true });
    const result = await installAgentOs({ target, dir: targetDir, apply: true });

    const snippet = JSON.parse(await readFile(result.settingsSnippet, 'utf8'));
    assert.ok(snippet.hooks.SessionStart, `${target} must configure SessionStart`);
    assert.ok(
      snippet.hooks[expectations[target].turnEnd],
      `${target} must configure ${expectations[target].turnEnd}`,
    );
    assert.equal(TARGET_SPECS[target].settingsFile, expectations[target].settings);

    // The command must point at a hook file that actually got installed.
    const command = snippet.hooks.SessionStart[0].hooks[0].command;
    const match = command.match(/"([^"]+)"/);
    assert.ok(match, `${target}: hook command must quote its script path`);
    assert.ok(existsSync(match[1]), `${target}: ${match[1]} does not exist`);
  }

  await rm(dir, { recursive: true, force: true });
});

// ── Anonymization ────────────────────────────────────────────────────────────

test('no shipped template contains identifying content', async () => {
  const findings = await scanTemplatesForIdentifyingContent();
  assert.deepEqual(
    findings,
    [],
    `templates leak identifying content:\n${findings.map((f) => `  ${f.path}:${f.line} [${f.rule}] ${f.excerpt}`).join('\n')}`,
  );
});

test('the denylist actually fails on poisoned content (positive control)', () => {
  // A scanner that has only ever passed proves nothing. Each of these must be
  // caught, or the clean result above is meaningless.
  const poisoned = {
    'a.md': 'Ask Troy before deploying.',
    'b.md': 'Big Sister runs in the terminal and Clyde runs in the editor.',
    'c.md': 'The DairyForge and AimForge consoles share a parser.',
    'd.md': 'Deliver the Chobani route before Friday.',
    'e.md': 'Rules live in C:\\Users\\someone\\.claude\\CLAUDE.md',
    'f.md': 'Contact me at someone@example.com for access.',
    'g.md': 'Connect with postgres://user:pw@host.example.com:5432/db',
    'h.md': 'export OPENAI_API_KEY=sk-abcdefghijklmnop1234',
    'i.md': 'Point it at endpoint ep-dry-fog-aku9i5gq before migrating.',
    'j.md': 'Run speak.ps1 -Who bigsister to talk back.',
    'k.md': 'Log it to the neon database for the advisors.',
  };

  const findings = scanForIdentifyingContent(poisoned);
  const flagged = new Set(findings.map((finding) => finding.path));

  for (const path of Object.keys(poisoned)) {
    assert.ok(flagged.has(path), `${path} should have been flagged: ${poisoned[path]}`);
  }
});

test('the denylist does not flag ordinary generic prose', () => {
  const clean = {
    'ok.md': [
      'Cite the file and line for every claim you make.',
      'Run the test suite before you claim the fix works.',
      'Store advisory output in PostgreSQL or SQLite, configured by env var.',
      'A chain with one uncited arrow is the lie.',
      'Do not destroy what you did not create.',
    ].join('\n'),
  };
  assert.deepEqual(scanForIdentifyingContent(clean), []);
});

test('every denylist rule is a usable regex with a name', () => {
  assert.ok(IDENTIFYING_PATTERNS.length >= 10);
  for (const rule of IDENTIFYING_PATTERNS) {
    assert.equal(typeof rule.name, 'string');
    assert.ok(rule.pattern instanceof RegExp);
  }
});

test('every file the hook injects is a file the installer actually creates', async () => {
  // A writer with no reader — or a reader pointed at a path nothing writes — is
  // a dead arrow: the loop looks wired and silently carries nothing forward.
  const dir = await scratch();
  await installAgentOs({ target: 'claude', dir, apply: true });
  const hook = join(dir, 'agent-os', 'hooks', 'session-start-context.mjs');

  for (const path of ['BLOCKERS.md', 'LESSONS.md', 'LEARNINGS.md', 'memory/MEMORY.md', 'SESSION_BOARD.md']) {
    assert.ok(existsSync(join(dir, path)), `the hook reads ${path} but the installer never creates it`);
  }

  // Drive each one: content written to the file must come back out of the hook.
  await writeFile(join(dir, 'BLOCKERS.md'), '# BLOCKERS\n\n## Open\n\n## blocker-marker-one\n', 'utf8');
  await writeFile(join(dir, 'LESSONS.md'), '# LESSONS\n\n## Approved\n\n## lesson-marker-two\n', 'utf8');
  await writeFile(join(dir, 'LEARNINGS.md'), '# LEARNINGS\n\n## Approved\n\n- learning-marker-three\n', 'utf8');
  await writeFile(join(dir, 'memory', 'MEMORY.md'), '# MEMORY INDEX\n\n## Index\n\n- [Thing](thing.md) — memory-marker-four\n', 'utf8');
  await writeFile(
    join(dir, 'SESSION_BOARD.md'),
    '# SESSION BOARD\n\n| session | scope | files | started | status |\n|---|---|---|---|---|\n| board-marker-five | x | y | z | active |\n',
    'utf8',
  );

  const { stdout } = await run(process.execPath, [hook]);
  for (const marker of [
    'blocker-marker-one', 'lesson-marker-two', 'learning-marker-three',
    'memory-marker-four', 'board-marker-five',
  ]) {
    assert.match(stdout, new RegExp(marker), `${marker} never reached session context`);
  }

  await rm(dir, { recursive: true, force: true });
});

test('the template tree is non-trivial and all markdown or scripts', async () => {
  const files = await listTemplateFiles(DEFAULT_TEMPLATES_ROOT);
  assert.ok(files.length >= 12, `expected a real template tree, found ${files.length}`);
  for (const file of files) {
    assert.match(file, /\.(md|json|mjs)$/, `unexpected template file type: ${file}`);
  }
});

// ── Hook behavior, end to end ────────────────────────────────────────────────

test('the session-start hook is silent on a fresh install and speaks once there is state', async () => {
  const dir = await scratch();
  await installAgentOs({ target: 'claude', dir, apply: true });
  const hook = join(dir, 'agent-os', 'hooks', 'session-start-context.mjs');

  const fresh = await run(process.execPath, [hook]);
  assert.equal(
    fresh.stdout.trim(),
    '',
    'a fresh install has nothing to carry forward and must inject nothing',
  );

  await writeFile(
    join(dir, 'BLOCKERS.md'),
    '# BLOCKERS\n\n## Open\n\n## Staging rejects migration 004\n\n**Owner:** the user.\n',
    'utf8',
  );

  const loaded = await run(process.execPath, [hook]);
  assert.match(loaded.stdout, /Staging rejects migration 004/);
  assert.match(loaded.stdout, /UNVERIFIED/, 'carried-forward state must be marked unverified');
  assert.ok(
    !loaded.stdout.includes('YYYY-MM-DD'),
    'template guidance must be stripped, not injected as if it were real state',
  );

  await rm(dir, { recursive: true, force: true });
});

test('the session-start hook emits the JSON contract when asked', async () => {
  const dir = await scratch();
  await installAgentOs({ target: 'gemini', dir, apply: true });
  const hook = join(dir, 'agent-os', 'hooks', 'session-start-context.mjs');
  await writeFile(join(dir, 'BLOCKERS.md'), '# BLOCKERS\n\n## Open\n\n## Something is broken\n', 'utf8');

  const { stdout } = await run(process.execPath, [hook, '--format', 'json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /Something is broken/);

  await rm(dir, { recursive: true, force: true });
});

test('the turn-capture hook journals both event shapes and survives junk', async () => {
  const dir = await scratch();
  await installAgentOs({ target: 'claude', dir, apply: true });
  const hook = join(dir, 'agent-os', 'hooks', 'stop-capture.mjs');

  const feed = async (payload) => {
    const child = execFile(process.execPath, [hook]);
    child.stdin.end(payload);
    await new Promise((done) => child.on('close', done));
  };

  await feed(JSON.stringify({
    session_id: 's-1', hook_event_name: 'Stop', last_assistant_message: 'claude turn', tool_use_ids: ['a', 'b'],
  }));
  await feed(JSON.stringify({
    session_id: 'g-1', hook_event_name: 'AfterAgent', prompt_response: 'gemini turn',
  }));
  await feed('this is not json');

  const day = new Date().toISOString().slice(0, 10);
  const journal = join(dir, 'agent-os', 'journal', `${day}.jsonl`);
  const lines = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(lines.length, 3, 'every turn must be journaled, including the malformed one');
  assert.equal(lines[0].last_assistant_message, 'claude turn');
  assert.equal(lines[0].tool_use_count, 2);
  assert.equal(lines[1].last_assistant_message, 'gemini turn', 'Gemini prompt_response must be read');
  assert.equal(lines[2].last_assistant_message, null);
  for (const line of lines) assert.equal(line.review_state, 'uncaptured');

  await rm(dir, { recursive: true, force: true });
});

test('neither hook can block a session', async () => {
  const dir = await scratch();
  await installAgentOs({ target: 'claude', dir, apply: true });

  // Point them at a directory that does not exist: they must still exit 0 and
  // must not emit a blocking decision.
  const env = { ...process.env, AGENT_OS_ROOT: join(dir, 'does', 'not', 'exist') };

  const start = await run(process.execPath, [join(dir, 'agent-os', 'hooks', 'session-start-context.mjs')], { env });
  assert.equal(start.stdout.trim(), '');

  const child = execFile(process.execPath, [join(dir, 'agent-os', 'hooks', 'stop-capture.mjs')], { env });
  child.stdin.end('{}');
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(code, 0, 'a non-zero exit from a Stop hook would prevent the session from stopping');

  await rm(dir, { recursive: true, force: true });
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('the CLI emits machine-readable JSON for the desktop UI', async () => {
  const dir = await scratch();
  const { stdout } = await run(process.execPath, [
    join(repoRoot, 'bin', 'helmion.mjs'),
    'agent-os', 'install', '--target', 'claude', '--dir', dir, '--yes', '--json',
  ]);

  const report = JSON.parse(stdout);
  assert.equal(report.applied, true);
  assert.equal(report.targets.length, 1);
  assert.equal(report.targets[0].target, 'claude');
  assert.equal(report.targets[0].hooksWired, false);
  assert.ok(report.targets[0].files.every((file) => typeof file.action === 'string'));
  assert.ok(existsSync(join(dir, 'CLAUDE.md')));

  await rm(dir, { recursive: true, force: true });
});

test('the CLI rejects an unknown target', async () => {
  await assert.rejects(
    run(process.execPath, [join(repoRoot, 'bin', 'helmion.mjs'), 'agent-os', 'install', '--target', 'nope']),
    /Unknown target "nope"/,
  );
});

// ── Grok: the fourth target ──────────────────────────────────────────────────
//
// Troy named four LLMs. Until 2026-07-30 AGENT_OS_TARGETS held three, so a Grok
// session was the one that opened with no rules file at all — the installer did
// not merely skip it, `resolveTargets` THREW on the name.
//
// Every fact in the grok spec is cited, because a template that ships to
// strangers may not carry a guess:
//   directory   ~/.grok — xAI Grok Build stores config at ~/.grok/config.toml
//               and skills at ~/.grok/skills/, already documented in this repo
//               at desktop/Helmion.Desktop.Core/ProviderCapabilities.cs:104,118.
//   context     AGENTS.md — xai-org/grok-build's own subagent prompt template
//               says "Repos often contain project instruction files named
//               AGENTS.md, Agents.md, Claude.md, or AGENT.md". Grok Build has
//               NO file of its own name, so inventing GROK.md would have
//               produced a file nothing reads — the exact write-only defect
//               this work exists to remove.
//   hooks       ~/.grok/hooks/ holds individual JSON files with the same nested
//               {hooks:{Event:[{hooks:[{type,command}]}]}} shape as Claude
//               Code, and Stop + SessionStart are both supported events.
test('grok is a supported target and lands AGENTS.md in ~/.grok', async () => {
  assert.ok(AGENT_OS_TARGETS.includes('grok'), 'grok must be one of the targets');
  assert.deepEqual(resolveTargets('grok'), ['grok']);
  assert.deepEqual(resolveTargets(), [...AGENT_OS_TARGETS], 'the default must include grok');

  const spec = TARGET_SPECS.grok;
  assert.equal(spec.directoryName, '.grok');
  assert.equal(spec.contextFile, 'AGENTS.md');
  assert.equal(
    defaultTargetDirectory('grok', '/home/x'),
    join('/home/x', '.grok'),
    'grok installs beside the other three, under the home directory',
  );
});

test('a grok install writes the rules file and the companion set', async () => {
  const dir = await scratch();
  const report = await installAgentOs({ target: 'grok', dir, apply: true });

  assert.equal(report.target, 'grok');
  assert.equal(report.applied, true);
  assert.equal(report.hooksWired, false, 'this installer never edits a settings file');

  // The rules actually reached the file a Grok session reads.
  const context = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(context, /Cite or say nothing/);
  assert.match(context, /Source of truth/);
  assert.ok(context.includes(AGENT_OS_MARKER_BEGIN), 'must carry the reinstall marker');
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(context), 'no unresolved placeholder may ship');

  for (const companion of ['LESSONS.md', 'LEARNINGS.md', 'BLOCKERS.md', 'WINS.md']) {
    assert.ok(existsSync(join(dir, companion)), `grok is missing ${companion}`);
  }
  assert.ok(existsSync(join(dir, 'agent-os', 'hooks', 'session-start-context.mjs')));

  await rm(dir, { recursive: true, force: true });
});

test('the grok hook snippet uses grok own event names and is valid JSON', async () => {
  const dir = await scratch();
  await installAgentOs({ target: 'grok', dir, apply: true });

  const snippet = JSON.parse(await readFile(join(dir, 'agent-os', 'hooks.json'), 'utf8'));
  assert.ok(snippet.hooks.SessionStart, 'SessionStart is a documented Grok Build event');
  assert.ok(snippet.hooks.Stop, 'Stop is a documented Grok Build event');

  // The command must point at the hook this same install actually wrote, or the
  // snippet is instructions to run a file that is not there.
  const command = snippet.hooks.SessionStart[0].hooks[0].command;
  const hookPath = command.match(/"([^"]+)"/)[1];
  assert.ok(existsSync(hookPath), `snippet points at a missing hook: ${hookPath}`);

  await rm(dir, { recursive: true, force: true });
});

// ── Estate cargo ─────────────────────────────────────────────────────────────
//
// The starter kit above is distilled and anonymized. The estate is the
// opposite cargo: the user's own grown files — the Claude seat's CLAUDE.md
// and its flywheel companions — copied verbatim into every seat's managed
// folder and refreshed as the sources change. These tests pin the four
// promises: verbatim, everywhere, refreshed on change, and never at the
// cost of a seat's own files.

const ESTATE_SOURCES = Object.freeze({
  'CLAUDE.md': '# My own rules, hand-built\n\nRule one: check the disk before you speak.\nRule two: no claim without a file behind it.\n',
  'LESSONS.md': '# LESSONS\n\n## 2026-01-01 - the grown flywheel\n\nA hundred small lessons live here now.\n',
  'LEARNINGS.md': '# LEARNINGS\n\n- Learning one: the copy is the proof.\n',
});

async function estateHome() {
  const home = await scratch();
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  for (const [name, content] of Object.entries(ESTATE_SOURCES)) {
    await writeFile(join(claudeDir, name), content, 'utf8');
  }
  return home;
}

const withBlock = (own) => [
  own,
  '',
  AGENT_OS_MARKER_BEGIN,
  '@agent-os/AGENT_OS.md',
  AGENT_OS_MARKER_END,
  '',
].join('\n');

test('renderEstateFiles carries the sources verbatim, managed, under agent-os/estate', () => {
  const contents = {
    'agent-os/estate/CLAUDE-ESTATE.md': 'rules with trailing space \n\n\n',
    'agent-os/estate/LESSONS.md': 'lessons',
    // LEARNINGS.md absent from the snapshot: no file, never an empty one.
  };
  const files = renderEstateFiles(contents);

  assert.deepEqual(
    files.map((file) => file.path),
    ['agent-os/estate/CLAUDE-ESTATE.md', 'agent-os/estate/LESSONS.md'],
  );
  for (const file of files) {
    assert.equal(file.ownership, 'managed');
    assert.equal(file.cargo, 'estate');
    // Byte for byte: a render pass would have trimmed the trailing space
    // and blank lines, and then no hash could ever match the source.
    assert.equal(file.content, contents[file.path]);
  }
  assert.deepEqual(renderEstateFiles(), []);
  assert.deepEqual(renderEstateFiles({}), []);
});

test('loadEstateCargo reads the three sources and names the missing ones', async () => {
  const home = await estateHome();
  const { contents, missing } = await loadEstateCargo({ home });

  assert.deepEqual(missing, []);
  assert.equal(contents['agent-os/estate/CLAUDE-ESTATE.md'], ESTATE_SOURCES['CLAUDE.md']);
  assert.equal(contents['agent-os/estate/LESSONS.md'], ESTATE_SOURCES['LESSONS.md']);
  assert.equal(contents['agent-os/estate/LEARNINGS.md'], ESTATE_SOURCES['LEARNINGS.md']);

  const partial = await scratch();
  await mkdir(join(partial, '.claude'), { recursive: true });
  await writeFile(join(partial, '.claude', 'CLAUDE.md'), 'only this one', 'utf8');
  const second = await loadEstateCargo({ home: partial });
  assert.deepEqual(second.missing, ['LESSONS.md', 'LEARNINGS.md']);
  assert.deepEqual(Object.keys(second.contents), ['agent-os/estate/CLAUDE-ESTATE.md']);

  await rm(home, { recursive: true, force: true });
  await rm(partial, { recursive: true, force: true });
});

test('a source still identical to the shipped seed is the kit paper, not estate', async () => {
  // On a fresh machine the first sync writes the rendered context file and
  // the companion seeds into the Claude seat. A second sync must not
  // "discover" those as the user's estate and start copying them around.
  const home = await scratch();
  const templates = await loadAgentOsTemplates();
  const rendered = renderAgentOsFiles({ target: 'claude', templates, installDir: join(home, '.claude') });
  await mkdir(join(home, '.claude'), { recursive: true });
  for (const name of ['CLAUDE.md', 'LESSONS.md', 'LEARNINGS.md']) {
    await writeFile(join(home, '.claude', name), rendered.find((file) => file.path === name).content, 'utf8');
  }

  const { contents, missing, kitOwned } = await loadEstateCargo({ home, templates });
  assert.deepEqual(contents, {});
  assert.deepEqual(missing, []);
  assert.deepEqual(kitOwned.sort(), ['CLAUDE.md', 'LEARNINGS.md', 'LESSONS.md']);

  // And a full double install on a fresh home never grows an estate folder.
  const fresh = await scratch();
  await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home: fresh, apply: true });
  const second = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home: fresh, apply: true });
  for (const result of second.targets) {
    assert.equal(result.estate.carried, 0, `${result.target}: the kit must not feed back as estate`);
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate')), false);
  }

  await rm(home, { recursive: true, force: true });
  await rm(fresh, { recursive: true, force: true });
});

test('the estate lands in every seat, refreshes on change, and touches no seat file of its own', async () => {
  const home = await estateHome();

  // Every seat present. Two seats already carry the agent OS block in their
  // own context files, and codex has its own LESSONS.md: all of those are
  // the seats' own files and must come through byte-for-byte.
  const ownContext = {
    codex: withBlock('# Codex own rules'),
    grok: withBlock('# Grok own rules'),
  };
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.md'), ownContext.codex, 'utf8');
  const codexOwnLessons = '# Codex lessons of its own\n';
  await writeFile(join(home, '.codex', 'LESSONS.md'), codexOwnLessons, 'utf8');
  await mkdir(join(home, '.gemini'), { recursive: true });
  await mkdir(join(home, '.grok'), { recursive: true });
  await writeFile(join(home, '.grok', 'AGENTS.md'), ownContext.grok, 'utf8');

  // The source CLAUDE.md doubles as the claude seat's context file; give it
  // the block too, so the run leaves the source itself exactly as found.
  const sourceClaude = withBlock(ESTATE_SOURCES['CLAUDE.md']);
  await writeFile(join(home, '.claude', 'CLAUDE.md'), sourceClaude, 'utf8');

  const first = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });

  for (const result of first.targets) {
    assert.equal(result.estate.carried, ESTATE_CARGO.length, `${result.target} must carry the whole estate`);
    assert.deepEqual(result.estate.skipped, []);
    const dir = result.directory;
    assert.equal(
      await readFile(join(dir, 'agent-os', 'estate', 'CLAUDE-ESTATE.md'), 'utf8'),
      sourceClaude,
      `${result.target}: the estate copy must equal the source bytes`,
    );
    assert.equal(await readFile(join(dir, 'agent-os', 'estate', 'LESSONS.md'), 'utf8'), ESTATE_SOURCES['LESSONS.md']);
    assert.equal(await readFile(join(dir, 'agent-os', 'estate', 'LEARNINGS.md'), 'utf8'), ESTATE_SOURCES['LEARNINGS.md']);
  }

  // The seats' own files are byte-for-byte what they were.
  assert.equal(await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8'), ownContext.codex);
  assert.equal(await readFile(join(home, '.grok', 'AGENTS.md'), 'utf8'), ownContext.grok);
  assert.equal(await readFile(join(home, '.codex', 'LESSONS.md'), 'utf8'), codexOwnLessons);
  assert.equal(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'), sourceClaude, 'the source is read, never written');

  // Unchanged sources: the estate is a no-op.
  const second = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of second.targets) {
    const estateActions = result.files.filter((file) => file.cargo === 'estate');
    assert.equal(estateActions.length, ESTATE_CARGO.length);
    assert.ok(
      estateActions.every((file) => file.action === 'unchanged'),
      `${result.target}: unchanged sources must not refresh the estate`,
    );
  }

  // One source grows: exactly that copy refreshes, in every seat.
  const grown = `${ESTATE_SOURCES['LESSONS.md']}\n## 2026-01-02 - one more lesson\n`;
  await writeFile(join(home, '.claude', 'LESSONS.md'), grown, 'utf8');
  const third = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of third.targets) {
    const byPath = new Map(result.files.map((file) => [file.path, file.action]));
    assert.equal(byPath.get('agent-os/estate/LESSONS.md'), 'update', `${result.target}: the grown source must refresh`);
    assert.equal(byPath.get('agent-os/estate/CLAUDE-ESTATE.md'), 'unchanged');
    assert.equal(byPath.get('agent-os/estate/LEARNINGS.md'), 'unchanged');
    assert.equal(await readFile(join(result.directory, 'agent-os', 'estate', 'LESSONS.md'), 'utf8'), grown);
  }
  // And codex's own LESSONS.md still is not the estate's business.
  assert.equal(await readFile(join(home, '.codex', 'LESSONS.md'), 'utf8'), codexOwnLessons);

  await rm(home, { recursive: true, force: true });
});

test('a seat with no presence on the machine gets no estate, and the skip is recorded', async () => {
  const home = await estateHome();
  await mkdir(join(home, '.codex'), { recursive: true });
  // .gemini and .grok do not exist: those seats are not present here.

  const report = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  const byTarget = new Map(report.targets.map((result) => [result.target, result]));

  for (const absent of ['gemini', 'grok']) {
    const result = byTarget.get(absent);
    assert.equal(result.estate.carried, 0, `${absent}: no presence, no estate`);
    assert.deepEqual(
      result.estate.skipped.sort(),
      ESTATE_CARGO.map((entry) => entry.destination).sort(),
    );
    const estateActions = result.files.filter((file) => file.cargo === 'estate');
    assert.ok(estateActions.every((file) => file.action === 'skip' && /not present/.test(file.reason)));
    assert.equal(
      existsSync(join(home, TARGET_SPECS[absent].directoryName, 'agent-os', 'estate')),
      false,
      `${absent}: the skip must not write the estate folder either`,
    );
  }

  for (const present of ['claude', 'codex']) {
    assert.equal(byTarget.get(present).estate.carried, ESTATE_CARGO.length, `${present} is present and carries the estate`);
  }

  await rm(home, { recursive: true, force: true });
});

test('no estate sources means no estate cargo, and no error', async () => {
  const home = await scratch();
  await mkdir(join(home, '.claude'), { recursive: true });

  const report = await installAgentOsTargets({ targets: ['claude'], home, apply: true });
  const [result] = report.targets;
  assert.equal(result.estate.carried, 0);
  assert.deepEqual(result.estate.skipped, []);
  assert.equal(result.files.some((file) => file.cargo === 'estate'), false);
  assert.equal(existsSync(join(home, '.claude', 'agent-os', 'estate')), false);

  await rm(home, { recursive: true, force: true });
});

// ── Estate folder cargo (part B1) ────────────────────────────────────────────
//
// The same estate, one level down: the Claude seat's hand-built hook scripts
// (scripts/) and its topic lessons library (lessons/) ride along file by
// file. The fences are part of the cargo: root files only, an extension
// allowlist per folder, so backup copies, logs and nested tool trees stay
// home. Carriage only — nothing here wires or runs a carried script.

const ESTATE_FOLDER_CARRIED = Object.freeze({
  // [folder-relative source path, exact bytes]
  scripts: Object.freeze({
    'hook_block_destructive.ps1': '# the destructive-command block\r\nif ($cmd -match "rm -rf") { exit 2 }\n',
    'rules_drift_check.mjs': 'export const drift = "check";\n',
    'session_start_inject.sh': '#!/bin/sh\necho start\n',
  }),
  lessons: Object.freeze({
    'INDEX.md': '# Lessons index\n',
    'lessons-hooks.md': '# Hooks lessons\n\n- Name the line that broke.\n',
  }),
});

// Files that sit in the same folders but must NOT be carried: a backup copy,
// a log, a wrong-extension file, and a script one level down in a subfolder.
const ESTATE_FOLDER_LEFT_HOME = Object.freeze({
  scripts: Object.freeze({
    'hook_block_destructive.ps1.bak-2026-07-25': 'an old copy',
    'tts.log': 'a log line\n',
    'neon/db.mjs': 'a nested tool tree file\n',
  }),
  lessons: Object.freeze({
    'INDEX.md.20260728-175435.bak': 'an old copy',
    'notes.txt': 'not markdown\n',
  }),
});

const folderDestinations = () => Object.values(ESTATE_FOLDER_CARRIED)
  .flatMap((files, index) => {
    const folder = ESTATE_CARGO_FOLDERS[index];
    return Object.keys(files).map((name) => `${folder.destination}/${name}`);
  })
  .sort();

async function estateFolderHome() {
  const home = await estateHome();
  const claudeDir = join(home, '.claude');
  for (const [folder, files] of Object.entries(ESTATE_FOLDER_CARRIED)) {
    await mkdir(join(claudeDir, folder), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(claudeDir, folder, name), content, 'utf8');
    }
  }
  for (const [folder, files] of Object.entries(ESTATE_FOLDER_LEFT_HOME)) {
    for (const [name, content] of Object.entries(files)) {
      const full = join(claudeDir, folder, name);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
  }
  return home;
}

test('loadEstateCargo carries the estate folders by their fences, and names the missing ones', async () => {
  const home = await estateFolderHome();
  const { contents, missingFolders } = await loadEstateCargo({ home });

  assert.deepEqual(missingFolders, []);
  for (const [folder, files] of Object.entries(ESTATE_FOLDER_CARRIED)) {
    const spec = ESTATE_CARGO_FOLDERS.find((entry) => entry.source === folder);
    for (const [name, content] of Object.entries(files)) {
      assert.equal(
        contents[`${spec.destination}/${name}`],
        content,
        `${folder}/${name} must be carried byte for byte`,
      );
    }
  }
  const carriedFolderKeys = Object.keys(contents).filter((path) => path.includes('/scripts/') || path.includes('/lessons/'));
  assert.deepEqual(carriedFolderKeys.sort(), folderDestinations(), 'only the fenced files ride');
  for (const [folder, files] of Object.entries(ESTATE_FOLDER_LEFT_HOME)) {
    const spec = ESTATE_CARGO_FOLDERS.find((entry) => entry.source === folder);
    for (const name of Object.keys(files)) {
      assert.equal(contents[`${spec.destination}/${name}`], undefined, `${folder}/${name} stays home`);
    }
  }

  // Absent folders: named in missingFolders, no contents, no error.
  const bare = await estateHome();
  const bareResult = await loadEstateCargo({ home: bare });
  assert.deepEqual(bareResult.missingFolders, ['scripts', 'lessons']);
  assert.deepEqual(
    Object.keys(bareResult.contents).filter((path) => path.includes('/scripts/') || path.includes('/lessons/')),
    [],
  );

  // Present but empty folders: not missing, and they contribute nothing.
  const empty = await estateHome();
  await mkdir(join(empty, '.claude', 'scripts'), { recursive: true });
  await mkdir(join(empty, '.claude', 'lessons'), { recursive: true });
  const emptyResult = await loadEstateCargo({ home: empty });
  assert.deepEqual(emptyResult.missingFolders, []);
  assert.deepEqual(
    Object.keys(emptyResult.contents).filter((path) => path.includes('/scripts/') || path.includes('/lessons/')),
    [],
  );

  await rm(home, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

test('renderEstateFiles carries folder cargo sorted, verbatim, managed', () => {
  const contents = {
    'agent-os/estate/scripts/session_start_inject.sh': '#!/bin/sh\necho start\n',
    'agent-os/estate/lessons/INDEX.md': '# Lessons index\n',
    'agent-os/estate/scripts/hook_block_destructive.ps1': 'a script with trailing space \n\n',
    'agent-os/estate/CLAUDE-ESTATE.md': 'the fixed cargo still rides first\n',
    'agent-os/unrelated.txt': 'not estate cargo at all',
  };
  const files = renderEstateFiles(contents);

  assert.deepEqual(
    files.map((file) => file.path),
    [
      'agent-os/estate/CLAUDE-ESTATE.md',
      'agent-os/estate/scripts/hook_block_destructive.ps1',
      'agent-os/estate/scripts/session_start_inject.sh',
      'agent-os/estate/lessons/INDEX.md',
    ],
  );
  for (const file of files) {
    assert.equal(file.ownership, 'managed');
    assert.equal(file.cargo, 'estate');
    assert.equal(file.content, contents[file.path], 'verbatim: no trim, no render');
  }
});

test('the estate folders land in every seat, refresh on change only, and skip with the seat', async () => {
  const home = await estateFolderHome();
  const expectedCarried = ESTATE_CARGO.length + folderDestinations().length;

  // Three seats present; grok is not on this machine.
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.gemini'), { recursive: true });

  const first = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  const byTarget = new Map(first.targets.map((result) => [result.target, result]));

  for (const present of ['claude', 'codex', 'gemini']) {
    const result = byTarget.get(present);
    assert.equal(result.estate.carried, expectedCarried, `${present} must carry the fixed estate and both folders`);
    for (const [folder, files] of Object.entries(ESTATE_FOLDER_CARRIED)) {
      for (const [name, content] of Object.entries(files)) {
        assert.equal(
          await readFile(join(result.directory, 'agent-os', 'estate', folder, name), 'utf8'),
          content,
          `${present}: estate/${folder}/${name} must equal the source bytes`,
        );
      }
    }
    // Nothing that stayed home appears in a seat.
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'scripts', 'neon')), false);
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'scripts', 'tts.log')), false);
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'lessons', 'notes.txt')), false);
  }

  // The absent seat: every estate entry — fixed and folder — is a recorded
  // skip, and no estate folder is written for it.
  const grok = byTarget.get('grok');
  assert.equal(grok.estate.carried, 0);
  assert.deepEqual(
    grok.estate.skipped.sort(),
    [...ESTATE_CARGO.map((entry) => entry.destination), ...folderDestinations()].sort(),
  );
  assert.equal(existsSync(join(home, '.grok', 'agent-os', 'estate')), false);

  // Unchanged sources: every folder entry is a no-op in every present seat.
  const second = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of second.targets) {
    if (result.target === 'grok') continue;
    const folderActions = result.files.filter(
      (file) => file.cargo === 'estate' && folderDestinations().includes(file.path),
    );
    assert.equal(folderActions.length, folderDestinations().length);
    assert.ok(
      folderActions.every((file) => file.action === 'unchanged'),
      `${result.target}: unchanged folder sources must not refresh`,
    );
  }

  // One script grows: exactly that copy refreshes, in every present seat.
  const grown = `${ESTATE_FOLDER_CARRIED.scripts['rules_drift_check.mjs']}// one more check\n`;
  await writeFile(join(home, '.claude', 'scripts', 'rules_drift_check.mjs'), grown, 'utf8');
  const third = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of third.targets) {
    if (result.target === 'grok') continue;
    const byPath = new Map(result.files.map((file) => [file.path, file.action]));
    assert.equal(byPath.get('agent-os/estate/scripts/rules_drift_check.mjs'), 'update', `${result.target}: the grown script must refresh`);
    assert.equal(byPath.get('agent-os/estate/scripts/hook_block_destructive.ps1'), 'unchanged');
    assert.equal(byPath.get('agent-os/estate/lessons/INDEX.md'), 'unchanged');
    assert.equal(
      await readFile(join(result.directory, 'agent-os', 'estate', 'scripts', 'rules_drift_check.mjs'), 'utf8'),
      grown,
    );
  }

  // The sources were read, never written: the files left home are untouched.
  assert.equal(
    await readFile(join(home, '.claude', 'scripts', 'hook_block_destructive.ps1.bak-2026-07-25'), 'utf8'),
    'an old copy',
  );

  await rm(home, { recursive: true, force: true });
});

// ── Estate tree cargo (part B2) ─────────────────────────────────────────────
//
// The skills library rides as a tree: each skill is a folder whose shape is
// part of the skill, so the walk is recursive and the fences are exclusions
// (secret-bearing names, dependency and cache directories, logs, backups,
// binaries, an oversized file) rather than the folder cargo's allowlist.
// Carriage only — nothing here installs a skill into a seat's native
// skills home or runs anything it carries.

const ESTATE_TREE_CARRIED = Object.freeze({
  // [tree-relative source path, exact bytes]
  'cite-or-shut-up/SKILL.md': '# Cite or shut up\n\n- Name the file behind the claim.\n',
  'cite-or-shut-up/references/sources.md': '# Sources\n\nWhere claims come from.\n',
  'llm-council/council.py': 'print("council is in session")\n',
  'llm-council/notes.txt': 'council notes\n',
});

// Files that sit in the same tree but must NOT be carried: a real .env and
// its template, a name carrying "key", a backup copy, a log, a binary, the
// dependency and cache directories, and one file over the size cap.
const ESTATE_TREE_LEFT_HOME = Object.freeze({
  'llm-council/.env': 'COUNCIL_KEY=not-the-estate\n',
  'llm-council/.env.template': 'COUNCIL_KEY=\n',
  'llm-council/api-key-notes.md': 'where the keys live\n',
  'cite-or-shut-up/SKILL.md.20260728-212459.bak': 'an old copy',
  'cite-or-shut-up/debug.log': 'a log line\n',
  'cite-or-shut-up/diagram.png': 'not really a png, fenced by name\n',
  'llm-council/node_modules/pkg/index.js': 'a dependency file\n',
  'llm-council/__pycache__/council.cpython-312.pyc': 'bytecode\n',
  'llm-council/big-transcript.md': 'x'.repeat(ESTATE_TREE_FILE_MAX_BYTES + 1),
});

const treeSpec = () => ESTATE_CARGO_TREES[0];

const treeDestinations = () => Object.keys(ESTATE_TREE_CARRIED)
  .map((rel) => `${treeSpec().destination}/${rel}`)
  .sort();

async function estateTreeHome() {
  const home = await estateHome();
  const skillsDir = join(home, '.claude', treeSpec().source);
  for (const files of [ESTATE_TREE_CARRIED, ESTATE_TREE_LEFT_HOME]) {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(skillsDir, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
  }
  return home;
}

test('loadEstateCargo carries the skills tree by its fences, and names the missing tree', async () => {
  const home = await estateTreeHome();
  const { contents, missingTrees } = await loadEstateCargo({ home });

  assert.deepEqual(missingTrees, []);
  for (const [rel, content] of Object.entries(ESTATE_TREE_CARRIED)) {
    assert.equal(
      contents[`${treeSpec().destination}/${rel}`],
      content,
      `skills/${rel} must be carried byte for byte, its folder shape intact`,
    );
  }
  const carriedTreeKeys = Object.keys(contents)
    .filter((path) => path.startsWith(`${treeSpec().destination}/`));
  assert.deepEqual(carriedTreeKeys.sort(), treeDestinations(), 'only the fenced files ride');
  for (const rel of Object.keys(ESTATE_TREE_LEFT_HOME)) {
    assert.equal(
      contents[`${treeSpec().destination}/${rel}`],
      undefined,
      `skills/${rel} stays home`,
    );
  }

  // Absent tree: named in missingTrees, no contents, no error.
  const bare = await estateHome();
  const bareResult = await loadEstateCargo({ home: bare });
  assert.deepEqual(bareResult.missingTrees, [treeSpec().source]);
  assert.deepEqual(
    Object.keys(bareResult.contents).filter((path) => path.startsWith(`${treeSpec().destination}/`)),
    [],
  );

  // Present but empty tree: not missing, and it contributes nothing.
  const empty = await estateHome();
  await mkdir(join(empty, '.claude', treeSpec().source), { recursive: true });
  const emptyResult = await loadEstateCargo({ home: empty });
  assert.deepEqual(emptyResult.missingTrees, []);
  assert.deepEqual(
    Object.keys(emptyResult.contents).filter((path) => path.startsWith(`${treeSpec().destination}/`)),
    [],
  );

  await rm(home, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

test('renderEstateFiles carries tree cargo sorted, verbatim, managed', () => {
  const contents = {
    'agent-os/estate/skills/llm-council/council.py': 'print("council")\n',
    'agent-os/estate/skills/cite-or-shut-up/SKILL.md': '# Cite or shut up\n',
    'agent-os/estate/skills/cite-or-shut-up/references/sources.md': '# Sources \n\n',
    'agent-os/estate/scripts/rules_drift_check.mjs': 'export const drift = "check";\n',
    'agent-os/estate/CLAUDE-ESTATE.md': 'the fixed cargo still rides first\n',
    'agent-os/unrelated.txt': 'not estate cargo at all',
  };
  const files = renderEstateFiles(contents);

  assert.deepEqual(
    files.map((file) => file.path),
    [
      'agent-os/estate/CLAUDE-ESTATE.md',
      'agent-os/estate/scripts/rules_drift_check.mjs',
      'agent-os/estate/skills/cite-or-shut-up/SKILL.md',
      'agent-os/estate/skills/cite-or-shut-up/references/sources.md',
      'agent-os/estate/skills/llm-council/council.py',
    ],
  );
  for (const file of files) {
    assert.equal(file.ownership, 'managed');
    assert.equal(file.cargo, 'estate');
    assert.equal(file.content, contents[file.path], 'verbatim: no trim, no render');
  }
});

test('the skills tree lands in every seat, refreshes on change only, and skips with the seat', async () => {
  const home = await estateTreeHome();
  const expectedCarried = ESTATE_CARGO.length + treeDestinations().length;

  // Three seats present; grok is not on this machine.
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.gemini'), { recursive: true });

  const first = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  const byTarget = new Map(first.targets.map((result) => [result.target, result]));

  for (const present of ['claude', 'codex', 'gemini']) {
    const result = byTarget.get(present);
    assert.equal(result.estate.carried, expectedCarried, `${present} must carry the fixed estate and the whole tree`);
    for (const [rel, content] of Object.entries(ESTATE_TREE_CARRIED)) {
      assert.equal(
        await readFile(join(result.directory, 'agent-os', 'estate', 'skills', rel), 'utf8'),
        content,
        `${present}: estate/skills/${rel} must equal the source bytes`,
      );
    }
    // Nothing that stayed home appears in a seat — and the copy never
    // lands in the seat's NATIVE skills home, only in the managed folder.
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'skills', 'llm-council', '.env')), false);
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'skills', 'llm-council', 'node_modules')), false);
    assert.equal(existsSync(join(result.directory, 'agent-os', 'estate', 'skills', 'llm-council', 'big-transcript.md')), false);
    if (result.target !== 'claude') {
      assert.equal(
        existsSync(join(result.directory, 'skills')),
        false,
        `${result.target}: no native skills home is written`,
      );
    }
  }
  // The source seat's native skills home is the source itself: untouched,
  // and the estate copy sits beside it under agent-os/, not inside it.
  assert.equal(existsSync(join(home, '.claude', 'skills', 'agent-os')), false);

  // The absent seat: every estate entry — fixed and tree — is a recorded
  // skip, and no estate folder is written for it.
  const grok = byTarget.get('grok');
  assert.equal(grok.estate.carried, 0);
  assert.deepEqual(
    grok.estate.skipped.sort(),
    [...ESTATE_CARGO.map((entry) => entry.destination), ...treeDestinations()].sort(),
  );
  assert.equal(existsSync(join(home, '.grok', 'agent-os', 'estate')), false);

  // Unchanged sources: every tree entry is a no-op in every present seat.
  const second = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of second.targets) {
    if (result.target === 'grok') continue;
    const treeActions = result.files.filter(
      (file) => file.cargo === 'estate' && treeDestinations().includes(file.path),
    );
    assert.equal(treeActions.length, treeDestinations().length);
    assert.ok(
      treeActions.every((file) => file.action === 'unchanged'),
      `${result.target}: unchanged tree sources must not refresh`,
    );
  }

  // One nested file grows: exactly that copy refreshes, in every present seat.
  const grown = `${ESTATE_TREE_CARRIED['cite-or-shut-up/references/sources.md']}\nOne more source.\n`;
  await writeFile(join(home, '.claude', 'skills', 'cite-or-shut-up', 'references', 'sources.md'), grown, 'utf8');
  const third = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], home, apply: true });
  for (const result of third.targets) {
    if (result.target === 'grok') continue;
    const byPath = new Map(result.files.map((file) => [file.path, file.action]));
    assert.equal(byPath.get('agent-os/estate/skills/cite-or-shut-up/references/sources.md'), 'update', `${result.target}: the grown file must refresh`);
    assert.equal(byPath.get('agent-os/estate/skills/cite-or-shut-up/SKILL.md'), 'unchanged');
    assert.equal(byPath.get('agent-os/estate/skills/llm-council/council.py'), 'unchanged');
    assert.equal(
      await readFile(join(result.directory, 'agent-os', 'estate', 'skills', 'cite-or-shut-up', 'references', 'sources.md'), 'utf8'),
      grown,
    );
  }

  // The sources were read, never written: the files left home are untouched.
  assert.equal(
    await readFile(join(home, '.claude', 'skills', 'llm-council', '.env'), 'utf8'),
    ESTATE_TREE_LEFT_HOME['llm-council/.env'],
  );

  await rm(home, { recursive: true, force: true });
});

test('installing all four targets into one directory keeps grok separate from codex', async () => {
  // grok and codex BOTH use AGENTS.md. Without per-target subdirectories the
  // second install would overwrite the first one's rules file.
  const dir = await scratch();
  const report = await installAgentOsTargets({ targets: [...AGENT_OS_TARGETS], dir, apply: true });

  assert.equal(report.targets.length, 4);
  assert.ok(existsSync(join(dir, '.grok', 'AGENTS.md')), 'grok rules file');
  assert.ok(existsSync(join(dir, '.codex', 'AGENTS.md')), 'codex rules file');

  const grokRules = await readFile(join(dir, '.grok', 'AGENTS.md'), 'utf8');
  const codexRules = await readFile(join(dir, '.codex', 'AGENTS.md'), 'utf8');
  assert.notEqual(grokRules, codexRules, 'each target must get its own rendered file');

  await rm(dir, { recursive: true, force: true });
});

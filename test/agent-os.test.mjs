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
  AGENT_OS_TARGETS,
  DEFAULT_TEMPLATES_ROOT,
  IDENTIFYING_PATTERNS,
  TARGET_SPECS,
  defaultTargetDirectory,
  installAgentOs,
  installAgentOsTargets,
  listTemplateFiles,
  loadAgentOsTemplates,
  render,
  renderAgentOsFiles,
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

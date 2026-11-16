import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_OS_TARGETS,
  PROFILE_SYNC_STAMP_PROVIDERS,
  TARGET_PRESENCE_PROVIDERS,
  TARGET_SPECS,
  TOML_HOOK_SECTION_BEGIN,
  TOML_HOOK_SECTION_END,
  defaultTargetDirectory,
  installAgentOs,
  loadAgentOsTemplates,
  mergeTomlHookSection,
  renderAgentOsFiles,
  resolveTargets,
} from '../src/core/agent-os.mjs';
import {
  buildExpectedKitHashes,
  verifyProfileSyncFiles,
} from '../src/cloud/profile-sync.mjs';
import { createHash } from 'node:crypto';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'agent-os-platforms-'));
}

// The canary strings live in the ONE governance source (core/CORE_RULES.md).
// Every platform's rendered rules file must carry them — that is what
// "one source rendered per platform, no hand-diverged copies" means, and
// it is checked here for all six targets, old and new alike.
const CANARY_RULES = ['Honesty outranks everything', 'Cite or say nothing', 'Source of truth'];

// ── One source, every seatable file-based platform ─────────────────────────

test('every target renders the same governance source into its own rules file', async () => {
  const templates = await loadAgentOsTemplates();
  assert.deepEqual(
    [...AGENT_OS_TARGETS].sort(),
    ['claude', 'codex', 'gemini', 'grok', 'mistral', 'qwen'],
    'the write set is the six seatable platforms with a file surface',
  );
  for (const target of AGENT_OS_TARGETS) {
    const files = renderAgentOsFiles({ target, templates, installDir: '/tmp/x' });
    const context = files.find((file) => file.path === TARGET_SPECS[target].contextFile);
    assert.ok(context, `${target}: renders ${TARGET_SPECS[target].contextFile}`);
    for (const canary of CANARY_RULES) {
      assert.ok(context.content.includes(canary), `${target}: rules file carries "${canary}"`);
    }
  }
});

test('the new targets resolve and land in their documented home directories', () => {
  assert.deepEqual(resolveTargets('qwen'), ['qwen']);
  assert.deepEqual(resolveTargets('qwen,mistral'), ['qwen', 'mistral']);
  assert.equal(defaultTargetDirectory('qwen', '/home/example'), join('/home/example', '.qwen'));
  assert.equal(defaultTargetDirectory('mistral', '/home/example'), join('/home/example', '.vibe'));
});

// ── Qwen Code: Claude-shaped hooks in settings.json ────────────────────────

test('qwen renders QWEN.md and a Claude-shaped hook snippet', async () => {
  const templates = await loadAgentOsTemplates();
  const files = renderAgentOsFiles({ target: 'qwen', templates, installDir: '/home/x/.qwen' });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('QWEN.md'));
  assert.ok(paths.includes('settings.json'));
  assert.ok(paths.includes('agent-os/settings.hooks.json'));

  const snippet = JSON.parse(files.find((file) => file.path === 'agent-os/settings.hooks.json').content);
  assert.ok(
    snippet.hooks.SessionStart[0].hooks[0].command.includes('session-start-context.mjs'),
    'SessionStart wires the context hook',
  );
  assert.ok(
    snippet.hooks.Stop[0].hooks[0].command.includes('stop-capture.mjs'),
    'Stop wires the capture hook',
  );

  // Import mode: an existing QWEN.md gets the estate pointer block, the
  // form Qwen's @path imports consume.
  const context = files.find((file) => file.path === 'QWEN.md');
  assert.ok(context.content.includes('@agent-os/estate/CLAUDE-ESTATE.md'));
});

test('qwen install wires the hooks into settings.json and preserves user settings', async () => {
  const home = await scratch();
  const dir = join(home, '.qwen');
  await mkdir(dir, { recursive: true });
  const userSettings = {
    model: { name: 'qwen3-coder' },
    permissions: { allow: ['Read'] },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'echo user-hook' }] },
      ],
    },
  };
  await writeFile(join(dir, 'settings.json'), `${JSON.stringify(userSettings, null, 2)}\n`, 'utf8');

  const first = await installAgentOs({ target: 'qwen', home, apply: true });
  assert.equal(first.hooksWired, true);
  const merged = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(merged.model, userSettings.model, 'user keys survive the merge');
  assert.deepEqual(merged.permissions, userSettings.permissions, 'user permissions survive the merge');
  const commands = merged.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(commands.includes('echo user-hook'), 'the user hook survives the merge');
  assert.ok(commands.some((command) => command.includes('session-start-context.mjs')), 'the governance hook is wired');
  const stopCommands = merged.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.some((command) => command.includes('stop-capture.mjs')), 'the capture hook is wired');

  const afterFirst = await readFile(join(dir, 'settings.json'), 'utf8');
  const second = await installAgentOs({ target: 'qwen', home, apply: true });
  const settingsAction = second.files.find((file) => file.path === 'settings.json');
  assert.equal(settingsAction.action, 'unchanged', 'a second sync changes nothing');
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), afterFirst, 'bytes are stable across syncs');

  await rm(home, { recursive: true, force: true });
});

test('qwen install refuses an unparseable settings.json untouched', async () => {
  const home = await scratch();
  const dir = join(home, '.qwen');
  await mkdir(dir, { recursive: true });
  const broken = '{ not json ';
  await writeFile(join(dir, 'settings.json'), broken, 'utf8');

  const report = await installAgentOs({ target: 'qwen', home, apply: true });
  assert.equal(report.hooksWired, false, 'hooks report as not wired');
  const settingsAction = report.files.find((file) => file.path === 'settings.json');
  assert.equal(settingsAction.action, 'skip');
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), broken, 'the file is byte-identical');
  // The snippet still lands beside it, with the manual merge sheet.
  assert.ok(report.files.some((file) => file.path === 'agent-os/settings.hooks.json'));

  await rm(home, { recursive: true, force: true });
});

// ── Mistral Vibe: rules as AGENTS.md, hooks as a TOML section ──────────────

test('mistral renders AGENTS.md and the delimited hooks.toml section', async () => {
  const templates = await loadAgentOsTemplates();
  const files = renderAgentOsFiles({ target: 'mistral', templates, installDir: '/home/x/.vibe' });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('hooks.toml'));
  assert.ok(paths.includes('agent-os/hooks.toml'));

  const section = files.find((file) => file.path === 'hooks.toml').content;
  assert.ok(section.includes(TOML_HOOK_SECTION_BEGIN));
  assert.ok(section.includes(TOML_HOOK_SECTION_END));
  assert.ok(section.includes('type = "session_start"'), 'session_start is the context hook type');
  assert.ok(section.includes('session-start-context.mjs'));
  assert.ok(section.includes('type = "post_agent"'), 'post_agent is the turn-end hook type');
  assert.ok(section.includes('stop-capture.mjs'));

  // The merge sheet for a TOML target explains the section, not a JSON key.
  const sheet = files.find((file) => file.path === 'agent-os/MERGE_HOOKS.md');
  assert.ok(sheet.content.includes('[[hooks]]'), 'the merge sheet speaks TOML');
  assert.ok(sheet.content.includes('post_agent'), 'the merge sheet names the turn-end type');
});

test('mergeTomlHookSection appends after user content and refreshes only its own section', async () => {
  const templates = await loadAgentOsTemplates();
  const files = renderAgentOsFiles({ target: 'mistral', templates, installDir: '/home/x/.vibe' });
  const section = files.find((file) => file.path === 'hooks.toml').content;

  const userHooks = '[[hooks]]\nname = "mine"\ntype = "pre_tool"\ncommand = "echo mine"\n';
  const appended = mergeTomlHookSection(userHooks, section);
  assert.equal(appended.ok, true);
  assert.equal(appended.changed, true);
  assert.ok(appended.content.startsWith(userHooks), 'user content survives byte-for-byte as a prefix');
  assert.ok(appended.content.includes('name = "mine"'), 'the user hook is still there');
  assert.ok(appended.content.includes('agent-os-session-start'), 'the governance section landed');

  const again = mergeTomlHookSection(appended.content, section);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'an already-current section is not rewritten');
  assert.equal(again.content, appended.content);

  // A stale section is refreshed in place; content after it is preserved.
  const stale = appended.content.replace('timeout = 10', 'timeout = 99');
  const withTail = `${stale}\n[[hooks]]\nname = "after"\ntype = "post_tool"\ncommand = "echo after"\n`;
  const refreshed = mergeTomlHookSection(withTail, section);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.changed, true);
  assert.ok(refreshed.content.includes('timeout = 10'), 'the section is refreshed to the shipped form');
  assert.ok(!refreshed.content.includes('timeout = 99'));
  assert.ok(refreshed.content.includes('name = "after"'), 'content after the section survives');
  assert.ok(refreshed.content.startsWith(userHooks), 'content before the section survives');

  // Broken marker shapes are refused, never guessed at.
  const lone = `${TOML_HOOK_SECTION_BEGIN}\n[[hooks]]\nname = "x"\n`;
  const refused = mergeTomlHookSection(lone, section);
  assert.equal(refused.ok, false);
  const doubled = `${section}\n${section}`;
  assert.equal(mergeTomlHookSection(doubled, section).ok, false, 'two sections are refused');
  assert.equal(mergeTomlHookSection(userHooks, 'no markers here').ok, false, 'a snippet with no section is refused');
});

test('mistral install lands the section, stays idempotent, and refuses broken markers', async () => {
  const home = await scratch();
  const dir = join(home, '.vibe');
  await mkdir(dir, { recursive: true });
  const userHooks = '[[hooks]]\nname = "mine"\ntype = "pre_tool"\ncommand = "echo mine"\n';
  await writeFile(join(dir, 'hooks.toml'), userHooks, 'utf8');

  const first = await installAgentOs({ target: 'mistral', home, apply: true });
  assert.equal(first.hooksWired, true);
  const afterFirst = await readFile(join(dir, 'hooks.toml'), 'utf8');
  assert.ok(afterFirst.startsWith(userHooks), 'the user hook file survives as a prefix');
  assert.ok(afterFirst.includes('agent-os-turn-capture'));
  assert.ok(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'the rules file landed');
  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  for (const canary of CANARY_RULES) assert.ok(agents.includes(canary), `AGENTS.md carries "${canary}"`);

  const second = await installAgentOs({ target: 'mistral', home, apply: true });
  const settingsAction = second.files.find((file) => file.path === 'hooks.toml');
  assert.equal(settingsAction.action, 'unchanged', 'a second sync changes nothing');
  assert.equal(await readFile(join(dir, 'hooks.toml'), 'utf8'), afterFirst, 'bytes are stable across syncs');
  assert.equal(afterFirst.split(TOML_HOOK_SECTION_BEGIN).length - 1, 1, 'exactly one section');

  // Broken markers: the file is left byte-identical and hooks report unwired.
  const broken = `${TOML_HOOK_SECTION_BEGIN}\n[[hooks]]\nname = "stranded"\n`;
  await writeFile(join(dir, 'hooks.toml'), broken, 'utf8');
  const third = await installAgentOs({ target: 'mistral', home, apply: true });
  assert.equal(third.hooksWired, false);
  assert.equal(third.files.find((file) => file.path === 'hooks.toml').action, 'skip');
  assert.equal(await readFile(join(dir, 'hooks.toml'), 'utf8'), broken, 'the broken file is byte-identical');

  await rm(home, { recursive: true, force: true });
});

// ── The stamp law and the expected kit follow the write set ────────────────

test('the stamp set is exactly the six-write set; no-file-surface seats are never stamped', () => {
  assert.deepEqual(
    PROFILE_SYNC_STAMP_PROVIDERS,
    AGENT_OS_TARGETS.map((target) => TARGET_PRESENCE_PROVIDERS[target]),
    'the stamps derive from the installer targets, so they cannot drift',
  );
  assert.deepEqual(
    [...PROFILE_SYNC_STAMP_PROVIDERS].sort(),
    ['claude', 'gemini', 'grok', 'mistral', 'openai', 'qwen'],
  );
  for (const notSeated of ['openrouter', 'cloudflare', 'nvidia', 'groq', 'runway', 'ollama']) {
    assert.ok(!PROFILE_SYNC_STAMP_PROVIDERS.includes(notSeated), `${notSeated} is never stamped`);
  }
});

test('the expected kit covers qwen and mistral with exactly the predictable files', async () => {
  const templates = await loadAgentOsTemplates();
  const expected = buildExpectedKitHashes(templates);
  const predictable = [
    'LESSONS.md', 'LEARNINGS.md', 'BLOCKERS.md', 'WINS.md', 'SESSION_BOARD.md',
    'memory/MEMORY.md', 'agent-os/AGENT_OS.md',
    'agent-os/hooks/session-start-context.mjs', 'agent-os/hooks/stop-capture.mjs',
  ];
  for (const target of ['qwen', 'mistral']) {
    const table = expected[target];
    assert.ok(table, `${target}: an expected table exists`);
    assert.deepEqual(Object.keys(table).sort(), [...predictable].sort(), `${target}: exactly the 9 predictable files`);
  }
  // The path-embedding files are never expected, per target.
  assert.equal(expected.qwen['QWEN.md'], undefined, 'qwen: the context file is never expected');
  assert.equal(expected.qwen['agent-os/settings.hooks.json'], undefined, 'qwen: the snippet embeds the install path');
  assert.equal(expected.qwen['settings.json'], undefined, 'qwen: the settings file embeds the install path');
  assert.equal(expected.mistral['AGENTS.md'], undefined, 'mistral: the context file is never expected');
  assert.equal(expected.mistral['agent-os/hooks.toml'], undefined, 'mistral: the snippet embeds the install path');
  assert.equal(expected.mistral['hooks.toml'], undefined, 'mistral: the hooks file embeds the install path');
  assert.equal(expected.mistral['agent-os/MERGE_HOOKS.md'], undefined, 'mistral: the merge sheet embeds the install path');

  // And a device report for a new target verifies against the set.
  const kitHash = expected.mistral['agent-os/AGENT_OS.md'];
  const rendered = renderAgentOsFiles({ target: 'mistral', templates, installDir: '/anywhere' });
  const index = rendered.find((file) => file.path === 'agent-os/AGENT_OS.md');
  assert.equal(kitHash, createHash('sha256').update(index.content, 'utf8').digest('hex'));
  const files = [
    { path: '/home/x/.vibe/agent-os/AGENT_OS.md', target: 'mistral', action: 'created', sha256: kitHash },
    { path: '/home/x/.vibe/agent-os/AGENT_OS.md', target: 'mistral', action: 'created', sha256: '0'.repeat(64) },
    { path: '/home/x/.qwen/agent-os/AGENT_OS.md', target: 'qwen', action: 'created', sha256: expected.qwen['agent-os/AGENT_OS.md'] },
  ];
  assert.deepEqual(verifyProfileSyncFiles(files, expected), ['verified', 'mismatch', 'verified']);
});

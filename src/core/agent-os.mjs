// Agent OS — a one-button, anonymized install of the self-improvement loop.
//
// The loop is a small set of files plus two hooks: a lean core-rules file, the
// companion logs it accumulates (lessons, learnings, blockers, wins, session
// board, memory index), and hook wiring that injects that state at session
// start and captures each turn at the end.
//
// Two boundaries this module never crosses:
//
//   1. It does not overwrite user content. Files outside `agent-os/` are
//      created once and thereafter skipped. A context file that already exists
//      gets a delimited block appended, never a rewrite.
//   2. It does not edit a settings file. Hook configuration is written as a
//      snippet next to the settings file with merge instructions, because
//      settings files carry keys this installer knows nothing about.
//
// Everything here is pure except `installAgentOs`, which is the only function
// that touches the filesystem.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TEMPLATES_ROOT = resolve(here, '..', '..', 'templates', 'agent-os');

export const AGENT_OS_MARKER_BEGIN = '<!-- BEGIN AGENT OS -->';
export const AGENT_OS_MARKER_END = '<!-- END AGENT OS -->';

/** Directory the installer owns outright and may rewrite on reinstall. */
export const MANAGED_DIR = 'agent-os';

export const AGENT_OS_TARGETS = Object.freeze(['claude', 'codex', 'gemini']);

// Per-tool facts, each from that tool's own documentation:
//
//   claude  ~/.claude/CLAUDE.md is the user-scope memory file; Claude Code
//           reads CLAUDE.md, not AGENTS.md. Imports use @path, resolved
//           relative to the importing file. Hooks live in settings.json under
//           "hooks"; turn end is "Stop"; timeout is in SECONDS.
//           https://code.claude.com/docs/en/memory
//           https://code.claude.com/docs/en/hooks
//
//   codex   AGENTS.md is the convention, with ~/.codex/AGENTS.md as the global
//           scope; files are concatenated root-down with no import syntax, so
//           an existing file gets the rules inline. Hooks live in
//           ~/.codex/hooks.json under "hooks"; turn end is "Stop".
//           https://learn.chatgpt.com/docs/agent-configuration/agents-md
//           https://learn.chatgpt.com/docs/hooks
//
//   gemini  ~/.gemini/GEMINI.md is the global context file, with @file.md
//           imports. Hooks live in settings.json under "hooks"; turn end is
//           "AfterAgent"; timeout is in MILLISECONDS.
//           https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md
//           https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
export const TARGET_SPECS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    directoryName: '.claude',
    contextFile: 'CLAUDE.md',
    settingsFile: 'settings.json',
    snippetFile: 'settings.hooks.json',
    contextTemplate: 'targets/claude/CLAUDE.md',
    snippetTemplate: 'targets/claude/settings.hooks.json',
    turnEndEvent: 'Stop',
    appendMode: 'import',
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex / ChatGPT',
    directoryName: '.codex',
    contextFile: 'AGENTS.md',
    settingsFile: 'hooks.json',
    snippetFile: 'hooks.json',
    contextTemplate: 'targets/codex/AGENTS.md',
    snippetTemplate: 'targets/codex/hooks.json',
    turnEndEvent: 'Stop',
    appendMode: 'inline',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    directoryName: '.gemini',
    contextFile: 'GEMINI.md',
    settingsFile: 'settings.json',
    snippetFile: 'settings.hooks.json',
    contextTemplate: 'targets/gemini/GEMINI.md',
    snippetTemplate: 'targets/gemini/settings.hooks.json',
    turnEndEvent: 'AfterAgent',
    appendMode: 'import',
  }),
});

/** Companion logs. User-owned: created once, never rewritten. */
const COMPANIONS = Object.freeze([
  ['companions/LESSONS.md', 'LESSONS.md'],
  ['companions/LEARNINGS.md', 'LEARNINGS.md'],
  ['companions/BLOCKERS.md', 'BLOCKERS.md'],
  ['companions/WINS.md', 'WINS.md'],
  ['companions/SESSION_BOARD.md', 'SESSION_BOARD.md'],
  ['companions/MEMORY.md', 'memory/MEMORY.md'],
]);

const PARTIALS = Object.freeze({
  CORE_RULES: 'core/CORE_RULES.md',
  LOOP: 'core/LOOP.md',
  LOOP_SUMMARY: 'core/LOOP_SUMMARY.md',
  ADVISORY: 'core/ADVISORY.md',
});

const HOOK_TEMPLATES = Object.freeze([
  'hooks/session-start-context.mjs',
  'hooks/stop-capture.mjs',
]);

export function resolveTargets(requested) {
  if (!requested || requested === 'all') return [...AGENT_OS_TARGETS];
  const names = String(requested)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) throw new Error('--target requires at least one value');
  for (const name of names) {
    if (!AGENT_OS_TARGETS.includes(name)) {
      throw new Error(
        `Unknown target "${name}". Valid targets: ${AGENT_OS_TARGETS.join(', ')}, all`,
      );
    }
  }
  return [...new Set(names)];
}

export function defaultTargetDirectory(target, home = homedir()) {
  const spec = TARGET_SPECS[target];
  if (!spec) throw new Error(`Unknown target "${target}"`);
  return join(home, spec.directoryName);
}

/** Recursively list every template file, relative to the templates root. */
export async function listTemplateFiles(templatesRoot = DEFAULT_TEMPLATES_ROOT) {
  const found = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative(templatesRoot, full).split(sep).join('/'));
    }
  }
  await walk(templatesRoot);
  return found.sort();
}

/** Read every template file into a { relativePath: content } map. */
export async function loadAgentOsTemplates(templatesRoot = DEFAULT_TEMPLATES_ROOT) {
  const files = await listTemplateFiles(templatesRoot);
  const templates = {};
  await Promise.all(files.map(async (file) => {
    templates[file] = await readFile(join(templatesRoot, file), 'utf8');
  }));
  return templates;
}

function requireTemplate(templates, key) {
  const value = templates[key];
  if (typeof value !== 'string') throw new Error(`Missing template: ${key}`);
  return value;
}

/** Substitute {{TOKEN}} placeholders and fail loudly on any left behind. */
export function render(template, values) {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, token) => {
    if (!(token in values)) return match;
    return String(values[token]);
  });
  const leftover = out.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover) throw new Error(`Unresolved template placeholder ${leftover[0]}`);
  return out;
}

function trimBody(text) {
  return text.replace(/\s+$/, '');
}

/**
 * Build every file for one target.
 *
 * Returns entries of { path, content, ownership }, where `path` is relative to
 * the install directory and ownership is 'managed' (inside agent-os/, may be
 * refreshed) or 'user' (created once, then left alone).
 */
export function renderAgentOsFiles({ target, templates, installDir }) {
  const spec = TARGET_SPECS[target];
  if (!spec) throw new Error(`Unknown target "${target}"`);

  const partials = {};
  for (const [token, path] of Object.entries(PARTIALS)) {
    partials[token] = trimBody(requireTemplate(templates, path));
  }

  // Forward slashes work on every platform Node runs on and need no JSON
  // escaping, which a Windows backslash path would.
  const hooksDir = posix.join(
    installDir.split(sep).join('/'),
    MANAGED_DIR,
    'hooks',
  );

  const files = [];
  const add = (path, content, ownership) => {
    files.push({ path, content: `${trimBody(content)}\n`, ownership });
  };

  // The generated context file carries the same markers as an appended block.
  // Without them a reinstall cannot tell "I wrote this" from "the user wrote
  // this", and appends the rules a second time.
  add(
    spec.contextFile,
    [
      AGENT_OS_MARKER_BEGIN,
      trimBody(render(requireTemplate(templates, spec.contextTemplate), partials)),
      AGENT_OS_MARKER_END,
    ].join('\n'),
    'user',
  );

  for (const [source, destination] of COMPANIONS) {
    add(destination, requireTemplate(templates, source), 'user');
  }

  add(
    `${MANAGED_DIR}/AGENT_OS.md`,
    render(requireTemplate(templates, 'shared/AGENT_OS.md'), partials),
    'managed',
  );

  add(
    `${MANAGED_DIR}/${spec.snippetFile}`,
    render(requireTemplate(templates, spec.snippetTemplate), { HOOKS_DIR: hooksDir }),
    'managed',
  );

  add(
    `${MANAGED_DIR}/MERGE_HOOKS.md`,
    render(requireTemplate(templates, 'shared/MERGE_HOOKS.md'), {
      SETTINGS_PATH: posix.join(installDir.split(sep).join('/'), spec.settingsFile),
      SNIPPET_PATH: posix.join(installDir.split(sep).join('/'), MANAGED_DIR, spec.snippetFile),
      TURN_END_EVENT: spec.turnEndEvent,
    }),
    'managed',
  );

  for (const hook of HOOK_TEMPLATES) {
    add(`${MANAGED_DIR}/${hook}`, requireTemplate(templates, hook), 'managed');
  }

  return files;
}

/**
 * The block appended to a context file that already exists.
 *
 * Import mode points at the managed file, so the user's own file grows by four
 * lines. Inline mode carries the rules themselves, for a tool with no import
 * syntax.
 */
export function appendBlockFor({ target, renderedContext }) {
  const spec = TARGET_SPECS[target];
  const body = spec.appendMode === 'import'
    ? [
      'Agent OS is installed. The core rules, the self-improvement loop, and the',
      'advisory lane are in the imported file below.',
      '',
      `@${MANAGED_DIR}/AGENT_OS.md`,
    ].join('\n')
    : trimBody(renderedContext);

  return [
    '',
    AGENT_OS_MARKER_BEGIN,
    body,
    AGENT_OS_MARKER_END,
    '',
  ].join('\n');
}

/**
 * Decide what to do with each file, without touching disk.
 *
 * `existing` maps a relative path to its current content, or undefined when the
 * file is absent. Actions:
 *   create    — no file there, write it
 *   append    — context file exists without our marker, add a delimited block
 *   update    — managed file whose content changed, refresh it
 *   unchanged — managed file already identical
 *   skip      — user file already present, leave it exactly as it is
 */
export function planAgentOsInstall({ target, files, existing = {} }) {
  const spec = TARGET_SPECS[target];
  const actions = [];

  for (const file of files) {
    const current = existing[file.path];

    if (current === undefined) {
      actions.push({ ...file, action: 'create', reason: 'not present' });
      continue;
    }

    if (file.path === spec.contextFile) {
      if (current.includes(AGENT_OS_MARKER_BEGIN)) {
        actions.push({ ...file, action: 'unchanged', reason: 'agent OS block already present' });
      } else {
        actions.push({
          ...file,
          action: 'append',
          reason: 'file exists — appending a delimited block, leaving your content intact',
          appendText: appendBlockFor({ target, renderedContext: file.content }),
        });
      }
      continue;
    }

    if (file.ownership === 'managed') {
      actions.push(current === file.content
        ? { ...file, action: 'unchanged', reason: 'already current' }
        : { ...file, action: 'update', reason: 'managed file — refreshing' });
      continue;
    }

    actions.push({ ...file, action: 'skip', reason: 'yours — left untouched' });
  }

  return actions;
}

/**
 * Plan, and optionally apply, an install for one target.
 * With `apply: false` nothing is written — that is the default, so the
 * destructive-looking step needs an explicit --yes.
 */
export async function installAgentOs({
  target,
  dir,
  templatesRoot = DEFAULT_TEMPLATES_ROOT,
  templates = null,
  apply = false,
  home = homedir(),
}) {
  const spec = TARGET_SPECS[target];
  if (!spec) throw new Error(`Unknown target "${target}"`);

  const installDir = resolve(dir ?? defaultTargetDirectory(target, home));
  const loaded = templates ?? await loadAgentOsTemplates(templatesRoot);
  const files = renderAgentOsFiles({ target, templates: loaded, installDir });

  const existing = {};
  for (const file of files) {
    const full = join(installDir, file.path);
    if (existsSync(full)) existing[file.path] = await readFile(full, 'utf8');
  }

  const actions = planAgentOsInstall({ target, files, existing });

  if (apply) {
    for (const action of actions) {
      const full = join(installDir, action.path);
      if (action.action === 'create' || action.action === 'update') {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, action.content, 'utf8');
      } else if (action.action === 'append') {
        await writeFile(full, `${existing[action.path].replace(/\s+$/, '')}\n${action.appendText}`, 'utf8');
      }
    }
  }

  const counts = actions.reduce((acc, action) => {
    acc[action.action] = (acc[action.action] ?? 0) + 1;
    return acc;
  }, {});

  return {
    target: spec.id,
    label: spec.label,
    directory: installDir,
    applied: apply,
    settingsFile: join(installDir, spec.settingsFile),
    settingsSnippet: join(installDir, MANAGED_DIR, spec.snippetFile),
    hooksWired: false, // Always false: this installer never edits a settings file.
    counts,
    files: actions.map(({ path, action, reason, ownership }) => ({
      path, action, reason, ownership,
    })),
  };
}

export async function installAgentOsTargets({
  targets,
  dir = null,
  templatesRoot = DEFAULT_TEMPLATES_ROOT,
  apply = false,
  home = homedir(),
}) {
  const templates = await loadAgentOsTemplates(templatesRoot);
  const results = [];
  for (const target of targets) {
    // When an explicit --dir is given for several targets, keep them apart by
    // giving each its own subdirectory; otherwise they would collide on the
    // shared companion filenames.
    const targetDir = dir
      ? (targets.length > 1 ? join(dir, TARGET_SPECS[target].directoryName) : dir)
      : defaultTargetDirectory(target, home);
    results.push(await installAgentOs({
      target, dir: targetDir, templatesRoot, templates, apply, home,
    }));
  }
  return { applied: apply, targets: results };
}

// ── Anonymization guard ──────────────────────────────────────────────────────
//
// These templates ship to strangers. Nothing in them may identify the person
// whose working practice they were distilled from, name a private project, or
// carry a path or credential from the machine they were written on.
//
// This is a denylist, so it proves the absence of known leaks, not the absence
// of all leaks. A test drives it against a deliberately poisoned input to
// confirm it can still fail — a scanner that only ever passes proves nothing.

export const IDENTIFYING_PATTERNS = Object.freeze([
  { name: 'personal-name', pattern: /\b(troy|halter|saadi|fahmi|bryce)\b/i },
  { name: 'assistant-persona', pattern: /\b(big[\s-]?sister|big[\s-]?brother|clyde|jarvis|cora)\b/i },
  { name: 'private-project', pattern: /\b(dairyforge|aimforge|caldmere|gauge[\s-]?sandbox|forge[\s-]?light|modularizer)\b/i },
  { name: 'customer-name', pattern: /\b(chobani|glanbia|lactalis|dfa|nampa|twin[\s-]?falls|kimberly)\b/i },
  { name: 'vendor-binding', pattern: /\b(neon|hume|kokoro|meshy|caldmere|supabase)\b/i },
  { name: 'windows-user-path', pattern: /\b[A-Za-z]:[\\/]{1,2}(users|helmion)\b/i },
  { name: 'unix-home-path', pattern: /(^|\s)\/(?:home|users)\/[a-z][\w.-]*/i },
  { name: 'email-address', pattern: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { name: 'neon-endpoint-id', pattern: /\bep-[a-z]+-[a-z]+-[a-z0-9]+\b/i },
  { name: 'connection-string', pattern: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/\S+/i },
  { name: 'api-key', pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-\S+|xai-[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})/ },
  { name: 'voice-persona-rule', pattern: /\b(speak\.ps1|voice_preference|edge[\s-]?tts|en-US-\w+Neural)\b/i },
  { name: 'machine-local-file', pattern: /\b(BASE_RULES\.md|MEMORY\.md\s+is\s+a\s+budget|bigsister\w*)\b/i },
]);

/**
 * Scan a { path: content } map for identifying content.
 * Returns one finding per match: { path, rule, line, excerpt }.
 */
export function scanForIdentifyingContent(fileMap) {
  const findings = [];
  for (const [path, content] of Object.entries(fileMap)) {
    const lines = String(content).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of IDENTIFYING_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        findings.push({
          path,
          rule: name,
          line: index + 1,
          excerpt: line.trim().slice(0, 160),
          matched: match[0],
        });
      }
    });
  }
  return findings;
}

export async function scanTemplatesForIdentifyingContent(templatesRoot = DEFAULT_TEMPLATES_ROOT) {
  return scanForIdentifyingContent(await loadAgentOsTemplates(templatesRoot));
}

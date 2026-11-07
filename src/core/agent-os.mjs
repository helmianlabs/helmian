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
// The estate cargo (see ESTATE_CARGO below) is the one exception to the
// "created once" rule, and it stays inside boundary 1: the user's own grown
// files are copied into the managed folder only, refreshed when they change,
// and the seat files they were copied from are read, never written.
//
// Everything here is pure except `installAgentOs` and `loadEstateCargo`,
// which are the only functions that touch the filesystem.

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

export const AGENT_OS_TARGETS = Object.freeze(['claude', 'codex', 'gemini', 'grok']);

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
//
//   grok    ~/.grok/AGENTS.md is the GLOBAL rules file, read at session start;
//           a repo-level or deeper AGENTS.md wins where they disagree. Grok
//           Build has no file of its own name — it reads the AGENTS.md family
//           (and CLAUDE.md) — so a "GROK.md" would be a file nothing loads.
//           Hooks are discovered as individual JSON files under ~/.grok/hooks/,
//           in the same nested shape Claude Code uses; turn end is "Stop".
//           https://docs.x.ai/build/features/project-rules
//           https://github.com/xai-org/grok-build
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
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok Build',
    directoryName: '.grok',
    contextFile: 'AGENTS.md',
    // Hooks are read from individual files in ~/.grok/hooks/, so unlike the
    // other three there is no shared settings file to merge INTO — the snippet
    // is dropped in under its own name and nothing of the user's is touched.
    settingsFile: 'hooks/agent-os.json',
    snippetFile: 'hooks.json',
    contextTemplate: 'targets/grok/AGENTS.md',
    snippetTemplate: 'targets/grok/hooks.json',
    turnEndEvent: 'Stop',
    // Inline, like codex: Grok reads the AGENTS.md family, and no @import
    // syntax is documented for it. Pointing at a file it may not follow would
    // append four lines that silently carry nothing.
    appendMode: 'inline',
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

// ── Estate cargo ─────────────────────────────────────────────────────────────
//
// The templates above are a distilled starter kit: they ship to strangers, so
// they are anonymized and they carry no one's actual work. The estate is the
// opposite cargo. It is the user's own grown files, read from the source seat
// on this machine at install time and copied into every seat's managed
// folder, refreshed on every sync — so what one seat has learned and written
// down reaches the others instead of staying stranded in the seat that grew
// it.
//
// The source of truth is the Claude seat: its CLAUDE.md (hand-built, the
// largest single rules document the user owns) and the flywheel's grown
// companions — LESSONS.md and LEARNINGS.md, whose template seeds in the other
// seats are empty frames by comparison.
//
// Three properties keep this cargo honest:
//
//   - Verbatim. An estate file is a copy, not a render: no trimming, no
//     placeholder pass, no anonymization scan. The bytes that land are the
//     bytes that were read, so a sync report's hash for a copy equals the
//     source's hash, and "unchanged" is a direct comparison.
//   - Managed only. Copies land under agent-os/estate/ and nowhere else. The
//     seat's own files — the very files the estate was read from, and every
//     other seat's own context file and companions — are never the copy's
//     destination.
//   - Presence-gated. A seat whose directory does not exist on this machine
//     is not present here; its estate cargo is skipped and the skip is
//     recorded in the plan, never silently dropped and never forced into a
//     folder the sync itself just invented.

/** The seat whose directory holds the estate sources. */
export const ESTATE_SOURCE_TARGET = 'claude';

export const ESTATE_CARGO = Object.freeze([
  Object.freeze({ source: 'CLAUDE.md', destination: `${MANAGED_DIR}/estate/CLAUDE-ESTATE.md` }),
  Object.freeze({ source: 'LESSONS.md', destination: `${MANAGED_DIR}/estate/LESSONS.md` }),
  Object.freeze({ source: 'LEARNINGS.md', destination: `${MANAGED_DIR}/estate/LEARNINGS.md` }),
]);

// ── Estate folder cargo (part B1) ────────────────────────────────────────────
//
// Two folders of the same estate, carried file by file under the same four
// properties: the hand-built hook scripts in `scripts/` — the user's own
// PC-side gates (autonomy boundary, destructive-command block, commit QA,
// pretask blocker gate, the topic-lessons injector, and the rest of the
// library) — and the topic lessons library in `lessons/` that the
// topic-lessons hook injects from. Carriage is all this is: the files land
// as data in each seat's managed folder; nothing here wires or runs them.
//
// Two fences keep the carriage to the estate itself:
//
//   - Root files only, never recursive. The subfolders under `scripts/` are
//     separate tool trees with their own dependency folders, logs and data
//     files — one of them holds a secret-bearing .env — and none of that is
//     estate. A seat receives the scripts folder's own files, not everything
//     that happens to live beneath it.
//   - An extension allowlist per folder. Backup copies (.bak and friends),
//     logs and caches sit in these folders beside the living files; the
//     allowlist names the file kinds that ARE the estate — script files for
//     `scripts/`, markdown for `lessons/` — and everything else stays home.
export const ESTATE_SCRIPT_EXTENSIONS = Object.freeze([
  '.ps1', '.mjs', '.js', '.cjs', '.sh', '.py', '.bat', '.cmd', '.vbs',
]);

export const ESTATE_CARGO_FOLDERS = Object.freeze([
  Object.freeze({
    source: 'scripts',
    destination: `${MANAGED_DIR}/estate/scripts`,
    extensions: ESTATE_SCRIPT_EXTENSIONS,
  }),
  Object.freeze({
    source: 'lessons',
    destination: `${MANAGED_DIR}/estate/lessons`,
    extensions: Object.freeze(['.md']),
  }),
]);

/** True when a folder-root file name is one the folder's cargo carries. */
function estateFolderFileCarried(folder, name) {
  const lower = String(name).toLowerCase();
  return folder.extensions.some((extension) => lower.endsWith(extension));
}

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
 * Build the estate entries for one target from loaded contents.
 *
 * `estateContents` maps a destination path to the source file's exact text,
 * as returned by `loadEstateCargo`. A destination with no string content is
 * left out entirely — a missing source produces no file, never an empty one.
 */
export function renderEstateFiles(estateContents = {}) {
  const files = [];
  for (const { destination } of ESTATE_CARGO) {
    const content = estateContents?.[destination];
    if (typeof content !== 'string') continue;
    files.push({ path: destination, content, ownership: 'managed', cargo: 'estate' });
  }
  // Folder cargo: every snapshot key under a folder's destination is one
  // carried file. Sorted, so the plan reads the same on every run.
  for (const folder of ESTATE_CARGO_FOLDERS) {
    const prefix = `${folder.destination}/`;
    const paths = Object.keys(estateContents ?? {})
      .filter((path) => path.startsWith(prefix))
      .sort();
    for (const path of paths) {
      const content = estateContents[path];
      if (typeof content !== 'string') continue;
      files.push({ path, content, ownership: 'managed', cargo: 'estate' });
    }
  }
  return files;
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
 * The estate-shaped contents the installer itself ships: the rendered
 * context file for the source seat and the companion seeds, exactly as an
 * install writes them. A source still byte-identical to one of these is the
 * kit's own paper — a fresh install's context file, a companion seed nobody
 * has written in yet — not the user's grown estate. Carrying it would feed
 * the starter kit back to every seat dressed as the user's own work, and
 * would make a second sync on a fresh machine "discover" an estate the
 * first sync manufactured.
 */
function kitOwnedEstateContents(templates, sourceDir) {
  const rendered = renderAgentOsFiles({ target: ESTATE_SOURCE_TARGET, templates, installDir: sourceDir });
  const byPath = new Map(rendered.map((file) => [file.path, file.content]));
  const owned = {};
  for (const { source, destination } of ESTATE_CARGO) {
    const content = byPath.get(source);
    if (typeof content === 'string') owned[destination] = content;
  }
  return owned;
}

/**
 * Read the estate sources from the source seat's directory under `home`.
 *
 * Returns { contents, missing, missingFolders, kitOwned }: `contents` maps
 * each estate destination path to the source file's exact text; `missing`
 * lists the fixed-cargo source names that are not there; `missingFolders`
 * lists the estate folders that are not there; `kitOwned` lists the sources
 * that exist but are still the installer's own shipped paper (see above)
 * and so are not estate yet. Neither absence is an error — a machine may
 * not have grown a file yet — but both are reported, never silently treated
 * as an empty file. This is the one read of user content the installer
 * performs, and it is read-only: the sources are never written by any code
 * path here.
 *
 * Folder cargo reads one level only: the folder's own root files whose
 * names pass its extension allowlist (see ESTATE_CARGO_FOLDERS). An
 * existing folder with no carried files contributes nothing and is not
 * missing. The kit-owned exclusion does not reach folder files: the kit
 * ships no scripts or lessons, so no folder file can be kit paper.
 */
export async function loadEstateCargo({
  home = homedir(),
  templates = null,
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  const sourceDir = defaultTargetDirectory(ESTATE_SOURCE_TARGET, home);
  const kitOwnedRefs = templates ? kitOwnedEstateContents(templates, sourceDir) : {};
  const contents = {};
  const missing = [];
  const missingFolders = [];
  const kitOwned = [];
  for (const { source, destination } of ESTATE_CARGO) {
    let content;
    try {
      content = await readFileImpl(join(sourceDir, source), 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      missing.push(source);
      continue;
    }
    if (kitOwnedRefs[destination] !== undefined && content === kitOwnedRefs[destination]) {
      kitOwned.push(source);
      continue;
    }
    contents[destination] = content;
  }
  for (const folder of ESTATE_CARGO_FOLDERS) {
    let entries;
    try {
      entries = await readdirImpl(join(sourceDir, folder.source), { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      missingFolders.push(folder.source);
      continue;
    }
    const names = entries
      .filter((entry) => entry.isFile() && estateFolderFileCarried(folder, entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      contents[`${folder.destination}/${name}`] = await readFileImpl(
        join(sourceDir, folder.source, name),
        'utf8',
      );
    }
  }
  return { contents, missing, missingFolders, kitOwned };
}

/**
 * Plan, and optionally apply, an install for one target.
 * With `apply: false` nothing is written — that is the default, so the
 * destructive-looking step needs an explicit --yes.
 *
 * `estateContents` is the estate snapshot to carry (see loadEstateCargo).
 * Pass a map — including an empty one — to carry exactly that. Left
 * undefined, the snapshot is loaded from disk — but only for a home install:
 * an explicit `dir` names a self-contained scratch install, and the estate
 * is a home-level cargo, so a scratch install carries none unless the caller
 * hands it over. installAgentOsTargets loads the snapshot once and hands
 * the same one to every target, so all four seats receive the estate as it
 * stood when the sync began, even if an earlier target's install in the same
 * run touches the source seat's files.
 */
export async function installAgentOs({
  target,
  dir,
  templatesRoot = DEFAULT_TEMPLATES_ROOT,
  templates = null,
  apply = false,
  home = homedir(),
  estateContents = undefined,
}) {
  const spec = TARGET_SPECS[target];
  if (!spec) throw new Error(`Unknown target "${target}"`);

  const installDir = resolve(dir ?? defaultTargetDirectory(target, home));
  // Presence is judged before this run writes anything: a seat directory
  // the sync itself is about to create does not count as the seat being
  // present on this machine.
  const seatPresent = existsSync(installDir);
  const loaded = templates ?? await loadAgentOsTemplates(templatesRoot);
  const estate = estateContents ?? (dir ? {} : (await loadEstateCargo({ home, templates: loaded })).contents);
  const files = [
    ...renderAgentOsFiles({ target, templates: loaded, installDir }),
    ...renderEstateFiles(estate),
  ];

  const existing = {};
  for (const file of files) {
    const full = join(installDir, file.path);
    if (existsSync(full)) existing[file.path] = await readFile(full, 'utf8');
  }

  const planned = planAgentOsInstall({ target, files, existing });

  // The estate is presence-gated: where the seat has no directory on this
  // machine, its estate entries are recorded as skips instead of writes.
  // The rest of the cargo installs as it always has.
  const actions = seatPresent
    ? planned
    : planned.map((action) => (action.cargo === 'estate' && (action.action === 'create' || action.action === 'update')
      ? { ...action, action: 'skip', reason: 'seat not present on this machine — estate cargo skipped' }
      : action));

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

  const estateActions = actions.filter((action) => action.cargo === 'estate');

  return {
    target: spec.id,
    label: spec.label,
    directory: installDir,
    applied: apply,
    settingsFile: join(installDir, spec.settingsFile),
    settingsSnippet: join(installDir, MANAGED_DIR, spec.snippetFile),
    hooksWired: false, // Always false: this installer never edits a settings file.
    counts,
    estate: {
      carried: estateActions.filter((action) => action.action !== 'skip').length,
      skipped: estateActions
        .filter((action) => action.action === 'skip')
        .map((action) => action.path),
    },
    files: actions.map(({ path, action, reason, ownership, cargo }) => ({
      path, action, reason, ownership, ...(cargo ? { cargo } : {}),
    })),
  };
}

export async function installAgentOsTargets({
  targets,
  dir = null,
  templatesRoot = DEFAULT_TEMPLATES_ROOT,
  apply = false,
  home = homedir(),
  estateContents = undefined,
}) {
  const templates = await loadAgentOsTemplates(templatesRoot);
  // One estate snapshot for the whole run, taken before any target writes:
  // the seats all receive the estate as it stood when the sync began. As in
  // installAgentOs, an explicit dir means a scratch install and carries no
  // estate unless the caller hands a snapshot over.
  const estate = estateContents ?? (dir ? {} : (await loadEstateCargo({ home, templates })).contents);
  const results = [];
  for (const target of targets) {
    // When an explicit --dir is given for several targets, keep them apart by
    // giving each its own subdirectory; otherwise they would collide on the
    // shared companion filenames.
    const targetDir = dir
      ? (targets.length > 1 ? join(dir, TARGET_SPECS[target].directoryName) : dir)
      : defaultTargetDirectory(target, home);
    results.push(await installAgentOs({
      target, dir: targetDir, templatesRoot, templates, apply, home, estateContents: estate,
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

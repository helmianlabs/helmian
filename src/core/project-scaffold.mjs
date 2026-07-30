// Project scaffold — the planning folder that exists BEFORE any coding tool
// opens the project.
//
// The problem it solves: an agent handed a vague goal invents the missing
// scope, and once the invented scope is in the diff nobody can tell it from a
// real one. So the structure that states the scope — requirements, blueprint,
// acceptance criteria, a sprint area, docs, and the handoff prompt a
// zero-context session reads — is written first, by hand or by an architect
// session, and the builder executes against it.
//
// Two boundaries this module never crosses:
//
//   1. It does not overwrite. Every file it writes is user-owned from the
//      moment it lands: a second run reports each existing file as preserved
//      and writes nothing over it. There is no --force and no overwrite flag,
//      because these files accumulate the operator's own reasoning. This repo
//      destroyed a real 5,512-byte rules file twice by templating over it
//      (see the LivingDocuments note in
//      desktop/Helmion.Desktop.Core/ClaudeProfileInstaller.cs), so the
//      preserve path here is the only path.
//   2. It does not invent a second templating mechanism. Tokens, the
//      leftover-token check, and the identifying-content scanner are all
//      reused from src/core/agent-os.mjs. One render(), one denylist.
//
// Everything here is pure except `scaffoldProject`, which is the only function
// that touches the filesystem, and only when called with `apply: true`.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listTemplateFiles,
  loadAgentOsTemplates,
  render,
  scanForIdentifyingContent,
} from './agent-os.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROJECT_TEMPLATES_ROOT = resolve(here, '..', '..', 'templates', 'project');

/**
 * Templates under this prefix are substituted INTO other templates and are
 * never written out as files of their own — the same role core/ plays for
 * agent-os.
 */
export const PARTIAL_PREFIX = 'partials/';

/**
 * The sprint pack lives at this prefix in the template tree and is emitted
 * under `sprints/<sprint id>/`, so the same four files can be re-emitted for
 * sprint-002 without duplicating them in the repo.
 */
export const SPRINT_TEMPLATE_PREFIX = 'sprints/sprint/';

/** Every file the scaffolder writes is the operator's from the moment it lands. */
export const OWNERSHIP = 'user';

/** Turn a typed project name into a filesystem- and slug-safe identifier. */
export function slugifyProjectName(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!slug) {
    throw new Error(
      `Project name "${name ?? ''}" has no letters or digits in it, so it cannot become a folder name`,
    );
  }
  return slug;
}

/** sprint-001, sprint-012, sprint-134. */
export function sprintId(number = 1) {
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Sprint number must be a positive integer, got ${number}`);
  }
  return `sprint-${String(parsed).padStart(3, '0')}`;
}

/** partials/SOURCE_OF_TRUTH.md -> SOURCE_OF_TRUTH */
export function partialToken(templatePath) {
  const token = basename(templatePath)
    .replace(/\.[^.]+$/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  if (!/^[A-Z0-9_]+$/.test(token)) {
    throw new Error(`Partial ${templatePath} does not yield a usable {{TOKEN}} name`);
  }
  return token;
}

/** Where a template file lands, relative to the project directory. */
export function destinationFor(templatePath, { sprint }) {
  if (templatePath.startsWith(PARTIAL_PREFIX)) return null;
  if (templatePath.startsWith(SPRINT_TEMPLATE_PREFIX)) {
    return `sprints/${sprint}/${templatePath.slice(SPRINT_TEMPLATE_PREFIX.length)}`;
  }
  return templatePath;
}

export async function listProjectTemplates(templatesRoot = DEFAULT_PROJECT_TEMPLATES_ROOT) {
  return listTemplateFiles(templatesRoot);
}

/** Read every project template into a { relativePath: content } map. */
export async function loadProjectTemplates(templatesRoot = DEFAULT_PROJECT_TEMPLATES_ROOT) {
  // Deliberately the agent-os loader: it already walks a root and reads utf8,
  // and a second copy of that walk is a second thing to keep in step.
  return loadAgentOsTemplates(templatesRoot);
}

function trimBody(text) {
  return text.replace(/\s+$/, '');
}

/**
 * Build every file for one project, without touching disk.
 *
 * Partials are rendered first with the scalar tokens, then injected into the
 * files that reference them, so a partial may itself carry {{PROJECT_NAME}}.
 * render() throws on any token left unresolved at either stage.
 */
export function renderProjectFiles({
  templates,
  name,
  slug = null,
  sprintNumber = 1,
  createdDate,
}) {
  const projectName = String(name ?? '').trim();
  if (!projectName) throw new Error('A project name is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(createdDate ?? ''))) {
    throw new Error(`createdDate must be YYYY-MM-DD, got "${createdDate}"`);
  }

  const projectSlug = slug ?? slugifyProjectName(projectName);
  const sprint = sprintId(sprintNumber);

  const scalars = {
    PROJECT_NAME: projectName,
    PROJECT_SLUG: projectSlug,
    CREATED_DATE: createdDate,
    SPRINT_ID: sprint,
    SPRINT_NUMBER: sprint.slice('sprint-'.length),
  };

  const partials = {};
  for (const path of Object.keys(templates)) {
    if (!path.startsWith(PARTIAL_PREFIX)) continue;
    partials[partialToken(path)] = trimBody(render(templates[path], scalars));
  }

  const values = { ...scalars, ...partials };

  const files = [];
  for (const path of Object.keys(templates).sort()) {
    const destination = destinationFor(path, { sprint });
    if (destination === null) continue;
    files.push({
      path: destination,
      content: `${trimBody(render(templates[path], values))}\n`,
      ownership: OWNERSHIP,
    });
  }

  if (files.length === 0) throw new Error('The project template tree produced no files');
  return files;
}

/**
 * Decide what to do with each file, without touching disk.
 *
 * `existing` maps a relative path to its current content, or undefined when the
 * file is absent. There are exactly two actions and neither one writes over
 * anything:
 *   create   — nothing there, write it
 *   preserve — a file is already there; it is the operator's, leave every byte
 *
 * There is deliberately no update, no append, and no overwrite action. A
 * planning file accumulates reasoning that no template can reconstruct.
 */
export function planProjectScaffold({ files, existing = {} }) {
  return files.map((file) => (existing[file.path] === undefined
    ? { ...file, action: 'create', reason: 'not present' }
    : { ...file, action: 'preserve', reason: 'yours — left untouched' }));
}

/**
 * Write the planned actions to disk. Only a 'create' action writes anything.
 *
 * The write flag is 'wx', which fails when the file already exists. The plan
 * was built from a read of the disk a moment earlier, and between that read and
 * this write another process — a second agent, an editor, the operator — can
 * create the file. Without 'wx' that window is an overwrite. With it, the
 * action is downgraded to 'preserve' and the existing bytes stand.
 *
 * Actions are mutated in place so the returned report describes what actually
 * happened rather than what was intended.
 */
export async function applyProjectActions({ projectDir, actions }) {
  for (const action of actions) {
    if (action.action !== 'create') continue;
    const full = join(projectDir, action.path);
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, action.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      action.action = 'preserve';
      action.reason = 'appeared while scaffolding — left untouched';
    }
  }
  return actions;
}

/** Where `helmion project init <name>` puts the project by default. */
export function defaultProjectDirectory(slug, cwd = process.cwd()) {
  return join(cwd, slug);
}

/**
 * Plan, and optionally apply, the scaffold for one project.
 *
 * With `apply: false` nothing is written — that is the default, so the
 * filesystem-touching step needs an explicit --yes, matching `agent-os
 * install`.
 */
export async function scaffoldProject({
  name,
  dir = null,
  cwd = process.cwd(),
  templatesRoot = DEFAULT_PROJECT_TEMPLATES_ROOT,
  templates = null,
  sprintNumber = 1,
  createdDate = new Date().toISOString().slice(0, 10),
  apply = false,
}) {
  const projectName = String(name ?? '').trim();
  if (!projectName) throw new Error('A project name is required');
  const slug = slugifyProjectName(projectName);
  const projectDir = resolve(dir ?? defaultProjectDirectory(slug, cwd));

  const loaded = templates ?? await loadProjectTemplates(templatesRoot);
  const files = renderProjectFiles({
    templates: loaded, name: projectName, slug, sprintNumber, createdDate,
  });

  // Read the current state BEFORE planning, so "preserve" is a fact about disk
  // rather than an assumption about a directory being new.
  const existing = {};
  for (const file of files) {
    const full = join(projectDir, file.path);
    if (existsSync(full)) existing[file.path] = await readFile(full, 'utf8');
  }

  const actions = planProjectScaffold({ files, existing });

  if (apply) await applyProjectActions({ projectDir, actions });

  const counts = actions.reduce((acc, action) => {
    acc[action.action] = (acc[action.action] ?? 0) + 1;
    return acc;
  }, {});

  return {
    project: projectName,
    slug,
    directory: projectDir,
    sprint: sprintId(sprintNumber),
    createdDate,
    applied: apply,
    counts,
    files: actions.map(({ path, action, reason, ownership }) => ({
      path, action, reason, ownership,
    })),
  };
}

/**
 * Point the agent-os denylist at the project templates.
 *
 * These templates ship to strangers, so the same scanner that guards
 * templates/agent-os guards this tree — one denylist, one positive control. It
 * proves the absence of KNOWN leaks, not of all leaks.
 */
export async function scanProjectTemplatesForIdentifyingContent(
  templatesRoot = DEFAULT_PROJECT_TEMPLATES_ROOT,
) {
  return scanForIdentifyingContent(await loadProjectTemplates(templatesRoot));
}

// ─────────────────────────────────────────────────────────────────────────────
// User-defined slash commands.
//
// Format deliberately mirrors Claude Code's, so a command file Troy already
// wrote for Claude Code works here unchanged. The rules implemented below are
// quoted from https://code.claude.com/docs/en/skills (fetched 2026-07-28):
//
//   "File under `.claude/commands/` | File name without extension |
//    `.claude/commands/deploy.md` → `/deploy`"
//
//   "$ARGUMENTS | All arguments passed when invoking the skill. If $ARGUMENTS
//    is not present in the content, arguments are appended as
//    `ARGUMENTS: <value>`."
//
//   "$N | Shorthand for `$ARGUMENTS[N]`, such as `$0` for the first argument
//    or `$1` for the second."          ← 0-BASED. Not a typo, see NOTE below.
//
//   "An indexed placeholder with no corresponding argument, such as `$2` when
//    only one argument was passed, stays in the content unchanged. A named
//    placeholder … with no matching argument expands to an empty string."
//
//   "To include a literal `$` … escape it with a backslash: `\$1.00`. A
//    backslash before any other `$` is left unchanged. Only a single backslash
//    directly before the token escapes it. A doubled backslash such as `\\$1`
//    leaves both backslashes in place, and `$1` still expands…"
//
//   "Indexed arguments use shell-style quoting … `/my-skill "hello world"
//    second` makes `$0` expand to `hello world` and `$1` to `second`. The
//    $ARGUMENTS placeholder always expands to the full argument string as
//    typed."
//
// NOTE ON $1: the assignment asked for "positional $1..$9" meaning $1 = first.
// The current published spec says $0 = first and $1 = second. This file
// implements the PUBLISHED spec, because the point is to match the tool Troy
// actually uses. `$1` is therefore the SECOND argument here, exactly as in
// Claude Code. Named arguments (`arguments: [issue, branch]` + `$issue`) are
// the readable way to avoid the off-by-one entirely.
//
// What is deliberately NOT implemented: dynamic context injection
// (`` !`command` ``) — Claude Code runs those before the model sees the file.
// Executing shell out of a markdown file that can arrive from a third-party
// plugin is exactly the hole this repo is trying to close, so command bodies
// here are inert text. Seam documented in docs/, not silently omitted.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname, basename, sep } from 'node:path';

/** Directory that holds command markdown, under a project or user root. */
export const COMMANDS_SUBDIR = 'commands';
/** Helmion's config directory name, project-local and in the home directory. */
export const HELMION_DIR = '.helmion';

/** Source tiers, lowest precedence first. Later tiers win, per the spec's
 *  "personal overrides project". Built-ins are handled separately: they always
 *  win, and a file that tried to shadow one is reported rather than ignored. */
export const SOURCE_PROJECT = 'project';
export const SOURCE_USER = 'user';
export const SOURCE_PLUGIN = 'plugin';

const MAX_DEPTH = 8;
const TRUTHY = new Set(['true', 'yes', 'on', '1']);
const FALSY = new Set(['false', 'no', 'off', '0']);

/**
 * Only these fields get inline-list parsing (`[a, b]` → ['a','b']).
 *
 * This distinction is load-bearing, not cosmetic. The spec's own example of a
 * hint is `argument-hint: [issue-number]` — square brackets that are LITERAL
 * TEXT shown during autocomplete, not a one-element YAML list. Parsing every
 * bracketed value as a list turned `[env] [tag]` into the string "env", which
 * is what the hint test caught.
 */
const LIST_FIELDS = new Set(['allowed-tools', 'disallowed-tools', 'arguments', 'paths']);

/** Project command directory for a workspace: <workspace>/.helmion/commands. */
export function projectCommandsDir(workspace) {
  return join(workspace, HELMION_DIR, COMMANDS_SUBDIR);
}

/** User command directory: ~/.helmion/commands. */
export function userCommandsDir(home = homedir()) {
  return join(home, HELMION_DIR, COMMANDS_SUBDIR);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter delimited by `---` lines.
 *
 * A deliberately small YAML subset: `key: value`, block lists (`  - item`),
 * and inline lists (`[a, b]`). Helmion has one runtime dependency (pg) and
 * adding a YAML parser to read five fields is not worth the supply chain.
 *
 * Malformed frontmatter does NOT throw. Per the spec — "If the frontmatter
 * YAML is malformed, Claude Code loads the skill body with empty metadata, so
 * /skill-name still works but Claude has no description" — the body survives
 * and the problem is reported, so a typo never silently deletes a command.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  // Tolerate a UTF-8 BOM and CRLF; both are normal for files authored on this box.
  const normalized = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized.trimStart().startsWith('---') === false) {
    return { meta: {}, body: normalized, frontmatterPresent: false, warnings: [] };
  }
  const lines = normalized.split('\n');
  if (lines[0].trim() !== '---') {
    return { meta: {}, body: normalized, frontmatterPresent: false, warnings: [] };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    // Opened but never closed: the whole file would otherwise vanish into
    // metadata. Keep the body, say so.
    return {
      meta: {},
      body: normalized,
      frontmatterPresent: false,
      warnings: ['Frontmatter opened with --- but never closed; the whole file was treated as body.'],
    };
  }

  const meta = {};
  const warnings = [];
  let pendingKey = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem && pendingKey) {
      if (!Array.isArray(meta[pendingKey])) meta[pendingKey] = [];
      meta[pendingKey].push(stripQuotes(listItem[1].trim()));
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) {
      warnings.push(`Ignored unparsable frontmatter line ${i + 1}: ${raw.trim()}`);
      continue;
    }
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (!value) {
      // `key:` alone opens a block list on the following lines.
      pendingKey = key;
      meta[key] = [];
      continue;
    }
    pendingKey = null;
    meta[key] = LIST_FIELDS.has(key) ? parseScalar(value) : stripQuotes(value);
  }

  return {
    meta,
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    frontmatterPresent: true,
    warnings,
  };
}

function stripQuotes(value) {
  const s = String(value).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(value) {
  const s = stripQuotes(value);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => stripQuotes(part.trim())).filter(Boolean);
  }
  return s;
}

/** Spec: booleans "accept `yes`, `no`, `on`, `off`, `1`, and `0` in any letter
 *  case, in addition to `true` and `false`." Anything else keeps the default. */
export function parseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return fallback;
}

/** `allowed-tools` / `arguments` accept "a space- or comma-separated string,
 *  or a YAML list". Normalize all three to an array. */
export function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split an argument string shell-style, so `"hello world" second` is two
 * arguments and not three. Quotes group; they are not kept in the value.
 * An unterminated quote yields the rest of the line as one argument rather
 * than throwing — a REPL should not reject a line over a missing quote.
 */
export function splitArguments(raw) {
  const text = String(raw ?? '');
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * Expand placeholders in a command body.
 *
 * Returns the expanded text. Every rule here is the quoted spec at the top of
 * this file; the tests assert each one individually.
 */
export function expandCommand(body, rawArgs = '', { argumentNames = [] } = {}) {
  const text = String(body ?? '');
  const argString = String(rawArgs ?? '').trim();
  const positional = splitArguments(argString);
  const names = toList(argumentNames);
  const named = new Map();
  names.forEach((name, index) => named.set(name, positional[index]));

  let sawArguments = false;

  const pattern = /(\\*)\$(ARGUMENTS\[(\d+)\]|ARGUMENTS|\d+|[A-Za-z_][A-Za-z0-9_-]*)/g;

  const expanded = text.replace(pattern, (match, slashes, token, bracketIndex) => {
    // Decide what this token expands to, or that it is not a placeholder at all.
    let replacement;
    if (token === 'ARGUMENTS') {
      replacement = argString;
    } else if (bracketIndex !== undefined) {
      replacement = positional[Number(bracketIndex)];
    } else if (/^\d+$/.test(token)) {
      replacement = positional[Number(token)];
    } else if (named.has(token)) {
      // Named placeholder with no matching argument expands to empty string.
      replacement = named.get(token) ?? '';
    } else {
      // Not a declared name → not a placeholder. Left completely unchanged,
      // including any backslashes, per "A backslash before any other `$` is
      // left unchanged."
      return match;
    }

    // Escaping. Exactly one backslash escapes and is consumed; any other count
    // (including two) is left in place and the token still expands.
    if (slashes.length === 1) return `$${token}`;

    if (token === 'ARGUMENTS' || bracketIndex !== undefined || /^\d+$/.test(token)) {
      if (token === 'ARGUMENTS') sawArguments = true;
    }

    // An indexed placeholder with no corresponding argument stays unchanged.
    if (replacement === undefined) return match;

    return `${slashes}${replacement}`;
  });

  // "If $ARGUMENTS is not present in the content, arguments are appended as
  // ARGUMENTS: <value>." Indexed/named placeholders do not count as presence,
  // matching the spec's wording, so a body using only $0 still gets the tail.
  if (!sawArguments && argString) {
    return `${expanded.replace(/\s*$/, '')}\n\nARGUMENTS: ${argString}`;
  }
  return expanded;
}

/**
 * Split a REPL line into a command name and its raw argument string.
 * Returns null when the line is not a slash invocation.
 */
export function parseSlashInput(line) {
  const text = String(line ?? '').trim();
  if (!text.startsWith('/') || text === '/') return null;
  const withoutSlash = text.slice(1);
  const match = /^([^\s]+)\s*([\s\S]*)$/.exec(withoutSlash);
  if (!match) return null;
  return { name: match[1], rawArgs: match[2] ?? '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a command name from a file path relative to a commands root.
 *
 * Top level:  deploy.md                 → { base: 'deploy',    name: 'deploy' }
 * Nested:     frontend/component.md     → { base: 'component', name: 'frontend:component' }
 *
 * The nested shape follows the spec's directory-qualified form, "`apps/web/…`
 * → `/apps/web:deploy`": the subdirectory path, then a colon, then the name.
 */
export function commandNameFromRelPath(relPath) {
  const segments = String(relPath).split(/[\\/]/).filter(Boolean);
  const file = segments.pop();
  const base = basename(file, extname(file));
  const namespace = segments.join('/');
  return {
    base,
    namespace: namespace || null,
    name: namespace ? `${namespace}:${base}` : base,
  };
}

async function walkMarkdown(root, depth = 0, prefix = '') {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...await walkMarkdown(join(root, entry.name), depth + 1, rel));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      found.push({ absolute: join(root, entry.name), rel });
    }
  }
  return found;
}

/**
 * Load every command markdown file under one root.
 * `namespacePrefix` is set for plugins, producing `/plugin-name:command`.
 */
export async function loadCommandsFrom({
  root,
  source,
  origin = null,
  namespacePrefix = null,
}) {
  const files = await walkMarkdown(root);
  const commands = [];
  const errors = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file.absolute, 'utf8');
    } catch (error) {
      errors.push({ path: file.absolute, message: error.message });
      continue;
    }
    const { meta, body, warnings } = parseFrontmatter(text);
    const derived = commandNameFromRelPath(file.rel);
    const name = namespacePrefix ? `${namespacePrefix}:${derived.name}` : derived.name;
    commands.push({
      name,
      base: derived.base,
      namespace: derived.namespace,
      source,
      origin,
      path: file.absolute,
      description: typeof meta.description === 'string' && meta.description
        ? meta.description
        : firstParagraph(body),
      argumentHint: meta['argument-hint'] ? String(meta['argument-hint']) : null,
      allowedTools: toList(meta['allowed-tools']),
      argumentNames: toList(meta.arguments),
      model: meta.model ? String(meta.model) : null,
      userInvocable: parseBoolean(meta['user-invocable'], true),
      body,
      warnings,
    });
  }
  return { commands, errors };
}

function firstParagraph(body) {
  const text = String(body ?? '').trim();
  if (!text) return '';
  const para = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return para.length > 160 ? `${para.slice(0, 157)}…` : para;
}

/**
 * Build the full command registry.
 *
 * Precedence, lowest first: project → user. The spec's rule is "personal
 * overrides project", so a ~/.helmion command wins over a workspace one of the
 * same name; the loser is recorded in `overridden` rather than dropped
 * silently. Plugin commands carry a `plugin:` prefix and so cannot collide.
 *
 * Built-ins ALWAYS win. A file that tried to take a built-in name is loaded,
 * refused a dispatch slot, and listed in `shadowedBuiltins` — the REPL prints
 * that list, so "my /clear stopped working" can never be a mystery.
 */
export async function discoverCommands({
  workspace,
  home = homedir(),
  builtins = [],
  plugins = [],
  includeUser = true,
} = {}) {
  const builtinSet = new Set(builtins.map((b) => String(b).replace(/^\//, '')));
  const registry = new Map();
  const aliases = new Map();
  const overridden = [];
  const shadowedBuiltins = [];
  const errors = [];

  const tiers = [
    { root: projectCommandsDir(workspace), source: SOURCE_PROJECT, origin: workspace },
  ];
  if (includeUser) {
    tiers.push({ root: userCommandsDir(home), source: SOURCE_USER, origin: home });
  }

  for (const tier of tiers) {
    const loaded = await loadCommandsFrom(tier);
    errors.push(...loaded.errors);
    for (const cmd of loaded.commands) register(cmd);
  }

  for (const plugin of plugins) {
    if (!plugin?.commandsDir) continue;
    const loaded = await loadCommandsFrom({
      root: plugin.commandsDir,
      source: SOURCE_PLUGIN,
      origin: plugin.name,
      namespacePrefix: plugin.name,
    });
    errors.push(...loaded.errors);
    for (const cmd of loaded.commands) register(cmd);
  }

  function register(cmd) {
    if (builtinSet.has(cmd.name)) {
      shadowedBuiltins.push({ name: cmd.name, path: cmd.path, source: cmd.source });
      return;
    }
    const existing = registry.get(cmd.name);
    if (existing) overridden.push({ name: cmd.name, losing: existing.path, winning: cmd.path });
    registry.set(cmd.name, cmd);

    // Bare-name alias for a namespaced command, so /component reaches
    // /frontend:component when nothing else claims the short name. The spec's
    // nested-skill behaviour: the qualified name always works, the bare one
    // resolves to whichever command owns it outright.
    if (cmd.namespace || cmd.source === SOURCE_PLUGIN) {
      if (!builtinSet.has(cmd.base)) {
        const claimed = aliases.get(cmd.base);
        if (claimed && claimed !== cmd.name) aliases.set(cmd.base, null); // ambiguous
        else aliases.set(cmd.base, cmd.name);
      }
    }
  }

  return {
    commands: registry,
    aliases,
    overridden,
    shadowedBuiltins,
    errors,
    list: [...registry.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Resolve a typed name to a command. Exact name first, then an unambiguous
 * bare-name alias. An ambiguous bare name resolves to nothing rather than
 * guessing which one was meant.
 */
export function resolveCommand(registry, name) {
  if (!registry) return null;
  const key = String(name ?? '').replace(/^\//, '');
  const direct = registry.commands.get(key);
  if (direct) return direct;
  const alias = registry.aliases.get(key);
  return alias ? registry.commands.get(alias) ?? null : null;
}

/** Render the discovered commands for `/help`, one line each with description. */
export function formatCommandList(registry, { indent = '  ' } = {}) {
  if (!registry || registry.list.length === 0) {
    return `${indent}(none — add markdown files to ${HELMION_DIR}/${COMMANDS_SUBDIR}/)\n`;
  }
  const width = Math.min(
    34,
    registry.list.reduce((max, c) => Math.max(max, c.name.length + (c.argumentHint ? c.argumentHint.length + 1 : 0)), 0),
  );
  let out = '';
  for (const cmd of registry.list) {
    if (!cmd.userInvocable) continue;
    const label = `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`;
    const desc = cmd.description || '(no description)';
    out += `${indent}${label.padEnd(width + 1)}  ${desc}  [${cmd.source}]\n`;
  }
  for (const shadow of registry.shadowedBuiltins) {
    out += `${indent}! /${shadow.name} in ${shadow.path} is IGNORED — built-in commands cannot be overridden.\n`;
  }
  return out;
}

/** Everything the desktop bridge needs to list commands, without bodies. */
export function serializeRegistry(registry) {
  return {
    commands: registry.list.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      argumentNames: c.argumentNames,
      allowedTools: c.allowedTools,
      model: c.model,
      source: c.source,
      origin: c.origin,
      path: c.path,
      userInvocable: c.userInvocable,
    })),
    shadowedBuiltins: registry.shadowedBuiltins,
    overridden: registry.overridden,
    errors: registry.errors,
  };
}

export { sep as pathSep };

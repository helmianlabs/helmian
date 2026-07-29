// ─────────────────────────────────────────────────────────────────────────────
// Plugins / connectors.
//
// A plugin is a DIRECTORY. Layout mirrors Claude Code's so an existing plugin
// loads here unchanged (https://code.claude.com/docs/en/plugins, fetched
// 2026-07-28):
//
//   ".claude-plugin/ | Plugin root | Contains plugin.json manifest"
//   "commands/       | Plugin root | Skills as flat Markdown files"
//   ".mcp.json       | Plugin root | MCP server configurations"
//   "Common mistake: Don't put commands/, agents/, skills/, or hooks/ inside
//    the .claude-plugin/ directory. Only plugin.json goes inside."
//   "name | Unique identifier and skill namespace. Skills are prefixed with
//    this (e.g., /my-first-plugin:hello)."
//
// Helmion reads `.helmion-plugin/plugin.json` first and falls back to
// `.claude-plugin/plugin.json`, so both ecosystems work.
//
// ── SECURITY ────────────────────────────────────────────────────────────────
// Two hard rules, both fail-closed, both proven by test/plugins.test.mjs:
//
//   1. NOTHING FROM A PLUGIN IS EVER EXECUTED HERE. This module reads markdown
//      and JSON. It does not spawn a process, does not import plugin code,
//      does not run an install script. Command bodies are inert text
//      (src/agent/commands.mjs deliberately omits `` !`cmd` `` injection).
//
//   2. A DECLARED MCP SERVER IS NOT A REGISTERED MCP SERVER. Every server in a
//      plugin's .mcp.json is REFUSED unless agent-I's install ledger already
//      holds an approved, un-drifted baseline for it. There is no second,
//      ungated install path in this file: `plugin add` of a remote source is
//      refused outright and points at `helmion mcp-install`, which is the only
//      thing that can produce an approval.
//
// HONEST SEAM: Helmion's agent has no MCP client today — `mcpServers` appears
// nowhere in src/agent/ and nothing in the turn loop spawns an external server
// (verified 2026-07-28: the only child_process.spawn in src/agent is the
// run_command tool at tools.mjs:483). So an `approved` verdict here produces a
// vetted registration RECORD, not a running server. When a client is added, it
// must consume `registrations` from this module and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HELMION_DIR, COMMANDS_SUBDIR } from './commands.mjs';

export const PLUGIN_MANIFEST_DIRS = Object.freeze(['.helmion-plugin', '.claude-plugin']);
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const MCP_DECLARATION_FILE = '.mcp.json';
export const REGISTRY_FILE = 'plugins.json';

/** Verdicts for a declared MCP server. Only `approved` may ever be registered. */
export const MCP_APPROVED = 'approved';
export const MCP_REFUSED = 'refused';

export class RemoteSourceRefusedError extends Error {
  constructor(spec) {
    super(
      `Refusing to add "${spec}" as a plugin: it is a remote source.\n`
      + `Nothing fetched from the network gets a command slot or an MCP registration here.\n`
      + `Clone it yourself, read it, then vet it through the gated pipeline:\n`
      + `  helmion mcp-install --root <cloned-path>\n`
      + `and add the local directory once you have approved it.`,
    );
    this.name = 'RemoteSourceRefusedError';
    this.spec = spec;
  }
}

/** Registry path: <workspace>/.helmion/plugins.json */
export function registryPath(workspace) {
  return join(workspace, HELMION_DIR, REGISTRY_FILE);
}

/**
 * Is this spec something on local disk, or something that has to be fetched?
 * Anything that is not a path we can already read is remote, including the
 * bare `owner/repo` shorthand — the ambiguous case resolves to REFUSE.
 */
export function classifySource(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return 'invalid';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'remote';
  if (/^(git@|ssh:|git:)/i.test(s)) return 'remote';
  if (isAbsolute(s)) return 'local';
  if (s.startsWith('.') || s.startsWith('~')) return 'local';
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'local';
  // `owner/repo` with no path-ish marker: GitHub shorthand, not a directory.
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return 'remote';
  return 'local';
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest + declarations
// ─────────────────────────────────────────────────────────────────────────────

async function readJson(path) {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return { present: false, value: null, error: null };
  try {
    return { present: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { present: true, value: null, error: error.message };
  }
}

/**
 * Read a plugin manifest. A plugin with no manifest still loads — the docs
 * make plugin.json optional ("optional if components use default locations") —
 * and falls back to its directory name for the namespace.
 */
export async function loadPluginManifest(root) {
  for (const dir of PLUGIN_MANIFEST_DIRS) {
    const path = join(root, dir, PLUGIN_MANIFEST_FILE);
    const { present, value, error } = await readJson(path);
    if (!present) continue;
    if (error) {
      return {
        present: true, path, name: null, warnings: [`${path} is not valid JSON (${error}).`],
      };
    }
    return {
      present: true,
      path,
      name: typeof value.name === 'string' ? value.name.trim() : null,
      description: typeof value.description === 'string' ? value.description : null,
      version: value.version ?? null,
      author: value.author ?? null,
      warnings: [],
    };
  }
  return { present: false, path: null, name: null, warnings: [] };
}

/**
 * Read `.mcp.json`. Shape matches the ecosystem standard and agent-I's
 * pipeline output: { "mcpServers": { "<name>": { command, args } } }.
 */
export async function readMcpDeclarations(root) {
  const path = join(root, MCP_DECLARATION_FILE);
  const { present, value, error } = await readJson(path);
  if (!present) return { present: false, servers: [], warnings: [] };
  if (error) {
    return {
      present: true,
      servers: [],
      warnings: [`${path} is not valid JSON (${error}); no server from it is eligible.`],
    };
  }
  const table = value?.mcpServers && typeof value.mcpServers === 'object' ? value.mcpServers : {};
  const servers = Object.entries(table).map(([name, decl]) => ({
    name,
    declaration: decl ?? {},
  }));
  return { present: true, servers, warnings: [] };
}

/**
 * Where on local disk does this declaration's code live? Null when there is
 * nothing on disk to fingerprint — an `npx`-fetched package or a remote URL —
 * which is itself a refusal reason, because an unvettable server is not a
 * trusted one.
 */
export function declarationLocalRoot(declaration, pluginRoot) {
  const decl = declaration ?? {};
  if (decl.url || decl.type === 'sse' || decl.type === 'http') return null;
  const args = Array.isArray(decl.args) ? decl.args : [];
  const command = String(decl.command ?? '');
  if (/^(npx|npm|pnpm|yarn|bunx|uvx|pipx)$/i.test(command)) return null;
  const scriptArg = args.find((a) => /\.(mjs|cjs|js|ts|py)$/i.test(String(a)));
  if (scriptArg) {
    const p = String(scriptArg);
    return dirname(isAbsolute(p) ? p : resolve(pluginRoot, p));
  }
  if (/\.(mjs|cjs|js|ts|py)$/i.test(command)) {
    return dirname(isAbsolute(command) ? command : resolve(pluginRoot, command));
  }
  return null;
}

/** Lazily reach agent-I's ledger. Injectable so a test can drive both branches
 *  without standing up a real approval, and so a concurrent edit to that module
 *  produces a clear error here instead of an import-time crash. */
async function ledgerApi(override) {
  if (override) return override;
  return import('../core/mcp-install-ledger.mjs');
}

/**
 * THE GATE. Decide whether one declared MCP server may be registered.
 *
 * Fail-closed at every branch: no local root, no baseline, drifted baseline,
 * or a ledger that cannot be read all return REFUSED. The only path to
 * `approved` is an existing, matching, human-approved baseline written by
 * `helmion mcp-install`.
 */
export async function evaluateMcpDeclaration({
  serverName,
  declaration,
  pluginRoot,
  pluginName,
  ledgerDir,
  ledger = null,
}) {
  const refuse = (reason, detail = {}) => ({
    name: serverName,
    plugin: pluginName,
    status: MCP_REFUSED,
    reason,
    ...detail,
  });

  const localRoot = declarationLocalRoot(declaration, pluginRoot);
  if (!localRoot) {
    return refuse(
      `"${serverName}" resolves to code that is not on local disk (fetched at run time or served remotely), `
      + `so it cannot be fingerprinted or vetted. Vendor it locally and run: helmion mcp-install --root <path>`,
    );
  }

  const exists = await stat(localRoot).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) {
    return refuse(`"${serverName}" points at ${localRoot}, which does not exist.`);
  }

  let api;
  try {
    api = await ledgerApi(ledger);
  } catch (error) {
    return refuse(`Cannot read the install ledger, so nothing can be approved (${error.message}).`);
  }

  let drift;
  try {
    drift = await api.checkForDrift({
      ledgerDir,
      serverName,
      root: localRoot,
      declared: {},
    });
  } catch (error) {
    return refuse(`Ledger check failed for "${serverName}" (${error.message}).`);
  }

  if (drift.status === 'no-baseline') {
    return refuse(
      `"${serverName}" has never been approved. ${drift.message} `
      + `Run: helmion mcp-install --root ${localRoot}`,
      { localRoot },
    );
  }
  if (drift.status === 'drift-detected') {
    return refuse(
      `"${serverName}" changed since it was approved. ${drift.message}`,
      { localRoot, comparison: drift.comparison ?? null },
    );
  }

  return {
    name: serverName,
    plugin: pluginName,
    status: MCP_APPROVED,
    reason: drift.message,
    localRoot,
    declaration,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load one plugin directory: identity, its commands directory, and a verdict
 * for every MCP server it declares. Never executes anything it finds.
 */
export async function loadPlugin({
  root,
  workspace,
  ledgerDir = null,
  ledger = null,
  name: nameHint = null,
}) {
  const absolute = resolve(root);
  const warnings = [];
  const manifest = await loadPluginManifest(absolute);
  warnings.push(...(manifest.warnings ?? []));

  const dirName = absolute.split(/[\\/]/).filter(Boolean).pop() || 'plugin';
  const name = manifest.name || nameHint || dirName;

  const commandsDir = join(absolute, COMMANDS_SUBDIR);
  const hasCommands = await stat(commandsDir).then((s) => s.isDirectory()).catch(() => false);

  // The documented "common mistake" — components nested inside the manifest
  // directory — silently yields a plugin with no commands. Say it out loud.
  for (const manifestDir of PLUGIN_MANIFEST_DIRS) {
    const misplaced = join(absolute, manifestDir, COMMANDS_SUBDIR);
    const bad = await stat(misplaced).then((s) => s.isDirectory()).catch(() => false);
    if (bad) {
      warnings.push(
        `${misplaced} is ignored: commands/ belongs at the plugin root, not inside ${manifestDir}/.`,
      );
    }
  }

  const declarations = await readMcpDeclarations(absolute);
  warnings.push(...declarations.warnings);

  const resolvedLedgerDir = ledgerDir
    ?? join(workspace ?? absolute, HELMION_DIR, 'mcp-security');

  const mcpServers = [];
  for (const server of declarations.servers) {
    mcpServers.push(await evaluateMcpDeclaration({
      serverName: server.name,
      declaration: server.declaration,
      pluginRoot: absolute,
      pluginName: name,
      ledgerDir: resolvedLedgerDir,
      ledger,
    }));
  }

  return {
    name,
    root: absolute,
    description: manifest.description ?? null,
    version: manifest.version ?? null,
    manifestPresent: manifest.present,
    commandsDir: hasCommands ? commandsDir : null,
    mcpServers,
    // Only approved servers are ever handed onward. A consumer that reads
    // `registrations` cannot accidentally pick up a refused one.
    registrations: mcpServers.filter((s) => s.status === MCP_APPROVED),
    refusals: mcpServers.filter((s) => s.status === MCP_REFUSED),
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export async function readRegistry(workspace) {
  const { present, value, error } = await readJson(registryPath(workspace));
  if (!present) return { plugins: [] };
  if (error) throw new Error(`${registryPath(workspace)} is not valid JSON (${error}).`);
  return { plugins: Array.isArray(value?.plugins) ? value.plugins : [] };
}

async function writeRegistry(workspace, registry) {
  const path = registryPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
  return path;
}

/**
 * Register a LOCAL plugin directory. Remote specs are refused before any
 * network call is even considered — this function has no fetch path at all.
 */
export async function addPlugin({ workspace, spec, ledgerDir = null, ledger = null }) {
  const kind = classifySource(spec);
  if (kind === 'remote') throw new RemoteSourceRefusedError(spec);
  if (kind === 'invalid') throw new Error('plugin add requires a directory path.');

  const absolute = resolve(workspace, String(spec));
  const isDir = await stat(absolute).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) throw new Error(`Not a directory: ${absolute}`);

  const plugin = await loadPlugin({ root: absolute, workspace, ledgerDir, ledger });
  const registry = await readRegistry(workspace);
  const existing = registry.plugins.findIndex((p) => p.name === plugin.name);
  const entry = {
    name: plugin.name,
    path: absolute,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  if (existing === -1) registry.plugins.push(entry);
  else registry.plugins[existing] = { ...registry.plugins[existing], ...entry };
  const path = await writeRegistry(workspace, registry);
  return { plugin, entry, registryPath: path, replaced: existing !== -1 };
}

export async function removePlugin({ workspace, name }) {
  const registry = await readRegistry(workspace);
  const before = registry.plugins.length;
  registry.plugins = registry.plugins.filter((p) => p.name !== name);
  if (registry.plugins.length === before) return { removed: false };
  await writeRegistry(workspace, registry);
  return { removed: true };
}

/** Load every enabled plugin in the registry. A missing directory is reported,
 *  not thrown — one deleted plugin must not stop a session from starting. */
export async function loadEnabledPlugins({ workspace, ledgerDir = null, ledger = null } = {}) {
  let registry;
  try {
    registry = await readRegistry(workspace);
  } catch (error) {
    return { plugins: [], errors: [{ name: null, message: error.message }] };
  }
  const plugins = [];
  const errors = [];
  for (const entry of registry.plugins) {
    if (entry.enabled === false) continue;
    try {
      plugins.push(await loadPlugin({
        root: entry.path, workspace, ledgerDir, ledger, name: entry.name,
      }));
    } catch (error) {
      errors.push({ name: entry.name, message: error.message });
    }
  }
  return { plugins, errors };
}

/** Human-readable load report — every refusal printed, never swallowed. */
export function formatPluginReport(plugins, { indent = '  ' } = {}) {
  if (!plugins.length) return `${indent}(no plugins registered)\n`;
  let out = '';
  for (const p of plugins) {
    const commandNote = p.commandsDir ? 'commands/' : 'no commands/';
    out += `${indent}${p.name}${p.version ? ` v${p.version}` : ''} — ${commandNote} — ${p.root}\n`;
    for (const w of p.warnings) out += `${indent}  ! ${w}\n`;
    for (const s of p.registrations) {
      out += `${indent}  ✓ mcp "${s.name}" APPROVED — ${s.reason}\n`;
    }
    for (const s of p.refusals) {
      out += `${indent}  ✗ mcp "${s.name}" REFUSED — ${s.reason}\n`;
    }
  }
  return out;
}

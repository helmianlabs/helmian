// Tenant workspaces: the minimal tenant -> workspace-dir mapping.
//
// Command discovery (src/agent/commands.mjs) reads ONE workspace's
// .helmion/commands/. A runner process serves exactly one tenant (the one
// its device token paired with), but until now every tenant's turns read
// the runner host's single shared workspace — so a new tenant's workspace
// had no commands of its own, and the starter set the product promises
// existed only where an operator had hand-seeded it (Troy's tenant, on
// the cloud worker's disk).
//
// The mapping: a tenant's own command workspace lives at
//   <bridge workspace>/tenants/<tenantId>/
// The five starter commands ship inside the package
// (src/agent/starter-commands/) and are written into that dir on first
// use — additively, never overwriting a file that is already there, so
// anything the tenant (or an operator) later edits or adds stands.
//
// Discovery for a turn merges two registries: the bridge workspace's own
// (the operator's commands — they win on a name clash) and the tenant
// dir's (which fills the gaps). The merged object carries the exact
// registry shape resolveCommand reads ({ commands, aliases, list,
// errors }), so expansion behaves identically to a single-workspace run.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS_SUBDIR, HELMION_DIR, discoverCommands } from './commands.mjs';

const STARTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'starter-commands');
// Same shape tenant-context accepts for tenant ids; lowercase, no slashes,
// no dot-dot — a tenant id must never become a path escape.
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function tenantWorkspacePath(root, tenantId) {
  const id = String(tenantId ?? '').trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(id) || id.includes('..')) throw new Error('tenant id cannot name a workspace directory');
  const base = String(root ?? '').trim();
  if (!base) throw new Error('a workspace root is required');
  return join(base, 'tenants', id);
}

/** The bundled starter command files: [{ name, fileName, body }], sorted by name. */
export async function starterCommandFiles() {
  const names = (await readdir(STARTERS_DIR)).filter((n) => n.endsWith('.md')).sort();
  const out = [];
  for (const fileName of names) {
    out.push({ name: fileName.replace(/\.md$/, ''), fileName, body: await readFile(join(STARTERS_DIR, fileName), 'utf8') });
  }
  return out;
}

/**
 * Write any missing starter commands into <dir>/.helmion/commands/.
 * Additive only: an existing file is never touched. Returns the command
 * names written this call (empty when the pantry was already stocked).
 */
export async function ensureTenantStarterCommands(dir) {
  const commandsDir = join(String(dir), HELMION_DIR, COMMANDS_SUBDIR);
  await mkdir(commandsDir, { recursive: true });
  const written = [];
  for (const starter of await starterCommandFiles()) {
    try {
      // 'wx': create only when absent — an existing file always wins.
      await writeFile(join(commandsDir, starter.fileName), starter.body, { encoding: 'utf8', flag: 'wx' });
      written.push(starter.name);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return written;
}

/** Merge two discovery registries; `base` wins every name/alias clash. */
export function mergeCommandRegistries(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const commands = new Map(extra.commands);
  for (const [name, cmd] of base.commands) commands.set(name, cmd);
  const aliases = new Map(extra.aliases);
  for (const [name, target] of base.aliases) aliases.set(name, target);
  return {
    commands,
    aliases,
    overridden: [...(extra.overridden ?? []), ...(base.overridden ?? [])],
    shadowedBuiltins: [...(extra.shadowedBuiltins ?? []), ...(base.shadowedBuiltins ?? [])],
    errors: [...(extra.errors ?? []), ...(base.errors ?? [])],
    list: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Discovery for one tenant's turn: the bridge workspace's registry merged
 * with the tenant dir's own. The tenant dir contributes its project tier
 * only (its .helmion/commands/); the user tier (~/.helmion/commands) and
 * plugins come from the base discovery, exactly as a single-workspace
 * run would load them — nothing is discovered twice.
 */
export async function discoverTenantCommands({ workspace, tenantDir, builtins = [], plugins = [], discoverImpl = discoverCommands } = {}) {
  const base = await discoverImpl({ workspace, builtins, plugins });
  if (!tenantDir || String(tenantDir) === String(workspace)) return base;
  const extra = await discoverImpl({ workspace: tenantDir, builtins, plugins: [], includeUser: false });
  return mergeCommandRegistries(base, extra);
}

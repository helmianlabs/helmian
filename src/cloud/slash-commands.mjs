// Slash commands for the composer "/" menu (GET /api/admin/commands).
//
// WHERE THE TRUTH LIVES: a slash command is a markdown file discovered by
// discoverCommands (src/agent/commands.mjs) — the workspace's
// .helmion/commands/, the user's ~/.helmion/commands/, and each enabled
// plugin's commands/ folder. The bridge runs that exact discovery with
// builtins: [] when it expands a leading /name in a composer message, so
// this module runs the same call the same way: the menu lists only what
// will actually expand. The REPL's own built-ins (exit, help, …) are NOT
// composer commands and are never listed — on the bridge path they do
// not exist.
//
// WHICH WORKSPACE: the one this process serves — HELMION_WORKSPACE_PATH
// when set, else the process working directory (src/agent/env.mjs's
// resolution, the same one installed-plugins.mjs uses). On the
// agent-computer host that is the bridge workspace the turns run in, so
// the list the menu shows is the list the turn can expand. A workspace
// this process cannot see (a bridge running on another machine with its
// own command files) is not listed — the menu is the served workspace's
// truth, not a guess about someone else's disk.
//
// Rows carry name + plain description + where the command comes from,
// and nothing else: no file paths, no bodies, no discovery internals.
import { discoverCommands, SOURCE_PLUGIN, SOURCE_PROJECT, SOURCE_USER } from '../agent/commands.mjs';
import { loadEnabledPlugins } from '../agent/plugins.mjs';

export const SLASH_COMMANDS_PATH = '/api/admin/commands';

const DESCRIPTION_MAX = 200;

const ORIGIN_BY_SOURCE = Object.freeze({
  [SOURCE_PROJECT]: 'workspace',
  [SOURCE_USER]: 'personal',
  [SOURCE_PLUGIN]: 'plugin',
});

/** One discovered command → its menu row, or null when it is not the user's to invoke. */
export function slashCommandRow(command) {
  if (!command || typeof command.name !== 'string' || !command.name) return null;
  // /help applies the same filter: a command marked user-invocable: false
  // is for the model to reach for, not for a person to pick from a menu.
  if (command.userInvocable === false) return null;
  const description = String(command.description ?? '').replace(/\s+/g, ' ').trim();
  return Object.freeze({
    name: command.name,
    description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description,
    origin: ORIGIN_BY_SOURCE[command.source] ?? 'workspace',
  });
}

export function slashCommandsWorkspace(env = process.env) {
  return String(env.HELMION_WORKSPACE_PATH ?? '').trim() || process.cwd();
}

/**
 * The menu's command list: every user-invocable command the served
 * workspace's own discovery finds, read through the same loader and the
 * same discovery call the bridge turn uses. Command files that fail to
 * load are reported under `unavailable` (message only — never a path)
 * rather than silently dropped.
 */
export async function listSlashCommands({
  workspace,
  discoverCommandsImpl = discoverCommands,
  loadEnabledPluginsImpl = loadEnabledPlugins,
} = {}) {
  const { plugins = [] } = await loadEnabledPluginsImpl({ workspace });
  const registry = await discoverCommandsImpl({ workspace, builtins: [], plugins });
  return Object.freeze({
    commands: Object.freeze((registry?.list ?? []).map(slashCommandRow).filter(Boolean)),
    unavailable: Object.freeze((registry?.errors ?? []).map((e) => Object.freeze({
      message: String(e?.message ?? e),
    }))),
  });
}

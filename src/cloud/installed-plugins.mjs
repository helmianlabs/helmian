// Installed plugins for the composer "+" picker (GET /api/admin/plugins).
//
// WHERE THE TRUTH LIVES: a plugin is installed on the PC bridge — the
// workspace registry (.helmion/plugins.json) plus the install ledger's
// verdicts on its declared MCP servers, both read by loadEnabledPlugins
// (src/agent/plugins.mjs). Nothing from a plugin is executed on this
// path: the loader reads markdown and JSON only, and a declared server
// reaches `registrations` only when the ledger already approved it.
// This module is the read path from that truth to the picker: name +
// what the plugin brings, in plain words, and nothing else — no roots,
// no file paths, no refusal internals ride to a cloud surface.
//
// WHICH WORKSPACE: the one this process serves — HELMION_WORKSPACE_PATH
// when set, else the process working directory, the same resolution the
// agent runtime uses (src/agent/env.mjs). On the agent-computer host that
// is the bridge workspace the turns run in, so the list the picker shows
// is the list the turn can actually consume (src/agent/attachments.mjs
// matches an attached plugin by name against the same enabled set).
import { loadEnabledPlugins } from '../agent/plugins.mjs';

export const INSTALLED_PLUGINS_PATH = '/api/admin/plugins';

// Attachable names are exactly the names the message-metadata validator
// accepts for a plugin attachment: the lowercased name against
// ATTACHMENT_NAME_PATTERN (src/cloud/envoy-agents.mjs). A plugin whose
// name cannot be carried that way is not listed — attaching it would
// ride to the turn and match nothing.
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/;

export function canonicalPluginName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return name && name.length <= 64 && PLUGIN_NAME_PATTERN.test(name) ? name : null;
}

/** What a plugin brings to a turn, in one plain line. */
export function pluginBrings(plugin) {
  const parts = [];
  const tools = (plugin?.registrations ?? []).length;
  if (tools) parts.push(`brings ${tools} approved tool server${tools === 1 ? '' : 's'} — their tools join the turn`);
  if (plugin?.commandsDir) parts.push('adds its commands as skills');
  const refused = (plugin?.refusals ?? []).length;
  if (refused) parts.push(`${refused} declared server${refused === 1 ? ' was' : 's were'} refused by the install ledger and stays off`);
  if (!parts.length) return 'Installed and enabled; adds no tools or commands to a turn yet.';
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** One loaded plugin → its picker row, or null when it cannot be attached. */
export function installedPluginRow(plugin) {
  const name = canonicalPluginName(plugin?.name);
  if (!name) return null;
  return Object.freeze({
    name,
    ...(plugin?.version ? { version: String(plugin.version) } : {}),
    brings: pluginBrings(plugin),
    tools: (plugin?.registrations ?? []).length > 0,
    commands: Boolean(plugin?.commandsDir),
  });
}

export function installedPluginsWorkspace(env = process.env) {
  return String(env.HELMION_WORKSPACE_PATH ?? '').trim() || process.cwd();
}

/**
 * The picker's plugin list: every enabled plugin in the workspace, read
 * through the same loader (and the same ledger gate) the bridge turn
 * uses. Plugins that fail to load are reported under `unavailable`
 * rather than silently dropped.
 */
export async function listInstalledPlugins({ workspace, loadEnabledPluginsImpl = loadEnabledPlugins } = {}) {
  const { plugins = [], errors = [] } = await loadEnabledPluginsImpl({ workspace });
  return Object.freeze({
    plugins: Object.freeze(plugins.map(installedPluginRow).filter(Boolean)),
    unavailable: Object.freeze(errors.map((e) => Object.freeze({
      name: e?.name ?? null,
      message: String(e?.message ?? e),
    }))),
  });
}

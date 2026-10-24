// Turn-side consumption of composer "+" attachments.
//
// The picker (web/marketing/app/composer-picker.mjs) attaches skills,
// connectors and plugins to a message; the cloud stores them as message
// metadata (src/cloud/envoy-agents.mjs normalizeMessageMetadata) and the
// bridges hand them to the turn. This module is where a turn finds out
// what those attachments actually MEAN here — honestly:
//
// - plugin    → REAL capability. The plugin is looked up in the enabled
//               plugins for this workspace; each of its APPROVED MCP
//               registrations (install-ledger verdicts from
//               src/agent/plugins.mjs — refused servers never reach this
//               module) is connected through the real MCP client
//               (src/agent/mcp-client.mjs) and its tools join the turn's
//               catalog as extraTools for createToolRuntime.
// - connector → CONTEXT ONLY today. Slack/Discord/GitHub registrations
//               live cloud-side; no agent-side callable tool exists for
//               them, so the turn is told exactly that, in-context, and
//               told not to claim it used the connector.
// - skill     → the name rides along; the bridge already expanded a
//               leading /name into the command body before the turn.
// - webSearch → a flag the turn honors by instruction. Helmian has no
//               web-search tool today, so ON is stated plainly as
//               requested-but-unavailable rather than faked, and OFF is
//               stated as an instruction not to use web sources.

import { isAbsolute, resolve } from 'node:path';
import { createMcpClient } from './mcp-client.mjs';
import { normalizeMessageMetadata } from '../cloud/envoy-agents.mjs';

export function mcpToolName(pluginName, serverName, toolName) {
  const clean = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
  return `mcp_${clean(pluginName)}_${clean(serverName)}_${clean(toolName)}`.slice(0, 64);
}

/** Declared env names a server asked for, granted from the live environment by name only. */
function grantDeclaredEnv(declaration, base = process.env) {
  const granted = {};
  for (const [name, configured] of Object.entries(declaration?.env ?? {})) {
    granted[name] = configured && !String(configured).startsWith('$') ? String(configured) : (base[name] ?? '');
  }
  return granted;
}

function resolveArgs(declaration, pluginRoot) {
  // .mcp.json paths are relative to the PLUGIN root (the declaration's own
  // home), not to the server code directory the ledger fingerprints.
  const args = Array.isArray(declaration?.args) ? declaration.args : [];
  return args.map((arg) => {
    const text = String(arg);
    return pluginRoot && !isAbsolute(text) && (text.startsWith('./') || text.startsWith('../')) ? resolve(pluginRoot, text) : text;
  });
}

/**
 * @param {{metadata?: object|null, plugins?: Array, connectorInfo?: object,
 *          createMcpClientImpl?: Function}} input
 * @returns {Promise<{extraTools: object, toolNames: string[], contextText: string|null, dispose: () => Promise<void>}>}
 */
export async function resolveTurnAttachments({ metadata = null, plugins = [], connectorInfo = {}, createMcpClientImpl = createMcpClient } = {}) {
  const clean = normalizeMessageMetadata(metadata ?? undefined);
  const lines = [];
  const extraTools = {};
  const clients = [];
  if (!clean) {
    return { extraTools, toolNames: [], contextText: null, dispose: async () => {} };
  }
  for (const attachment of clean.attachments ?? []) {
    if (attachment.kind === 'skill') {
      lines.push(`Skill attached: /${attachment.name}. If the message begins with that command it has already been expanded into the command's instructions for this turn.`);
      continue;
    }
    if (attachment.kind === 'connector') {
      const info = connectorInfo[attachment.key] ?? {};
      const label = info.name ?? attachment.name ?? attachment.key;
      lines.push(`Connector attached: ${label} (${attachment.key}). It is connected in this workspace${info.detail ? ` — ${info.detail}` : ''}, but Helmian has NO agent-side callable tool for this connector today: you cannot call it in this turn. Treat it as context only and do not claim you used it.`);
      continue;
    }
    if (attachment.kind === 'plugin') {
      const plugin = (plugins ?? []).find((p) => String(p?.name ?? '').toLowerCase() === attachment.name);
      if (!plugin) {
        lines.push(`Plugin attached: ${attachment.name}. It is NOT installed or enabled in this workspace, so none of its tools are available in this turn. Say so plainly if asked to use it.`);
        continue;
      }
      const refused = plugin.refusals ?? [];
      if (refused.length) {
        lines.push(`Plugin ${plugin.name}: ${refused.length} declared MCP server(s) were REFUSED by the install ledger (${refused.map((s) => s.name).join(', ')}) and are not available.`);
      }
      if (!(plugin.registrations ?? []).length) {
        lines.push(`Plugin attached: ${plugin.name}. It has no approved MCP servers, so it adds no callable tools to this turn${plugin.commandsDir ? '; its /${plugin.name}: skills are available as commands' : ''}.`);
        continue;
      }
      for (const registration of plugin.registrations) {
        const declaration = registration.declaration ?? {};
        if (!declaration.command) {
          lines.push(`Plugin ${plugin.name}: approved server "${registration.name}" has no launch command in its declaration, so it cannot be connected in this turn.`);
          continue;
        }
        try {
          const client = await createMcpClientImpl({
            command: String(declaration.command),
            args: resolveArgs(declaration, plugin.root),
            env: grantDeclaredEnv(declaration),
            cwd: registration.localRoot ?? plugin.root,
          });
          clients.push(client);
          const tools = await client.listTools();
          const added = [];
          for (const tool of tools) {
            const name = mcpToolName(plugin.name, registration.name, tool.name);
            if (extraTools[name]) continue;
            extraTools[name] = {
              description: `${tool.description ?? tool.name} (via the ${plugin.name} plugin's "${registration.name}" MCP server)`,
              parameters: tool.inputSchema ?? { type: 'object', properties: {} },
              readOnly: tool.annotations?.readOnlyHint === true,
              async execute(args) {
                const result = await client.callTool(tool.name, args ?? {});
                const text = client.textOf(result);
                return result?.isError ? `Error: ${text || 'the MCP server reported an error'}` : (text || JSON.stringify(result ?? {}));
              },
            };
            added.push(name);
          }
          lines.push(`Plugin attached: ${plugin.name} — its approved MCP server "${registration.name}" is connected for this turn with ${added.length} callable tool(s)${added.length ? `: ${added.join(', ')}` : ''}. Use them when the request calls for them.`);
        } catch (error) {
          lines.push(`Plugin ${plugin.name}: its approved MCP server "${registration.name}" could not be connected for this turn (${error.message}). Its tools are NOT available; say so plainly if asked.`);
        }
      }
    }
  }
  if (clean.webSearch !== undefined) {
    lines.push(clean.webSearch
      ? 'Web search: the user turned it ON for this message, but Helmian has no web-search tool today — you cannot search the web in this turn. Say so plainly if the answer needs current web information.'
      : 'Web search: OFF for this turn — answer without web sources.');
  }
  return {
    extraTools,
    toolNames: Object.keys(extraTools),
    contextText: lines.length ? `[Attached to this message — Helmian composer "+"]\n${lines.join('\n')}\n[/Attached]` : null,
    dispose: async () => { for (const client of clients) { try { await client.close(); } catch { /* already gone */ } } },
  };
}

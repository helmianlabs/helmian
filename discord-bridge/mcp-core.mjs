// Discord tools core: the Discord mirror, exposed as MCP tools an agent can
// actually call (research note helmian-connectors-2026-10-25 §6, bite 2).
//
// This module is transport-free on purpose, the same split as bridge-core.mjs:
// the cloud client, the Guard gate and the Discord poster are injected, and
// mcp-server.mjs wires the real ones. No discord.js import, no token of its
// own — the server talks to the EXISTING bridge/cloud mirror plumbing with
// the bridge's own credential (HELMIAN_ENVOY_BRIDGE_TOKEN):
//
//   list channels   GET  /api/admin/envoy/bridge/links
//   read messages   GET  /api/admin/envoy/bridge/outbound?since=
//   post a message  the bridge's own webhook delivery (see createWebhookPoster)
//
// THE GUARD RULE for the one mutating tool, copied from the hands pattern
// (hands-mcp/src/hands.mjs + guard-client.mjs): a mutating call is put to
// Executive Guard FIRST, as an injected authorizer with the guard-client
// contract — authorize({ tool, args }) -> { outcome: 'allow' | 'deny' |
// 'pending', reason?, approvalId? }. The tool result REPORTS the Guard
// outcome and nothing executes without 'allow'. No Guard wired (the
// standalone entry today) means the default authorizer denies, fail closed,
// in Guard's own words.
import { splitForDiscord, webhookName } from './bridge-core.mjs';

export const DISCORD_MCP_SERVER_NAME = 'helmian-discord';
export const DISCORD_MCP_SERVER_VERSION = '1.0.0';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export const DISCORD_MCP_TOOLS = Object.freeze([
  {
    name: 'discord_list_channels',
    description: 'List the Discord channels linked to Helmian Envoy channels by the mirror: Discord channel + server ids, the Envoy channel each mirrors, and the agents seated in it. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: 'discord_read_messages',
    description: 'Read recent messages from one linked (mirrored) channel, newest last. This reads the mirror feed: messages posted from the Helmian side of the channel (people in Helmian, agent replies, notices). Messages that originated in Discord are excluded by the cloud\u2019s anti-echo filter, so this is the Helmian half of the conversation, not the full Discord history. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The Discord channel id (see discord_list_channels).' },
        limit: { type: 'number', description: 'How many messages at most (1-50, default 20).' },
        sinceHours: { type: 'number', description: 'How far back to look, in hours (default 24, max 168).' },
      },
      required: ['channelId'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'discord_post_message',
    description: 'Post a message to a linked Discord channel through the Helmian mirror, under the given author name. MUTATING: the call is put to Executive Guard first and the result reports the Guard outcome \u2014 nothing is posted without a Guard allow. The message is delivered by the bridge\u2019s channel webhook with mentions disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The Discord channel id (see discord_list_channels).' },
        text: { type: 'string', description: 'The message text (up to 8000 characters; longer posts are split by the mirror).' },
        authorName: { type: 'string', description: 'Name shown as the poster on Discord (default "Helmian").' },
      },
      required: ['channelId', 'text'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
]);

const TOOL_NAMES = new Set(DISCORD_MCP_TOOLS.map((t) => t.name));
export const POST_TOOL = 'discord_post_message';

/**
 * The cloud bridge client, same shape as bridge-core's internal api():
 * bearer HELMIAN_ENVOY_BRIDGE_TOKEN against /api/admin/envoy/bridge/*.
 */
export function createBridgeCloudClient({ cloud, token, fetchImpl = fetch } = {}) {
  const base = String(cloud ?? '').replace(/\/+$/, '');
  const secret = String(token ?? '');
  async function api(path, { method = 'GET', body = null } = {}) {
    if (!base) throw new Error('the Helmian cloud URL is not configured (HELMIAN_CLOUD), so the mirror cannot be read');
    if (!secret) throw new Error('the bridge token is not configured (HELMIAN_ENVOY_BRIDGE_TOKEN), so the mirror cannot be read');
    const res = await fetchImpl(`${base}/api/admin/envoy/bridge/${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await res.json(); } catch {}
    if (!res.ok || parsed?.valid === false) throw Object.assign(new Error(`cloud ${path} ${res.status} ${parsed?.code ?? ''}`.trim()), { status: res.status, code: parsed?.code });
    return parsed;
  }
  return {
    async links() {
      const r = await api('links');
      return Array.isArray(r.links) ? r.links : [];
    },
    async outbound(sinceIso) {
      const r = await api(`outbound?since=${encodeURIComponent(sinceIso)}`);
      return Array.isArray(r.messages) ? r.messages : [];
    },
  };
}

/**
 * The production poster: the bridge's own Envoy -> Discord delivery, the
 * same webhook call pumpOutbound makes (bridge-core.mjs) \u2014 split at the
 * mirror's size, posted under the author's name, mentions disabled.
 * `getWebhook(discordChannelId)` resolves the channel's webhook ({id, token})
 * from the bridge's webhook cache; when it returns null the post refuses
 * \u2014 this poster never creates a webhook and never touches the bot.
 */
export function createWebhookPoster({ fetchImpl = fetch, getWebhook } = {}) {
  if (typeof getWebhook !== 'function') throw new Error('createWebhookPoster needs a getWebhook resolver');
  return {
    async post({ discordChannelId, text, authorName }) {
      const hook = await getWebhook(discordChannelId);
      if (!hook?.id || !hook?.token) {
        throw new Error(`no webhook is cached for Discord channel ${discordChannelId} yet \u2014 the bridge creates it the first time it delivers a message there, and this post was not sent`);
      }
      const parts = splitForDiscord(text);
      if (!parts.length) throw new Error('nothing to post: the message text is empty');
      const username = webhookName({ authorKind: 'agent', authorName: authorName || 'Helmian' });
      for (const part of parts) {
        const res = await fetchImpl(`https://discord.com/api/v10/webhooks/${hook.id}/${hook.token}?wait=true`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: part, username, allowed_mentions: { parse: [] } }),
        });
        if (!res.ok) throw new Error(`discord webhook ${res.status}`);
      }
      return { parts: parts.length, username };
    },
  };
}

/** The fail-closed default, in the hands guard-client's own words. */
export const GUARD_NOT_LIVE = Object.freeze({
  live: false,
  async authorize() {
    return { outcome: 'deny', reason: 'Executive Guard is not live yet, so mutating actions are denied (fail closed).' };
  },
});

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const jsonText = (value) => text(JSON.stringify(value, null, 2));

function cleanChannelId(value) {
  const id = String(value ?? '').trim();
  return /^\d{5,25}$/.test(id) ? id : null;
}

/**
 * @param {{cloudClient?: object, cloud?: string, token?: string,
 *          fetchImpl?: Function, guard?: object, poster?: object,
 *          now?: () => number}} deps
 *   cloudClient wins when given; otherwise one is built from cloud/token.
 *   guard defaults to GUARD_NOT_LIVE (fail closed). poster has no default:
 *   without one, an approved post still cannot execute and says so.
 */
export function createDiscordMcpCore({ cloudClient = null, cloud, token, fetchImpl = fetch, guard = GUARD_NOT_LIVE, poster = null, now = () => Date.now() } = {}) {
  const client = cloudClient ?? createBridgeCloudClient({ cloud, token, fetchImpl });

  async function findLink(channelId) {
    const links = await client.links();
    return { links, link: links.find((l) => String(l.discordChannelId) === channelId) ?? null };
  }

  async function listChannels() {
    const links = await client.links();
    return jsonText({
      channels: links.map((l) => ({
        discordChannelId: String(l.discordChannelId),
        guildId: String(l.guildId),
        envoyChannelId: String(l.envoyChannelId),
        tenantId: String(l.tenantId),
        agents: Array.isArray(l.agents) ? l.agents : [],
      })),
    });
  }

  async function readMessages(args) {
    const channelId = cleanChannelId(args?.channelId);
    if (!channelId) return text('Bad arguments: "channelId" must be a Discord channel id (5-25 digits).', true);
    const limit = Math.min(50, Math.max(1, Math.floor(Number(args?.limit ?? 20)) || 20));
    const sinceHours = Math.min(168, Math.max(0.1, Number(args?.sinceHours ?? 24) || 24));
    const { link } = await findLink(channelId);
    if (!link) return text(`Discord channel ${channelId} is not linked to any Helmian channel. Call discord_list_channels to see the linked channels. Nothing was read.`, true);
    const since = new Date(now() - sinceHours * 3600_000).toISOString();
    const all = await client.outbound(since);
    const messages = all
      .filter((m) => String(m.discordChannelId) === channelId)
      .slice(-limit)
      .map((m) => ({
        id: String(m.id),
        author: m.authorName || m.displayName || 'Helmian member',
        authorKind: m.authorKind ?? null,
        body: String(m.body ?? ''),
        createdAt: m.createdAt ?? null,
      }));
    return jsonText({
      channel: { discordChannelId: channelId, guildId: String(link.guildId), envoyChannelId: String(link.envoyChannelId) },
      since, count: messages.length, messages,
    });
  }

  async function postMessage(args) {
    const channelId = cleanChannelId(args?.channelId);
    if (!channelId) return text('Bad arguments: "channelId" must be a Discord channel id (5-25 digits). Nothing was posted.', true);
    const body = String(args?.text ?? '');
    if (!body.trim() || body.length > 8000) return text('Bad arguments: "text" must be 1-8000 characters. Nothing was posted.', true);
    const authorName = String(args?.authorName ?? 'Helmian').trim().slice(0, 80) || 'Helmian';

    // Routing before Guard (the hands order): an unlinked channel is
    // refused here \u2014 no Guard ask, nothing queued.
    const { link } = await findLink(channelId);
    if (!link) return text(`Discord channel ${channelId} is not linked to any Helmian channel. Call discord_list_channels to see the linked channels. Nothing was posted, and Guard was not asked.`, true);

    // The Guard gate. The outcome is REPORTED in the result, in the hands
    // pattern's words; only an allow ever reaches the poster.
    const decision = await guard.authorize({ tool: POST_TOOL, args: { channelId, text: body, authorName } });
    if (decision?.outcome === 'pending') {
      return text(`Waiting for a human approval in Executive Guard${decision.approvalId ? ` (approval ${decision.approvalId})` : ''}. Nothing has been posted.`);
    }
    if (decision?.outcome !== 'allow') {
      return text(`Denied: ${decision?.reason || 'Executive Guard did not allow this post.'} Nothing was posted.`, true);
    }
    if (!poster || typeof poster.post !== 'function') {
      return text('Guard allowed this post, but no Discord poster is wired into this server, so nothing was posted.', true);
    }
    const sent = await poster.post({ discordChannelId: channelId, text: body, authorName });
    return text(`Posted to Discord channel ${channelId} through the Helmian mirror (${sent?.parts ?? 1} message part(s), as "${sent?.username ?? authorName}").`);
  }

  async function callTool(name, args = {}) {
    if (!TOOL_NAMES.has(name)) return text(`Unknown tool ${name}.`, true);
    try {
      if (name === 'discord_list_channels') return await listChannels();
      if (name === 'discord_read_messages') return await readMessages(args ?? {});
      return await postMessage(args ?? {});
    } catch (error) {
      return text(`The Discord mirror could not complete ${name}: ${error.message}`, true);
    }
  }

  /** One JSON-RPC message in, one response object out (null = notification). */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const { id, method } = message;
    if (id === undefined || id === null) return null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
    try {
      if (method === 'initialize') {
        return reply({
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: DISCORD_MCP_SERVER_NAME, version: DISCORD_MCP_SERVER_VERSION },
        });
      }
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: DISCORD_MCP_TOOLS });
      if (method === 'tools/call') return reply(await callTool(message.params?.name, message.params?.arguments ?? {}));
      return fail(-32601, `unknown method ${method}`);
    } catch (error) {
      return fail(-32000, error?.message ?? String(error));
    }
  }

  return { tools: DISCORD_MCP_TOOLS, callTool, handleMessage, guardLive: guard?.live === true };
}

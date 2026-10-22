// Discord <-> Envoy bridge core. No discord.js import here so it is testable:
// the gateway client and fetch are injected.
//
// Discord -> Envoy: every human message in a linked Discord channel is posted
// to the linked Envoy channel (POST /bridge/inbound). Agents in that Envoy
// channel then answer through the user's runner like any other message.
// Envoy -> Discord: new Envoy messages in linked channels (humans typed in
// Helmian, agent replies, notices) are posted to Discord through one channel
// webhook, with the author's name, so each agent shows up as its own member.
// Linking: an admin presses "Link Discord" in /app and gets a code; anyone with
// Manage Channels in the Discord channel types `helmian link CODE` there.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const LINK_RE = /^\s*[!/]?helmian\s+link\s+([A-Za-z2-9]{8})\s*$/i;
const AGENT_AVATARS = {
  Maestro: 'https://helmian.cloud/assets/agents/maestro.png',
  Claude: 'https://helmian.cloud/assets/agents/claude.png',
  ChatGPT: 'https://helmian.cloud/assets/agents/chatgpt.png',
  Grok: 'https://helmian.cloud/assets/agents/grok.png',
  Gemini: 'https://helmian.cloud/assets/agents/gemini.png',
};

export function splitForDiscord(text, max = 1900) {
  const s = String(text ?? '');
  if (s.length <= max) return s ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

// Discord webhook usernames: 1-80 chars, may not contain "discord" or "clyde".
export function webhookName(message) {
  let name = String(message.displayName || message.authorName || 'Helmian').replace(/discord/gi, 'D-cord').replace(/clyde/gi, 'Clyd3');
  if (message.authorKind === 'human') name = `${name} (Helmian)`;
  name = name.trim().slice(0, 80);
  return name || 'Helmian';
}

export function inboundText(msg) {
  const parts = [String(msg.content ?? '').trim()];
  for (const a of msg.attachments ?? []) if (a?.url) parts.push(a.url);
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}

export function createBridge({ cloud, token, fetchImpl = fetch, stateDir, log = console.log, now = () => Date.now() }) {
  const statePath = join(stateDir, 'discord-bridge-state.json');
  let state = { webhooks: {}, since: null, posted: [] };
  let links = [];
  const byDiscord = () => new Map(links.map((l) => [l.discordChannelId, l]));
  const stats = { inbound: 0, outbound: 0, linked: 0, errors: 0, lastOutboundPoll: null, lastError: null };

  async function api(path, { method = 'GET', body = null } = {}) {
    const res = await fetchImpl(`${cloud}/api/admin/envoy/bridge/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await res.json(); } catch {}
    if (!res.ok || parsed?.valid === false) throw Object.assign(new Error(`cloud ${path} ${res.status} ${parsed?.code ?? ''}`.trim()), { status: res.status, code: parsed?.code });
    return parsed;
  }

  async function load() {
    try { state = { ...state, ...JSON.parse(await readFile(statePath, 'utf8')) }; } catch { /* first run */ }
    if (!Array.isArray(state.posted)) state.posted = [];
  }
  async function save() {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${statePath}.tmp`;
    state.posted = state.posted.slice(-1000);
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, statePath);
  }

  async function refreshLinks() {
    const r = await api('links');
    links = Array.isArray(r.links) ? r.links : [];
    return links;
  }

  // Gateway message from Discord.
  async function onDiscordMessage(msg, { canManage }) {
    if (!msg || msg.author?.bot || msg.webhookId) return { skipped: 'bot' };
    const content = String(msg.content ?? '');
    const link = LINK_RE.exec(content);
    if (link) {
      if (!(await canManage(msg))) { await msg.reply?.('Only someone with Manage Channels here can link this channel to Helmian.'); return { skipped: 'no_permission' }; }
      try {
        const out = await api('confirm-link', { method: 'POST', body: { code: link[1].toUpperCase(), guildId: msg.guildId, channelId: msg.channelId, channelName: msg.channel?.name ?? '', guildName: msg.guild?.name ?? '' } });
        await refreshLinks();
        await msg.reply?.(`Linked to Helmian Envoy #${out.envoyChannelTitle}. Messages here and there now mirror both ways${out.agents?.length ? `, and the agents in it (${out.agents.length}) can answer here` : ''}.`);
        stats.linked += 1;
        return { linked: out.envoyChannelId };
      } catch (error) {
        const why = error.code === 'ENVOY_LINK_CODE_UNKNOWN' ? 'That code is wrong or expired. Press Link Discord in Helmian for a new one.'
          : error.code === 'DISCORD_CHANNEL_ALREADY_LINKED' ? 'This Discord channel is already linked to another Envoy channel.' : 'Linking failed. Try again in a minute.';
        await msg.reply?.(why);
        return { error: error.code ?? 'link_failed' };
      }
    }
    const target = byDiscord().get(String(msg.channelId));
    if (!target) return { skipped: 'not_linked' };
    const body = inboundText(msg);
    if (!body) return { skipped: 'empty' };
    await api('inbound', { method: 'POST', body: {
      tenantId: target.tenantId, envoyChannelId: target.envoyChannelId, discordChannelId: String(msg.channelId),
      discordMessageId: String(msg.id), authorId: String(msg.author.id), authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || 'Discord member', body,
    } });
    stats.inbound += 1;
    return { mirrored: true };
  }

  // One outbound poll: Envoy -> Discord through webhooks.
  async function pumpOutbound({ getWebhook }) {
    const since = state.since ?? new Date(now() - 60_000).toISOString();
    const r = await api(`outbound?since=${encodeURIComponent(since)}`);
    stats.lastOutboundPoll = new Date(now()).toISOString();
    const posted = new Set(state.posted);
    let newest = Date.parse(since);
    let sent = 0;
    for (const m of r.messages ?? []) {
      const t = Date.parse(m.createdAt);
      if (Number.isFinite(t) && t > newest) newest = t;
      if (posted.has(m.id)) continue;
      const hook = await getWebhook(m.discordChannelId, state.webhooks);
      if (!hook) continue;
      for (const part of splitForDiscord(m.body)) {
        const res = await fetchImpl(`https://discord.com/api/v10/webhooks/${hook.id}/${hook.token}?wait=true`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: part, username: webhookName(m), avatar_url: AGENT_AVATARS[m.authorName] ?? undefined, allowed_mentions: { parse: [] } }),
        });
        if (res.status === 404) { delete state.webhooks[m.discordChannelId]; throw new Error('webhook was deleted; will recreate'); }
        if (!res.ok) throw new Error(`discord webhook ${res.status}`);
      }
      posted.add(m.id); state.posted.push(m.id); sent += 1; stats.outbound += 1;
    }
    // Small overlap so same-millisecond rows are not skipped; `posted` dedupes.
    state.since = new Date(Math.max(newest - 5000, Date.parse(since))).toISOString();
    await save();
    return sent;
  }

  return { load, save, refreshLinks, onDiscordMessage, pumpOutbound, stats, get links() { return links; }, get state() { return state; } };
}

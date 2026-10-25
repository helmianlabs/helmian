// Slack <-> Envoy bridge core (inbound). No Slack SDK import here so it is
// testable: the Socket Mode client (index.mjs) and fetch are injected.
//
// Slack -> Envoy: every human message in a linked Slack channel is posted to
// the linked Envoy channel (POST /bridge/inbound, provider 'slack'). The
// cloud stores it under a `slack:<userId>:<name>` author subject, so /app
// renders it with the author's name and a SLACK badge carrying the Slack
// channel name (message metadata). Agents in that Envoy channel then answer
// through the user's runner like any other message.
//
// Linking: an owner/admin presses "Link Slack" in /app and gets a code;
// someone in the Slack channel types `helmian link CODE` there. Slack
// message events carry no channel-admin permission bit (unlike Discord's
// Manage Channels check), so the code itself is the credential: single
// use, expires after 15 minutes, stored server-side as a hash and verified
// server-side — exactly as it already is for Discord.
//
// Outbound (Envoy -> Slack): the pump below polls the cloud's outbound
// feed and posts each message to its linked Slack channel through the bot
// token's chat.postMessage, authored as the sender (see slackAuthorName).
// The feed itself excludes Slack-born messages ('slack:%' subjects), and
// the pump re-checks the origin before posting, so nothing echoes back.
// Named outbound exists only when a bot token exists; without one the
// pump never fires and the signed webhook pipe (HELMION_SLACK_WEBHOOK_URL,
// proven 2026-10-24) remains the route to Slack — under the app identity,
// with no author name. Attachments are not carried: the feed carries
// message text only, so a file attached in Envoy stays in Envoy — the
// same treatment the Discord outbound gives attachments today.

export const LINK_RE = /^\s*[!/]?helmian\s+link\s+([A-Za-z2-9]{8})\s*$/i;

// A raw Slack events_api event -> the shape the core works with, or null
// for anything that is not a plain message event. `teamId` comes from the
// envelope payload (events do not always carry it).
export function normalizeSlackEvent(event, teamId) {
  if (!event || event.type !== 'message') return null;
  return {
    channelId: String(event.channel ?? ''),
    teamId: String(event.team ?? teamId ?? ''),
    ts: String(event.ts ?? ''),
    userId: event.user ? String(event.user) : '',
    botId: event.bot_id ? String(event.bot_id) : null,
    subtype: event.subtype ? String(event.subtype) : null,
    text: String(event.text ?? ''),
  };
}

// The health/status word for outbound, used by index.mjs: with a bot
// token the bridge posts under each sender's name ('named'); without one
// named outbound is off and only the webhook pipe reaches Slack
// ('webhook-only'). Never anything in between — no silent pretend.
export function outboundMode(hasBotToken) {
  return hasBotToken ? 'named' : 'webhook-only';
}

// The name an outbound post is authored under, mirroring the Discord
// bridge's webhookName rule: the cloud-resolved display name, with
// " (Helmian)" appended for humans (agents post under their bare name —
// on Discord they get an avatar instead; a Slack text post cannot carry
// one, so the name line is the carrier). Slack posts as the bot, so the
// name rides as a bold first line of the text (see outboundParts).
export function slackAuthorName(message) {
  let name = String(message.displayName || message.authorName || 'Helmian member').replace(/[\u0000-\u001f]/g, '').trim();
  if (message.authorKind === 'human') name = `${name} (Helmian)`;
  return name.slice(0, 80) || 'Helmian member';
}

// Split a body the way the Discord splitter does (newline, then space,
// then hard cut), sized for Slack: bodies arrive capped at 4000 chars,
// and name line + body stay under max per post.
export function splitForSlack(text, max = 3900) {
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

// One feed message -> the chat.postMessage texts for it, each carrying
// the author's bold name line. Empty body -> no posts at all.
export function outboundParts(message) {
  const body = String(message.body ?? '').trim();
  if (!body) return [];
  const nameLine = `**${slackAuthorName(message)}**`;
  return splitForSlack(body, 3900 - nameLine.length - 1).map((chunk) => `${nameLine}\n${chunk}`);
}

export function createBridge({ cloud, token, fetchImpl = fetch, now = () => Date.now() }) {
  let links = [];
  // Slack redelivers events when an ack is slow; a message's ts is unique
  // per channel, so a bounded in-memory seen-set stops a redelivery from
  // reposting. The durable backstop is the cloud's idempotency key
  // (`slack:<ts>`): even if this set has forgotten, the cloud replays.
  const seen = new Set();
  const seenQueue = [];
  const stats = { inbound: 0, outbound: 0, linked: 0, errors: 0, lastOutboundPoll: null, lastError: null };
  const bySlack = () => new Map(links.map((l) => [l.slackChannelId, l]));
  // Outbound cursor + dedupe live in memory only, like the rest of this
  // bridge (no state directory by design): the feed re-serves a small
  // overlap window each poll and this set is what stops a repost within
  // a run. A restart replays at most the last minute of the feed, and
  // the cursor starts 60s back, same as the Discord bridge's first poll.
  let outSince = null;
  const outPosted = new Set();
  const outPostedQueue = [];

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

  async function refreshLinks() {
    const r = await api('links');
    links = Array.isArray(r.slackLinks) ? r.slackLinks : [];
    return links;
  }

  function markSeen(key) {
    seen.add(key);
    seenQueue.push(key);
    if (seenQueue.length > 2000) seen.delete(seenQueue.shift());
  }

  // One normalized Slack message event. `reply` (optional, provided by
  // index.mjs when a bot token exists) answers in the Slack channel.
  async function onSlackMessage(evt, { reply = null } = {}) {
    if (!evt) return { skipped: 'not_message' };
    // Bots, the app itself, edits, deletes, joins: never mirrored.
    if (evt.botId || evt.subtype || !evt.userId) return { skipped: 'bot' };
    const text = String(evt.text ?? '').trim();
    const link = LINK_RE.exec(text);
    if (link) {
      try {
        const out = await api('confirm-link', { method: 'POST', body: { provider: 'slack', code: link[1].toUpperCase(), teamId: evt.teamId, channelId: evt.channelId, channelName: evt.channelName ?? '', teamName: evt.teamName ?? '' } });
        await refreshLinks();
        await reply?.(`Linked to Helmian Envoy #${out.envoyChannelTitle}. Messages posted here now appear there${out.agents?.length ? `, and the agents in it (${out.agents.length}) can answer` : ''}.`);
        stats.linked += 1;
        return { linked: out.envoyChannelId };
      } catch (error) {
        const why = error.code === 'ENVOY_LINK_CODE_UNKNOWN' ? 'That code is wrong or expired. Press Link Slack in Helmian for a new one.'
          : error.code === 'SLACK_CHANNEL_ALREADY_LINKED' ? 'This Slack channel is already linked to another Envoy channel.' : 'Linking failed. Try again in a minute.';
        await reply?.(why);
        return { error: error.code ?? 'link_failed' };
      }
    }
    const target = bySlack().get(String(evt.channelId));
    if (!target) return { skipped: 'not_linked' };
    if (!text) return { skipped: 'empty' };
    const seenKey = `${evt.channelId}:${evt.ts}`;
    if (seen.has(seenKey)) return { skipped: 'duplicate' };
    markSeen(seenKey);
    try {
      await api('inbound', { method: 'POST', body: {
        provider: 'slack', tenantId: target.tenantId, envoyChannelId: target.envoyChannelId, slackChannelId: String(evt.channelId),
        slackMessageId: String(evt.ts), teamId: evt.teamId || target.teamId, authorId: String(evt.userId), authorName: evt.userName || 'Slack member', body: text.slice(0, 4000),
      } });
    } catch (error) {
      // Let a genuine redelivery retry this one.
      seen.delete(seenKey);
      throw error;
    }
    stats.inbound += 1;
    return { mirrored: true };
  }

  function markOutPosted(id) {
    outPosted.add(id);
    outPostedQueue.push(id);
    if (outPostedQueue.length > 2000) outPosted.delete(outPostedQueue.shift());
  }

  // One outbound poll: Envoy -> Slack through the bot token's
  // chat.postMessage, injected by index.mjs as postMessage({ channel,
  // text }). Without a poster (no bot token) this is an honest no-op:
  // named outbound is off, and the webhook pipe is the route to Slack.
  // Rows for Discord links ride the same feed; they carry no
  // slackChannelId and are the Discord bridge's to post.
  async function pumpOutbound({ postMessage } = {}) {
    if (typeof postMessage !== 'function') return { skipped: 'no_poster' };
    const since = outSince ?? new Date(now() - 60_000).toISOString();
    const r = await api(`outbound?since=${encodeURIComponent(since)}`);
    stats.lastOutboundPoll = new Date(now()).toISOString();
    let newest = Date.parse(since);
    let sent = 0;
    for (const m of r.messages ?? []) {
      const t = Date.parse(m.createdAt);
      if (Number.isFinite(t) && t > newest) newest = t;
      if (!m.slackChannelId) continue;
      // Origin exclusion, checked again here even though the cloud feed
      // already excludes Slack-born messages: a Slack message must never
      // be posted back to Slack.
      if (m.source === 'slack' || String(m.authorSubject ?? '').startsWith('slack:')) continue;
      if (outPosted.has(m.id)) continue;
      const parts = outboundParts(m);
      if (!parts.length) continue;
      for (const text of parts) await postMessage({ channel: String(m.slackChannelId), text });
      markOutPosted(m.id);
      sent += 1;
      stats.outbound += 1;
    }
    // Small overlap so same-millisecond rows are not skipped; outPosted dedupes.
    outSince = new Date(Math.max(newest - 5000, Date.parse(since))).toISOString();
    return sent;
  }

  return { refreshLinks, onSlackMessage, pumpOutbound, stats, get links() { return links; } };
}

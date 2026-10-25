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
// Outbound (Envoy -> Slack) is deliberately not here yet: posting each
// author under their own name needs the bot token's chat.postMessage, a
// go-live step (see README). Agent replies reach Slack today through the
// signed webhook pipe (HELMION_SLACK_WEBHOOK_URL) proven 2026-10-24. The
// cloud already serves the Slack outbound feed (bridge/outbound excludes
// Slack-born messages) for when the pump lands.

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

export function createBridge({ cloud, token, fetchImpl = fetch }) {
  let links = [];
  // Slack redelivers events when an ack is slow; a message's ts is unique
  // per channel, so a bounded in-memory seen-set stops a redelivery from
  // reposting. The durable backstop is the cloud's idempotency key
  // (`slack:<ts>`): even if this set has forgotten, the cloud replays.
  const seen = new Set();
  const seenQueue = [];
  const stats = { inbound: 0, linked: 0, errors: 0, lastError: null };
  const bySlack = () => new Map(links.map((l) => [l.slackChannelId, l]));

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

  return { refreshLinks, onSlackMessage, stats, get links() { return links; } };
}

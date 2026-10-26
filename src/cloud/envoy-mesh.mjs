// Envoy mesh: agents as channel members, and the Discord / Slack links.
//
// Routes (hung off handleEnvoyAblyRoute; live-admin.mjs stays untouched):
//   Signed-in members and paired desktops (session cookie or device token):
//     GET  /api/admin/envoy/channel-config?channel_id=   agents + Discord / Slack links for one channel
//     POST /api/admin/envoy/channel-config               add-agent | remove-agent | link-discord | unlink-discord | link-slack | unlink-slack
//     GET  /api/admin/envoy/agent-work?providers=a,b     device token: messages waiting for an agent reply
//     POST /api/admin/envoy/agent-messages               device token: post as an agent member
//   Bridge services (Hetzner, bearer HELMIAN_ENVOY_BRIDGE_TOKEN):
//     GET  /api/admin/envoy/bridge/links
//     POST /api/admin/envoy/bridge/confirm-link
//     POST /api/admin/envoy/bridge/inbound
//     GET  /api/admin/envoy/bridge/outbound?since=
//
// Storage needs no new migration: a channel's config is an append-only
// author_kind='system' row in helmion.envoy_messages (author CONFIG_SUBJECT,
// hidden from chat reads); the newest row wins. Every change also writes a
// visible notice ("Claude joined the channel").
//
// Provider keys never reach this server (rule 019). Agents run on the user's
// own runner (PC bridge) and post their replies here.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { publishEnvoyMessage } from './envoy-ably.mjs';
import {
  AGENT_NAMES, AGENT_PROVIDERS, CONFIG_SUBJECT, DESK_ROSTER_FALLBACK, MAESTRO_DESK_SLUG, NOTICE_SUBJECT,
  agentSubject, agentsToAnswer, describeAuthor, discordSubject, isSlackId, slackSubject,
  emptyConfig, normalizeProvider, parseConfig, publicConfig, serializeConfig,
} from './envoy-agents.mjs';
import { claimGateFor, tenantAgentStateOn } from './tenant-agent-state.mjs';

// The bot status functions live in bot-status.mjs (import-free, so the
// channels store can carry them too); re-exported here for the callers
// and tests that have always taken them from the mesh.
export { discordBotStatus, slackBotStatus } from './bot-status.mjs';
import { discordBotStatus, slackBotStatus } from './bot-status.mjs';

export const CHANNEL_CONFIG_PATH = '/api/admin/envoy/channel-config';
export const AGENT_WORK_PATH = '/api/admin/envoy/agent-work';
export const AGENT_MESSAGES_PATH = '/api/admin/envoy/agent-messages';
export const BRIDGE_PREFIX = '/api/admin/envoy/bridge/';
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const WORK_WINDOW_MS = 30 * 60 * 1000;
const MSG_COLS = 'id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata';

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

export function newLinkCode() {
  // 8 chars from an unambiguous alphabet (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export function messageOut(row) {
  const who = describeAuthor(row.author_subject, row.author_kind);
  return {
    id: String(row.id), channelId: String(row.channel_id), authorSubject: String(row.author_subject), authorKind: String(row.author_kind),
    ...(who.name ? { authorName: who.name } : {}), source: who.source, ...(who.provider ? { agentProvider: who.provider } : {}),
    body: String(row.body), ...(row.metadata ? { metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata } : {}), idempotencyKey: String(row.idempotency_key), createdAt: row.created_at,
  };
}

async function setTenant(client, tenantId) {
  await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
}

async function readConfig(client, tenantId, channelId) {
  const r = await client.query(
    `select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1`,
    [tenantId, channelId, CONFIG_SUBJECT],
  );
  return r.rowCount ? parseConfig(r.rows[0].body) : null;
}

async function insertMessage(client, { tenantId, channelId, subject, kind, body, key, metadata = null }) {
  const r = await client.query(
    `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
     returning ${MSG_COLS}`,
    [tenantId, channelId, subject, kind, body, key, metadata ? JSON.stringify(metadata) : null],
  );
  if (r.rowCount === 1) return { row: r.rows[0], replayed: false };
  const again = await client.query(
    `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
    [tenantId, channelId, subject, key],
  );
  return { row: again.rows[0] ?? null, replayed: true };
}

async function writeConfig(client, tenantId, channelId, config) {
  await insertMessage(client, { tenantId, channelId, subject: CONFIG_SUBJECT, kind: 'system', body: serializeConfig(config), key: `cfg:${randomUUID()}` });
}

async function notice(client, tenantId, channelId, text) {
  const { row } = await insertMessage(client, { tenantId, channelId, subject: NOTICE_SUBJECT, kind: 'system', body: text.slice(0, 4000), key: `notice:${randomUUID()}` });
  return row;
}

async function channelRow(client, tenantId, channelId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(channelId ?? ''))) throw fail(400, 'ENVOY_CHANNEL_INVALID');
  const r = await client.query('select id, slug, title, kind from helmion.envoy_channels where tenant_id=$1 and id=$2', [tenantId, channelId]);
  if (r.rowCount !== 1) throw fail(404, 'ENVOY_CHANNEL_NOT_FOUND');
  return r.rows[0];
}

function contextFor(actor) {
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: randomUUID(), requestId: randomUUID() };
}

const publish = (tenantId, row, publishImpl) => { if (row) void (publishImpl ?? publishEnvoyMessage)({ tenantId, channelId: String(row.channel_id), message: messageOut(row) }); };

export function createEnvoyMesh({ pool, now = () => Date.now(), publishImpl = null, nameLookup = null, agentStateImpl = null } = {}) {
  const tx = (actor, work) => withTenantTransaction(pool, contextFor(actor), async (client, context) => {
    await requireActiveTenantMembership(client, context);
    return work(client);
  });
  const raw = async (work) => {
    const client = await pool.connect();
    try { await client.query('begin'); const out = await work(client); await client.query('commit'); return out; }
    catch (error) { try { await client.query('rollback'); } catch {} throw error; }
    finally { client.release(); }
  };

  return Object.freeze({
    async getConfig(actor, channelId) {
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        const config = await readConfig(client, actor.tenantId, channelId);
        return { channel: { id: String(channel.id), slug: channel.slug, title: channel.title, kind: channel.kind }, configured: Boolean(config), config: publicConfig(config, now()) };
      });
    },

    async changeConfig(actor, input) {
      const action = String(input?.action ?? '');
      const channelId = String(input?.channelId ?? '');
      const admin = ['owner', 'admin'].includes(String(actor.role));
      let posted = null; let linkCode = null;
      const result = await tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        const config = (await readConfig(client, actor.tenantId, channelId)) ?? emptyConfig();
        if (action === 'add-agent' || action === 'remove-agent') {
          if (actor.role === 'auditor') throw fail(403, 'ENVOY_ROLE_FORBIDDEN');
          const provider = normalizeProvider(input?.provider);
          if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
          const has = config.agents.includes(provider);
          if (action === 'add-agent' && !has) { config.agents = [...config.agents, provider]; config.joined = { ...(config.joined ?? {}), [provider]: new Date(now()).toISOString() }; await writeConfig(client, actor.tenantId, channelId, config); posted = await notice(client, actor.tenantId, channelId, `${AGENT_NAMES[provider]} joined #${channel.title}.`); }
          if (action === 'remove-agent' && has) { config.agents = config.agents.filter((p) => p !== provider); await writeConfig(client, actor.tenantId, channelId, config); posted = await notice(client, actor.tenantId, channelId, `${AGENT_NAMES[provider]} left #${channel.title}.`); }
        } else if (action === 'link-discord') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          linkCode = newLinkCode();
          config.pendingLink = { codeHash: sha256(linkCode), expiresAt: new Date(now() + LINK_CODE_TTL_MS).toISOString() };
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'unlink-discord') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          if (config.discord || config.pendingLink) {
            const was = config.discord;
            config.discord = null; config.pendingLink = null;
            await writeConfig(client, actor.tenantId, channelId, config);
            if (was) posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is no longer linked to Discord #${was.channelName || was.channelId}.`);
          }
        } else if (action === 'link-slack') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          linkCode = newLinkCode();
          config.pendingLink = { codeHash: sha256(linkCode), expiresAt: new Date(now() + LINK_CODE_TTL_MS).toISOString() };
          await writeConfig(client, actor.tenantId, channelId, config);
        } else if (action === 'unlink-slack') {
          if (!admin) throw fail(403, 'ENVOY_ADMIN_REQUIRED');
          if (config.slack || config.pendingLink) {
            const was = config.slack;
            config.slack = null; config.pendingLink = null;
            await writeConfig(client, actor.tenantId, channelId, config);
            if (was) posted = await notice(client, actor.tenantId, channelId, `#${channel.title} is no longer linked to Slack #${was.channelName || was.channelId}.`);
          }
        } else {
          throw fail(400, 'ENVOY_CONFIG_ACTION_UNSUPPORTED');
        }
        return { config: publicConfig(config, now()), configured: true };
      });
      publish(actor.tenantId, posted, publishImpl);
      return linkCode ? { ...result, linkCode, linkCommand: `helmian link ${linkCode}` } : result;
    },

    // Messages in this tenant that one of `providers` should answer and has not.
    async agentWork(actor, providers) {
      if (actor.viaDeviceToken !== true) throw fail(403, 'ENVOY_DEVICE_TOKEN_REQUIRED');
      const wanted = [...new Set(String(providers ?? '').split(',').map(normalizeProvider).filter(Boolean))];
      if (!wanted.length) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      return tx(actor, async (client) => {
        // Claim gate (tenant-agent-state.mjs): once a tenant has ANY
        // readiness signal — a registered runner, a presence report, a
        // stored connection — those signals are authoritative: work is
        // handed over only for providers the tenant itself has a
        // credential for, and withheld providers are named in the
        // response instead of the message silently sitting. A tenant
        // with no signals at all is the hand-wired case (the operator's
        // own runners resolve credentials locally); its claiming is
        // exactly what it was before this gate existed.
        const state = await (agentStateImpl ?? tenantAgentStateOn)(client, actor.tenantId);
        const gate = claimGateFor(state);
        const withheld = new Map();
        const cfgRows = await client.query(
          `select distinct on (channel_id) channel_id, body from helmion.envoy_messages where tenant_id=$1 and author_subject=$2 order by channel_id, created_at desc, id desc`,
          [actor.tenantId, CONFIG_SUBJECT],
        );
        const since = new Date(now() - WORK_WINDOW_MS).toISOString();
        const work = [];
        for (const cfgRow of cfgRows.rows) {
          const config = parseConfig(cfgRow.body);
          if (!config || !config.agents.some((p) => wanted.includes(p))) continue;
          const channel = await channelRow(client, actor.tenantId, String(cfgRow.channel_id));
          const recent = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject <> $3 and created_at > $4 order by created_at desc, id desc limit 40`,
            [actor.tenantId, channel.id, CONFIG_SUBJECT, since],
          );
          const rows = recent.rows.reverse();
          const answered = new Set(rows.filter((r) => String(r.idempotency_key).startsWith('reply:')).map((r) => `${r.author_subject}|${String(r.idempotency_key).slice(6)}`));
          // Only messages after the agent joined count.
          for (const row of rows) {
            const message = messageOut(row);
            const at = new Date(row.created_at).getTime();
            let due = agentsToAnswer(message, config.agents, { desk: config.desk === true, room: channel.kind === 'agent' && config.desk !== true }).filter((p) => wanted.includes(p) && !answered.has(`agent:${p}|${message.id}`) && !(config.joined?.[p] && at < Date.parse(config.joined[p])));
            if (gate) {
              for (const p of due) if (!gate.has(p)) withheld.set(p, state.reason ?? 'no-provider');
              due = due.filter((p) => gate.has(p));
            }
            if (!due.length) continue;
            const context = rows.filter((r) => new Date(r.created_at) <= new Date(row.created_at) && r.author_kind !== 'system').slice(-12).map(messageOut);
            work.push({ channel: { id: String(channel.id), slug: channel.slug, title: channel.title, linkedToDiscord: Boolean(config.discord), linkedToSlack: Boolean(config.slack) }, members: config.agents, message, agents: due, context });
          }
        }
        return {
          work: work.slice(0, 20),
          agentState: { state: state.state, gated: state.gated },
          ...(withheld.size ? { withheld: [...withheld].map(([provider, reason]) => ({ provider, reason })) } : {}),
        };
      });
    },

    async postAsAgent(actor, input) {
      if (actor.viaDeviceToken !== true) throw fail(403, 'ENVOY_DEVICE_TOKEN_REQUIRED');
      const provider = normalizeProvider(input?.provider);
      if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      // No reply is ever authored by Maestro: Maestro is the human's
      // seat, not an agent, so a 'maestro' post is refused outright —
      // even where a historical roster still lists it (Bite 2).
      if (provider === 'maestro') throw fail(400, 'ENVOY_AGENT_NOT_AN_AGENT');
      const body = String(input?.body ?? '').trim();
      if (!body || body.length > 4000) throw fail(400, 'ENVOY_MESSAGE_INVALID');
      const replyTo = input?.replyTo ? String(input.replyTo) : null;
      if (replyTo && !/^[0-9a-f-]{36}$/i.test(replyTo)) throw fail(400, 'ENVOY_REPLY_INVALID');
      const key = replyTo ? `reply:${replyTo}` : String(input?.idempotencyKey ?? '').trim();
      if (key.length < 8 || key.length > 200) throw fail(400, 'ENVOY_IDEMPOTENCY_INVALID');
      let out = null;
      const result = await tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, String(input?.channelId ?? ''));
        const config = await readConfig(client, actor.tenantId, String(channel.id));
        if (!config?.agents.includes(provider)) throw fail(403, 'ENVOY_AGENT_NOT_MEMBER');
        const { row, replayed } = await insertMessage(client, { tenantId: actor.tenantId, channelId: String(channel.id), subject: agentSubject(provider), kind: 'agent', body, key });
        if (!row) throw fail(500, 'ENVOY_RECEIPT_NOT_DURABLE');
        if (!replayed) out = row;
        return { receipt: { durable: true, replayed, message: messageOut(row) } };
      });
      publish(actor.tenantId, out, publishImpl);
      return result;
    },

    // Private agent rooms (envoy-rooms.mjs): a kind 'agent' channel is one
    // agent's own room, and its roster is exactly that agent, seeded once
    // when the room is created. An existing config is never rewritten —
    // if the room already has one, it stands as it is.
    async seedRoomAgent(actor, channelId, provider) {
      const p = normalizeProvider(provider);
      if (!p) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
      // Maestro has no private room: it is the human's seat, not an agent.
      if (p === 'maestro') throw fail(400, 'ENVOY_AGENT_NOT_AN_AGENT');
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        if (channel.kind !== 'agent') throw fail(400, 'ENVOY_ROOM_KIND_INVALID');
        const existing = await readConfig(client, actor.tenantId, channelId);
        if (existing) return { seeded: false, configured: true };
        const config = emptyConfig();
        config.agents = [p];
        config.joined = { [p]: new Date(now()).toISOString() };
        await writeConfig(client, actor.tenantId, channelId, config);
        return { seeded: true, configured: true };
      });
    },

    // The Maestro desk (envoy-maestro.mjs): the tenant's one manager-seat
    // channel (reserved slug). Its config is seeded once and carries
    // desk:true — the flag that switches this channel's human sends to
    // dispatch routing in agentsToAnswer (see agentWork above). The
    // roster is the union of the agents seated in the tenant's other
    // channels, or every worker agent when the desk is the first thing
    // configured. 'maestro' is never on it: in the desk, Maestro is the
    // human sending. An existing config is never rewritten.
    async seedDesk(actor, channelId) {
      return tx(actor, async (client) => {
        const channel = await channelRow(client, actor.tenantId, channelId);
        if (channel.slug !== MAESTRO_DESK_SLUG) throw fail(400, 'ENVOY_DESK_INVALID');
        const existing = await readConfig(client, actor.tenantId, channelId);
        if (existing) return { seeded: false, configured: true, agents: existing.agents };
        const others = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id<>$2', [actor.tenantId, channel.id]);
        const seated = new Set();
        for (const row of others.rows) {
          const cfg = await readConfig(client, actor.tenantId, String(row.id));
          for (const p of cfg?.agents ?? []) if (p !== 'maestro') seated.add(p);
        }
        const roster = AGENT_PROVIDERS.filter((p) => seated.has(p));
        const config = emptyConfig();
        config.desk = true;
        config.agents = roster.length ? roster : [...DESK_ROSTER_FALLBACK];
        const stamp = new Date(now()).toISOString();
        config.joined = Object.fromEntries(config.agents.map((p) => [p, stamp]));
        await writeConfig(client, actor.tenantId, channelId, config);
        return { seeded: true, configured: true, agents: config.agents };
      });
    },

    // ---- Bridge services (Discord + Slack) ----
    async bridgeLinks() {
      return raw(async (client) => {
        const r = await client.query(
          `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 order by tenant_id, channel_id, created_at desc, id desc`,
          [CONFIG_SUBJECT],
        );
        const links = [];
        const slackLinks = [];
        for (const row of r.rows) {
          const config = parseConfig(row.body);
          if (config?.discord) links.push({ tenantId: String(row.tenant_id), envoyChannelId: String(row.channel_id), guildId: config.discord.guildId, discordChannelId: config.discord.channelId, agents: config.agents });
          if (config?.slack) slackLinks.push({ tenantId: String(row.tenant_id), envoyChannelId: String(row.channel_id), teamId: config.slack.teamId, slackChannelId: config.slack.channelId, agents: config.agents });
        }
        return { links, slackLinks };
      });
    },

    async bridgeConfirmLink(input) {
      const code = String(input?.code ?? '').trim().toUpperCase();
      if (!/^[A-Z2-9]{8}$/.test(code)) throw fail(400, 'ENVOY_LINK_CODE_INVALID');
      if (String(input?.provider ?? 'discord') === 'slack') {
        const teamId = String(input?.teamId ?? ''); const slackChannelId = String(input?.channelId ?? '');
        if (!isSlackId(teamId) || !isSlackId(slackChannelId)) throw fail(400, 'SLACK_IDS_INVALID');
        const hash = sha256(code);
        let posted = null; let tenantId = null;
        const result = await raw(async (client) => {
          const r = await client.query(
            `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 and body like $2 order by tenant_id, channel_id, created_at desc, id desc`,
            [CONFIG_SUBJECT, `%${hash}%`],
          );
          const hit = r.rows.map((row) => ({ row, config: parseConfig(row.body) })).find((x) => x.config?.pendingLink?.codeHash === hash && Date.parse(x.config.pendingLink.expiresAt) > now());
          if (!hit) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
          // The newest config for that channel must still be the one holding this code.
          tenantId = String(hit.row.tenant_id);
          await setTenant(client, tenantId);
          const current = await readConfig(client, tenantId, String(hit.row.channel_id));
          if (current?.pendingLink?.codeHash !== hash) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
          // One Envoy channel per Slack channel.
          const taken = (await this.bridgeLinks()).slackLinks.find((l) => l.slackChannelId === slackChannelId && !(l.tenantId === tenantId && l.envoyChannelId === String(hit.row.channel_id)));
          if (taken) throw fail(409, 'SLACK_CHANNEL_ALREADY_LINKED');
          const channel = await channelRow(client, tenantId, String(hit.row.channel_id));
          current.pendingLink = null;
          current.slack = { teamId, channelId: slackChannelId, channelName: String(input?.channelName ?? '').slice(0, 100), teamName: String(input?.teamName ?? '').slice(0, 100), linkedAt: new Date(now()).toISOString() };
          await writeConfig(client, tenantId, String(channel.id), current);
          posted = await notice(client, tenantId, String(channel.id), `#${channel.title} is now linked to Slack #${current.slack.channelName || slackChannelId}${current.slack.teamName ? ` in ${current.slack.teamName}` : ''}. Messages posted there now appear here.`);
          return { tenantId, envoyChannelId: String(channel.id), envoyChannelTitle: channel.title, agents: current.agents };
        });
        publish(tenantId, posted, publishImpl);
        return result;
      }
      const guildId = String(input?.guildId ?? ''); const discordChannelId = String(input?.channelId ?? '');
      if (!/^\d{5,25}$/.test(guildId) || !/^\d{5,25}$/.test(discordChannelId)) throw fail(400, 'DISCORD_IDS_INVALID');
      const hash = sha256(code);
      let posted = null; let tenantId = null;
      const result = await raw(async (client) => {
        const r = await client.query(
          `select distinct on (tenant_id, channel_id) tenant_id, channel_id, body from helmion.envoy_messages where author_subject=$1 and body like $2 order by tenant_id, channel_id, created_at desc, id desc`,
          [CONFIG_SUBJECT, `%${hash}%`],
        );
        const hit = r.rows.map((row) => ({ row, config: parseConfig(row.body) })).find((x) => x.config?.pendingLink?.codeHash === hash && Date.parse(x.config.pendingLink.expiresAt) > now());
        if (!hit) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
        // The newest config for that channel must still be the one holding this code.
        tenantId = String(hit.row.tenant_id);
        await setTenant(client, tenantId);
        const current = await readConfig(client, tenantId, String(hit.row.channel_id));
        if (current?.pendingLink?.codeHash !== hash) throw fail(404, 'ENVOY_LINK_CODE_UNKNOWN');
        // One Envoy channel per Discord channel.
        const taken = (await this.bridgeLinks()).links.find((l) => l.discordChannelId === discordChannelId && !(l.tenantId === tenantId && l.envoyChannelId === String(hit.row.channel_id)));
        if (taken) throw fail(409, 'DISCORD_CHANNEL_ALREADY_LINKED');
        const channel = await channelRow(client, tenantId, String(hit.row.channel_id));
        current.pendingLink = null;
        current.discord = { guildId, channelId: discordChannelId, channelName: String(input?.channelName ?? '').slice(0, 100), guildName: String(input?.guildName ?? '').slice(0, 100), linkedAt: new Date(now()).toISOString() };
        await writeConfig(client, tenantId, String(channel.id), current);
        posted = await notice(client, tenantId, String(channel.id), `#${channel.title} is now linked to Discord #${current.discord.channelName || discordChannelId}${current.discord.guildName ? ` in ${current.discord.guildName}` : ''}. Messages and agent replies mirror both ways.`);
        return { tenantId, envoyChannelId: String(channel.id), envoyChannelTitle: channel.title, agents: current.agents };
      });
      publish(tenantId, posted, publishImpl);
      return result;
    },

    async bridgeInbound(input) {
      const tenantId = String(input?.tenantId ?? ''); const envoyChannelId = String(input?.envoyChannelId ?? '');
      if (String(input?.provider ?? 'discord') === 'slack') {
        // A Slack message id is its ts: "1729900000.000100". It is the
        // idempotency anchor — Slack redelivers events, and the stored
        // key `slack:<ts>` makes a redelivery a replay, never a dupe.
        const messageId = String(input?.slackMessageId ?? '');
        if (!/^\d{5,20}\.\d{1,10}$/.test(messageId)) throw fail(400, 'SLACK_MESSAGE_ID_INVALID');
        const body = String(input?.body ?? '').trim();
        if (!body) return { skipped: 'empty' };
        const subject = slackSubject(input?.authorId, input?.authorName);
        let out = null;
        const result = await raw(async (client) => {
          await setTenant(client, tenantId);
          const config = await readConfig(client, tenantId, envoyChannelId);
          if (!config?.slack || config.slack.channelId !== String(input?.slackChannelId ?? '')) throw fail(403, 'SLACK_CHANNEL_NOT_LINKED');
          if (input?.teamId && config.slack.teamId !== String(input.teamId)) throw fail(403, 'SLACK_CHANNEL_NOT_LINKED');
          const metadata = { source: { provider: 'slack', teamId: config.slack.teamId, channelId: config.slack.channelId, channelName: config.slack.channelName } };
          const { row, replayed } = await insertMessage(client, { tenantId, channelId: envoyChannelId, subject, kind: 'human', body: body.slice(0, 4000), key: `slack:${messageId}`, metadata });
          if (!replayed) out = row;
          return { receipt: { durable: true, replayed, message: row ? messageOut(row) : null } };
        });
        publish(tenantId, out, publishImpl);
        return result;
      }
      const messageId = String(input?.discordMessageId ?? '');
      if (!/^\d{5,25}$/.test(messageId)) throw fail(400, 'DISCORD_MESSAGE_ID_INVALID');
      const body = String(input?.body ?? '').trim();
      if (!body) return { skipped: 'empty' };
      const subject = discordSubject(input?.authorId, input?.authorName);
      let out = null;
      const result = await raw(async (client) => {
        await setTenant(client, tenantId);
        const config = await readConfig(client, tenantId, envoyChannelId);
        if (!config?.discord || config.discord.channelId !== String(input?.discordChannelId ?? '')) throw fail(403, 'DISCORD_CHANNEL_NOT_LINKED');
        const { row, replayed } = await insertMessage(client, { tenantId, channelId: envoyChannelId, subject, kind: 'human', body: body.slice(0, 4000), key: `discord:${messageId}` });
        if (!replayed) out = row;
        return { receipt: { durable: true, replayed, message: row ? messageOut(row) : null } };
      });
      publish(tenantId, out, publishImpl);
      return result;
    },

    async bridgeOutbound(sinceValue) {
      const since = Number.isFinite(Date.parse(String(sinceValue ?? ''))) ? new Date(String(sinceValue)) : new Date(now() - 60_000);
      const { links, slackLinks } = await this.bridgeLinks();
      if (!links.length && !slackLinks.length) return { messages: [], links: 0, slackLinks: 0 };
      return raw(async (client) => {
        const out = [];
        for (const link of links) {
          await setTenant(client, link.tenantId);
          const r = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and created_at > $3 and author_subject <> $4 and author_subject not like 'discord:%' order by created_at asc, id asc limit 50`,
            [link.tenantId, link.envoyChannelId, since.toISOString(), CONFIG_SUBJECT],
          );
          for (const row of r.rows) {
            const m = messageOut(row);
            let displayName = m.authorName;
            if (!displayName && m.authorKind === 'human' && nameLookup) { try { displayName = await nameLookup(m.authorSubject); } catch {} }
            out.push({ ...m, tenantId: link.tenantId, discordChannelId: link.discordChannelId, guildId: link.guildId, displayName: displayName || 'Helmian member' });
          }
        }
        // Slack feed: same window, but a channel's Slack-born messages are
        // never echoed back to Slack (origin exclusion on 'slack:%').
        for (const link of slackLinks) {
          await setTenant(client, link.tenantId);
          const r = await client.query(
            `select ${MSG_COLS} from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and created_at > $3 and author_subject <> $4 and author_subject not like 'slack:%' order by created_at asc, id asc limit 50`,
            [link.tenantId, link.envoyChannelId, since.toISOString(), CONFIG_SUBJECT],
          );
          for (const row of r.rows) {
            const m = messageOut(row);
            let displayName = m.authorName;
            if (!displayName && m.authorKind === 'human' && nameLookup) { try { displayName = await nameLookup(m.authorSubject); } catch {} }
            out.push({ ...m, tenantId: link.tenantId, slackChannelId: link.slackChannelId, teamId: link.teamId, displayName: displayName || 'Helmian member' });
          }
        }
        out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return { messages: out.slice(0, 200), links: links.length, slackLinks: slackLinks.length };
      });
    },
  });
}

export function bridgeTokenOk(request, expected = process.env.HELMIAN_ENVOY_BRIDGE_TOKEN) {
  const want = String(expected ?? '').trim();
  if (want.length < 32) return null; // not configured
  const h = String(request?.headers?.authorization ?? '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const a = Buffer.from(sha256(got)); const b = Buffer.from(sha256(want));
  return timingSafeEqual(a, b);
}

// Clerk display names for Helmian humans mirrored to Discord. Cached, best effort.
const nameCache = new Map();
export async function clerkDisplayName(subject, { secret = process.env.CLERK_SECRET_KEY, fetchImpl = fetch } = {}) {
  if (!/^user_[A-Za-z0-9]{10,64}$/.test(String(subject)) || !secret) return null;
  const hit = nameCache.get(subject);
  if (hit && hit.at > Date.now() - 10 * 60_000) return hit.name;
  const res = await fetchImpl(`https://api.clerk.com/v1/users/${subject}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) return null;
  const u = await res.json();
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || null;
  nameCache.set(subject, { name, at: Date.now() });
  return name;
}

export async function handleEnvoyMeshRoute({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson, mesh = null } = {}) {
  const path = requestUrl?.pathname ?? '';
  const ours = path === CHANNEL_CONFIG_PATH || path === AGENT_WORK_PATH || path === AGENT_MESSAGES_PATH || path.startsWith(BRIDGE_PREFIX);
  if (!ours) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error, fallback) => {
    const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? fallback });
  };
  let store;
  try { store = mesh ?? createEnvoyMesh({ pool: getPool(), nameLookup: (s) => clerkDisplayName(s) }); }
  catch (error) { reply(503, { valid: false, code: 'ENVOY_STORE_UNAVAILABLE' }); return true; }
  const body = async () => { try { return (await readJson(request)) ?? {}; } catch { throw fail(400, 'ENVOY_BODY_INVALID'); } };

  if (path.startsWith(BRIDGE_PREFIX)) {
    const ok = bridgeTokenOk(request);
    if (ok === null) { reply(503, { valid: false, code: 'ENVOY_BRIDGE_NOT_CONFIGURED' }); return true; }
    if (!ok) { reply(401, { valid: false, code: 'ENVOY_BRIDGE_UNAUTHORIZED' }); return true; }
    const sub = path.slice(BRIDGE_PREFIX.length);
    try {
      if (request.method === 'GET' && sub === 'links') reply(200, { valid: true, ...await store.bridgeLinks() });
      else if (request.method === 'GET' && sub === 'outbound') reply(200, { valid: true, ...await store.bridgeOutbound(requestUrl.searchParams.get('since')) });
      else if (request.method === 'POST' && sub === 'confirm-link') reply(200, { valid: true, ...await store.bridgeConfirmLink(await body()) });
      else if (request.method === 'POST' && sub === 'inbound') reply(200, { valid: true, ...await store.bridgeInbound(await body()) });
      else reply(404, { valid: false, code: 'ENVOY_BRIDGE_ROUTE_UNKNOWN' });
    } catch (error) { failure(error, 'ENVOY_BRIDGE_FAILED'); }
    return true;
  }

  try {
    const actor = await activeTenantActor(request);
    if (path === CHANNEL_CONFIG_PATH && request.method === 'GET') reply(200, { valid: true, ...await store.getConfig(actor, requestUrl.searchParams.get('channel_id')), discordBot: discordBotStatus(), slackBot: slackBotStatus() });
    else if (path === CHANNEL_CONFIG_PATH && request.method === 'POST') reply(200, { valid: true, ...await store.changeConfig(actor, await body()) });
    else if (path === AGENT_WORK_PATH && request.method === 'GET') reply(200, { valid: true, ...await store.agentWork(actor, requestUrl.searchParams.get('providers')) });
    else if (path === AGENT_MESSAGES_PATH && request.method === 'POST') reply(200, { valid: true, ...await store.postAsAgent(actor, await body()) });
    else reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' });
  } catch (error) { failure(error, 'ENVOY_MESH_FAILED'); }
  return true;
}

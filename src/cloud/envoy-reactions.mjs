// Envoy message reactions: the server + data half (emoji bite 2,
// 2026-11-04). A reaction is an attributed room event, not decoration:
// one row per (message, emoji, actor) in helmion.envoy_message_reactions
// (sql/068), written and read through this store, and mirrored to the
// room's realtime channel on every change. Members and agents react
// through the same road — a seat 👍-ing a message is the same kind of
// event as a member doing it (plan §5.6), with the actor's kind and
// subject on the row, so who reacted is stored and returnable.
//
// Identity follows the message roads exactly. A browser member reacts
// as themselves (actor from the session). An agent reacts through the
// worker's device-token road, naming its provider in the body exactly
// like postAsAgent (envoy-mesh.mjs): the subject is derived server-side
// via agentSubject, 'maestro' is refused (Maestro is the human's seat),
// and a custom agent must be on the channel's roster. Nothing here
// trusts a client-supplied actor.
//
// The emoji vocabulary is bite 1's map (web/marketing/app/emoji-map.mjs):
// the row stores the asset SLUG, and a request may name the slug or the
// Unicode character — the character normalizes through the same map the
// desk renders by, so the two can never drift. The pack column rides
// every row from day one (sql/068): only the default pack ships in this
// bite and no entitlement is enforced yet; when packs land, the check
// belongs at the same seam that validates the slug.
//
// Counts are the row count. There is no cached tally to lose: add is an
// insert that conflicts to nothing, remove is a delete, toggle is one
// then the other inside one transaction, so what the list read returns
// after a reload is what was written.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the envoy-ably hook (envoy-ably.mjs delegates here),
// like runner presence and the mesh.
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { CONFIG_SUBJECT, agentSubject, describeAuthor, normalizeCustomHandle, normalizeProvider, parseConfig } from './envoy-agents.mjs';
import { envoyChannelName, parseAblyApiKey } from './envoy-ably.mjs';
import { EMOJI_MAP, emojiAssetSlug } from '../../web/marketing/app/emoji-map.mjs';

export const MESSAGE_REACTIONS_PATH = '/api/admin/envoy/message-reactions';
export const REACTION_PACK_DEFAULT = 'default';
export const REACTION_EMOJI_SLUGS = Object.freeze([...new Set(Object.values(EMOJI_MAP))].sort());
const SLUG_SET = new Set(REACTION_EMOJI_SLUGS);
const UUID_RE = /^[0-9a-f-]{36}$/i;
const PACK_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MESSAGE_IDS = 100;
const REACTION_ACTIONS = new Set(['toggle', 'add', 'remove']);
const ENVOY_ABLY_REST = 'https://rest.ably.io';

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const isMissingTable = (error) => error?.code === '42P01';

// A request names a reaction by slug ('fire') or by the character the
// user tapped ('🔥'); both land on the shipped set's slug. Anything else
// — an unmapped emoji, a ZWJ sequence, an unknown slug — is refused, so
// a reaction can never point at an asset that does not exist.
export function normalizeReactionEmoji(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw fail(400, 'ENVOY_REACTION_EMOJI_REQUIRED');
  if (SLUG_SET.has(raw)) return raw;
  const slug = emojiAssetSlug(raw);
  if (slug) return slug;
  throw fail(400, 'ENVOY_REACTION_EMOJI_UNSUPPORTED');
}

// The pack a reaction belongs to. Only 'default' ships in this bite;
// the field is validated and stored so the economy layer (paid/earned
// packs, tenant packs) bolts on without a data rebuild.
export function normalizeReactionPack(input) {
  if (input === undefined || input === null || String(input).trim() === '') return REACTION_PACK_DEFAULT;
  const pack = String(input).trim().toLowerCase();
  if (!PACK_RE.test(pack)) throw fail(400, 'ENVOY_REACTION_PACK_INVALID');
  return pack;
}

export function normalizeReactionAction(input) {
  if (input === undefined || input === null || String(input).trim() === '') return 'toggle';
  const action = String(input).trim().toLowerCase();
  if (!REACTION_ACTIONS.has(action)) throw fail(400, 'ENVOY_REACTION_ACTION_INVALID');
  return action;
}

function uuid(value, code) {
  const result = String(value ?? '').trim();
  if (!UUID_RE.test(result)) throw fail(400, code);
  return result;
}

// Group flat reaction rows into per-emoji summaries: count plus the
// attributed actors in the order they reacted. Display names/providers
// derive through describeAuthor, the same derivation message authors
// get, so a reactor reads identically to an author everywhere.
function summarizeReactions(rows, customAgents = []) {
  const byEmoji = new Map();
  for (const row of rows) {
    const emoji = String(row.emoji);
    let entry = byEmoji.get(emoji);
    if (!entry) {
      entry = { emoji, pack: String(row.pack), count: 0, actors: [] };
      byEmoji.set(emoji, entry);
    }
    entry.count += 1;
    const who = describeAuthor(String(row.actor_subject), String(row.actor_kind), customAgents);
    entry.actors.push(Object.freeze({
      subject: String(row.actor_subject),
      kind: String(row.actor_kind),
      ...(who.name ? { name: who.name } : {}),
      ...(who.provider ? { provider: who.provider } : {}),
      at: row.created_at,
    }));
  }
  return [...byEmoji.values()];
}

// Room-event mirror: fire-and-forget publish of one reaction change to
// the channel's realtime stream, under the event name 'reaction' so
// subscribers can tell it from a 'message'. Same never-throws contract
// and the same Ably REST road as envoy-ably's publishEnvoyMessage; the
// list read stays the source of truth, this is the live nudge.
export async function publishEnvoyReaction({
  tenantId,
  channelId,
  event,
  ablyKey = process.env.ABLY_API_KEY,
  fetchImpl = fetch,
  log = null,
} = {}) {
  let keyName;
  let keySecret;
  try {
    ({ keyName, keySecret } = parseAblyApiKey(ablyKey));
  } catch {
    return { published: false, reason: 'ably_not_configured' };
  }
  const channel = envoyChannelName(tenantId, channelId);
  try {
    const res = await fetchImpl(`${ENVOY_ABLY_REST}/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${keyName}:${keySecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'reaction', data: event }),
    });
    if (!res?.ok) {
      log?.(`envoy reaction publish failed: http ${res?.status ?? 'unknown'}`);
      return { published: false, reason: `http_${res?.status ?? 'unknown'}` };
    }
    return { published: true, channel };
  } catch (err) {
    log?.(`envoy reaction publish error: ${err?.message ?? err}`);
    return { published: false, reason: 'error' };
  }
}

// Own lazy pool, same env var and ssl rule as the sibling envoy stores:
// live-admin.mjs owns the primary pool and cannot pass it through the
// frozen hook.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

export function createEnvoyReactionsStore(pool, { publishImpl = null } = {}) {
  // Same transaction shape as the mesh store: tenant context from the
  // verified actor, active membership required for every caller —
  // device-token agent callers included, exactly as postAsAgent runs.
  const contextFor = (actor) => ({
    tenantId: actor.tenantId,
    actorSubject: actor.subject,
    actorRole: actor.role,
    sessionId: randomUUID(),
    requestId: randomUUID(),
  });
  const tx = (actor, work) => withTenantTransaction(pool, contextFor(actor), async (client, context) => {
    await requireActiveTenantMembership(client, context);
    return work(client);
  });

  const channelRow = async (client, tenantId, channelId) => {
    if (!UUID_RE.test(String(channelId ?? ''))) throw fail(400, 'ENVOY_CHANNEL_INVALID');
    const r = await client.query('select id, slug, title, kind from helmion.envoy_channels where tenant_id=$1 and id=$2', [tenantId, channelId]);
    if (r.rowCount !== 1) throw fail(404, 'ENVOY_CHANNEL_NOT_FOUND');
    return r.rows[0];
  };

  // The channel's newest config row, the same rows the mesh reads: the
  // roster (agents + customAgents) an agent reaction is checked against.
  const readConfig = async (client, tenantId, channelId) => {
    const r = await client.query(
      'select body from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 order by created_at desc, id desc limit 1',
      [tenantId, channelId, CONFIG_SUBJECT],
    );
    return r.rowCount ? parseConfig(r.rows[0].body) : null;
  };

  // The target must be a real, visible message in this channel: config
  // rows share the messages table and are not reactable.
  const messageRow = async (client, tenantId, channelId, messageId) => {
    const r = await client.query(
      'select id from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject <> $4',
      [tenantId, channelId, messageId, CONFIG_SUBJECT],
    );
    if (r.rowCount !== 1) throw fail(404, 'ENVOY_MESSAGE_NOT_FOUND');
    return r.rows[0];
  };

  const reactionRows = async (client, tenantId, channelId, messageIds) => {
    const r = await client.query(
      `select message_id, emoji, pack, actor_subject, actor_kind, created_at
       from helmion.envoy_message_reactions
       where tenant_id=$1 and channel_id=$2 and message_id = any($3::uuid[])
       order by created_at asc, actor_subject asc`,
      [tenantId, channelId, messageIds],
    );
    return r.rows;
  };

  return Object.freeze({
    // Summaries for a page of messages (the desk's read): every requested
    // id answers, with an empty list when nobody has reacted, plus the
    // caller's own reactions per message so a client can render toggle
    // state without a second call. Before sql/068 the read is empty,
    // like presence before its migration.
    async listForMessages(actor, channelId, messageIds) {
      const normalizedChannelId = uuid(channelId, 'ENVOY_CHANNEL_INVALID');
      const ids = [...new Set((messageIds ?? []).map((id) => uuid(id, 'ENVOY_MESSAGE_INVALID')))];
      if (!ids.length) throw fail(400, 'ENVOY_MESSAGE_IDS_REQUIRED');
      if (ids.length > MAX_MESSAGE_IDS) throw fail(400, 'ENVOY_MESSAGE_IDS_TOO_MANY');
      try {
        return await tx(actor, async (client) => {
          await channelRow(client, actor.tenantId, normalizedChannelId);
          const config = await readConfig(client, actor.tenantId, normalizedChannelId);
          const rows = await reactionRows(client, actor.tenantId, normalizedChannelId, ids);
          const byMessage = new Map(ids.map((id) => [id, []]));
          for (const row of rows) byMessage.get(String(row.message_id))?.push(row);
          const reactions = {};
          const mine = {};
          for (const id of ids) {
            const own = byMessage.get(id) ?? [];
            reactions[id] = summarizeReactions(own, config?.customAgents ?? []);
            mine[id] = own.filter((row) => String(row.actor_subject) === actor.subject).map((row) => String(row.emoji));
          }
          return { channelId: normalizedChannelId, reactions, mine };
        });
      } catch (error) {
        if (isMissingTable(error)) {
          return { channelId: normalizedChannelId, reactions: Object.fromEntries(ids.map((id) => [id, []])), mine: Object.fromEntries(ids.map((id) => [id, []])) };
        }
        throw error;
      }
    },

    // One reaction change. Members act as themselves; device-token
    // callers act as the agent their body names (see the header). The
    // response carries the message's full summary after the change, so
    // the caller renders the chip row from the answer alone.
    async toggleReaction(actor, input) {
      const channelId = uuid(input?.channelId, 'ENVOY_CHANNEL_INVALID');
      const messageId = uuid(input?.messageId, 'ENVOY_MESSAGE_INVALID');
      const emoji = normalizeReactionEmoji(input?.emoji);
      const pack = normalizeReactionPack(input?.pack);
      const action = normalizeReactionAction(input?.action);
      const isDevice = actor?.viaDeviceToken === true;
      // The provider is validated here, but the agent's subject is only
      // derived inside the transaction, against the channel's own
      // roster — the same order postAsAgent follows.
      let provider = null;
      if (isDevice) {
        provider = normalizeProvider(input?.provider) ?? normalizeCustomHandle(input?.provider);
        if (!provider) throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
        if (provider === 'maestro') throw fail(400, 'ENVOY_AGENT_NOT_AN_AGENT');
      }
      let out;
      try {
        out = await tx(actor, async (client) => {
          const channel = await channelRow(client, actor.tenantId, channelId);
          await messageRow(client, actor.tenantId, String(channel.id), messageId);
          let actorSubject = actor.subject;
          let actorKind = 'human';
          const config = await readConfig(client, actor.tenantId, String(channel.id));
          if (isDevice) {
            if (!normalizeProvider(provider) && !(config?.customAgents ?? []).some((a) => (a.handle || a.id) === provider)) {
              throw fail(400, 'ENVOY_AGENT_UNSUPPORTED');
            }
            if (!(config?.agents ?? []).includes(provider)) throw fail(403, 'ENVOY_AGENT_NOT_MEMBER');
            actorSubject = agentSubject(provider, config?.customAgents ?? []);
            actorKind = 'agent';
          }
          // Toggle is add-then-remove inside this one transaction: an
          // insert that lands is the add; an insert that conflicts to
          // nothing means the reaction already stands, so the toggle
          // removes it. Explicit add/remove skip the other half, which
          // makes a replayed add and a remove of an absent reaction
          // clean no-ops (changed:false, and no room event is mirrored).
          let changed = false;
          let reacted;
          if (action === 'remove') {
            const removed = await client.query(
              `delete from helmion.envoy_message_reactions
               where tenant_id=$1 and message_id=$2 and emoji=$3 and actor_subject=$4`,
              [actor.tenantId, messageId, emoji, actorSubject],
            );
            changed = removed.rowCount === 1;
            reacted = false;
          } else {
            const inserted = await client.query(
              `insert into helmion.envoy_message_reactions(tenant_id, channel_id, message_id, emoji, pack, actor_subject, actor_kind)
               values ($1,$2,$3,$4,$5,$6,$7)
               on conflict (tenant_id, message_id, emoji, actor_subject) do nothing`,
              [actor.tenantId, String(channel.id), messageId, emoji, pack, actorSubject, actorKind],
            );
            if (inserted.rowCount === 1) {
              changed = true;
              reacted = true;
            } else if (action === 'add') {
              reacted = true;
            } else {
              const removed = await client.query(
                `delete from helmion.envoy_message_reactions
                 where tenant_id=$1 and message_id=$2 and emoji=$3 and actor_subject=$4`,
                [actor.tenantId, messageId, emoji, actorSubject],
              );
              changed = removed.rowCount === 1;
              reacted = false;
            }
          }
          const rows = await reactionRows(client, actor.tenantId, String(channel.id), [messageId]);
          return {
            messageId,
            channelId: String(channel.id),
            emoji,
            pack,
            action: reacted ? 'added' : 'removed',
            reacted,
            changed,
            actorSubject,
            actorKind,
            reactions: summarizeReactions(rows, config?.customAgents ?? []),
          };
        });
      } catch (error) {
        if (isMissingTable(error)) throw fail(503, 'ENVOY_REACTIONS_UNAVAILABLE');
        throw error;
      }
      // Mirror the change to the room's realtime channel after the
      // write has committed, and only when something actually changed —
      // a replayed add is not a new event. Fire-and-forget, like the
      // message publish: a realtime failure never fails the reaction.
      if (out.changed) {
        const count = out.reactions.find((entry) => entry.emoji === emoji)?.count ?? 0;
        const event = {
          type: 'reaction',
          action: out.action,
          messageId,
          channelId: out.channelId,
          emoji,
          pack,
          actorSubject: out.actorSubject,
          actorKind: out.actorKind,
          count,
          at: new Date().toISOString(),
        };
        void Promise.resolve()
          .then(() => (publishImpl ?? publishEnvoyReaction)({ tenantId: actor.tenantId, channelId: out.channelId, event }))
          .catch(() => {});
      }
      return out;
    },
  });
}

// Route delegate. GET lists summaries for a page of messages; POST
// applies one toggle/add/remove. Member auth via activeTenantActor,
// device-token agent callers ride the same path (see the header).
// Returns false when the request is not ours.
export async function handleEnvoyReactionsRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store: injectedStore,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== MESSAGE_REACTIONS_PATH) return false;
  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error) => {
    const status = error?.status && error.status >= 400 && error.status < 600
      ? error.status
      : (error instanceof TenantAuthorizationError ? 403 : 400);
    reply(status, { valid: false, code: error?.code ?? 'ENVOY_REACTIONS_FAILED' });
  };
  let store;
  try {
    store = injectedStore ?? createEnvoyReactionsStore(getPool());
  } catch {
    reply(503, { valid: false, code: 'ENVOY_REACTIONS_UNAVAILABLE' });
    return true;
  }
  try {
    const actor = await activeTenantActor(request);
    if (request.method === 'GET') {
      const ids = [
        ...(requestUrl.searchParams.getAll('message_id') ?? []),
        ...String(requestUrl.searchParams.get('message_ids') ?? '').split(','),
      ].map((value) => value.trim()).filter(Boolean);
      reply(200, { valid: true, ...await store.listForMessages(actor, requestUrl.searchParams.get('channel_id'), ids) });
    } else if (request.method === 'POST') {
      let body;
      try { body = (await readJson(request)) ?? {}; } catch { throw fail(400, 'ENVOY_BODY_INVALID'); }
      reply(200, { valid: true, ...await store.toggleReaction(actor, body) });
    } else {
      reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' });
    }
  } catch (error) {
    failure(error);
  }
  return true;
}

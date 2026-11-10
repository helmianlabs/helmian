import { publishEnvoyMessage } from './envoy-ably.mjs';

const KINDS = new Set(['team', 'direct', 'agent']);
const AUTHORS = new Set(['human', 'agent', 'system']);

function text(value, name, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`${name} is missing or too long`);
  return result;
}

function cursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!/^\d{1,20}$/.test(result)) throw new Error('message cursor is invalid');
  return result;
}

export function normalizeEnvoyChannel(input) {
  const slug = text(input?.slug, 'channel slug', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('channel slug is invalid');
  const kind = text(input?.kind ?? 'team', 'channel kind', 16).toLowerCase();
  if (!KINDS.has(kind)) throw new Error('channel kind is unsupported');
  return Object.freeze({ slug, title: text(input?.title, 'channel title', 120), kind });
}

export function normalizeEnvoyMessage(input) {
  const authorKind = text(input?.authorKind, 'author kind', 16).toLowerCase();
  if (!AUTHORS.has(authorKind)) throw new Error('author kind is unsupported');
  // Attachments arrive either as a `metadata` object or as a bare
  // `attachments` array (the picker's two shapes); both normalize to the
  // one stored metadata form. Absent stays absent — the pre-picker wire
  // shape is unchanged.
  const metadata = normalizeMessageMetadata(input?.metadata ?? (input?.attachments !== undefined ? { attachments: input.attachments } : undefined));
  return Object.freeze({
    channelId: text(input?.channelId, 'channel id', 64),
    authorSubject: text(input?.authorSubject, 'author subject', 256),
    authorKind,
    body: text(input?.body, 'message body', 4000),
    ...(metadata ? { metadata } : {}),
  });
}

/**
 * Envoy is allowed to display/send a message only after the caller has
 * already established the same tenant membership used by the other surfaces.
 * This helper is a policy seam, not an authorization bypass or agent runner.
 */
export function assertEnvoyMembership({ tenantId, subject, role, canUseEnvoy }) {
  if (!text(tenantId, 'tenant id', 128) || !text(subject, 'subject', 256)) {
    throw new Error('Envoy identity is incomplete');
  }
  if (!['owner', 'admin', 'member', 'auditor'].includes(String(role ?? '').toLowerCase())) {
    throw new Error('Envoy role is unsupported');
  }
  if (canUseEnvoy !== true) throw new Error('Envoy access is not enabled for this identity');
  return true;
}

function contextFor(actor) {
  assertEnvoyMembership({ tenantId: actor.tenantId, subject: actor.subject, role: actor.role, canUseEnvoy: true });
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function rowMessage(row, authorEmoji = null) {
  const who = describeAuthor(row.author_subject, row.author_kind);
  const metadata = row.metadata ? normalizeMessageMetadata(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
  return Object.freeze({ id: String(row.id), channelId: String(row.channel_id), authorSubject: String(row.author_subject), authorKind: String(row.author_kind), ...(who.name ? { authorName: who.name } : {}), ...(authorEmoji ? { authorEmoji } : {}), source: who.source, ...(who.provider ? { agentProvider: who.provider } : {}), body: String(row.body), ...(metadata ? { metadata } : {}), idempotencyKey: String(row.idempotency_key), createdAt: row.created_at });
}

// Member faces (emoji bite 5): a human author's profile emoji
// (helmion.user_profiles.avatar_emoji — the Settings > Envoy profile
// record) rides their messages, so every client renders the member's
// chosen face instead of a bare initial. Best-effort by shape:
// profiles are a separate store with their own migration history
// (059/062), so a missing table or a failed read yields no faces,
// never a failed message list.
async function profileEmojis(client, subjects) {
  const wanted = [...new Set((subjects ?? []).filter((s) => typeof s === 'string' && s))];
  if (!wanted.length) return new Map();
  try {
    const r = await client.query('select subject, avatar_emoji from helmion.user_profiles where subject = any($1::text[])', [wanted]);
    return new Map(r.rows.filter((row) => row.avatar_emoji).map((row) => [String(row.subject), String(row.avatar_emoji)]));
  } catch { return new Map(); }
}

// ---------- the empty-desk answer (polish P1, 2026-11-09) ----------
// The fresh-signup walk's headline finding: a first message in a
// workspace with no AI connected got a dispatch line and then
// silence — the mesh withholds the work (no provider credential to
// hand it to) and nothing told the person. The state module names
// that honestly in its banner; this is the same honesty inside the
// channel, as a reply: when a human send lands in a tenant with
// ZERO connected providers (tenant-agent-state's connectedProviders
// — runner presence reports and stored connections), Maestro
// answers the message himself with the one fix: connect an AI from
// the Agents tab. The answer is a stored agent message under
// 'agent:maestro', so it renders as Maestro, persists like any
// reply, and is filtered out of every routing result by the same
// 'maestro' exclusions that guard the desk. It is NOT gated on the
// state module's `gated` flag: a brand-new workspace has no
// readiness signals at all and is exactly the case that must be
// answered, while a hand-wired tenant whose runners resolve
// credentials locally reports connected providers and never sees
// it. Two restraint rules: a replayed send (idempotent retry)
// answers nothing new, and the answer never answers itself — when
// the channel's previous word is already this answer, the next
// send waits for a connection instead of stacking copies.
export const EMPTY_DESK_SUBJECT = 'agent:maestro';
export const EMPTY_DESK_ANSWER_BODY = 'Maestro here — no AI is connected to this workspace yet, so nobody can answer your message. Open the Agents tab and press Connect on the AI you already have, and your messages will be answered here.';
export const EMPTY_DESK_KEY_PREFIX = 'maestro-empty-desk:';

/** The pure decision: answer this send, or stay quiet. */
export function emptyDeskAnswerDecision({ connectedProviders, previousSubject, previousKey } = {}) {
  if (!Array.isArray(connectedProviders) || connectedProviders.length > 0) return false;
  if (previousSubject === EMPTY_DESK_SUBJECT && String(previousKey ?? '').startsWith(EMPTY_DESK_KEY_PREFIX)) return false;
  return true;
}

/**
 * Post the empty-desk answer for one durable human message, in its
 * own tenant transaction (the maestro-activation notice pattern:
 * best-effort, separate from the send's durability). `stateOn` is
 * injectable for tests. Returns { answered } — a thrown error is
 * the caller's to log; this helper never swallows one silently.
 */
export async function postEmptyDeskAnswerIfNeeded({ pool, tenantId, channelId, messageId, stateOn = tenantAgentStateOn } = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('helmion.tenant_id', $1, true)`, [String(tenantId)]);
    const state = await stateOn(client, tenantId);
    const prev = await client.query(
      `select author_subject, idempotency_key from helmion.envoy_messages
        where tenant_id=$1 and channel_id=$2 and author_subject <> $3 and id <> $4
        order by id desc limit 1`,
      [String(tenantId), String(channelId), CONFIG_SUBJECT, messageId],
    );
    const previous = prev.rows[0] ?? null;
    const answer = emptyDeskAnswerDecision({
      connectedProviders: state?.connectedProviders,
      previousSubject: previous?.author_subject ?? null,
      previousKey: previous?.idempotency_key ?? null,
    });
    if (!answer) { await client.query('commit'); return { answered: false }; }
    const inserted = await client.query(
      `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
       values ($1,$2,$3,'agent',$4,$5)
       on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
       returning id`,
      [String(tenantId), String(channelId), EMPTY_DESK_SUBJECT, EMPTY_DESK_ANSWER_BODY, `${EMPTY_DESK_KEY_PREFIX}${messageId}`],
    );
    await client.query('commit');
    return { answered: inserted.rowCount === 1, messageId: inserted.rows[0] ? String(inserted.rows[0].id) : null };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

export function createEnvoyStore(pool) {
  return Object.freeze({
    async listChannels(actor) {
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('select id, slug, title, kind, created_by_subject, created_at from helmion.envoy_channels where tenant_id=$1 order by created_at, id', [context.tenantId]);
        const channels = result.rows.map((row) => Object.freeze({ id: String(row.id), slug: String(row.slug), title: String(row.title), kind: String(row.kind), createdBySubject: String(row.created_by_subject), createdAt: row.created_at }));
        const configs = await client.query(
          'select distinct on (channel_id) channel_id, body from helmion.envoy_messages where tenant_id=$1 and author_subject=$2 order by channel_id, created_at desc, id desc',
          [context.tenantId, CONFIG_SUBJECT],
        );
        const configsByChannelId = new Map(configs.rows.map((row) => [String(row.channel_id), parseConfig(row.body)]));
        return { channels: attachChannelLinks(channels, configsByChannelId), discordBot: discordBotStatus(), slackBot: slackBotStatus() };
      });
    },
    async createChannel(actor, input) {
      const channel = normalizeEnvoyChannel(input);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.envoy_channels(tenant_id, slug, title, kind, created_by_subject)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, slug) do update set slug=excluded.slug
           returning id, slug, title, kind, created_by_subject, created_at, (xmax = 0) as inserted`,
          [context.tenantId, channel.slug, channel.title, channel.kind, context.actorSubject],
        );
        if (result.rows[0]?.inserted) {
          await appendAuditEvent(client, context, { actionType: 'envoy.channel.created', canonicalTarget: { channelId: String(result.rows[0].id), slug: channel.slug, kind: channel.kind }, policyVersion: 'envoy-chat.v1', decision: 'ALLOW', privacySummary: `Created the ${channel.title} channel`, result: { created: true } });
        }
        return { channel: Object.freeze({ id: String(result.rows[0].id), slug: String(result.rows[0].slug), title: String(result.rows[0].title), kind: String(result.rows[0].kind), createdBySubject: String(result.rows[0].created_by_subject), createdAt: result.rows[0].created_at }), inserted: result.rows[0]?.inserted === true };
      });
    },
    async listMessages(actor, channelId, limit = 50, afterId = null) {
      const normalizedChannelId = text(channelId, 'channel id', 64);
      const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const normalizedCursor = cursor(afterId);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const channel = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id=$2', [context.tenantId, normalizedChannelId]);
        if (channel.rowCount !== 1) throw new Error('Envoy channel was not found in this Organization');
        const result = normalizedCursor
          ? await client.query(
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and id > $3 and author_subject <> 'system:envoy-config'
             order by id asc limit $4`,
            [context.tenantId, normalizedChannelId, normalizedCursor, boundedLimit],
          )
          : await client.query(
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject <> 'system:envoy-config'
             order by created_at desc, id desc limit $3`,
            [context.tenantId, normalizedChannelId, boundedLimit],
          );
        const rows = normalizedCursor ? result.rows : result.rows.slice().reverse();
        const faces = await profileEmojis(client, rows.filter((r) => r.author_kind === 'human').map((r) => String(r.author_subject)));
        const messages = rows.map((row) => rowMessage(row, faces.get(String(row.author_subject)) ?? null));
        return { messages, nextCursor: messages.at(-1)?.id ?? normalizedCursor };
      });
    },
    async appendMessage(actor, input) {
      // Device-token callers (the PC bridge) post as agent-authored messages
      // so replies do not render as the user talking to themselves. Both
      // fields are server-derived from the verified token; the client sends
      // only body, channelId, and idempotencyKey. Browser sessions stay
      // forced to human exactly as before.
      const isBridge = actor?.viaDeviceToken === true;
      const message = normalizeEnvoyMessage({
        ...input,
        authorSubject: isBridge ? `${actor.subject}:bridge` : actor.subject,
        authorKind: isBridge ? 'agent' : 'human',
      });
      const idempotencyKey = text(input?.idempotencyKey, 'idempotency key', 200);
      const context = contextFor(actor);
      const out = await withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
           returning id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata`,
          [context.tenantId, message.channelId, message.authorSubject, message.authorKind, message.body, idempotencyKey, message.metadata ? JSON.stringify(message.metadata) : null],
        );
        const row = result.rowCount === 1 ? result.rows[0] : (await client.query(
          `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at, metadata
           from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
          [context.tenantId, message.channelId, message.authorSubject, idempotencyKey],
        )).rows[0];
        if (!row) throw new Error('Envoy message receipt was not durable');
        const faces = await profileEmojis(client, [String(row.author_subject)]);
        return { receipt: Object.freeze({ format: 'helmion.envoy-message-receipt.v1', durable: true, replayed: result.rowCount !== 1, message: rowMessage(row, faces.get(String(row.author_subject)) ?? null) }) };
      });
      // Realtime push for the PC bridge (v2). Fire-and-forget: the write is
      // already durable above, and a realtime failure must never fail the send.
      // publishEnvoyMessage never throws by contract.
      void publishEnvoyMessage({
        tenantId: context.tenantId,
        channelId: out.receipt.message.channelId,
        message: out.receipt.message,
      });
      // The empty-desk answer (polish P1): a fresh human send in a
      // workspace with no AI connected gets Maestro's answer in the
      // channel instead of silence. Best-effort, after the send is
      // durable and in its own transaction: a failure is logged and
      // never fails the send. The desk has no realtime subscriber,
      // so the answer lands on the sender's own post-send reload
      // and on every client's next poll, like any stored reply.
      if (!out.receipt.replayed && message.authorKind === 'human') {
        // Helm's setup guide first (helm-kb.mjs): a setup question
        // is answered by Maestro from the guide — word for word,
        // one step at a time — on any desk, with zero seats
        // connected or a full crew, and an unanswered question on
        // an empty desk is filed to the guide's miss queue there.
        // Only a message the guide leaves unanswered falls through
        // to the empty-desk answer below, so a fresh send gets at
        // most one Maestro message and the two never fight.
        let kbAnswer = null;
        try {
          kbAnswer = await postHelmKbAnswerIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id, senderSubject: message.authorSubject, body: message.body });
        } catch (error) {
          console.error('[envoy-chat] helm kb answer failed:', error.message);
        }
        if (!kbAnswer?.answered) {
          try {
            await postEmptyDeskAnswerIfNeeded({ pool, tenantId: context.tenantId, channelId: message.channelId, messageId: out.receipt.message.id });
          } catch (error) {
            console.error('[envoy-chat] empty-desk answer failed:', error.message);
          }
        }
      }
      return out;
    },
    async appendConnectorMessage(binding) {
      const actor = { tenantId: binding.tenantId, subject: binding.subject, role: binding.role, sessionId: binding.sessionId, requestId: binding.requestId };
      const message = normalizeEnvoyMessage({ channelId: binding.channelId, authorSubject: binding.subject, authorKind: 'human', body: binding.text });
      const context = contextFor(actor); const idempotencyKey = text(`${binding.provider}:${binding.eventId}`, 'connector idempotency key', 300);
      return withTenantTransaction(pool, context, async (client) => { await requireActiveTenantMembership(client, context); const channel = await client.query('select id from helmion.envoy_channels where tenant_id=$1 and id=$2', [context.tenantId, message.channelId]); if (channel.rowCount !== 1) throw new Error('Envoy channel was not found in this Organization'); const result = await client.query(`insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing returning id, channel_id, author_subject, author_kind, body, idempotency_key, created_at`, [context.tenantId, message.channelId, message.authorSubject, message.authorKind, message.body, idempotencyKey]); const row = result.rowCount === 1 ? result.rows[0] : (await client.query(`select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`, [context.tenantId, message.channelId, message.authorSubject, idempotencyKey])).rows[0]; if (!row) throw new Error('Envoy connector message receipt was not durable'); return { durable: true, replayed: result.rowCount !== 1, message: rowMessage(row) }; });
    },
  });
}
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';
import { tenantAgentStateOn } from './tenant-agent-state.mjs';
import { CONFIG_SUBJECT, describeAuthor, normalizeMessageMetadata, parseConfig } from './envoy-agents.mjs';
import { discordBotStatus, slackBotStatus } from './bot-status.mjs';
import { postHelmKbAnswerIfNeeded } from './helm-kb.mjs';

// The channels list carries each channel's Discord / Slack link (from
// its newest config row, the same rows the bridges read) plus the bot
// status, so a client knows the true link state of every channel from
// this one read — not only the channel it happens to have open. Pure:
// the store hands it the parsed configs by channel id.
export function attachChannelLinks(channels, configsByChannelId = new Map()) {
  return channels.map((channel) => {
    const config = configsByChannelId.get(String(channel.id)) ?? null;
    return Object.freeze({ ...channel, discord: config?.discord ?? null, slack: config?.slack ?? null, github: config?.github ?? null, avatar: config?.avatar ?? null });
  });
}

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
  return Object.freeze({
    channelId: text(input?.channelId, 'channel id', 64),
    authorSubject: text(input?.authorSubject, 'author subject', 256),
    authorKind,
    body: text(input?.body, 'message body', 4000),
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

function rowMessage(row) {
  return Object.freeze({ id: String(row.id), channelId: String(row.channel_id), authorSubject: String(row.author_subject), authorKind: String(row.author_kind), body: String(row.body), idempotencyKey: String(row.idempotency_key), createdAt: row.created_at });
}

export function createEnvoyStore(pool) {
  return Object.freeze({
    async listChannels(actor) {
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query('select id, slug, title, kind, created_by_subject, created_at from helmion.envoy_channels order by created_at, id');
        return { channels: result.rows.map((row) => Object.freeze({ id: String(row.id), slug: String(row.slug), title: String(row.title), kind: String(row.kind), createdBySubject: String(row.created_by_subject), createdAt: row.created_at })) };
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
           returning id, slug, title, kind, created_by_subject, created_at`,
          [context.tenantId, channel.slug, channel.title, channel.kind, context.actorSubject],
        );
        return { channel: Object.freeze({ id: String(result.rows[0].id), slug: String(result.rows[0].slug), title: String(result.rows[0].title), kind: String(result.rows[0].kind), createdBySubject: String(result.rows[0].created_by_subject), createdAt: result.rows[0].created_at }) };
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
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and id > $3
             order by id asc limit $4`,
            [context.tenantId, normalizedChannelId, normalizedCursor, boundedLimit],
          )
          : await client.query(
            `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at
             from helmion.envoy_messages where tenant_id=$1 and channel_id=$2
             order by created_at desc, id desc limit $3`,
            [context.tenantId, normalizedChannelId, boundedLimit],
          );
        const messages = normalizedCursor ? result.rows.map(rowMessage) : result.rows.map(rowMessage).reverse();
        return { messages, nextCursor: messages.at(-1)?.id ?? normalizedCursor };
      });
    },
    async appendMessage(actor, input) {
      const message = normalizeEnvoyMessage({ ...input, authorSubject: actor.subject, authorKind: 'human' });
      const idempotencyKey = text(input?.idempotencyKey, 'idempotency key', 200);
      const context = contextFor(actor);
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing
           returning id, channel_id, author_subject, author_kind, body, idempotency_key, created_at`,
          [context.tenantId, message.channelId, message.authorSubject, message.authorKind, message.body, idempotencyKey],
        );
        const row = result.rowCount === 1 ? result.rows[0] : (await client.query(
          `select id, channel_id, author_subject, author_kind, body, idempotency_key, created_at
           from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_subject=$3 and idempotency_key=$4`,
          [context.tenantId, message.channelId, message.authorSubject, idempotencyKey],
        )).rows[0];
        if (!row) throw new Error('Envoy message receipt was not durable');
        return { receipt: Object.freeze({ format: 'helmion.envoy-message-receipt.v1', durable: true, replayed: result.rowCount !== 1, message: rowMessage(row) }) };
      });
    },
  });
}
import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';

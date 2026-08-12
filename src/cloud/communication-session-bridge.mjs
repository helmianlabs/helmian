// Signed session bridge for Discord/Slack connector turns.
//
// The provider webhook is only an authenticated transport. This module is the
// authority boundary after that transport has been verified and after
// communication-identity.mjs has resolved the provider user/channel to exactly
// one active Helmian tenant membership. It mints a short-lived HMAC envelope,
// re-checks that envelope on every turn, binds it to one connection, refreshes
// policy before each turn, and hands execution to an explicitly supplied
// bounded runtime adapter. It never trusts tenant/role claims from Discord or
// Slack and it never creates a membership.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { connectorCanRequestAgentTurn } from './communication-identity.mjs';
import { normalizeTenantContext } from '../core/tenant-context.mjs';

export const CONNECTOR_SESSION_MARKER = 'helmion-connector:';
export const CONNECTOR_SESSION_ISSUER = 'helmian-connector-gateway';
export const CONNECTOR_SESSION_AUDIENCE = 'helmian-agent';
export const CONNECTOR_SESSION_VERSION = 1;
export const DEFAULT_CONNECTOR_SESSION_LIFETIME_SECONDS = 15 * 60;
export const DEFAULT_CONNECTOR_SESSION_CLOCK_SKEW_SECONDS = 30;
export const MAX_CONNECTOR_SESSION_TOKEN_CHARS = 4_096;
export const MAX_CONNECTOR_TURN_CHARS = 4_000;
export const MAX_CONNECTOR_EVENT_ID_CHARS = 256;

const PROVIDERS = new Set(['discord', 'slack']);
const ROLES = new Set(['owner', 'admin', 'member', 'auditor']);

function boundedString(value, name, max = 256) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new TypeError(`${name} is invalid`);
  }
  return clean;
}

function requireSecret(secret) {
  const value = String(secret ?? '');
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('connector session signing secret must be at least 32 bytes');
  }
  return value;
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodePayload(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('connector payload is not base64url');
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('connector payload must be an object');
  }
  return decoded;
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function constantTimeSignature(expected, presented) {
  let actual;
  try { actual = Buffer.from(String(presented ?? ''), 'base64url'); } catch { return false; }
  if (!actual.length || actual.toString('base64url') !== String(presented ?? '')) return false;
  const wanted = Buffer.from(expected, 'base64url');
  return wanted.length === actual.length && timingSafeEqual(wanted, actual);
}

function normalizeLifetime(value, fallback) {
  const lifetime = Number(value ?? fallback);
  if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 60 * 60) {
    throw new TypeError('connector session lifetime must be 60-3600 seconds');
  }
  return lifetime;
}

function normalizeEpoch(date, name) {
  const value = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(value)) throw new TypeError(`${name} is invalid`);
  return Math.floor(value / 1_000);
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object' || !connectorCanRequestAgentTurn(binding)) {
    throw new Error('a verified connector identity binding is required');
  }
  const provider = boundedString(binding.provider, 'connector provider', 16).toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error('connector provider is unsupported');
  const role = boundedString(binding.role, 'connector role', 32).toLowerCase();
  if (!ROLES.has(role)) throw new Error('connector role is unsupported');
  return Object.freeze({
    sessionIssuer: 'signed-session-required',
    provider,
    eventId: boundedString(binding.eventId, 'connector event id', MAX_CONNECTOR_EVENT_ID_CHARS),
    externalUserId: boundedString(binding.externalUserId, 'connector user id'),
    channelId: boundedString(binding.channelId, 'connector channel id'),
    tenantId: boundedString(binding.tenantId, 'tenant id', 128),
    subject: boundedString(binding.subject, 'subject', 256),
    role,
    surface: `connector-${provider}`,
    attributes: binding.attributes && typeof binding.attributes === 'object'
      ? Object.freeze({ ...binding.attributes }) : Object.freeze({}),
  });
}

function publicContext(claims) {
  return Object.freeze({
    sessionId: boundedString(claims.sid, 'session id'),
    receiptId: boundedString(claims.jti, 'receipt id'),
    tenantId: boundedString(claims.tid, 'tenant id', 128),
    subjectId: boundedString(claims.sub, 'subject id'),
    role: boundedString(claims.rol, 'role', 32),
    provider: boundedString(claims.prv, 'provider', 16),
    channelId: boundedString(claims.chn, 'channel id'),
    externalUserId: boundedString(claims.uid, 'external user id'),
    sourceEventId: boundedString(claims.evt, 'source event id', MAX_CONNECTOR_EVENT_ID_CHARS),
    surface: boundedString(claims.srf, 'surface', 32),
    attributes: claims.attr && typeof claims.attr === 'object' && !Array.isArray(claims.attr)
      ? Object.freeze({ ...claims.attr }) : Object.freeze({}),
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  });
}

/**
 * Mint a short-lived signed connector session from an already verified binding.
 * The returned token is a bearer-like secret and must only be retained by the
 * connector gateway; never place it in a provider message or browser markup.
 */
export function mintConnectorSession(binding, {
  secret,
  now = new Date(),
  lifetimeSeconds = DEFAULT_CONNECTOR_SESSION_LIFETIME_SECONDS,
  sessionId = randomUUID(),
  receiptId = randomUUID(),
} = {}) {
  const normalized = normalizeBinding(binding);
  const signingSecret = requireSecret(secret);
  const issuedAt = normalizeEpoch(now, 'now');
  const lifetime = normalizeLifetime(lifetimeSeconds, DEFAULT_CONNECTOR_SESSION_LIFETIME_SECONDS);
  const claims = {
    v: CONNECTOR_SESSION_VERSION,
    iss: CONNECTOR_SESSION_ISSUER,
    aud: CONNECTOR_SESSION_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + lifetime,
    sid: boundedString(String(sessionId), 'session id'),
    jti: boundedString(String(receiptId), 'receipt id'),
    tid: normalized.tenantId,
    sub: normalized.subject,
    rol: normalized.role,
    prv: normalized.provider,
    chn: normalized.channelId,
    uid: normalized.externalUserId,
    evt: normalized.eventId,
    srf: normalized.surface,
    // Attributes are copied only from the verified server-side binding. They
    // are input to policy, never an authorization override on their own.
    attr: normalized.attributes,
  };
  const payload = encodePayload(claims);
  const token = `${CONNECTOR_SESSION_MARKER}${payload}.${sign(payload, signingSecret)}`;
  if (token.length > MAX_CONNECTOR_SESSION_TOKEN_CHARS) throw new Error('connector session token is too large');
  return Object.freeze({ token, context: publicContext(claims) });
}

/** Verify, normalize, and fail closed on one connector session token. */
export function verifyConnectorSession(token, {
  secret,
  now = new Date(),
  clockSkewSeconds = DEFAULT_CONNECTOR_SESSION_CLOCK_SKEW_SECONDS,
  maxLifetimeSeconds = 60 * 60,
} = {}) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw.startsWith(CONNECTOR_SESSION_MARKER)) return { ok: false, reason: 'connector session marker is invalid' };
  if (raw.length > MAX_CONNECTOR_SESSION_TOKEN_CHARS) return { ok: false, reason: 'connector session token is too large' };
  let signingSecret;
  try { signingSecret = requireSecret(secret); } catch (error) { return { ok: false, reason: error.message }; }
  const parts = raw.slice(CONNECTOR_SESSION_MARKER.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'connector session shape is invalid' };
  try {
    if (!constantTimeSignature(sign(parts[0], signingSecret), parts[1])) {
      return { ok: false, reason: 'connector session signature is invalid' };
    }
    const claims = decodePayload(parts[0]);
    if (claims.v !== CONNECTOR_SESSION_VERSION) throw new Error('connector session version is unsupported');
    if (claims.iss !== CONNECTOR_SESSION_ISSUER) throw new Error('connector session issuer is invalid');
    if (claims.aud !== CONNECTOR_SESSION_AUDIENCE) throw new Error('connector session audience is invalid');
    const issuedAt = Number(claims.iat);
    const expiresAt = Number(claims.exp);
    const nowSeconds = normalizeEpoch(now, 'now');
    const skew = Number(clockSkewSeconds);
    if (!Number.isSafeInteger(skew) || skew < 0 || skew > 300) throw new Error('connector clock skew is invalid');
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) throw new Error('connector session lifetime is invalid');
    if (issuedAt > nowSeconds + skew) throw new Error('connector session is not valid yet');
    if (expiresAt <= nowSeconds - skew) throw new Error('connector session has expired');
    if (expiresAt <= issuedAt || expiresAt - issuedAt > normalizeLifetime(maxLifetimeSeconds, 60 * 60)) {
      throw new Error('connector session lifetime exceeds policy');
    }
    const context = publicContext({ ...claims, iat: issuedAt, exp: expiresAt });
    if (!PROVIDERS.has(context.provider) || !ROLES.has(context.role)) throw new Error('connector session claim is unsupported');
    if (context.surface !== `connector-${context.provider}`) throw new Error('connector session surface is invalid');
    return { ok: true, context };
  } catch (error) {
    return { ok: false, reason: error?.message ?? 'connector session is invalid' };
  }
}

function requiredConnectionId(value) {
  return boundedString(value, 'connection id', 256);
}

function requiredTurnText(value) {
  return boundedString(value, 'connector turn', MAX_CONNECTOR_TURN_CHARS);
}

function sanitizedAuditContext(context) {
  return {
    sessionId: context.sessionId,
    receiptId: context.receiptId,
    tenantId: context.tenantId,
    subjectId: context.subjectId,
    role: context.role,
    provider: context.provider,
    channelId: context.channelId,
    surface: context.surface,
  };
}

/**
 * Convert a verified connector context into the existing Neon transaction
 * context. Callers pass this directly to withTenantTransaction(); no provider
 * user/channel claim is used as the Helmian subject except the already-bound
 * subjectId.
 */
export function toHelmianTenantContext(context, { requestId = randomUUID() } = {}) {
  if (!context || typeof context !== 'object') throw new TypeError('connector context is required');
  return normalizeTenantContext({
    tenantId: context.tenantId,
    actorSubject: context.subjectId,
    actorRole: context.role,
    sessionId: context.sessionId,
    requestId,
  });
}

/**
 * Create the small gateway used by a Discord/Slack adapter. The callbacks are
 * intentionally mandatory: a connector cannot run a model without a policy
 * resolver, audit sink, and bounded runtime adapter.
 */
export function createConnectorSessionBridge({
  secret,
  policyResolver,
  auditSink,
  runtimeFactory,
  now = () => new Date(),
  lifetimeSeconds = DEFAULT_CONNECTOR_SESSION_LIFETIME_SECONDS,
} = {}) {
  requireSecret(secret);
  if (typeof policyResolver !== 'function') throw new TypeError('policyResolver is required');
  if (typeof auditSink !== 'function') throw new TypeError('auditSink is required');
  if (typeof runtimeFactory !== 'function') throw new TypeError('runtimeFactory is required');
  const receipts = new Map();
  const sessions = new Map();

  async function record(event) {
    // Audit failures are authorization failures. A connector must not run if
    // the durable audit path cannot accept the event.
    const result = await auditSink(Object.freeze({ ...event }));
    if (result === false) throw new Error('connector audit sink refused the event');
  }

  function authorizeReceipt(context, connectionId) {
    const existing = receipts.get(context.receiptId);
    if (existing && (existing.connectionId !== connectionId || existing.sessionId !== context.sessionId)) {
      throw new Error('connector session receipt is already bound to another connection');
    }
    if (!existing) receipts.set(context.receiptId, {
      connectionId,
      sessionId: context.sessionId,
      expiresAt: context.expiresAt,
      events: new Set(),
    });
    return receipts.get(context.receiptId);
  }

  async function resolvePolicy(context) {
    const policy = await policyResolver(Object.freeze({ ...context, attributes: context.attributes }));
    if (!policy || policy.allowed === false || policy.enabled === false) {
      throw new Error('connector action policy denied this session');
    }
    return Object.freeze({ ...policy });
  }

  return Object.freeze({
    /** Issue a token only from a prior communication-identity binding. */
    async open({ binding, connectionId, sessionId, receiptId } = {}) {
      const connection = requiredConnectionId(connectionId);
      const normalized = normalizeBinding(binding);
      const policy = await resolvePolicy({
        tenantId: normalized.tenantId, subjectId: normalized.subject, role: normalized.role,
        provider: normalized.provider, channelId: normalized.channelId, surface: normalized.surface,
        attributes: normalized.attributes,
      });
      const issued = mintConnectorSession(normalized, {
        secret, now: now(), lifetimeSeconds, sessionId, receiptId,
      });
      const receipt = authorizeReceipt(issued.context, connection);
      sessions.set(issued.context.sessionId, { context: issued.context, connectionId: connection, policy, runtime: null });
      await record({
        event: 'connector_session_opened', decision: 'ALLOW',
        context: sanitizedAuditContext(issued.context),
      });
      return Object.freeze({ token: issued.token, context: issued.context, policy });
    },

    /**
     * Verify a token, reject provider-event replay, refresh policy, and call
     * the bounded runtime adapter. The adapter receives no signing secret.
     */
    async turn({ token, connectionId, eventId, text, onEvent, signal = null } = {}) {
      const connection = requiredConnectionId(connectionId);
      const verified = verifyConnectorSession(token, { secret, now: now() });
      if (!verified.ok) throw new Error(verified.reason);
      const context = verified.context;
      const tenantContext = toHelmianTenantContext(context);
      const receipt = authorizeReceipt(context, connection);
      const event = boundedString(eventId ?? context.sourceEventId, 'connector event id', MAX_CONNECTOR_EVENT_ID_CHARS);
      if (receipt.events.has(event)) throw new Error('connector event was already processed');
      const policy = await resolvePolicy(context);
      const session = sessions.get(context.sessionId) ?? { context, connectionId: connection, runtime: null };
      if (session.connectionId !== connection) throw new Error('connector session is owned by another connection');
      if (!session.runtime) {
        session.runtime = await runtimeFactory(Object.freeze({
          context,
          tenantContext,
          policy,
          bounded: true,
        }));
        if (!session.runtime || typeof session.runtime.runTurn !== 'function') {
          throw new Error('bounded connector runtime adapter is invalid');
        }
        sessions.set(context.sessionId, session);
      }
      const prompt = requiredTurnText(text);
      await record({
        event: 'connector_turn_started', decision: 'ALLOW',
        context: sanitizedAuditContext(context), eventId: event,
      });
      try {
        const result = await session.runtime.runTurn({
          text: prompt,
          context,
          policy,
          onEvent,
          signal,
        });
        receipt.events.add(event);
        await record({
          event: 'connector_turn_completed', decision: 'ALLOW',
          context: sanitizedAuditContext(context), eventId: event,
        });
        return result;
      } catch (error) {
        await record({
          event: 'connector_turn_failed', decision: 'DENY',
          context: sanitizedAuditContext(context), eventId: event,
          reason: error?.message ?? 'runtime failure',
        });
        throw error;
      }
    },

    /** Used by shutdown/idle eviction; no provider or model calls are made. */
    dispose() {
      for (const session of sessions.values()) void session.runtime?.dispose?.();
      sessions.clear();
      receipts.clear();
    },
    sessionCount() { return sessions.size; },
  });
}

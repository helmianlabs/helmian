// Watch tickets for the live agent-browser view (live-browser-view
// Bite 2, 2026-11-12; self-aligning secret, Bite 2.5, 2026-11-12).
//
//   POST /api/admin/browser/watch-ticket   { seat } -> { ticket, watchUrl }
//   GET  /api/admin/envoy/watch-secret     (device token) -> { secret, rotatedAt }
//
// The Browser tab asks at the first address before it opens a watch
// connection to the box's watch service
// (wss://watch.5-78-222-178.sslip.io). The ticket is short-lived
// (60 seconds), names ONE seat, and its tenant comes from the
// signed-in session (activeTenantActor), never from anything the
// request body claims: a body that carries a tenant selector is
// refused outright, the same rule the browser launcher keeps.
//
// Ticket shape: a signed statement, not a stored record. The payload
// is base64url JSON ({ v, tenant, seat, sub, iat, exp, nonce }) and
// the signature is HMAC-SHA256 over the payload part.
//
// The signing secret lives in the app's own database
// (helmion.watch_ticket_secret, sql/085): on first need the signer
// generates a strong random value and stores it as the table's
// single row, and a rotation is one update of that row. No
// environment variable carries it anywhere; Bite 2's hand-placed
// HELMION_WATCH_TICKET_SECRET copies, and the 503 they caused, are
// retired by this module. The watch service on the box holds no copy
// either: it fetches the current value from the second address
// above, which answers device-token callers only (the executor's
// own road to the cloud, never a customer session), keeps it in
// memory only, and refetches when a verification fails, so a
// rotation here heals the box side on its own. Until the sql/085
// table exists, both routes answer 503: nothing is minted and
// nothing is served.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so
// these routes hang off the existing envoy-ably hook (envoy-ably.mjs
// delegates here), the same road runner-presence.mjs took. The
// secret route's path lives under /api/admin/envoy/ because device
// tokens resolve there and nowhere else.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';

export const WATCH_TICKET_PATH = '/api/admin/browser/watch-ticket';
export const WATCH_SECRET_PATH = '/api/admin/envoy/watch-secret';
export const WATCH_TICKET_TTL_MS = 60_000;
export const WATCH_URL = 'wss://watch.5-78-222-178.sslip.io/watch';
// The session executor's provider ids: the only seats that can ever
// hold a browser on the box. The desk asks by these names.
export const WATCH_SEATS = Object.freeze(['mistral', 'openai', 'claude', 'grok', 'gemini']);
const SEAT_SET = new Set(WATCH_SEATS);

// --- the signing secret: one row in the app's own database ---
//
// Own lazy pool, the runner-presence shape: live-admin.mjs owns the
// primary pool and cannot pass it through the frozen hook. Same env
// var, same ssl rule.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw watchTicketNotConfiguredError();
    sharedPool = new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=disable') ? false : undefined,
      max: 3,
    });
  }
  return sharedPool;
}

function watchTicketNotConfiguredError() {
  return Object.assign(new Error('watch ticket signer is not configured'), {
    status: 503,
    code: 'WATCH_TICKET_NOT_CONFIGURED',
  });
}

function secretRecord(row, created) {
  const secret = String(row?.secret ?? '').trim();
  if (secret.length < 32) throw watchTicketNotConfiguredError();
  return Object.freeze({
    secret,
    rotatedAt: row?.rotated_at ? new Date(row.rotated_at).toISOString() : null,
    created,
  });
}

// Reads the signing secret from helmion.watch_ticket_secret. On
// first need (the table exists but holds no row) a strong random
// secret is generated and stored; the insert is conflict-safe, so
// two first callers racing still land on the one stored value, which
// is then read back. A missing table (sql/085 not yet applied) is
// the not-configured error, exactly like a missing database URL:
// the signer fails soft and mints nothing.
export async function resolveWatchTicketSecretRecord() {
  const pool = getPool();
  try {
    const existing = await pool.query(
      'select secret, rotated_at from helmion.watch_ticket_secret where id = 1',
    );
    if (existing.rowCount === 1) return secretRecord(existing.rows[0], false);
    const candidate = randomBytes(48).toString('base64url');
    await pool.query(
      'insert into helmion.watch_ticket_secret (id, secret) values (1, $1) on conflict (id) do nothing',
      [candidate],
    );
    const stored = await pool.query(
      'select secret, rotated_at from helmion.watch_ticket_secret where id = 1',
    );
    if (stored.rowCount !== 1) throw watchTicketNotConfiguredError();
    return secretRecord(stored.rows[0], true);
  } catch (error) {
    if (error?.code === '42P01') throw watchTicketNotConfiguredError();
    throw error;
  }
}

export async function resolveWatchTicketSecret() {
  return (await resolveWatchTicketSecretRecord()).secret;
}

function signPart(payloadPart, secret) {
  return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}

// Mints a ticket. Throws TypeError on a bad tenant, seat or ttl; the
// route maps that to a 400. now/ttlMs/nonce are injectable so proofs
// can mint through this exact code path (including deliberately
// expired tickets) without a second implementation.
export function mintWatchTicket({
  secret,
  tenantId,
  seat,
  subject = null,
  now = Date.now(),
  ttlMs = WATCH_TICKET_TTL_MS,
  nonce = randomBytes(16).toString('base64url'),
} = {}) {
  if (!secret) throw new TypeError('watch ticket secret is not configured');
  const tenant = String(tenantId ?? '').trim();
  if (!tenant) throw new TypeError('watch ticket tenant is required');
  const seatName = String(seat ?? '').trim().toLowerCase();
  if (!SEAT_SET.has(seatName)) throw new TypeError(`unknown watch seat: ${seatName || '(empty)'}`);
  const ttl = Number(ttlMs);
  if (!Number.isSafeInteger(ttl) || ttl < -WATCH_TICKET_TTL_MS || ttl > WATCH_TICKET_TTL_MS) {
    throw new TypeError('watch ticket ttl is out of range');
  }
  const issuedAt = Number(now);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) throw new TypeError('watch ticket time is invalid');
  const payload = {
    v: 1,
    tenant,
    seat: seatName,
    sub: subject ? String(subject) : null,
    iat: issuedAt,
    exp: issuedAt + ttl,
    nonce: String(nonce),
  };
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return Object.freeze({
    ticket: `${part}.${signPart(part, secret)}`,
    seat: seatName,
    expiresAt: new Date(payload.exp).toISOString(),
    expiresAtMs: payload.exp,
  });
}

// Verifies a ticket's signature and expiry. Returns
// { ok: true, payload } or { ok: false, reason } with reason one of
// 'malformed' | 'bad_signature' | 'expired' | 'unknown_seat' |
// 'bad_payload'. This is the canonical verifier: the watch service on
// the box implements the identical checks, and proofs exercise this
// one directly.
export function verifyWatchTicket({ secret, ticket, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'malformed' };
  const text = String(ticket ?? '');
  const dot = text.indexOf('.');
  if (dot <= 0 || dot !== text.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const part = text.slice(0, dot);
  const signature = text.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(part) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = signPart(part, secret);
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'bad_payload' }; }
  if (!payload || payload.v !== 1
    || typeof payload.tenant !== 'string' || !payload.tenant
    || typeof payload.seat !== 'string'
    || !Number.isSafeInteger(payload.exp)) {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!SEAT_SET.has(payload.seat)) return { ok: false, reason: 'unknown_seat' };
  if (Number(now) >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// Route delegate: POST /api/admin/browser/watch-ticket. Auth is the
// desk's own signed-in session through activeTenantActor (device-token
// callers land here too, with the tenant their token serves, which is
// the same tenant their seats run under). Returns false when the
// request is not ours.
export async function handleWatchTicketRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
} = {}) {
  if (request?.method !== 'POST' || requestUrl?.pathname !== WATCH_TICKET_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    const actor = await activeTenantActor(request);
    let secret;
    try {
      secret = await resolveWatchTicketSecret();
    } catch (error) {
      if (error?.status === 503) {
        send(response, 503, JSON.stringify({ valid: false, code: 'WATCH_TICKET_NOT_CONFIGURED' }));
        return true;
      }
      throw error;
    }
    let body = null;
    try { body = await readJson(request); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(response, 400, JSON.stringify({ valid: false, code: 'WATCH_TICKET_INVALID', message: 'A JSON body naming one seat is required.' }));
      return true;
    }
    // The tenant is the session's, never the body's (the browser
    // launcher's rule, kept verbatim in spirit): a tenant selector in
    // the body, or any key beyond the seat, is refused.
    const keys = Object.keys(body);
    if (keys.some((key) => key !== 'seat')) {
      send(response, 400, JSON.stringify({ valid: false, code: 'WATCH_TICKET_INVALID', message: 'Only the seat may be named; the tenant comes from your session.' }));
      return true;
    }
    const minted = mintWatchTicket({ secret, tenantId: actor.tenantId, seat: body.seat, subject: actor.subject });
    send(response, 200, JSON.stringify({
      valid: true,
      ok: true,
      ticket: minted.ticket,
      seat: minted.seat,
      expiresAt: minted.expiresAt,
      watchUrl: WATCH_URL,
    }));
  } catch (error) {
    if (error instanceof TypeError) {
      send(response, 400, JSON.stringify({ valid: false, code: 'WATCH_TICKET_INVALID', message: error.message }));
    } else {
      const status = membershipError(error) ? 403 : 400;
      send(response, status, JSON.stringify({
        valid: false,
        code: membershipError(error) ? 'WATCH_MEMBERSHIP_REQUIRED' : 'WATCH_TICKET_INVALID',
      }));
    }
  }
  return true;
}

// Route delegate: GET /api/admin/envoy/watch-secret. The box side of
// the self-aligning secret: the watch service fetches the current
// signing secret here so the two sides arrive at the same value with
// no human placing a copy anywhere. The gate is the device token,
// the same server credential the executor polls with (activeTenantActor
// marks such callers viaDeviceToken); a customer session, however
// valid, is refused, as is every caller without an identity. The
// answer carries the secret itself over the authenticated channel
// and is the one place it leaves the database besides the signer's
// own use. Returns false when the request is not ours.
export async function handleWatchSecretRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
} = {}) {
  if (request?.method !== 'GET' || requestUrl?.pathname !== WATCH_SECRET_PATH) return false;
  const refuse = (status, code) => {
    send(response, status, JSON.stringify({ valid: false, code }));
    return true;
  };
  let actor;
  try {
    actor = await activeTenantActor(request);
  } catch {
    return refuse(403, 'WATCH_SECRET_DEVICE_REQUIRED');
  }
  if (actor?.viaDeviceToken !== true) return refuse(403, 'WATCH_SECRET_DEVICE_REQUIRED');
  try {
    const record = await resolveWatchTicketSecretRecord();
    send(response, 200, JSON.stringify({
      valid: true,
      ok: true,
      secret: record.secret,
      rotatedAt: record.rotatedAt,
    }));
  } catch (error) {
    if (error?.status === 503) return refuse(503, 'WATCH_TICKET_NOT_CONFIGURED');
    return refuse(500, 'WATCH_SECRET_UNAVAILABLE');
  }
  return true;
}

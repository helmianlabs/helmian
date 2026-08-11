// AimForge -> Helmian authority boundary for Hume voice sessions.
//
// Hume forwards `custom_session_id`, but does not authenticate its contents.
// AimForge therefore signs the verified tenant/user/role context before the
// browser or phone sees it. Helmian verifies that signature and lifetime
// before a voice session can enter the tool-capable agent runtime.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const AIMFORGE_BRIDGE_MARKER = 'helmion:';
export const AIMFORGE_BRIDGE_ISSUER = 'aimforge-api';
export const AIMFORGE_BRIDGE_AUDIENCE = 'helmian-cora';
export const AIMFORGE_BRIDGE_VERSION = 1;
export const DEFAULT_BRIDGE_MAX_LIFETIME_SECONDS = 10 * 60;
export const DEFAULT_BRIDGE_CLOCK_SKEW_SECONDS = 30;
export const AIMFORGE_BRIDGE_SURFACES = Object.freeze(['mobile', 'cora']);

function decodeBase64UrlJson(encoded) {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('bridge payload is not base64url');
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  return JSON.parse(decoded);
}

function cleanBoundedString(value, name, max = 256) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error(`${name} is invalid`);
  }
  return clean;
}

function signatureMatches(expected, presented) {
  let actual;
  try {
    actual = Buffer.from(presented, 'base64url');
  } catch {
    return false;
  }
  if (actual.toString('base64url') !== presented) return false;
  if (expected.length !== actual.length || actual.length === 0) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Verify and normalize one AimForge-issued Hume session envelope.
 * Never returns partially trusted claims: any defect is a closed refusal.
 */
export function verifyAimForgeSessionBridge(customSessionId, {
  secret,
  now = new Date(),
  clockSkewSeconds = DEFAULT_BRIDGE_CLOCK_SKEW_SECONDS,
  maxLifetimeSeconds = DEFAULT_BRIDGE_MAX_LIFETIME_SECONDS,
} = {}) {
  const raw = typeof customSessionId === 'string' ? customSessionId.trim() : '';
  if (!raw.startsWith(AIMFORGE_BRIDGE_MARKER)) {
    return { ok: false, reason: `custom_session_id must start with ${AIMFORGE_BRIDGE_MARKER}` };
  }
  if (Buffer.byteLength(String(secret ?? ''), 'utf8') < 32) {
    return { ok: false, reason: 'AimForge bridge verification secret is unavailable' };
  }

  const compact = raw.slice(AIMFORGE_BRIDGE_MARKER.length);
  const parts = compact.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'custom_session_id has an invalid signed-envelope shape' };
  }

  try {
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    if (!signatureMatches(expected, parts[1])) {
      return { ok: false, reason: 'custom_session_id signature is invalid' };
    }

    const claims = decodeBase64UrlJson(parts[0]);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      throw new Error('bridge payload must be an object');
    }
    if (claims.v !== AIMFORGE_BRIDGE_VERSION) throw new Error('bridge version is not supported');
    if (claims.iss !== AIMFORGE_BRIDGE_ISSUER) throw new Error('bridge issuer is invalid');
    if (claims.aud !== AIMFORGE_BRIDGE_AUDIENCE) throw new Error('bridge audience is invalid');

    const issuedAt = Number(claims.iat);
    const expiresAt = Number(claims.exp);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) {
      throw new Error('bridge lifetime is invalid');
    }
    if (issuedAt > nowSeconds + clockSkewSeconds) throw new Error('bridge is not valid yet');
    if (expiresAt <= nowSeconds - clockSkewSeconds) throw new Error('bridge has expired');
    if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeSeconds) {
      throw new Error('bridge lifetime exceeds policy');
    }

    const surface = cleanBoundedString(claims.srf, 'surface', 32);
    if (!AIMFORGE_BRIDGE_SURFACES.includes(surface)) {
      throw new Error('bridge surface is not authorized for voice');
    }
    const focusedAssignmentId = claims.asg ?? null;
    if (focusedAssignmentId !== null
      && (!Number.isSafeInteger(focusedAssignmentId) || focusedAssignmentId <= 0)) {
      throw new Error('assignment focus is invalid');
    }

    return {
      ok: true,
      context: Object.freeze({
        sessionId: cleanBoundedString(claims.sid, 'session id'),
        tenantId: cleanBoundedString(claims.tid, 'tenant id'),
        subjectId: cleanBoundedString(claims.sub, 'subject id'),
        role: cleanBoundedString(claims.rol, 'role', 64),
        surface,
        issuedAt,
        expiresAt,
        receiptId: cleanBoundedString(claims.jti, 'receipt id'),
        focusedAssignmentId,
      }),
    };
  } catch (error) {
    return { ok: false, reason: error?.message ?? 'custom_session_id is invalid' };
  }
}

/** Bind a verified receipt to exactly one signed session/socket. */
export function authorizeAimForgeBridgeReceipt(receipts, context, connectionId) {
  const existing = receipts.get(context.receiptId);
  if (existing && (existing.connectionId !== connectionId
    || existing.sessionId !== context.sessionId)) {
    return { ok: false, reason: 'AimForge bridge receipt was already used by another voice connection' };
  }
  if (!existing) {
    receipts.set(context.receiptId, {
      connectionId,
      sessionId: context.sessionId,
      expiresAt: context.expiresAt,
    });
    return { ok: true, firstUse: true };
  }
  return { ok: true, firstUse: false };
}

// Helmian Herald pairing — first-party and per-device.
//
// TRUST BOUNDARY
//   - A short-lived code may mint one device-bound session.
//   - The browser receives the session only as an HttpOnly SameSite cookie.
//   - Every request also carries the non-secret device id and a fresh nonce.
//   - Tokens expire, may be revoked by device id, and never authorize another
//     scope. Session instructions and approval decisions are separate, explicit
//     scopes; there is no file, tool, shell, installer, or generic write scope.
//   - This registry is memory-only in Phase 1. Restarting Herald revokes every
//     session and code; durable owner-managed revocation is a later phase.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const STATUS_READ_SCOPE = 'status:read';
export const SESSION_READ_SCOPE = 'session:read';
export const SESSION_INSTRUCT_SCOPE = 'session:instruct';
export const APPROVAL_DECIDE_SCOPE = 'approval:decide';
export const HERALD_SCOPES = Object.freeze([
  STATUS_READ_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_INSTRUCT_SCOPE,
  APPROVAL_DECIDE_SCOPE,
]);
export const DEFAULT_PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_DEVICE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_NONCES_PER_DEVICE = 2_048;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function tokenDigest(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest();
}

function digestMatches(expected, supplied) {
  const actual = tokenDigest(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validDeviceId(deviceId) {
  return DEVICE_ID_PATTERN.test(String(deviceId ?? ''));
}

function validNonce(nonce) {
  return NONCE_PATTERN.test(String(nonce ?? ''));
}

export class HeraldPairingRegistry {
  constructor({
    clock = () => Date.now(),
    pairingCodeTtlMs = DEFAULT_PAIRING_CODE_TTL_MS,
    sessionTtlMs = DEFAULT_DEVICE_SESSION_TTL_MS,
    makeCode = () => String(randomInt(0, 100_000_000)).padStart(8, '0'),
    makeToken = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.clock = clock;
    this.pairingCodeTtlMs = pairingCodeTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.makeCode = makeCode;
    this.makeToken = makeToken;
    this.pendingCode = null;
    this.devices = new Map();
  }

  issuePairingCode({ scopes = [STATUS_READ_SCOPE] } = {}) {
    const grantedScopes = [...new Set(scopes)].filter((scope) => HERALD_SCOPES.includes(scope));
    if (grantedScopes.length === 0) grantedScopes.push(STATUS_READ_SCOPE);
    const code = this.makeCode();
    const expiresAtMs = this.clock() + this.pairingCodeTtlMs;
    this.pendingCode = { code, expiresAtMs, used: false, scopes: grantedScopes };
    return { code, scopes: grantedScopes, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  pair({ code, deviceId } = {}) {
    if (!validDeviceId(deviceId)) return { ok: false, reason: 'invalid_device' };
    if (!this.pendingCode) return { ok: false, reason: 'pairing_closed' };
    if (this.pendingCode.used) return { ok: false, reason: 'code_replayed' };
    if (this.clock() >= this.pendingCode.expiresAtMs) return { ok: false, reason: 'code_expired' };
    if (String(code ?? '') !== this.pendingCode.code) return { ok: false, reason: 'wrong_code' };

    const token = this.makeToken();
    const expiresAtMs = this.clock() + this.sessionTtlMs;
    this.pendingCode.used = true;
    this.devices.set(deviceId, {
      deviceId,
      tokenDigest: tokenDigest(token),
      scopes: new Set(this.pendingCode.scopes),
      expiresAtMs,
      revoked: false,
      nonces: new Set(),
    });

    return {
      ok: true,
      token,
      deviceId,
      scope: this.pendingCode.scopes.length === 1 ? this.pendingCode.scopes[0] : undefined,
      scopes: [...this.pendingCode.scopes],
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  authorize({ token, deviceId, nonce, scope = STATUS_READ_SCOPE } = {}) {
    if (!validDeviceId(deviceId)) return { ok: false, reason: 'unpaired' };
    if (!validNonce(nonce)) return { ok: false, reason: 'invalid_nonce' };
    if (!HERALD_SCOPES.includes(scope)) return { ok: false, reason: 'scope_denied' };

    let tokenRecord = null;
    for (const record of this.devices.values()) {
      if (digestMatches(record.tokenDigest, token)) {
        tokenRecord = record;
        break;
      }
    }
    if (!tokenRecord) return { ok: false, reason: 'unpaired' };
    if (tokenRecord.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
    if (tokenRecord.revoked) return { ok: false, reason: 'revoked' };
    if (this.clock() >= tokenRecord.expiresAtMs) return { ok: false, reason: 'expired' };
    if (!tokenRecord.scopes.has(scope)) return { ok: false, reason: 'scope_denied' };
    if (tokenRecord.nonces.has(nonce)) return { ok: false, reason: 'replayed_nonce' };

    tokenRecord.nonces.add(nonce);
    while (tokenRecord.nonces.size > MAX_NONCES_PER_DEVICE) {
      tokenRecord.nonces.delete(tokenRecord.nonces.values().next().value);
    }
    return {
      ok: true,
      deviceId,
      scope,
      scopes: [...tokenRecord.scopes],
      expiresAt: new Date(tokenRecord.expiresAtMs).toISOString(),
    };
  }

  revokeDevice(deviceId) {
    const record = this.devices.get(deviceId);
    if (!record) return false;
    record.revoked = true;
    return true;
  }
}

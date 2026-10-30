// PC spoke credentials. The PC pairs by proving it knows the hands passphrase
// (typed by Troy on the PC, never sent through chat) and receives a random token.
// Only SHA-256 digests are stored. Failed pairings lock pairing for 15 minutes
// after 5 misses.
//
// Device store: pairing NEVER silently evicts another device (agent-computer
// plan, bite 2 — the old cap of 3 dropped the oldest device without a word,
// which would have unpaired Troy's PC the day a box spoke joined). At capacity
// a NEW device's pairing is refused loudly instead; re-pairing an existing
// device always works (it rotates that device's token). Removing a stale
// device is a human's call, never a side effect of someone else pairing.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const digest = (t) => createHash('sha256').update(String(t)).digest();
const MAX_DEVICES = 32;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
// Short-lived pairing codes ("Set up this PC" in the web app). A code is
// minted only by a caller holding the operator's issuer token (the Helmian
// web app, after it has checked the signed-in owner/admin), lives 10 minutes,
// works once, and only its digest is kept (in memory — a restart voids codes).
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_LIVE_CODES = 20;
export const PAIR_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;
export function normalizePairCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

export function createSpokeTokens({ file, passphrase, staticToken = null, now = Date.now }) {
  let rows = [];
  if (file && existsSync(file)) { try { rows = JSON.parse(readFileSync(file, 'utf8')).devices || []; } catch { rows = []; } }
  let failures = [];
  let codes = []; // { hash, expiresAt }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices: rows }), { mode: 0o600 });
    renameSync(tmp, file);
  };

  function verify(bearer) {
    if (!bearer) return null;
    const presented = digest(bearer);
    let found = null;
    if (staticToken && timingSafeEqual(digest(staticToken), presented)) found = 'static';
    for (const row of rows) if (timingSafeEqual(Buffer.from(row.hash, 'hex'), presented)) found = row.deviceId;
    return found;
  }

  /** Passphrase check shared by PC pairing and the OAuth consent page (one lockout for both). */
  function checkPassphrase(given) {
    const t = now();
    failures = failures.filter((f) => t - f < LOCK_MS);
    if (failures.length >= LOCK_AFTER) return { ok: false, status: 429, error: 'Too many wrong passphrases; locked for 15 minutes.' };
    if (!timingSafeEqual(digest(given || ''), digest(passphrase))) { failures.push(t); return { ok: false, status: 401, error: 'Wrong passphrase.' }; }
    return { ok: true };
  }

  function issuePairCode() {
    const t = now();
    codes = codes.filter((c) => c.expiresAt > t);
    if (codes.length >= MAX_LIVE_CODES) return { ok: false, status: 429, error: 'Too many live pairing codes; wait a few minutes.' };
    const bytes = randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length];
    const expiresAt = t + PAIR_CODE_TTL_MS;
    codes.push({ hash: digest(raw).toString('hex'), expiresAt });
    return { ok: true, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Single-use: a matching live code is removed whether pairing then succeeds or not. Misses share the passphrase lockout. */
  function checkPairCode(given) {
    const t = now();
    failures = failures.filter((f) => t - f < LOCK_MS);
    if (failures.length >= LOCK_AFTER) return { ok: false, status: 429, error: 'Too many wrong codes; locked for 15 minutes.' };
    codes = codes.filter((c) => c.expiresAt > t);
    const presented = digest(normalizePairCode(given));
    const hit = codes.find((c) => timingSafeEqual(Buffer.from(c.hash, 'hex'), presented));
    if (!hit) { failures.push(t); return { ok: false, status: 401, error: 'That pairing code is wrong or expired. Make a new one in Helmian (Settings, Set up this PC).' }; }
    codes = codes.filter((c) => c !== hit);
    return { ok: true };
  }

  function pair({ passphrase: given, pairCode, deviceId }) {
    const t = now();
    const check = pairCode ? checkPairCode(pairCode) : checkPassphrase(given);
    if (!check.ok) return check;
    const id = String(deviceId || 'pc').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60) || 'pc';
    const isNew = !rows.some((r) => r.deviceId === id);
    if (isNew && rows.length >= MAX_DEVICES) {
      // Loud, never silent: no device is evicted to make room. The refusal is
      // logged here and returned to the pairing caller, who sees the error.
      const error = `the device store is full (${MAX_DEVICES} devices paired); a stale device must be removed by hand before a new one can pair — no device was removed to make room`;
      console.error(`[spoke-tokens] pairing refused for new device "${id}": ${error}`);
      return { ok: false, status: 507, error };
    }
    const token = randomBytes(32).toString('base64url');
    rows = rows.filter((r) => r.deviceId !== id);
    rows.push({ deviceId: id, hash: digest(token).toString('hex'), createdAt: new Date(t).toISOString() });
    save();
    return { ok: true, token, deviceId: id };
  }

  return { verify, pair, checkPassphrase, issuePairCode, devices: () => rows.map(({ deviceId, createdAt }) => ({ deviceId, createdAt })) };
}

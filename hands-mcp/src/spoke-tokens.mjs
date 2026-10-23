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

export function createSpokeTokens({ file, passphrase, staticToken = null, now = Date.now }) {
  let rows = [];
  if (file && existsSync(file)) { try { rows = JSON.parse(readFileSync(file, 'utf8')).devices || []; } catch { rows = []; } }
  let failures = [];
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

  function pair({ passphrase: given, deviceId }) {
    const t = now();
    const check = checkPassphrase(given);
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

  return { verify, pair, checkPassphrase, devices: () => rows.map(({ deviceId, createdAt }) => ({ deviceId, createdAt })) };
}

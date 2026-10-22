// OPT-IN cloud upload for Guard findings. DISABLED BY DEFAULT.
//
// This module is the ONLY part of the extension that may reach the network,
// and it does nothing unless the user explicitly enables it in the popup
// settings AND provides a device token. The default behavior is unchanged:
// findings stay in the local ledger and nowhere else.
//
// WHY THIS EXISTS: so browser findings can flow into the cloud Guard findings
// ledger (/api/guard/browser-events) for users who want their phone (/app) and
// /admin to show what the extension flagged. It is deliberately not automatic.
//
// NEEDS TROY'S MANUAL BROWSER TESTING: the opt-in toggle, the device token
// field, the upload trigger, retry behavior, and the manifest host permission
// below have not been exercised in a real browser. Do not treat this as
// verified until Troy has clicked through it.
//
// NOTE ON THE NETWORK GUARD TEST: extension/test/package.test.mjs fails the
// build if any shipped file reaches the network. This file is explicitly
// allowlisted there with a comment pointing back here, because the upload is
// opt-in and user-initiated. Everything else in the extension is still
// network-free by default.

import { readLedger, LEDGER_KEY } from './ledger.js';

/** Storage keys for the opt-in. Both must be set for any upload to happen. */
export const UPLOAD_ENABLED_KEY = 'helmion.guard.upload.enabled';
export const UPLOAD_TOKEN_KEY = 'helmion.guard.upload.deviceToken';
export const UPLOAD_CURSOR_KEY = 'helmion.guard.upload.cursor';
export const UPLOAD_ENDPOINT = 'https://helmian.cloud/api/guard/browser-events';

/** Batch size per request; the ledger caps keep the total bounded. */
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

// STORAGE SHAPE. The worker passes the ledger's storage wrapper
// (ledger.js chromeStorage()/memoryStorage()): get(key) returns the VALUE for one
// key, set(key, value) writes one key. It is NOT the raw browser storage area, so
// get([keys]) and set({ ...patch }) do not work on it. Before 0.2.4 this file
// used the raw-chrome shape, so every opt-in read came back undefined and the
// upload threw "Cannot read properties of undefined". These two helpers are the
// only way this file touches storage.
async function readKeys(storage, keys) {
  const out = {};
  for (const key of keys) out[key] = await storage.get(key);
  return out;
}

async function writeKeys(storage, patch) {
  for (const [key, value] of Object.entries(patch)) await storage.set(key, value);
}

function fingerprintFor(entry) {
  // Stable dedup key: kind + site + a hash of the normalized excerpt.
  const seed = `${entry.kind || 'unknown'}|${entry.site || ''}|${String(entry.excerpt || '').slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `ext-${Math.abs(hash).toString(36)}-${String(entry.timestamp || '').slice(0, 10)}`;
}

function toFinding(entry) {
  const kind = entry.kind === 'destructive-command' ? 'destructive-command' : 'unsourced-claim';
  return {
    fingerprint: fingerprintFor(entry),
    source: 'browser-extension',
    severity: kind === 'destructive-command' ? 'critical' : 'warning',
    title: kind === 'destructive-command' ? 'Destructive command flagged' : 'Unsourced claim flagged',
    detail: {
      kind,
      site: entry.site || null,
      // The excerpt is already clipped by the ledger (MAX_EXCERPT); never send more.
      excerpt: String(entry.excerpt || '').slice(0, 500),
    },
    pageRef: entry.url ? String(entry.url).slice(0, 2048) : null,
  };
}

async function postBatch(findings, deviceToken) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify({ findings }),
      });
      if (response.ok) return { ok: true };
      lastError = new Error(`upload failed with status ${response.status}`);
      // Do not retry auth failures or bad requests; the token or payload is wrong.
      if (response.status === 401 || response.status === 403 || response.status === 400) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  return { ok: false, error: lastError?.message ?? 'upload failed' };
}

/**
 * Upload ledger findings the server has not seen yet. Returns a summary.
 * Does NOTHING unless the user opted in and set a device token.
 */
export async function uploadNewFindings(storage) {
  const settings = await readKeys(storage, [UPLOAD_ENABLED_KEY, UPLOAD_TOKEN_KEY, UPLOAD_CURSOR_KEY]);
  if (settings[UPLOAD_ENABLED_KEY] !== true) return { ok: true, skipped: 'not-enabled' };
  const deviceToken = settings[UPLOAD_TOKEN_KEY];
  if (!deviceToken || typeof deviceToken !== 'string' || !deviceToken.trim()) {
    return { ok: true, skipped: 'no-device-token' };
  }
  const entries = await readLedger(storage);
  const cursor = Number(settings[UPLOAD_CURSOR_KEY] || 0);
  const pending = entries.slice(cursor, cursor + BATCH_SIZE);
  if (!pending.length) return { ok: true, uploaded: 0 };
  const result = await postBatch(pending.map(toFinding), deviceToken.trim());
  if (!result.ok) return result;
  await writeKeys(storage, { [UPLOAD_CURSOR_KEY]: cursor + pending.length });
  return { ok: true, uploaded: pending.length, remaining: entries.length - cursor - pending.length };
}

export async function getUploadSettings(storage) {
  const settings = await readKeys(storage, [UPLOAD_ENABLED_KEY, UPLOAD_TOKEN_KEY]);
  return {
    enabled: settings[UPLOAD_ENABLED_KEY] === true,
    hasToken: !!(settings[UPLOAD_TOKEN_KEY] && String(settings[UPLOAD_TOKEN_KEY]).trim()),
  };
}

export async function setUploadSettings(storage, { enabled, deviceToken }) {
  const patch = { [UPLOAD_ENABLED_KEY]: enabled === true };
  if (typeof deviceToken === 'string') {
    patch[UPLOAD_TOKEN_KEY] = deviceToken.trim();
    // A new token means re-upload from the start; the server dedups by fingerprint.
    if (deviceToken.trim()) patch[UPLOAD_CURSOR_KEY] = 0;
  }
  await writeKeys(storage, patch);
  return getUploadSettings(storage);
}

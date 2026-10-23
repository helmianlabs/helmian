// PC-side storage for Helmian hands workspace root grants.
//
// The default workspace roots in hands-spoke.json are the PC's built-in,
// mutable roots. A root grant adds ONE more folder, read-only, and only after
// a human approval has been issued as a signed grant envelope (see
// verifyRootGrant in hands-mcp/src/shared/protocol.mjs). The spoke re-verifies
// every envelope against its pinned Guard key every time it loads this file;
// an unsigned, tampered, expired, wrong-device, or non-read-only entry grants
// nothing. Removing an entry is revocation: the spoke loads this file per
// file operation, so a removal closes access without waiting for a restart.
//
// File format (roots.grants.json, beside hands-spoke.json, mode 0600):
//   {
//     "version": 1,
//     "grants": [
//       { "grantId": "<id from the signed claims>",
//         "rootPath": "<absolute folder from the signed claims>",
//         "envelope": { "payload": "<base64url canonical claims>",
//                       "signature": "<base64url Ed25519>",
//                       "keyId": "<signing key id>" } }
//     ]
//   }
// The grantId/rootPath fields are conveniences for listing and revocation
// only. Access is derived solely from the verified envelope claims; edited
// metadata cannot widen a grant because the signature covers the claims.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { isAbsoluteRootPath, rootGrantActionHash, verifyRootGrant } from '../../hands-mcp/src/shared/protocol.mjs';

// The Helmian config directory — the same folder defaultConfigPath() in
// pc-spoke.mjs points into (kept as a tiny local mirror so this module has no
// import cycle with the spoke).
function defaultGrantsDir() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, 'Helmian');
}

export function defaultRootGrantsPath() {
  return join(defaultGrantsDir(), 'roots.grants.json');
}

export function defaultRootRequestPath(requestId) {
  return join(defaultGrantsDir(), 'root-requests', `${requestId}.json`);
}

function envelopeOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.envelope && typeof entry.envelope === 'object') return entry.envelope;
  if (typeof entry.payload === 'string' && typeof entry.signature === 'string') return entry;
  return null;
}

/** Decode claims WITHOUT trusting them (listing/revocation bookkeeping only). */
export function decodeGrantClaims(envelope) {
  try {
    return JSON.parse(Buffer.from(String(envelope?.payload ?? ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function parseRootGrantsFile(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : data?.grants;
  if (!Array.isArray(rows)) throw new Error('grants file has no grants array');
  return rows;
}

async function readEntries(path) {
  try {
    return parseRootGrantsFile(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeEntries(path, entries) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, grants: entries }, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Load and verify every grant in the file. Fail closed per entry: bad entries
 * land in `rejected` with the reason and contribute no root. A missing file is
 * simply "no grants"; an unreadable/malformed file grants nothing either.
 */
export async function loadRootGrants({ path = defaultRootGrantsPath(), publicKeyX = null, spokeDeviceId = null, now = Date.now() } = {}) {
  let entries;
  try {
    entries = await readEntries(path);
  } catch (e) {
    return { roots: [], grants: [], rejected: [{ error: `grants file unreadable: ${e.message}` }] };
  }
  const grants = [];
  const rejected = [];
  const seenIds = new Set();
  entries.forEach((entry, index) => {
    const envelope = envelopeOf(entry);
    const untrusted = decodeGrantClaims(envelope);
    const v = verifyRootGrant({ publicKeyX, envelope, spokeDeviceId, now });
    if (!v.ok) {
      rejected.push({ index, grantId: untrusted?.grantId || entry?.grantId || null, rootPath: untrusted?.rootPath || entry?.rootPath || null, error: v.error });
      return;
    }
    if (seenIds.has(v.claims.grantId)) {
      rejected.push({ index, grantId: v.claims.grantId, rootPath: v.claims.rootPath, error: 'duplicate grantId' });
      return;
    }
    seenIds.add(v.claims.grantId);
    grants.push({
      grantId: v.claims.grantId,
      rootPath: v.claims.rootPath,
      scope: v.claims.scope,
      spokeDeviceId: v.claims.spokeDeviceId,
      approvalId: v.claims.approvalId,
      decidedBy: v.claims.decidedBy,
      requestId: v.claims.requestId || null,
      expiresAt: v.claims.exp ? new Date(v.claims.exp * 1000).toISOString() : null,
      envelope,
    });
  });
  return { roots: grants.map((g) => g.rootPath), grants, rejected };
}

/**
 * Verify a grant envelope, then add it to the grants file (replacing any entry
 * with the same grantId). Throws — and writes nothing — for anything that does
 * not verify against the pinned key for this device.
 */
export async function activateRootGrant({ path = defaultRootGrantsPath(), envelope, publicKeyX = null, spokeDeviceId = null, now = Date.now() } = {}) {
  const v = verifyRootGrant({ publicKeyX, envelope, spokeDeviceId, now });
  if (!v.ok) throw new Error(`root grant refused: ${v.error}`);
  let entries;
  try {
    entries = await readEntries(path);
  } catch (e) {
    throw new Error(`root grant refused: existing grants file is unreadable (${e.message})`);
  }
  const kept = entries.filter((entry) => {
    const claims = decodeGrantClaims(envelopeOf(entry));
    return entry?.grantId !== v.claims.grantId && claims?.grantId !== v.claims.grantId;
  });
  kept.push({ grantId: v.claims.grantId, rootPath: v.claims.rootPath, envelope });
  await writeEntries(path, kept);
  return v.claims;
}

/**
 * Revoke by grantId or by absolute root path. Matching uses the convenience
 * fields or the decoded (untrusted) claims — removal is fail-closed, so
 * trusting them here can only ever remove access, never grant it.
 */
export async function revokeRootGrant({ path = defaultRootGrantsPath(), selector } = {}) {
  if (!selector || typeof selector !== 'string') throw new Error('revoke selector (grantId or root path) is required');
  let entries;
  try {
    entries = await readEntries(path);
  } catch (e) {
    throw new Error(`could not read the grants file: ${e.message}`);
  }
  const caseInsensitive = platform() === 'win32';
  const samePath = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = resolve(a);
    const y = resolve(b);
    return caseInsensitive ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  const kept = entries.filter((entry) => {
    const claims = decodeGrantClaims(envelopeOf(entry));
    if (entry?.grantId === selector || claims?.grantId === selector) return false;
    if (samePath(entry?.rootPath, selector) || samePath(claims?.rootPath, selector)) return false;
    return true;
  });
  const removed = entries.length - kept.length;
  if (removed) await writeEntries(path, kept);
  return { removed, remaining: kept.length };
}

/**
 * The request record a spoke (or its operator) hands to the hub: one absolute
 * folder, read-only scope, who is asking, and why. `actionHash` binds the
 * record to the Guard action the hub should put in front of a human
 * (buildRootGrantAction in the shared protocol). The record itself grants
 * nothing; only a signed grant envelope does.
 */
export function createRootRequest({ rootPath, reason, requester = null, spokeDeviceId, now = Date.now(), requestId = randomUUID() } = {}) {
  if (!isAbsoluteRootPath(rootPath)) throw new Error('rootPath must be an absolute path');
  if (!spokeDeviceId || typeof spokeDeviceId !== 'string') throw new Error('spokeDeviceId is required');
  const cleanReason = String(reason ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  if (!cleanReason) throw new Error('a reason is required');
  return {
    version: 1,
    kind: 'root-request',
    requestId,
    rootPath,
    scope: 'read-only',
    requester: requester || spokeDeviceId,
    reason: cleanReason,
    spokeDeviceId,
    requestedAt: new Date(now).toISOString(),
    actionHash: rootGrantActionHash({ rootPath, scope: 'read-only', spokeDeviceId, expiresAt: null }),
  };
}

export async function saveRootRequest({ path, request } = {}) {
  const target = path || defaultRootRequestPath(request.requestId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(request, null, 2), { mode: 0o600 });
  return target;
}

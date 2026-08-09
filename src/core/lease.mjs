// THE LOCAL LEASE AUTHORITY — at most one active writer per project, enforced.
//
// WHY THIS FILE EXISTS
//
// README.md advertises "a database-enforced single active write lease per
// project," and the desktop UI repeats it as a "Lease invariant." Neither was
// true of file writes. Measured 2026-07-29:
//
//   - `requireActiveLease` (src/adapters/neon.mjs:151) had exactly four callers
//     — lines 736, 875, 923, 978 — and all four are Postgres writes to
//     Helmion's OWN coordination tables. None of them is a file write.
//   - grep for "lease" across src/agent/tools.mjs and src/core/governance-gate.mjs
//     returned ZERO matches, so nothing between an agent asking to write a file
//     and the write landing consulted a lease at all.
//   - desktop/Helmion.LocalService.Protocol/WorkspaceInspector.cs:56 built the
//     UI's lease status from a HARDCODED constant, "UNAVAILABLE".
//
// So the invariant was a sentence, not a mechanism.
//
// WHY IT IS LOCAL AND NOT THE DATABASE ONE
//
// The Postgres lease cannot back this promise for anyone but Troy. It needs a
// Neon connection string, a schema, and a reachable database. Someone who
// clones this repo has none of those, so a database-only lease means the
// invariant is unenforced on every machine except one. A file the OS can create
// atomically is available everywhere, needs no configuration, and works
// offline. The durable provider stays what it always was — cross-machine
// coordination — and this is the floor underneath it.
//
// HOW THE MUTUAL EXCLUSION ACTUALLY WORKS
//
// A fully written same-directory temporary record is published with an
// exclusive hard link. The OS either creates the final name or fails with
// EEXIST in one syscall. There is no read-then-write window and no visible
// partial JSON record. Everything else here is bookkeeping on top of that one
// guarantee.
//
// FAILURE POSTURE: CLOSED.
//
// A lease file that cannot be read, parsed, or understood refuses mutations. It
// does NOT fall through to "no lease found, carry on" — that reading is how a
// guard becomes decoration. The only thing that grants a mutation is a lease
// this process provably holds.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const LEASE_FILE = 'lease.json';
export const LEASE_DIR = '.helmion';
export const LEASE_VERSION = 1;

// 90 seconds. Long enough that a slow tool call does not lose the lease
// mid-write; short enough that a crashed session frees the project inside two
// minutes without anyone intervening.
export const DEFAULT_TTL_MS = 90_000;

export class LeaseHeldError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LeaseHeldError';
    this.details = details;
  }
}

export class LeaseUnreadableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LeaseUnreadableError';
    this.details = details;
  }
}

export function leasePath(workspace) {
  if (!workspace || typeof workspace !== 'string') {
    throw new TypeError('a lease needs a workspace path');
  }
  return path.join(workspace, LEASE_DIR, LEASE_FILE);
}

// Is a pid still running? `kill(pid, 0)` sends no signal; it only asks the
// kernel whether it could. ESRCH means gone. EPERM means it exists and belongs
// to somebody else — which for our purposes is very much alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function parseRecord(raw, file) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    throw new LeaseUnreadableError(
      `the lease file at ${file} is not valid JSON (${err.message})`,
      { file },
    );
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new LeaseUnreadableError(`the lease file at ${file} is not an object`, { file });
  }
  for (const field of ['leaseToken', 'projectSlug', 'expiresAt', 'pid', 'host']) {
    if (record[field] === undefined || record[field] === null) {
      throw new LeaseUnreadableError(
        `the lease file at ${file} is missing "${field}"; refusing to guess who holds it`,
        { file, field },
      );
    }
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (Number.isNaN(expiresAt)) {
    throw new LeaseUnreadableError(
      `the lease file at ${file} has an unparseable expiresAt (${record.expiresAt})`,
      { file },
    );
  }
  return { ...record, expiresAtMs: expiresAt };
}

/**
 * Read the lease without taking it. Throws LeaseUnreadableError on a corrupt
 * file — callers must decide, and every caller in this repo decides "refuse".
 *
 * @returns {null | object} null when no lease file exists at all.
 */
export function readLease(workspace, { now = Date.now() } = {}) {
  const file = leasePath(workspace);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new LeaseUnreadableError(
      `the lease file at ${file} could not be read (${err.message})`,
      { file, code: err.code },
    );
  }
  const record = parseRecord(raw, file);
  const expired = record.expiresAtMs <= now;
  const sameHost = record.host === hostname();
  // Liveness is only meaningful for a pid on this machine. A record from
  // another host is judged purely on its expiry.
  const holderAlive = sameHost ? pidAlive(record.pid) : !expired;
  return {
    ...record,
    file,
    expired,
    sameHost,
    holderAlive,
    // Takeable when the clock says it is dead, or when the process that wrote
    // it on THIS machine is gone. The second half is what stops a hard crash
    // from parking a project for the full TTL.
    takeable: expired || (sameHost && !holderAlive),
  };
}

// Write beside the target and rename. rename() is atomic on the same volume, so
// a reader never sees a half-written lease.
//
// Returns false instead of throwing when the rename is REFUSED because another
// process is contending for the same target. On Windows, renaming over a file
// another process holds open fails with EPERM/EACCES — POSIX would silently
// replace it. Two sessions deciding simultaneously to take over the same stale
// lease is a normal race, not an exception: exactly one rename wins, and the
// loser must be told it lost rather than crashing with a filesystem error.
//
// Found by test/lease.test.mjs "THE RACE", which produced
// "EPERM: operation not permitted, rename ... .tmp -> lease.json" on the first
// run with twelve concurrent processes.
function writeRecordAtomically(file, record) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, file);
    return true;
  } catch (err) {
    rmSync(temporary, { force: true });
    if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY' || err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

// Publish the first lease only after its complete bytes exist. Opening the
// final path with `wx` and then writing it gives exclusive ownership, but it
// briefly exposes a zero-length/partial JSON file to the losing processes.
// A hard link created from a fully written same-directory temporary file is
// also exclusive (EEXIST names the loser) and the target is complete at the
// instant it becomes visible.
function createRecordExclusively(file, record) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.create`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    linkSync(temporary, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Take the lease for this project, or fail because somebody else holds it.
 *
 * @returns {{record: object, tookOverFrom: object|null}}
 * @throws {LeaseHeldError} another live holder has it
 * @throws {LeaseUnreadableError} the existing file cannot be understood
 */
export function acquireLease(workspace, {
  projectSlug,
  coordinatorId = 'claude-code',
  instanceId = null,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
} = {}) {
  if (!projectSlug) throw new TypeError('a lease needs a projectSlug');
  const file = leasePath(workspace);
  mkdirSync(path.dirname(file), { recursive: true });

  const record = {
    version: LEASE_VERSION,
    projectSlug,
    leaseToken: randomUUID(),
    coordinatorId,
    instanceId: instanceId ?? `${hostname()}:${process.pid}`,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
    tookOverFrom: null,
  };

  // THE ATOMIC STEP. The full temporary record is linked to the final name
  // exclusively, so the OS decides one winner in one syscall and no loser can
  // observe half-written JSON.
  try {
    if (createRecordExclusively(file, record)) {
      return { record, tookOverFrom: null };
    }
  } catch (err) {
    throw new LeaseUnreadableError(
      `the lease at ${file} could not be created (${err.message})`,
      { file, code: err.code },
    );
  }

  // Somebody got there first. Whether we may take it over is a question about
  // THEIR record, so read it — and let a corrupt file throw rather than
  // treating "cannot tell" as "go ahead".
  const existing = readLease(workspace, { now });
  if (existing === null) {
    // It vanished between the failed create and the read. Try once more.
    return acquireLease(workspace, { projectSlug, coordinatorId, instanceId, ttlMs, now });
  }

  // SAME WRITER, DIFFERENT OBJECT. A lease already held by this process on this
  // machine is ours — adopt it and hand back the existing token.
  //
  // The invariant is "at most one active WRITER per project", and a writer is a
  // process, not an object. Two tool runtimes inside one Node process are the
  // same writer: `src/agent/tools.mjs` builds a fresh runtime every time the
  // permission mode changes (bridge.mjs does exactly this on a dropdown change)
  // and on every session reset. Treating that as a conflict deadlocked a session
  // against itself — caught by test/ask-permission.test.mjs "a permission change
  // clears session grants", which went red the moment the lease was wired in.
  //
  // A genuinely separate session is a different pid and is still refused below;
  // test/lease.test.mjs "THE RACE" proves that with twelve real processes.
  // Only a LIVE lease of ours is adopted. One of ours that has expired falls
  // through to the takeover path below, which rewrites it with a fresh expiry —
  // adopting an expired token would hand back something verifyLeaseHeld then
  // refuses, which is worse than not having it.
  if (!existing.expired && existing.pid === process.pid && existing.host === hostname()) {
    const adopted = { ...existing };
    for (const derived of ['expiresAtMs', 'expired', 'sameHost', 'holderAlive', 'takeable', 'file']) {
      delete adopted[derived];
    }
    return { record: adopted, tookOverFrom: null, reused: true };
  }

  if (!existing.takeable) {
    throw new LeaseHeldError(
      `another writer holds the lease on ${existing.projectSlug}: `
      + `${existing.coordinatorId}/${existing.instanceId} (pid ${existing.pid} on ${existing.host}), `
      + `until ${existing.expiresAt}`,
      {
        projectSlug: existing.projectSlug,
        holder: existing.coordinatorId,
        instanceId: existing.instanceId,
        pid: existing.pid,
        host: existing.host,
        expiresAt: existing.expiresAt,
      },
    );
  }

  // Takeover, recorded. Who was displaced and why is written into the new
  // record, because a lease that changes hands silently is a lease nobody can
  // audit afterwards.
  record.tookOverFrom = {
    leaseToken: existing.leaseToken,
    coordinatorId: existing.coordinatorId,
    instanceId: existing.instanceId,
    pid: existing.pid,
    host: existing.host,
    expiresAt: existing.expiresAt,
    reason: existing.expired
      ? 'the previous lease had expired'
      : 'the process holding it on this machine is no longer running',
  };
  // Two sessions can decide to claim the same stale lease at the same instant.
  // Only one rename wins; the other is told it lost, which is the invariant
  // doing its job rather than an error.
  if (!writeRecordAtomically(file, record)) {
    throw new LeaseHeldError(
      `another writer claimed the stale lease on ${projectSlug} at the same moment`,
      { projectSlug, contended: true },
    );
  }
  return { record, tookOverFrom: record.tookOverFrom };
}

/**
 * Push the expiry out. Only the holder can renew — a token that does not match
 * is refused, so a stale session cannot keep a project it has already lost.
 */
export function renewLease(workspace, { leaseToken, ttlMs = null, now = Date.now() } = {}) {
  const existing = readLease(workspace, { now });
  if (existing === null) {
    throw new LeaseHeldError('there is no lease to renew', { workspace });
  }
  if (existing.leaseToken !== leaseToken) {
    throw new LeaseHeldError(
      'this session does not hold the lease it is trying to renew; it was taken over',
      { heldBy: existing.instanceId, expected: leaseToken },
    );
  }
  const effectiveTtl = ttlMs ?? existing.ttlMs ?? DEFAULT_TTL_MS;
  const record = {
    ...existing,
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + effectiveTtl).toISOString(),
    ttlMs: effectiveTtl,
  };
  delete record.expiresAtMs;
  delete record.expired;
  delete record.sameHost;
  delete record.holderAlive;
  delete record.takeable;
  delete record.file;
  if (!writeRecordAtomically(existing.file, record)) {
    throw new LeaseHeldError(
      'the lease file was being replaced by another writer while this session tried to renew',
      { contended: true },
    );
  }
  return record;
}

/**
 * Give the lease up. Releasing one you do not hold is refused rather than
 * silently ignored, so a confused session cannot free somebody else's project.
 */
export function releaseLease(workspace, { leaseToken, now = Date.now() } = {}) {
  const existing = readLease(workspace, { now });
  if (existing === null) return { released: false, reason: 'there was no lease' };
  if (existing.leaseToken !== leaseToken) {
    throw new LeaseHeldError(
      'this session does not hold the lease it is trying to release',
      { heldBy: existing.instanceId, expected: leaseToken },
    );
  }
  rmSync(existing.file, { force: true });
  return { released: true, reason: '' };
}

/**
 * THE ENFORCEMENT QUESTION. Does this session provably hold the write lease
 * right now?
 *
 * Never throws. Callers are gates, and a gate that throws is a gate that fails
 * open somewhere upstream. Every "no" carries a reason a human can act on.
 *
 * @returns {{held: boolean, reason: string, record: object|null, failedClosed: boolean}}
 */
export function verifyLeaseHeld(workspace, { leaseToken, now = Date.now() } = {}) {
  if (!leaseToken) {
    return {
      held: false,
      failedClosed: false,
      record: null,
      reason: 'this session holds no write lease for the project',
    };
  }
  let existing;
  try {
    existing = readLease(workspace, { now });
  } catch (err) {
    return {
      held: false,
      failedClosed: true,
      record: null,
      reason: `the write lease could not be read (${err.message}); the lease check fails closed`,
    };
  }
  if (existing === null) {
    return {
      held: false,
      failedClosed: false,
      record: null,
      reason: 'the project has no write lease on disk, so no writer is authorized',
    };
  }
  if (existing.leaseToken !== leaseToken) {
    return {
      held: false,
      failedClosed: false,
      record: existing,
      reason: `the write lease is held by ${existing.coordinatorId}/${existing.instanceId} `
        + `(pid ${existing.pid} on ${existing.host}), not by this session`,
    };
  }
  if (existing.expired) {
    return {
      held: false,
      failedClosed: false,
      record: existing,
      reason: `this session's write lease expired at ${existing.expiresAt}`,
    };
  }
  return { held: true, failedClosed: false, record: existing, reason: '' };
}

/**
 * Read-only posture for a UI. Reports what is actually on disk, including
 * "unreadable", which is a real state and must not be laundered into "none".
 */
export function inspectLease(workspace, { now = Date.now() } = {}) {
  let existing;
  try {
    existing = readLease(workspace, { now });
  } catch (err) {
    return {
      status: 'UNREADABLE',
      label: 'Write lease unreadable',
      detail: err.message,
      isLive: false,
      record: null,
    };
  }
  if (existing === null) {
    return {
      status: 'NONE',
      label: 'No active write lease',
      detail: 'No session currently holds the write lease for this project.',
      isLive: false,
      record: null,
    };
  }
  if (existing.takeable) {
    return {
      status: 'STALE',
      label: 'Write lease stale',
      detail: existing.expired
        ? `Held by ${existing.instanceId} but expired at ${existing.expiresAt}. The next writer may take it over.`
        : `Held by ${existing.instanceId}, whose process (pid ${existing.pid}) is no longer running. The next writer may take it over.`,
      isLive: false,
      record: existing,
    };
  }
  return {
    status: 'ACTIVE',
    label: 'Write lease active',
    detail: `Held by ${existing.coordinatorId}/${existing.instanceId} (pid ${existing.pid} on ${existing.host}) until ${existing.expiresAt}.`,
    isLive: true,
    record: existing,
  };
}

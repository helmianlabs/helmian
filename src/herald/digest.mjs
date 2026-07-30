// Helmion Herald — what needs Troy, wherever he is.
//
// A herald announces. This is the pure half: it reads what the guards and the
// advisory loop already wrote to disk and turns it into a short, honest answer
// to one question — is anything waiting on me?
//
// WHY IT READS FILES AND NOT A DATABASE. Everything it reports is already
// durable on disk: the block ledger (.helmion/audit/*.jsonl, written by
// `helmion guard`), the advisory journal (.helmion/advisory/*.jsonl, written by
// `helmion review`), and the write lease (.helmion/lease.json). A phone
// companion that needs a database connection to tell you nothing is wrong is a
// phone companion that goes dark exactly when the network does.
//
// IT NEVER INVENTS A CALM STATE. The one failure a status surface must not have
// is looking green because it could not read anything. Every section reports
// `computed: false` with a reason when it could not be determined, and the
// headline treats "could not tell" as its own state — never as "fine". Same
// discipline as the guard panel's Unknown.
//
// READ-ONLY BY CONSTRUCTION. There is no write path in this file and none in the
// server that serves it. Approving something from a phone means authenticating a
// human on a device, and that is not a thing to bolt on at the end of a night.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const AUDIT_DIR = join('.helmion', 'audit');
export const ADVISORY_DIR = join('.helmion', 'advisory');
export const LEASE_FILE = join('.helmion', 'lease.json');

/** How many recent items each section carries. A phone screen, not an archive. */
export const RECENT_LIMIT = 25;

async function readJsonlDir(directory, limit) {
  try {
    const names = (await readdir(directory)).filter((n) => n.endsWith('.jsonl')).sort();
    if (names.length === 0) return { computed: true, rows: [], reason: '' };

    const rows = [];
    // Newest files first, and stop as soon as there are enough.
    for (const name of names.reverse()) {
      const text = await readFile(join(directory, name), 'utf8');
      const lines = text.split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
        if (rows.length >= limit) return { computed: true, rows, reason: '' };
      }
    }
    return { computed: true, rows, reason: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { computed: true, rows: [], reason: 'nothing recorded here yet' };
    }
    return { computed: false, rows: [], reason: error.message };
  }
}

/** Blocks the execution guard has refused. */
export async function readBlocks(workspace, limit = RECENT_LIMIT) {
  const result = await readJsonlDir(join(workspace, AUDIT_DIR), limit);
  return {
    computed: result.computed,
    reason: result.reason,
    items: result.rows.map((row) => ({
      at: row.timestamp ?? row.at ?? null,
      layer: row.layer ?? 'unknown',
      matched: row.matchedPattern ?? row.matched ?? '',
      text: String(row.text ?? '').slice(0, 400),
      outcome: row.outcome ?? 'blocked',
      source: row.source ?? '',
    })),
  };
}

/**
 * Advisory decisions, and specifically the ones that stopped.
 *
 * A decision that was ALLOWED is not news. The herald leads with refusals,
 * because those are the only ones that might be waiting on a person.
 */
export async function readAdvisory(workspace, limit = RECENT_LIMIT) {
  const result = await readJsonlDir(join(workspace, ADVISORY_DIR), limit * 4);
  const decisions = result.rows.filter((row) => row.kind === 'decision');

  return {
    computed: result.computed,
    reason: result.reason,
    items: decisions.slice(0, limit).map((row) => ({
      at: row.at ?? null,
      summary: row.summary ?? '',
      allowed: row.decision?.allowed === true,
      why: row.decision?.reason ?? '',
      missing: row.decision?.missing ?? [],
      blocks: (row.decision?.blocks ?? []).map((b) => `${b.advisor}: ${b.reason}`),
      concerns: (row.decision?.concerns ?? []).map((c) => `${c.advisor}: ${c.reason}`),
    })),
  };
}

/**
 * The write lease. Stale means the next agent may take it — worth knowing from a
 * sofa, because it is the difference between "my machine is working" and
 * "nothing has touched this in an hour".
 */
export async function readLease(workspace, now = new Date()) {
  try {
    const parsed = JSON.parse(await readFile(join(workspace, LEASE_FILE), 'utf8'));
    const expires = parsed.expiresAt ? new Date(parsed.expiresAt) : null;
    const expired = expires ? expires.getTime() < new Date(now).getTime() : null;
    return {
      computed: true,
      reason: '',
      holder: parsed.instanceId ?? parsed.coordinatorId ?? 'unknown',
      project: parsed.projectSlug ?? '',
      expiresAt: parsed.expiresAt ?? null,
      state: expired === null ? 'unknown' : (expired ? 'stale' : 'active'),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { computed: true, reason: 'no lease file — nothing holds the write lock', state: 'none' };
    }
    return { computed: false, reason: error.message, state: 'unknown' };
  }
}

/**
 * The headline. Three states and nothing softer.
 *
 *   needs-you  something is refused, blocked, or missing a review
 *   quiet      everything readable, nothing waiting
 *   unknown    at least one section could NOT be read
 *
 * `unknown` outranks `quiet` deliberately. A herald that says "all quiet"
 * because it could not open a file is worse than one that says nothing.
 */
export function summarize({ blocks, advisory, lease }) {
  const unreadable = [];
  if (!blocks?.computed) unreadable.push('block ledger');
  if (!advisory?.computed) unreadable.push('advisory journal');
  if (!lease?.computed) unreadable.push('write lease');

  const refusals = (advisory?.items ?? []).filter((d) => !d.allowed);
  const recentBlocks = blocks?.items ?? [];

  if (unreadable.length > 0) {
    return {
      state: 'unknown',
      headline: `Could not read: ${unreadable.join(', ')}`,
      detail: 'This is a could-not-compute, not an all-clear. Something on the machine is wrong.',
      waiting: refusals.length + recentBlocks.length,
    };
  }

  const waiting = refusals.length;
  if (waiting > 0) {
    const first = refusals[0];
    return {
      state: 'needs-you',
      headline: `${waiting} change${waiting === 1 ? '' : 's'} refused and waiting`,
      detail: first ? `${first.summary} — ${first.why}`.slice(0, 300) : '',
      waiting,
    };
  }

  if (recentBlocks.length > 0) {
    return {
      state: 'quiet',
      headline: 'Nothing waiting on you',
      detail: `${recentBlocks.length} command${recentBlocks.length === 1 ? '' : 's'} blocked recently. `
        + 'The guard handled them; none needs a decision.',
      waiting: 0,
    };
  }

  return {
    state: 'quiet',
    headline: 'Nothing waiting on you',
    detail: 'No refusals, no blocks recorded. Everything readable and quiet.',
    waiting: 0,
  };
}

/** The whole digest, in one call. */
export async function buildDigest(workspace, { now = new Date(), limit = RECENT_LIMIT } = {}) {
  const [blocks, advisory, lease] = await Promise.all([
    readBlocks(workspace, limit),
    readAdvisory(workspace, limit),
    readLease(workspace, now),
  ]);

  return {
    tool: 'Helmion Herald',
    workspace,
    generatedAt: new Date(now).toISOString(),
    summary: summarize({ blocks, advisory, lease }),
    lease,
    advisory,
    blocks,
  };
}

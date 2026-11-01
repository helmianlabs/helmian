// The learning loop's capture store: one candidate per abstracted pattern
// (the "skeleton"), deduped by fingerprint, counted on every re-sighting.
//
// A candidate is what a blocked or held attempt TEACHES the Guard. It is
// recorded inside decide() (server.mjs) after normalizeAction has run, so
// by construction it can only ever hold what the audit trail itself was
// allowed to hold: the action's already-redacted summary, its signals, its
// content hash. Raw text never reaches this store — there is no parameter
// for it. The skeleton goes one step further than the summary: typed
// spans, emails, phones, IPs, URLs, numbers and proper-name-shaped tokens
// are replaced by slots, so the learning store holds no contact PII even
// when a summary legitimately carries a redacted span.
//
// Two backends with one interface, mirroring state.mjs / audit.mjs: memory
// (tests) and an append-only JSONL file (production). The file backend
// appends the full updated record on every sighting; the latest record
// for a fingerprint wins on load, and only a torn LAST line is tolerated.
// Lifecycle events are NOT kept here — they are appended to the
// hash-chained audit trail by the caller (candidate.recorded /
// candidate.sighted), so what the Guard learned and when is verifiable
// from the same chain as its decisions. Compaction of the JSONL is a
// later bite, noted honestly rather than half-built.
//
// Swarm arithmetic is computed on read (isSwarm), never stored as fact:
// a burst is >= 5 sightings inside a rolling hour across >= 2 distinct
// principals. The window applies to the sighting timestamps; the
// principal count is over the candidate's life (the honest approximation
// the stored data supports — recentSightings keeps the last 50).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SWARM_MIN_SIGHTINGS = 5;
export const SWARM_WINDOW_MS = 60 * 60 * 1000;
export const SWARM_MIN_PRINCIPALS = 2;
const MAX_RECENT_SIGHTINGS = 50;
const SKELETON_MAX_CHARS = 500;

/* ── The skeleton ─────────────────────────────────────────────────────────
 *
 * Deterministic slot substitution over the redacted summary. Keep-list
 * discipline: the instruction-bearing words stay (they ARE the pattern);
 * everything that identifies a person, a place, an account or an amount
 * becomes a slot. Sentence-initial capitals are ordinary grammar, not
 * names, and are kept; a capitalized token mid-sentence is name-shaped
 * and slots. */

const REDACTED_SPAN = /\[REDACTED:([a-z0-9_]+)\]/gi;
const URL_SHAPE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|org|net|io|cloud|dev|ai|co|uk|de)\/[^\s]*/gi;
const EMAIL_SHAPE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_SHAPE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_SHAPE = /(?<!\d)(?:\+?\d[\d .()-]{8,}\d)(?!\d)/g; // mirrors redact.js
const NUMBER_SHAPE = /(?<!\d)(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\d)/g;
const NAME_SHAPE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;

function slotNames(segment) {
  return segment.replace(NAME_SHAPE, (match, offset) => {
    // A match at the very start of a sentence (allowing an opening quote
    // or bracket) is grammar, not a name.
    const before = segment.slice(0, offset).trimEnd();
    if (before === '' || /["'([{]$/.test(before)) return match;
    return '[slot:name]';
  });
}

export function skeletonize(summary) {
  let text = String(summary ?? '');
  text = text.replace(REDACTED_SPAN, (match, type) => `[slot:${type}]`);
  text = text.replace(URL_SHAPE, '[slot:url]');
  text = text.replace(EMAIL_SHAPE, '[slot:email]');
  text = text.replace(IPV4_SHAPE, '[slot:ipv4]');
  text = text.replace(PHONE_SHAPE, '[slot:phone]');
  text = text.replace(NUMBER_SHAPE, '[slot:number]');
  text = text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => slotNames(segment))
    .join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, SKELETON_MAX_CHARS);
}

export function fingerprintOf(skeleton) {
  return createHash('sha256').update(String(skeleton)).digest('hex');
}

/** Burst test, computed on read. See the header for the exact semantics. */
export function isSwarm(candidate, nowMs = Date.now()) {
  if (!candidate || !candidate.evidence) return false;
  const recent = (candidate.evidence.recentSightings || [])
    .filter((t) => nowMs - t <= SWARM_WINDOW_MS);
  return recent.length >= SWARM_MIN_SIGHTINGS
    && (candidate.evidence.distinctPrincipals || 0) >= SWARM_MIN_PRINCIPALS;
}

/* ── The store ──────────────────────────────────────────────────────────── */

function clone(record) {
  return JSON.parse(JSON.stringify(record));
}

function applySighting(rows, input, now) {
  const skeleton = skeletonize(input.summary);
  const fingerprint = fingerprintOf(skeleton);
  const atMs = now();
  const at = new Date(atMs).toISOString();
  const existing = rows.get(fingerprint);

  if (!existing) {
    const candidate = {
      candidateId: `cand_${fingerprint.slice(0, 16)}`,
      fingerprint,
      status: 'candidate',
      surface: input.surface || 'server',
      principalId: input.principalId || null,
      principalIds: input.principalId ? [input.principalId] : [],
      signals: [...new Set(input.signals || [])].sort(),
      ruleIdFired: input.ruleId || 'default',
      verdict: input.verdict,
      skeleton,
      evidence: {
        redactedSummary: String(input.summary ?? ''),
        contentHash: input.contentHash || null,
        firstSeen: at,
        lastSeen: at,
        sightingCount: 1,
        distinctPrincipals: input.principalId ? 1 : 0,
        recentSightings: [atMs],
      },
      humanDisposition: null,
      promotedRuleId: null,
    };
    rows.set(fingerprint, candidate);
    return { candidate: clone(candidate), created: true };
  }

  existing.evidence.sightingCount += 1;
  existing.evidence.lastSeen = at;
  existing.evidence.recentSightings = [...existing.evidence.recentSightings, atMs]
    .slice(-MAX_RECENT_SIGHTINGS);
  if (input.principalId && !existing.principalIds.includes(input.principalId)) {
    existing.principalIds.push(input.principalId);
    existing.evidence.distinctPrincipals = existing.principalIds.length;
  }
  if (input.principalId) existing.principalId = input.principalId;
  existing.ruleIdFired = input.ruleId || existing.ruleIdFired;
  existing.verdict = input.verdict || existing.verdict;
  // A disposition never hides a pattern that fires again (the guard
  // findings ack rule): a false-positive mark clears on re-sighting.
  if (existing.humanDisposition === 'false-positive') existing.humanDisposition = null;
  return { candidate: clone(existing), created: false };
}

function storeShape(rows, persist) {
  return {
    record(input, now = Date.now) {
      const result = applySighting(rows, input, now);
      if (persist) persist(rows.get(result.candidate.fingerprint));
      return result;
    },
    get(fingerprint) {
      const found = rows.get(fingerprint);
      return found ? clone(found) : null;
    },
    all() {
      return [...rows.values()]
        .sort((a, b) => (a.evidence.firstSeen < b.evidence.firstSeen ? -1 : 1))
        .map(clone);
    },
    // The human half of the flywheel: a person, not a counter, marks a
    // candidate. Promotion to a compiled rule is a reviewed code change
    // (plan §2.3 Path A); this store only carries the disposition.
    setDisposition(fingerprint, disposition) {
      const found = rows.get(fingerprint);
      if (!found) return null;
      found.humanDisposition = disposition;
      if (persist) persist(found);
      return clone(found);
    },
    get size() { return rows.size; },
  };
}

export function memoryCandidates() {
  return storeShape(new Map(), null);
}

export function fileCandidates(path, { now = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const rows = new Map();
  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      try {
        const record = JSON.parse(lines[i]);
        if (record && record.t === 'candidate' && record.candidate?.fingerprint) {
          rows.set(record.candidate.fingerprint, record.candidate);
        }
      } catch {
        // Only a torn LAST line (crash mid-append) is tolerated — the
        // same discipline as state.mjs.
        if (lines.slice(i + 1).some(Boolean)) throw new Error(`candidates file ${path} is corrupt at line ${i + 1}`);
      }
    }
  }
  const persist = (candidate) => {
    appendFileSync(path, `${JSON.stringify({ t: 'candidate', candidate })}\n`, { mode: 0o600 });
  };
  const store = storeShape(rows, persist);
  // The file backend carries the clock it was built with (the same
  // options-object pattern as memoryAudit/fileAudit); a caller may still
  // pass an explicit clock per record, exactly as with the memory store.
  const baseRecord = store.record;
  store.record = (input, nowFn) => baseRecord(input, typeof nowFn === 'function' ? nowFn : now);
  return store;
}

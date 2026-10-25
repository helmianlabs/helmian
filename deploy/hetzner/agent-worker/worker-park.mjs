// worker-park.mjs — quota park + clone guard for agent-worker.mjs
//
// PREPARED PATCH MODULE — BUILT LOCALLY 2026-10-24, NOT INSTALLED,
// UNVERIFIED against the live worker file. See INSTALL.md in this folder.
//
// Why this exists (measured 2026-10-24): the worker retried a quota-dead
// Gemini job until the job died, spawning clone runs of the same job (three
// Gemini runs alive at once on one dead quota). On a 2 GB server those
// clones are part of how memory filled until the SSH door stopped answering.
//
// What this module gives the worker:
//   - isQuotaError(text)   — classify a runner/CLI failure as quota-class
//                            (HTTP 429, RESOURCE_EXHAUSTED, quota/rate-limit
//                            wording, spending/usage limits, tier refusal).
//   - parkProvider(name)   — park that provider until its quota window
//                            resets (default: next 07:00 UTC, the Gemini
//                            daily-quota reset; override per provider).
//   - isParked(name)       — the claim loop asks before dispatching work.
//   - claimOnce(id)        — in-flight guard: the same message id can never
//                            have two live runs again (the clone signature).
//
// Park state persists in a small JSON file next to the worker so a worker
// restart does not un-park a dead quota and restart the clone cycle.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARK_FILE = process.env.WORKER_PARK_FILE ?? join(HERE, 'park-state.json');

// Gemini's free daily quota resets ~07:00 UTC (measured 2026-10-24: the
// 1:05 AM MDT re-fire was scheduled against a 07:00 UTC reset).
const DEFAULT_RESET_HOUR_UTC = 7;
// If a provider's reset is unknown, park for this long instead.
const FALLBACK_PARK_MS = Number(process.env.WORKER_PARK_FALLBACK_MS ?? 60 * 60 * 1000);

// Providers known to have a daily UTC reset hour. Anything else falls back
// to FALLBACK_PARK_MS. Antigravity rides the same Google daily windows, so
// it is listed too; grok's weekly window is NOT daily — leave it on the
// fallback unless a reset hour is proven.
const RESET_HOUR_UTC = {
  gemini: DEFAULT_RESET_HOUR_UTC,
  antigravity: DEFAULT_RESET_HOUR_UTC,
};

const QUOTA_RE =
  /(\b429\b|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit|too many requests|IneligibleTier|UNSUPPORTED_CLIENT|spending[\s_-]?limit|usage limit|weekly usage|AI credits)/i;

export function isQuotaError(text) {
  return QUOTA_RE.test(String(text ?? ''));
}

// Next reset instant for a provider: its daily UTC reset hour if known,
// otherwise now + fallback.
export function nextReset(provider, now = new Date()) {
  const hour = RESET_HOUR_UTC[String(provider ?? '').toLowerCase()];
  if (hour === undefined) return new Date(now.getTime() + FALLBACK_PARK_MS);
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0,
  ));
  if (reset <= now) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(PARK_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  const tmp = `${PARK_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, PARK_FILE); // atomic: a crash mid-write never corrupts the park
}

// Park a provider until its quota window resets. Returns the until-Date.
export function parkProvider(provider, reason = '') {
  const key = String(provider ?? '').toLowerCase();
  const until = nextReset(key);
  const state = loadState();
  state[key] = { until: until.toISOString(), reason: String(reason).slice(0, 300), parkedAt: new Date().toISOString() };
  saveState(state);
  return until;
}

// The parked-until Date for a provider, or null if not (or no longer) parked.
// Expired parks clear themselves from the state file on read.
export function parkedUntil(provider, now = new Date()) {
  const key = String(provider ?? '').toLowerCase();
  const state = loadState();
  const entry = state[key];
  if (!entry) return null;
  const until = new Date(entry.until);
  if (until <= now) {
    delete state[key];
    saveState(state);
    return null;
  }
  return until;
}

export function isParked(provider, now = new Date()) {
  return parkedUntil(provider, now) !== null;
}

// ---- clone guard -------------------------------------------------------
// One live run per message id, ever. claimOnce returns true if the caller
// owns the run; false if another run already has this message (a clone in
// the making — the caller should skip, not spawn).
const inFlight = new Set();

export function claimOnce(messageId) {
  const id = String(messageId ?? '');
  if (!id || inFlight.has(id)) return false;
  inFlight.add(id);
  return true;
}

export function releaseClaim(messageId) {
  inFlight.delete(String(messageId ?? ''));
}

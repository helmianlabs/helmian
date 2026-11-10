// Helmian Site Guard — intake screening: the website-protection
// piece of the Guard family (named by Troy, 2026-11-09), built for
// Helmian's own house first. The family, kept apart: Helmian Guard is
// the browser extension, the Executive Guard is the approvals server,
// and Helmian Site Guard is this — the server-side screen standing
// between arriving content and the seats.
//
// What it screens: every channel message the mesh is about to hand to
// a seat (envoy-mesh.mjs agentWork — the one road content reaches a
// seat by, whether it arrived from the desk, a Discord/Slack bridge,
// or another seat's debate turn), screened AFTER the Guard spine's
// ask evaluation (envoy-guard.mjs) has had its say, so a spine
// refusal keeps the spine's own record and this screen speaks only
// where the spine is silent.
//
// The kernels are the ones the tree already owns, reused by import —
// nothing here forks a pattern:
//   - the destructive-command kernel, src/core/governance.mjs
//     detectDestructiveOperation — the same patterns the desktop gate
//     runs (governance-gate.mjs) and the extension's generated
//     kernels are synced from. The full kernel set, not the ask
//     classifier's deliberate subset (envoy-actions.mjs): a chat
//     message carrying a kernel-shaped destruction the classifier
//     never types is still caught here.
//   - the prompt-injection markers from
//     src/cora/artifact-script-content-validation.mjs — only its
//     prompt-injection.* check ids are read. That module's length,
//     structure, PII and credential checks judge artifacts Helmian
//     ships; they are not intake law and are deliberately not
//     applied here.
// The extension's prompt-lane patterns (extension/content/
// prompt-risk.js) are NOT reused: that file is browser-lane code the
// server bundle never carries, and its direct-command subset is
// already covered by the governance kernel. Its natural-language
// erasure-intent patterns belong in the kernel itself if they are
// ever to be shared — a kernel bite, not a fork here.
//
// The posture is the claim lane's: flag and surface. A screen that
// fires records a Guard finding (guard-findings.mjs, the feed the
// Guard panel reads) and the turn proceeds untouched. The stops are
// two, both explicit: the destructive class — the Site Guard intake
// stop — and sustained volume over the rate limiter's stop line
// (bite A2, below). Either way the mesh hands out no work item for
// the message, and each due seat's reply is the Site Guard's
// refusal, in the same terminal shape as a Guard spine refusal.
// Nothing else stops a turn.
//
// Findings carry the Site Guard's own 'site-guard' source: sql/083
// widens sql/047's CHECK to admit it, guard-findings.mjs's enum
// admits it in the same step, and SITE_GUARD_FINDING_SOURCE below is
// the single switch point. (Bite A1 shipped 'cloud' here until the
// migration existed; findings it recorded keep that source, still
// naming the Site Guard in their fingerprint, title, and
// detail.kind.) Ordering: sql/083 must be applied to a database
// before this code writes findings to it — until then the database
// still rejects the new source, and the ingest wrapper logs the
// failed write loudly while turns proceed untouched. The finding
// shape is exactly the ingest input the store (and so the panel)
// already consumes.
// Finding details carry metadata only — class, pattern labels, and
// ids — never the screened text itself.
//
// The ingest wrapper cannot throw, for the same reason bite 3's
// cannot: the screen is a witness, and a witness that can veto the
// turn it witnesses would be a second gate. A failed write is logged
// loudly instead — an unrecorded flag is a hole in the feed, and the
// log is where that hole is announced.
//
// Bite A2 adds the second Site Guard sense: intake VOLUME. The
// screen above judges one message at a time; the rate limiter below
// counts due messages per tenant and per sender over a sliding
// window, at the same choke point, before the screen runs. Crossing
// the flag line is witnessed like any other flag and the turn
// proceeds; a sender whose count stands over the stop line is
// stopped — the rate stop, in the same terminal shape as the intake
// stop — until its window cools. The store is deliberately small:
// an in-process map inside this module instance (the mesh holds
// one), holding message timestamps only — never content. Its
// limits are stated where it is built (createSiteGuardRateLimiter):
// counts live and die with the process, and a deployment running
// several mesh processes enforces the window per process. No
// database table backs it; the findings feed is its only record,
// exactly as the screen's findings are the screen's record.

import { detectDestructiveOperation } from '../core/governance.mjs';
import { validateArtifactScriptContent } from '../cora/artifact-script-content-validation.mjs';

export const SITE_GUARD_NAME = 'Helmian Site Guard';
export const SITE_GUARD_FINDING_SOURCE = 'site-guard';
export const SITE_GUARD_FINGERPRINT_PREFIX = 'helmian-site-guard';
export const SITE_GUARD_KIND = 'helmian-site-guard-intake-screening';

export const SITE_GUARD_CLASS = Object.freeze({
  DESTRUCTIVE: 'destructive-command',
  INJECTION: 'prompt-injection',
});

// Bodies the mesh hands out are capped at 4,000 chars at every
// insertion road; the screen still bounds its own input to the
// artifact validator's cap so a future caller with a longer text
// cannot hand the kernels an unbounded string.
const MAX_SCREEN_CHARS = 12000;

/**
 * Screen one piece of inbound content. Pure: no I/O, no clocks.
 * Returns a frozen verdict:
 *   { blocked, classes: [{ class, hits }] }
 * `blocked` is true only when the destructive-command class fired —
 * the one class that stops a turn. `hits` names what matched, in the
 * owning kernel's own words (governance pattern labels;
 * prompt-injection.* check ids), so a finding can name the pattern
 * the same way every other Guard surface names it.
 */
export function screenIntakeContent(body) {
  const text = String(body ?? '').slice(0, MAX_SCREEN_CHARS);
  const classes = [];
  if (text.trim()) {
    const destructive = detectDestructiveOperation({ command: text });
    if (destructive.blocked) {
      classes.push(Object.freeze({ class: SITE_GUARD_CLASS.DESTRUCTIVE, hits: Object.freeze([...destructive.hits]) }));
    }
    const validation = validateArtifactScriptContent({ scriptKind: 'narration', text });
    const injectionIds = validation.failedCheckIds.filter((id) => id.startsWith('prompt-injection.'));
    if (injectionIds.length) {
      classes.push(Object.freeze({ class: SITE_GUARD_CLASS.INJECTION, hits: Object.freeze(injectionIds) }));
    }
  }
  return Object.freeze({
    blocked: classes.some((entry) => entry.class === SITE_GUARD_CLASS.DESTRUCTIVE),
    classes: Object.freeze(classes),
  });
}

function severityForClass(cls) {
  // The store's existing convention: the extension posts its
  // destructive-command findings as critical and its other flags as
  // warning (envoy-findings.mjs carries the same note).
  return cls === SITE_GUARD_CLASS.DESTRUCTIVE ? 'critical' : 'warning';
}

function titleForClass(cls, channelSlug) {
  const where = channelSlug ? ` in #${channelSlug}` : '';
  return cls === SITE_GUARD_CLASS.DESTRUCTIVE
    ? `${SITE_GUARD_NAME} stopped an inbound message${where} — destructive command pattern`
    : `${SITE_GUARD_NAME} flagged an inbound message${where} — prompt-injection markers`;
}

/**
 * Shape one screening verdict into the findings store's ingest
 * inputs — ONE finding per class that fired, so each kernel class
 * keeps its own row, its own severity, and its own sighting count.
 * The fingerprint is the class and the message, so a re-screen of
 * the same message on a later poll is a re-sighting of the same
 * row, exactly how the extension's and the spine's findings behave.
 * Returns [] for a clean screen. `at` is the screening instant as an
 * ISO string; the store stamps its own first/last-seen times, and
 * this one rides in the detail so the record says when THIS screen
 * happened.
 */
export function siteGuardFindingsForScreening(screening, { channelId, channelSlug = null, messageId, authorKind = null, at } = {}) {
  if (!screening?.classes?.length) return [];
  return screening.classes.map((entry) => Object.freeze({
    fingerprint: `${SITE_GUARD_FINGERPRINT_PREFIX}:${entry.class}:${String(messageId)}`,
    source: SITE_GUARD_FINDING_SOURCE,
    severity: severityForClass(entry.class),
    title: titleForClass(entry.class, channelSlug),
    detail: Object.freeze({
      kind: SITE_GUARD_KIND,
      class: entry.class,
      hits: [...entry.hits],
      stopped: screening.blocked,
      channelId: String(channelId),
      ...(channelSlug ? { channelSlug: String(channelSlug) } : {}),
      messageId: String(messageId),
      ...(authorKind ? { authorKind: String(authorKind) } : {}),
      screenedAt: String(at),
    }),
    pageRef: null,
  }));
}

/**
 * The stop record a Site Guard refusal message carries in its
 * metadata (under the same `guard` key the spine's refusals use), so
 * the mesh's terminal check treats the refusal as a record, never a
 * work source — the same shape contract as bite 2's outcome records,
 * with the Site Guard's own kind saying whose record it is.
 */
export function siteGuardStopRecord(screening) {
  return Object.freeze({
    kind: SITE_GUARD_KIND,
    verdict: 'refuse',
    stoppedBy: 'helmian-site-guard',
    classes: Object.freeze(screening.classes.map((entry) => entry.class)),
    hits: Object.freeze(screening.classes.flatMap((entry) => [...entry.hits])),
  });
}

/**
 * The refusal as the seat's reply text when the intake stop fires:
 * what stopped the message and which pattern matched, in plain
 * words, in the Site Guard's name — never the spine's (the spine
 * did not refuse this ask; it never evaluated it as one).
 */
export function siteGuardRefusalText(screening) {
  const destructive = screening.classes.find((entry) => entry.class === SITE_GUARD_CLASS.DESTRUCTIVE);
  const labels = destructive ? destructive.hits.join(', ') : 'destructive command pattern';
  return `${SITE_GUARD_NAME} stopped this message before it reached a seat. `
    + `What matched: a destructive command pattern (${labels}). Nothing was run and nothing was changed.`;
}

/**
 * Ingest one screening verdict's findings through the findings
 * store's own ingest path, as the acting tenant identity — the same
 * { tenantId, subject } the spine's witness passes. Returns how many
 * findings landed. NEVER throws: the dispatch outcome was decided
 * before this runs, and a findings failure must not change it. A
 * failure is logged loudly instead, naming the screen that went
 * unrecorded.
 */
export async function ingestSiteGuardFindings(store, actor, screening, context, { log = (...args) => console.error(...args) } = {}) {
  const inputs = siteGuardFindingsForScreening(screening, context);
  let landed = 0;
  for (const input of inputs) {
    try {
      await store.ingestFinding({ tenantId: actor.tenantId, subject: actor.subject }, input);
      landed += 1;
    } catch (error) {
      log(
        `[site-guard] Guard findings write FAILED (source ${SITE_GUARD_FINDING_SOURCE}, `
        + `class ${input.detail.class}, channel ${input.detail.channelId}, message ${input.detail.messageId}): `
        + `${error?.message ?? error} — the screening outcome stands unchanged; the findings feed has a gap for this screen.`,
      );
    }
  }
  return landed;
}

// ---------------------------------------------------------------------
// Bite A2 — intake rate limits, surfaced as Guard findings.
//
// The thresholds, as named constants. The window is one minute: the
// mesh's own cadence (a runner poll hands out due work, a seat
// answers, the next poll follows) lives in seconds, so a minute is
// long enough to hold a whole burst and short enough that a cooled
// sender is back quickly. The flag line, 30 messages in that
// minute, is a sustained one message every two seconds from ONE
// sender across the whole workspace — past anything a person types
// and past a healthy seat's answer cadence (each answer costs a
// model turn), so crossing it means a loop or a flood, and the only
// cost of being wrong is a warning row in the feed: the turn
// proceeds. The stop line, 90 in the minute, is three times that —
// no legitimate burst from one sender identity reaches it — and
// stopping is per sender, so one looping seat or one flooded bridge
// identity cannot silence the workspace's other senders.
export const SITE_GUARD_RATE_KIND = 'helmian-site-guard-rate-limit';
export const SITE_GUARD_RATE_CLASS = 'intake-rate-limit';
export const SITE_GUARD_RATE_WINDOW_MS = 60_000;
export const SITE_GUARD_RATE_FLAG_THRESHOLD = 30;
export const SITE_GUARD_RATE_STOP_THRESHOLD = 90;
// The tracked-sender ceiling for the in-process store. At the cap,
// senders whose windows have fully expired are evicted first, then
// the least recently active — a flood of fresh identities cannot
// grow the map without bound.
export const SITE_GUARD_RATE_MAX_TRACKED_SENDERS = 10_000;

/**
 * The sender identity a due message counts under: its author's
 * subject (a person's Clerk subject, a seat's agent subject, a
 * bridged sender's mapped subject), falling back to the author
 * kind when no subject rides the message. Bounded and
 * whitespace-free so it can ride a Map key and a finding
 * fingerprint unchanged. An identity only — never content.
 */
export function siteGuardSenderKey({ authorSubject = null, authorKind = null } = {}) {
  const subject = String(authorSubject ?? '').trim();
  const raw = subject || `kind:${String(authorKind ?? '').trim() || 'unknown'}`;
  return raw.replace(/\s+/g, '_').slice(0, 128);
}

/**
 * The rate store: one sliding window of message timestamps per
 * (tenant, sender), held in a Map inside the returned object. The
 * mesh builds ONE limiter per mesh instance and it lives exactly as
 * long as that instance — the limits, stated plainly:
 *   - In-process only. A restart forgets every count; a sender
 *     mid-flood starts the new process with a clean window.
 *   - Per instance. Where several mesh processes serve one
 *     deployment, each enforces its own window, so the effective
 *     ceiling is the threshold times the instance count. Closing
 *     that gap means a shared store — a later bite, if the
 *     deployment ever runs more than one mesh process.
 *   - Timestamps only. A window holds at most the sender's own
 *     timestamps inside the minute (a stopped sender's count cannot
 *     exceed the stop threshold by more than the messages a single
 *     poll hands out before the stop lands), and the sender map is
 *     capped (SITE_GUARD_RATE_MAX_TRACKED_SENDERS).
 * `observe` records ONE due message and returns a frozen verdict:
 *   { count, level, tripped, stopped, windowStart, at, ... }
 * `tripped` names the threshold THIS message crossed ('flag' or
 * 'stop') and is null otherwise — a crossing is reported exactly
 * once per window per line, so the mesh writes one finding per
 * trip and never one per message. `stopped` is the standing
 * posture: true while the count stands at or over the stop line.
 * Both lines re-arm when the count falls back under them as the
 * window slides, so a sender who floods again after cooling trips
 * again — a new trip, a new finding.
 */
export function createSiteGuardRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();
  function observe({ tenantId, senderKey, at } = {}) {
    const t = Number.isFinite(at) ? at : now();
    const key = `${String(tenantId)}|${String(senderKey)}`;
    let entry = windows.get(key);
    if (!entry) {
      if (windows.size >= SITE_GUARD_RATE_MAX_TRACKED_SENDERS) {
        for (const [k, e] of windows) {
          if (!e.stamps.length || t - e.stamps[e.stamps.length - 1] > SITE_GUARD_RATE_WINDOW_MS) windows.delete(k);
        }
        if (windows.size >= SITE_GUARD_RATE_MAX_TRACKED_SENDERS) {
          windows.delete(windows.keys().next().value);
        }
      }
      entry = { stamps: [], reportedFlag: false, reportedStop: false };
      windows.set(key, entry);
    }
    const cutoff = t - SITE_GUARD_RATE_WINDOW_MS;
    while (entry.stamps.length && entry.stamps[0] <= cutoff) entry.stamps.shift();
    entry.stamps.push(t);
    const count = entry.stamps.length;
    // Lines re-arm from the standing count, so a window that cooled
    // below a line reports its next crossing as a fresh trip.
    if (count < SITE_GUARD_RATE_STOP_THRESHOLD) entry.reportedStop = false;
    if (count < SITE_GUARD_RATE_FLAG_THRESHOLD) entry.reportedFlag = false;
    let tripped = null;
    if (count >= SITE_GUARD_RATE_STOP_THRESHOLD && !entry.reportedStop) {
      entry.reportedStop = true;
      entry.reportedFlag = true;
      tripped = 'stop';
    } else if (count >= SITE_GUARD_RATE_FLAG_THRESHOLD && !entry.reportedFlag) {
      entry.reportedFlag = true;
      tripped = 'flag';
    }
    const stopped = count >= SITE_GUARD_RATE_STOP_THRESHOLD;
    return Object.freeze({
      senderKey: String(senderKey),
      count,
      windowMs: SITE_GUARD_RATE_WINDOW_MS,
      flagThreshold: SITE_GUARD_RATE_FLAG_THRESHOLD,
      stopThreshold: SITE_GUARD_RATE_STOP_THRESHOLD,
      level: stopped ? 'stop' : count >= SITE_GUARD_RATE_FLAG_THRESHOLD ? 'flag' : 'none',
      tripped,
      stopped,
      windowStart: new Date(entry.stamps[0]).toISOString(),
      at: new Date(t).toISOString(),
    });
  }
  return Object.freeze({ observe });
}

/**
 * Shape one rate TRIP into the findings store's ingest input —
 * null for any observation that crossed nothing, so the mesh can
 * hand every verdict here and only trips land. The fingerprint is
 * the class, the tenant, and the sender, so the store keeps ONE
 * standing row per flooding sender: a later trip re-sights that row
 * (bumping its sighting count and refreshing its detail to the
 * latest trip, the store's own dedupe) instead of piling up a row
 * per message or per window. Severity follows the house
 * convention: the flag is a warning; the stop — a turn refused —
 * is critical. Detail is metadata only: counts, thresholds, the
 * window, ids, the sender identity. No message text is ever an
 * input to this function, so none can ride the finding.
 */
export function siteGuardFindingForRateLimit(verdict, { tenantId, channelId, channelSlug = null, messageId, authorKind = null } = {}) {
  if (!verdict?.tripped) return null;
  const stop = verdict.tripped === 'stop';
  const where = channelSlug ? ` in #${channelSlug}` : '';
  const seconds = Math.round(verdict.windowMs / 1000);
  return Object.freeze({
    fingerprint: `${SITE_GUARD_FINGERPRINT_PREFIX}:${SITE_GUARD_RATE_CLASS}:${String(tenantId)}:${verdict.senderKey}`,
    source: SITE_GUARD_FINDING_SOURCE,
    severity: stop ? 'critical' : 'warning',
    title: stop
      ? `${SITE_GUARD_NAME} stopped a sender${where} — intake rate limit (${verdict.count} messages in ${seconds}s)`
      : `${SITE_GUARD_NAME} flagged a sender${where} — intake rate limit (${verdict.count} messages in ${seconds}s)`,
    detail: Object.freeze({
      kind: SITE_GUARD_RATE_KIND,
      class: SITE_GUARD_RATE_CLASS,
      level: verdict.tripped,
      stopped: stop,
      count: verdict.count,
      windowMs: verdict.windowMs,
      windowStart: verdict.windowStart,
      flagThreshold: verdict.flagThreshold,
      stopThreshold: verdict.stopThreshold,
      senderKey: verdict.senderKey,
      ...(authorKind ? { authorKind: String(authorKind) } : {}),
      channelId: String(channelId),
      ...(channelSlug ? { channelSlug: String(channelSlug) } : {}),
      messageId: String(messageId),
      trippedAt: verdict.at,
    }),
    pageRef: null,
  });
}

/**
 * The stop record a rate refusal message carries in its metadata —
 * the same shape contract as the intake stop's record (kind,
 * verdict, stoppedBy, classes, hits), with the rate kind saying
 * whose record it is and the hit naming the count that stopped the
 * message, never the message.
 */
export function siteGuardRateStopRecord(verdict) {
  const seconds = Math.round(verdict.windowMs / 1000);
  return Object.freeze({
    kind: SITE_GUARD_RATE_KIND,
    verdict: 'refuse',
    stoppedBy: 'helmian-site-guard',
    classes: Object.freeze([SITE_GUARD_RATE_CLASS]),
    hits: Object.freeze([`intake rate limit: ${verdict.count} messages in ${seconds} seconds from one sender (stop threshold ${verdict.stopThreshold})`]),
  });
}

/**
 * The refusal as the seat's reply text when the rate stop fires:
 * what stopped the message and the count that did it, in plain
 * words, in the Site Guard's name.
 */
export function siteGuardRateRefusalText(verdict) {
  const seconds = Math.round(verdict.windowMs / 1000);
  return `${SITE_GUARD_NAME} stopped this message before it reached a seat. `
    + `What matched: an intake rate limit — ${verdict.count} messages in ${seconds} seconds from one sender. Nothing was run and nothing was changed.`;
}

/**
 * Ingest one rate trip's finding through the findings store, as the
 * acting tenant identity. Returns 1 when the finding landed, 0 for
 * a non-trip or a failed write. NEVER throws — same discipline as
 * the screen's wrapper: the dispatch outcome was decided before
 * this runs, and a findings failure is logged loudly, never
 * allowed to change it.
 */
export async function ingestSiteGuardRateFinding(store, actor, verdict, context, { log = (...args) => console.error(...args) } = {}) {
  const input = siteGuardFindingForRateLimit(verdict, context);
  if (!input) return 0;
  try {
    await store.ingestFinding({ tenantId: actor.tenantId, subject: actor.subject }, input);
    return 1;
  } catch (error) {
    log(
      `[site-guard] Guard findings write FAILED (source ${SITE_GUARD_FINDING_SOURCE}, `
      + `class ${SITE_GUARD_RATE_CLASS}, level ${input.detail.level}, channel ${input.detail.channelId}, message ${input.detail.messageId}): `
      + `${error?.message ?? error} — the rate outcome stands unchanged; the findings feed has a gap for this trip.`,
    );
    return 0;
  }
}

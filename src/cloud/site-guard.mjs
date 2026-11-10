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
// Guard panel reads) and the turn proceeds untouched. The ONE stop
// is the explicit destructive class — the Site Guard intake stop:
// the mesh hands out no work item for the message, and each due
// seat's reply is the Site Guard's refusal, in the same terminal
// shape as a Guard spine refusal. Nothing else stops a turn.
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

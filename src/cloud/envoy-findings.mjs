// Envoy Guard findings: the third step of the Guard spine
// (GUARD-TRACE-2026-11-06, bite 3 — finding G3).
//
// Bite 2 (envoy-guard.mjs) evaluates every typed seat ask and leaves the
// verdict as an outcome record — on the work item when the ask is
// allowed, on the refusal message when it is not. Until this bite those
// records lived only in the channel: the findings store
// (guard-findings.mjs) has allowed source 'governance-kernel' since it
// was written, but its only writer was the browser extension's
// device-token route — no server-side code ever ingested an evaluation,
// so the Guard panel could not show what the gate had decided, and a
// quiet panel still meant "nothing was recorded," never "evaluated and
// cleared" (finding G6's disease starts here).
//
// This module is the wire. The mesh (envoy-mesh.mjs agentWork) hands it
// every outcome record bite 2 produced — allows AND refusals — and it
// ingests one finding per seat the ask was due to through the store's
// own ingestFinding, the same call the extension route makes, with
// source 'governance-kernel'. The fingerprint is the class, the verdict
// and the seat, so a recurring evaluation is a re-sighting of one row:
// the store bumps its sighting count and a re-sighting clears its ack,
// exactly the behavior the extension's findings already live by.
//
// The write is a witness, never a gate. A findings failure must not
// change a dispatch outcome — an allow still dispatches, a refusal
// still refuses — so the ingest wrapper below cannot throw. But a
// silent gap is the failure this bite exists to end, so every failure
// is logged loudly in the server log, naming the outcome that went
// unrecorded.

import { SEAT_ACTION_NOUN } from './envoy-guard.mjs';

export const GOVERNANCE_KERNEL_SOURCE = 'governance-kernel';

// Severity follows the store's existing convention — the extension
// posts its destructive-command findings as critical and its other
// flags as warning (extension/background/upload.js). The kernel's hard
// classes stay critical: a destructive pattern matched, a credential
// reveal refused, or the gate itself failing closed. A refusal by
// posture alone (the write-lease tier, a promoted block rule) and an
// allow that carries flags are warnings. A clean allow is info: the
// record that this ask was evaluated and cleared.
function severityFor(evaluation) {
  if (evaluation.verdict === 'refuse') {
    if (evaluation.failedClosed) return 'critical';
    if (evaluation.action?.type === 'credential.resolve') return 'critical';
    if ((evaluation.hits ?? []).length) return 'critical';
    return 'warning';
  }
  return (evaluation.flags ?? []).length ? 'warning' : 'info';
}

function titleFor(evaluation, seat) {
  const noun = SEAT_ACTION_NOUN[evaluation.action?.type] ?? 'carrying out this ask';
  if (evaluation.verdict === 'refuse') return `Guard refused ${noun} — seat ${seat}`;
  return (evaluation.flags ?? []).length
    ? `Guard flagged ${noun} — seat ${seat}`
    : `Guard cleared ${noun} — seat ${seat}`;
}

/**
 * Shape one evaluation outcome record (envoy-guard.mjs) into the
 * findings store's ingest input. Returns null for a null outcome —
 * the chat action is never evaluated, so it leaves no finding.
 * `at` is the evaluation instant as an ISO string; the store stamps
 * its own first/last-seen times, and this one rides in the detail so
 * the record says when THIS evaluation happened.
 */
export function guardFindingForEvaluation(evaluation, { seat, seatSubject = null, channelId, channelSlug = null, messageId, at } = {}) {
  if (!evaluation) return null;
  const type = evaluation.action?.type ?? 'chat';
  const flags = (evaluation.flags ?? []).map((flag) => {
    if (typeof flag === 'string') return flag;
    return String(flag?.pattern ?? flag?.id ?? 'flag');
  });
  const detail = {
    kind: 'seat-action-evaluation',
    action: type,
    match: evaluation.action?.match ?? evaluation.match ?? null,
    verdict: evaluation.verdict,
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    seat: String(seat),
    ...(seatSubject ? { seatSubject: String(seatSubject) } : {}),
    channelId: String(channelId),
    ...(channelSlug ? { channelSlug: String(channelSlug) } : {}),
    messageId: String(messageId),
    ...((evaluation.hits ?? []).length ? { hits: [...evaluation.hits] } : {}),
    ...(flags.length ? { flags } : {}),
    ...(evaluation.failedClosed ? { failedClosed: true } : {}),
    evaluatedAt: String(at),
  };
  return Object.freeze({
    fingerprint: `${GOVERNANCE_KERNEL_SOURCE}:${type}:${evaluation.verdict}:${String(seat)}`,
    source: GOVERNANCE_KERNEL_SOURCE,
    severity: severityFor(evaluation),
    title: titleFor(evaluation, seat),
    detail,
    pageRef: null,
  });
}

/**
 * Ingest one evaluation outcome through the findings store's own
 * ingest path, as the acting tenant identity — the same
 * { tenantId, subject } the extension route passes for its device.
 * Returns true when the finding landed, false when it did not.
 * NEVER throws: the dispatch outcome was decided by bite 2 before
 * this runs, and a witness that can veto the act it witnesses would
 * be a second gate. A failure is logged loudly instead — an
 * unrecorded evaluation is a hole in the feed, and the log is where
 * that hole is announced until bite 7's heartbeat card can show it.
 */
export async function ingestEvaluationFinding(store, actor, evaluation, context, { log = (...args) => console.error(...args) } = {}) {
  const input = guardFindingForEvaluation(evaluation, context);
  if (!input) return false;
  try {
    await store.ingestFinding({ tenantId: actor.tenantId, subject: actor.subject }, input);
    return true;
  } catch (error) {
    log(
      `[envoy-guard] Guard findings write FAILED (source ${GOVERNANCE_KERNEL_SOURCE}, `
      + `action ${input.detail.action}, verdict ${input.detail.verdict}, seat ${input.detail.seat}, `
      + `channel ${input.detail.channelId}, message ${input.detail.messageId}): ${error?.message ?? error} `
      + '— the evaluation outcome stands unchanged; the findings feed has a gap for this evaluation.',
    );
    return false;
  }
}

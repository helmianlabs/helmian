/**
 * JOB 1 — TRIAGE.
 *
 * Reads an incoming item (a dictation line, a session-log entry) and decides
 * one thing: can this be handled here, or does it need a frontier model?
 *
 * WHAT THE VERDICT MEANS, AND WHAT IT DOES NOT. This job never handles anything
 * itself and never dispatches anything. It produces a LABEL. Nothing downstream
 * is allowed to act on a label without a human or a frontier model in the loop,
 * because the whole point is that the classifier is a 4B model and may be wrong.
 * The value is triage order, not automation.
 *
 * THE BIAS IS DELIBERATE AND ONE-DIRECTIONAL. The two errors are not equal:
 *   - wrongly escalating something trivial costs a few frontier tokens;
 *   - wrongly keeping something hard costs a wrong answer on real work.
 * So the prompt says: when in doubt, escalate. And `triageVerdict` forces
 * escalate whenever the model's own answer is missing, malformed, or uncertain.
 * There is no path through this file that turns "I don't know" into
 * "handle locally".
 */

import { runLocalJob, JSON_ONLY } from './local-job.mjs';

export const NAME = 'triage';

export const SCHEMA = Object.freeze({
  verdict: { enum: ['handle-locally', 'escalate'] },
  category: { enum: ['formatting', 'simple-fix', 'question', 'complex', 'unclear'] },
  reason: { string: { min: 1, max: 200 } },
});

export const SYSTEM = [
  'You are a triage classifier. You do not answer the item. You classify it.',
  '',
  'Return verdict "handle-locally" ONLY for items that are purely mechanical:',
  'fixing a typo, reformatting text, renaming a variable, adjusting whitespace,',
  'answering a one-line factual question with no code reasoning.',
  '',
  'Return verdict "escalate" for anything else, and ALWAYS for: debugging, root',
  'cause analysis, architecture, multi-step work, anything touching money,',
  'credentials, deletion, deploys or database schema, and anything you are not',
  'sure about. When in doubt, escalate.',
  '',
  'category is one of: formatting, simple-fix, question, complex, unclear.',
  'reason is one short sentence, under 200 characters.',
  JSON_ONLY,
  'Shape: {"verdict":"escalate","category":"complex","reason":"..."}',
].join('\n');

/**
 * Classify one item.
 *
 * FAILS TO "escalate", NEVER TO "handle-locally". Every failure mode — no local
 * model, timeout, garbage JSON, deny-listed input — produces an escalate
 * verdict carrying the skip reason. A caller that ignores `ok` and reads
 * `verdict` still gets the safe answer.
 */
export async function triageVerdict(text, opts = {}) {
  const res = await runLocalJob({
    name: NAME,
    system: SYSTEM,
    input: text,
    schema: SCHEMA,
    ...opts,
  });
  if (res.ok) return { ...res, verdict: res.data.verdict };
  return {
    ...res,
    verdict: 'escalate',
    data: {
      verdict: 'escalate',
      category: 'unclear',
      reason: `local triage unavailable (${res.skippedReason}) — escalating by default`,
    },
  };
}

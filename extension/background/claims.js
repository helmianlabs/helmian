// Runs the Helmion unsourced-claim detector over prose pulled off the page.
//
// This is the second lane. background/scan.js is the first, and the two are
// deliberately opposite in almost every way:
//
//                        scan.js                    claims.js
//   input                fenced code blocks         prose, and only prose
//   question             is this command destructive?  is this fact sourced?
//   answer               blocked / clean            flagged / clean
//   what the page does   masks the block            adds a note beside the text
//   ledger               writes a block event       writes nothing
//
// THE INPUT SPLIT IS LOAD-BEARING IN BOTH DIRECTIONS.
//
// scan.js must never see prose, because "never run rm -rf on a production
// server" is advice against a command and the kernel reports it as the command
// (measured — content/extract.js says so at length).
//
// This file must never see code, because a code block is full of the things the
// claim detector treats as CHECKABLE REFERENTS — paths, symbols, flags, numbers
// — and a comment inside it saying "probably" would flag the whole block for
// nothing. src/core/unverified-claims.mjs strips fenced blocks and inline spans
// itself (its stripCode), which covers raw markdown; the extension gets RENDERED
// text where the fences are already gone, so content/extract.js does the same job
// structurally by never collecting anything inside a <pre>.
//
// IT FLAGS. IT NEVER BLOCKS, AND THAT IS ENFORCED HERE AS WELL AS UPSTREAM.
// The detector pins `blocked` to a hardcoded false. This file spells the same
// literal false again rather than forwarding the detector's value, so a change
// on either side of the copy boundary cannot quietly turn a reading aid into a
// gate. extension/test/claims-scan.test.mjs pins it a third time, against a
// deliberately poisoned detector.

import {
  detectUnverifiedClaims,
  describeFindings,
} from '../generated/helmion-unverified-claims.generated.js';
import {
  detectHarmfulContent,
  describeHarmFindings,
} from '../generated/helmion-harmful-content.generated.js';

// A runaway guard, and nothing more — the same reasoning and the same number as
// background/scan.js MAX_LINE_LENGTH. A passage this long has stopped being a
// paragraph a human will read and has become a denial-of-service risk instead.
export const MAX_PASSAGE_LENGTH = 1000000;

// THERE IS NO MINIMUM LENGTH, AND THERE WAS ONE FOR AN HOUR.
//
// A twelve-character floor looked free — no paragraph is that short. Then:
// "iirc a.mjs" is ten characters, carries both signals, and the detector flags
// it. The floor would have deleted a true positive and reported nothing, which
// is the exact failure src/core/unverified-claims.mjs names as the worst this
// feature can have, because nothing reports it. The detector costs 5.7 ms over
// 100 KB, so the floor was buying microseconds with silence.

/**
 * One passage of prose in, one advisory verdict out.
 *
 * `skipped` carries the reason a passage was not examined. It exists for the
 * same reason scan.js grew one: a passage that was never looked at must not be
 * indistinguishable from a passage that came back clean.
 */
export function scanPassage(passage) {
  const text = String(passage ?? '').trim();
  if (!text) return { blocked: false, flagged: false, claims: [] };
  if (text.length > MAX_PASSAGE_LENGTH) {
    return {
      blocked: false,
      flagged: false,
      claims: [],
      skipped: `passage is ${text.length} characters, over the ${MAX_PASSAGE_LENGTH} limit`,
    };
  }

  const result = detectUnverifiedClaims(text);
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const harm = detectHarmfulContent(text);
  const harmHits = Array.isArray(harm?.hits) ? harm.hits : [];
  const flagged = claims.length > 0 || harmHits.length > 0;

  return {
    // Spelled literally. Not `result.blocked`, not `result.blocked === true`.
    // This lane has no route to a mask, a badge count or a refusal, and the
    // shape it returns should make that impossible to misread.
    blocked: false,
    flagged,
    harmHits,
    claims,
  };
}

/* ─── NO LEDGER ROW, ON PURPOSE ──────────────────────────────────────────────
 *
 * background/scan.js shapes every destructive block into an audit event because
 * a block is a thing that happened TO somebody's code. A flagged claim is not.
 * It is a suggestion to go and check something, it is wrong often enough that
 * this file's own source says so out loud (src/core/unverified-claims.mjs
 * LIMITATIONS), and recording those suggestions as evidence would fill a safety
 * ledger with a machine's guesses about English.
 *
 * If that decision is ever revisited, it belongs behind the same discussion the
 * browser ledger already needs — see the long comment in background/scan.js —
 * and not as a quiet addition here.
 */

// passages: [{ id, text }]  ->  [{ id, blocked:false, flagged, claims, summary, skipped }]
export function scanProse(passages) {
  if (!Array.isArray(passages)) throw new TypeError('scanProse expects an array of passages');
  return passages.map((passage) => {
    const result = scanPassage(passage?.text);
    // Human-facing wording lives in the core modules so CLI, desktop, and
    // extension stay aligned.
    const claimSummary = result.claims?.length
      ? describeFindings({ flagged: true, claims: result.claims })
      : '';
    const harmSummary = result.harmHits?.length
      ? describeHarmFindings({ flagged: true, hits: result.harmHits })
      : '';
    const summary = [claimSummary, harmSummary].filter(Boolean).join('\n');
    return { id: passage?.id ?? null, ...result, summary };
  });
}

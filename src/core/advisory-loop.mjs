// The advisory loop: publish what the Maestro is about to do, collect what the
// other models say about it, and refuse to call that a review when it is not.
//
// TROY'S ARCHITECTURE, 2026-07-30, in his words:
//
//   "the Maestro, which is the one controlling all the other agents, will have
//    read and write to the Neon database. The other agents will have read only
//    and then write to another lane for the advice... that Neon database is
//    getting all the code you're pushing, everything, for the other three LLMs
//    to see, read, and then they push in another lane anything they catch, any
//    wrong code, any dangerous, any harmful, any buggy, any hallucinated,
//    anything so they can catch bugs before you push it."
//
// That is CLAUDE.md Rule 0.27 with a feedback edge added. The trust tiers were
// already built — src/core/advisory-lane.mjs, classifyOperation, consensusStatus,
// and two separate Neon endpoints. What was missing is this file: nothing
// published work INTO the lane, and nothing on the push path ever asked whether
// a review had happened.
//
// THREE RULES THIS FILE ENFORCES, and they are the whole point:
//
//   1. AN ADVISOR CANNOT APPROVE ITSELF. A review is only counted when it names
//      an advisor from the known set and carries a verdict and a reason. A blank
//      verdict is not an approval, and neither is silence.
//
//   2. SILENCE IS NOT CONSENT. If an advisor is unreachable, its review is
//      MISSING, not APPROVED. `gate()` reports missing advisors by name rather
//      than counting a smaller quorum, because the failure mode of an advisory
//      system is that it degrades quietly into an empty ritual.
//
//   3. THE GATE ANSWERS, IT DOES NOT ACT. This module never commits, never
//      pushes and never writes to the trusted lane. It returns a verdict and the
//      caller decides. Rule 0.27: advisory output is low-trust and NEVER
//      auto-promotes.

import { classifyOperation } from './governance.mjs';

/** The advisors this loop knows how to ask. Matches ADVISORY_ADVISORS. */
export const ADVISORS = Object.freeze(['grok', 'gemini', 'chatgpt']);

/** A verdict an advisor may return. Anything else is not a verdict. */
export const VERDICTS = Object.freeze(['APPROVED', 'CONCERN', 'BLOCK']);

/** A reason shorter than this is not a reason. Mirrors MINIMUM_NOTE_LENGTH. */
export const MINIMUM_REASON = 20;

/**
 * What the Maestro is about to do, in the shape the advisors read.
 *
 * The diff is CLIPPED and the clip is declared. An advisor handed 400 KB of
 * patch will summarise rather than review it, and a truncated payload that does
 * not say it was truncated invites a confident opinion about code nobody saw.
 */
export const MAX_DIFF_CHARS = 24_000;

export function buildProposal({
  projectSlug,
  summary,
  intent = '',
  diff = '',
  files = [],
  citation = '',
  operation = {},
  now = new Date(),
} = {}) {
  const text = String(diff ?? '');
  const clipped = text.length > MAX_DIFF_CHARS;
  const tier = classifyOperation(operation);

  return {
    projectSlug: String(projectSlug ?? '').trim() || null,
    summary: String(summary ?? '').trim(),
    intent: String(intent ?? '').trim(),
    files: Array.isArray(files) ? files.map(String) : [],
    citation: String(citation ?? '').trim(),
    tier: tier.tier,
    tierReasons: tier.reasons,
    diff: clipped ? `${text.slice(0, MAX_DIFF_CHARS)}\n… [truncated]` : text,
    diffClipped: clipped,
    diffChars: text.length,
    createdAt: new Date(now).toISOString(),
  };
}

/**
 * The prompt an advisor is given.
 *
 * It asks for the four things Troy named — wrong, dangerous, harmful, buggy,
 * hallucinated — and it asks for a CITATION, because an advisor that cannot
 * point at a line has not reviewed anything. It also tells the advisor plainly
 * that it cannot approve or block on its own, so nothing downstream inherits a
 * confidence the advisor was never entitled to.
 */
export function reviewPrompt(proposal) {
  return [
    'You are a REVIEWER, not the author. You cannot approve or block anything on',
    'your own — your verdict is advisory and a human decides. Say so if you are',
    'unsure rather than guessing.',
    '',
    `PROJECT: ${proposal.projectSlug ?? '(unspecified)'}`,
    `TIER: ${proposal.tier} — ${proposal.tierReasons.join('; ')}`,
    `SUMMARY: ${proposal.summary}`,
    proposal.intent ? `INTENT: ${proposal.intent}` : '',
    proposal.files.length ? `FILES: ${proposal.files.join(', ')}` : '',
    proposal.citation ? `CLAIMED EVIDENCE: ${proposal.citation}` : '',
    proposal.diffClipped
      ? `\nNOTE: the diff below is TRUNCATED (${proposal.diffChars} chars total). Do not`
        + ' claim anything about code you cannot see.'
      : '',
    '',
    'CHANGE:',
    '```',
    proposal.diff || '(no diff supplied)',
    '```',
    '',
    'Look specifically for: code that is wrong, dangerous, harmful, buggy, or a',
    'claim the change does not support (a hallucination). Also flag anything the',
    'summary asserts that the diff does not actually do.',
    '',
    'Answer as JSON only:',
    '{"verdict":"APPROVED|CONCERN|BLOCK","reason":"<at least 20 characters>",',
    ' "citation":"<file:line you are pointing at, or empty>"}',
  ].filter(Boolean).join('\n');
}

/**
 * Turns whatever an advisor said into a review, or explains why it is not one.
 *
 * DEFENSIVE ON PURPOSE. This parses text produced by a model that was asked
 * nicely for JSON. The failure it must never make is reading a mess as an
 * approval — so anything it cannot parse becomes MISSING, never APPROVED.
 */
/**
 * Finds the object carrying a verdict inside whatever the advisor wrote.
 *
 * WHY THIS IS NOT `text.indexOf('{')` TO `text.lastIndexOf('}')`. Measured live
 * on 2026-07-30: Gemini answered with prose containing braces around a JSON
 * block, and that naive slice produced a syntactically valid object with no
 * `verdict` field. The gate correctly refused it — but it refused a REVIEW THAT
 * EXISTED, and reported the advisor as silent. Refusing is the safe direction;
 * being unable to read an answer that was given is still a defect.
 *
 * So: scan every balanced brace span, parse each, and prefer one that actually
 * carries a verdict. Still returns null when there is genuinely nothing, because
 * an unreadable answer must never become an approval.
 */
export function findVerdictObject(text) {
  const source = String(text ?? '');
  const candidates = [];

  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(source.slice(start, i + 1));
            if (value && typeof value === 'object') candidates.push(value);
          } catch { /* not an object */ }
          break;
        }
      }
    }
  }

  return candidates.find((c) => c.verdict !== undefined) ?? candidates[0] ?? null;
}

export function parseReview(advisor, raw) {
  const name = String(advisor ?? '').trim().toLowerCase();
  if (!ADVISORS.includes(name)) {
    return { advisor: name, counted: false, verdict: null, reason: `"${advisor}" is not a known advisor` };
  }

  const text = String(raw ?? '').trim();
  if (!text) {
    return { advisor: name, counted: false, verdict: null, reason: 'the advisor returned nothing' };
  }

  const parsed = findVerdictObject(text);

  if (!parsed || typeof parsed !== 'object') {
    return {
      advisor: name,
      counted: false,
      verdict: null,
      reason: 'the advisor did not answer with JSON, so no verdict could be read',
      raw: text.slice(0, 500),
    };
  }

  const verdict = String(parsed.verdict ?? '').trim().toUpperCase();
  if (!VERDICTS.includes(verdict)) {
    return {
      advisor: name,
      counted: false,
      verdict: null,
      reason: `"${parsed.verdict}" is not one of ${VERDICTS.join(', ')}`,
    };
  }

  const reason = String(parsed.reason ?? '').trim();
  if (reason.length < MINIMUM_REASON) {
    // A verdict with no reason is the exact shape of a rubber stamp.
    return {
      advisor: name,
      counted: false,
      verdict: null,
      reason: `${verdict} was given with no usable reason (${reason.length} chars)`,
    };
  }

  return {
    advisor: name,
    counted: true,
    verdict,
    reason,
    citation: String(parsed.citation ?? '').trim(),
  };
}

/**
 * The gate. Given a proposal and whatever reviews came back, say whether the
 * Maestro may proceed.
 *
 * WHAT IT REFUSES TO DO:
 *   - count a missing advisor as a passing one
 *   - treat an unparseable answer as agreement
 *   - let a Tier B change through on advice alone
 *
 * Tier B — schema, production data, authentication, cross-project contracts —
 * NEVER passes here regardless of votes. classifyOperation decides the tier and
 * a human decides Tier B; that is Rule 0.27 and this is where it bites.
 */
export function gate({ proposal, reviews = [], required = ADVISORS } = {}) {
  const counted = reviews.filter((r) => r?.counted);
  const byAdvisor = new Map(counted.map((r) => [r.advisor, r]));
  const missing = required.filter((name) => !byAdvisor.has(name));

  const blocks = counted.filter((r) => r.verdict === 'BLOCK');
  const concerns = counted.filter((r) => r.verdict === 'CONCERN');
  const approvals = counted.filter((r) => r.verdict === 'APPROVED');

  if (proposal?.tier === 'B') {
    return {
      allowed: false,
      reason: 'TIER B — a human decides this one. '
        + `Reasons: ${(proposal.tierReasons ?? []).join('; ')}. `
        + 'Advisory votes do not clear a schema, production-data, authentication '
        + 'or cross-project change.',
      blocks, concerns, approvals, missing, counted: counted.length,
    };
  }

  if (blocks.length > 0) {
    return {
      allowed: false,
      reason: `${blocks.length} advisor(s) said BLOCK: `
        + blocks.map((b) => `${b.advisor} — ${b.reason}`).join(' | '),
      blocks, concerns, approvals, missing, counted: counted.length,
    };
  }

  if (missing.length > 0) {
    // SILENCE IS NOT CONSENT. Named, not quietly excluded from the quorum.
    return {
      allowed: false,
      reason: `no usable review from: ${missing.join(', ')}. `
        + 'An advisor that did not answer has not approved anything.',
      blocks, concerns, approvals, missing, counted: counted.length,
    };
  }

  if (concerns.length > 0) {
    return {
      allowed: false,
      reason: `${concerns.length} advisor(s) raised a concern: `
        + concerns.map((c) => `${c.advisor} — ${c.reason}`).join(' | '),
      blocks, concerns, approvals, missing, counted: counted.length,
    };
  }

  return {
    allowed: true,
    reason: `${approvals.length} advisor(s) approved with a stated reason, none blocked, none missing.`,
    blocks, concerns, approvals, missing, counted: counted.length,
  };
}

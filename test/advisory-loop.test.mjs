// The advisory loop's gate — the line that turns advice into a brake.
//
// Troy's architecture: the Maestro writes, the other three read and write only to
// their own lane, and they "catch bugs before you push it". That only means
// something if the gate refuses to be talked into a pass. So the checks here are
// mostly about what it must NOT accept:
//
//   silence is not consent · a mess is not an approval · a verdict with no reason
//   is a rubber stamp · and Tier B is never cleared by votes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISORS,
  MAX_DIFF_CHARS,
  MINIMUM_REASON,
  VERDICTS,
  buildProposal,
  gate,
  parseReview,
  reviewPrompt,
} from '../src/core/advisory-loop.mjs';

const approve = (advisor, reason = 'reviewed the diff and the change matches its summary') =>
  parseReview(advisor, JSON.stringify({ verdict: 'APPROVED', reason }));

function allApproved() {
  return ADVISORS.map((name) => approve(name));
}

test('a proposal carries the tier, and Tier B is recognised from the operation', () => {
  const ordinary = buildProposal({ projectSlug: 'helmion', summary: 'rename a variable' });
  assert.equal(ordinary.tier, 'A');

  const schema = buildProposal({ summary: 'add a column', operation: { schemaChange: true } });
  assert.equal(schema.tier, 'B');
  assert.ok(schema.tierReasons.some((r) => r.includes('schema')));
});

test('a long diff is clipped AND says it was clipped', () => {
  // An advisor handed a truncated payload that does not admit it was truncated
  // will give a confident opinion about code it never saw.
  const proposal = buildProposal({ summary: 's', diff: 'x'.repeat(MAX_DIFF_CHARS + 5000) });
  assert.equal(proposal.diffClipped, true);
  assert.equal(proposal.diffChars, MAX_DIFF_CHARS + 5000);
  assert.ok(proposal.diff.includes('[truncated]'));
  assert.ok(reviewPrompt(proposal).includes('TRUNCATED'),
    'and the prompt warns the advisor not to claim anything about what it cannot see');
});

test('the prompt tells the advisor it cannot approve on its own', () => {
  const prompt = reviewPrompt(buildProposal({ summary: 'a change' }));
  assert.match(prompt, /cannot approve or block anything on/i);
  assert.match(prompt, /wrong, dangerous, harmful, buggy/i);
  assert.match(prompt, /hallucination/i);
});

test('A MESS IS NEVER AN APPROVAL', () => {
  // The one failure this parser must never make.
  for (const junk of [
    '', '   ', 'Sure! Looks good to me 👍', 'APPROVED', '{not json',
    '{"verdict":"LGTM","reason":"this is long enough to pass the length rule"}',
    null, undefined,
  ]) {
    const review = parseReview('grok', junk);
    assert.equal(review.counted, false, `"${String(junk).slice(0, 24)}" must not count`);
    assert.equal(review.verdict, null, 'and it carries no verdict');
    assert.ok(review.reason.length > 0, 'and it says why it did not count');
  }
});

test('a verdict with no usable reason is a rubber stamp, and is refused', () => {
  const stamped = parseReview('gemini', JSON.stringify({ verdict: 'APPROVED', reason: 'ok' }));
  assert.equal(stamped.counted, false);
  assert.match(stamped.reason, /no usable reason/);
  assert.ok(MINIMUM_REASON > 2);
});

test('an unknown advisor cannot vote', () => {
  const impostor = parseReview('some-other-model', JSON.stringify({
    verdict: 'APPROVED', reason: 'this reason is comfortably long enough to count',
  }));
  assert.equal(impostor.counted, false);
  assert.match(impostor.reason, /not a known advisor/);
});

test('a real verdict is read, with its citation', () => {
  const review = parseReview('chatgpt', 'Here you go:\n'
    + JSON.stringify({ verdict: 'BLOCK', reason: 'this deletes the audit directory', citation: 'src/x.mjs:42' })
    + '\nhope that helps');
  assert.equal(review.counted, true);
  assert.equal(review.verdict, 'BLOCK');
  assert.equal(review.citation, 'src/x.mjs:42');
  assert.ok(VERDICTS.includes(review.verdict));
});

test('THE HAPPY PATH: three real approvals let it through', () => {
  const decision = gate({ proposal: buildProposal({ summary: 'tidy a function' }), reviews: allApproved() });
  assert.equal(decision.allowed, true);
  assert.equal(decision.missing.length, 0);
  assert.equal(decision.counted, 3);
});

test('SILENCE IS NOT CONSENT — a missing advisor blocks and is NAMED', () => {
  // The failure mode of every advisory system: it degrades quietly into an empty
  // ritual because the quorum silently shrinks to whoever happened to answer.
  const decision = gate({
    proposal: buildProposal({ summary: 'tidy a function' }),
    reviews: [approve('grok'), approve('gemini')],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missing, ['chatgpt']);
  assert.match(decision.reason, /has not approved anything/);
});

test('an advisor that answered with junk counts as MISSING, not as agreeing', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'tidy a function' }),
    reviews: [approve('grok'), approve('gemini'), parseReview('chatgpt', 'yeah fine')],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missing, ['chatgpt']);
});

test('one BLOCK stops it, and the reason travels', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'delete some files' }),
    reviews: [
      approve('grok'),
      approve('gemini'),
      parseReview('chatgpt', JSON.stringify({
        verdict: 'BLOCK', reason: 'this removes the audit ledger the panel reads',
      })),
    ],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /said BLOCK/);
  assert.match(decision.reason, /audit ledger/, 'the advisor\'s own words reach the caller');
});

test('a CONCERN stops it too — advisory does not mean ignorable', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'change a default' }),
    reviews: [
      approve('grok'),
      approve('gemini'),
      parseReview('chatgpt', JSON.stringify({
        verdict: 'CONCERN', reason: 'the summary says read-only but the diff writes a file',
      })),
    ],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /raised a concern/);
});

test('TIER B IS NEVER CLEARED BY VOTES, even a clean sweep', () => {
  // CLAUDE.md Rule 0.27. Schema, production data, authentication and
  // cross-project contracts are a human's decision and no number of model
  // approvals substitutes for one.
  for (const operation of [
    { schemaChange: true },
    { migration: true },
    { productionDataAccess: true },
    { authenticationChange: true },
    { crossProjectContract: true },
  ]) {
    const decision = gate({
      proposal: buildProposal({ summary: 'a protected change', operation }),
      reviews: allApproved(),
    });
    assert.equal(decision.allowed, false, `${JSON.stringify(operation)} must not pass on votes`);
    assert.match(decision.reason, /TIER B/);
    assert.match(decision.reason, /a human decides/);
  }
});

test('a BLOCK outranks the tier message, so the sharpest reason is the one shown', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'x', operation: {} }),
    reviews: [
      approve('grok'),
      approve('gemini'),
      parseReview('chatgpt', JSON.stringify({ verdict: 'BLOCK', reason: 'it drops a table without a backup' })),
    ],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /drops a table/);
});

test('no reviews at all is a refusal, not a pass', () => {
  const decision = gate({ proposal: buildProposal({ summary: 'x' }), reviews: [] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.missing.length, ADVISORS.length);
});

test('the gate ANSWERS, it does not act', () => {
  // It returns a verdict and nothing else. Rule 0.27: advisory output is
  // low-trust and never auto-promotes, so this module must have no write path.
  const decision = gate({ proposal: buildProposal({ summary: 'x' }), reviews: allApproved() });
  assert.deepEqual(
    Object.keys(decision).sort(),
    ['allowed', 'approvals', 'blocks', 'concerns', 'counted', 'missing', 'reason'],
  );
});

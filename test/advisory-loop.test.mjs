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
  findVerdictObject,
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

test('SILENCE IS NOT A VETO — a quiet advisor does NOT stop the work', () => {
  // Corrected by Troy 2026-07-30. The first version blocked here, and that is
  // exactly what bit him: Gemini went quiet and the gate halted a change nobody
  // had objected to. An advisor that did not answer caught nothing.
  const decision = gate({
    proposal: buildProposal({ summary: 'tidy a function' }),
    reviews: [approve('grok'), approve('gemini')],
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.silent, ['chatgpt']);
  assert.equal(decision.coverage, '2/3');
});

test('…but the gap is RECORDED and named, never quietly dropped', () => {
  // Proceeding is not the same as pretending it was fully checked. "Two looked
  // and found nothing" is a weaker statement than three and the caller must be
  // able to tell which it got.
  const decision = gate({
    proposal: buildProposal({ summary: 'tidy a function' }),
    reviews: [approve('grok'), approve('gemini')],
  });
  assert.match(decision.reason, /NOT CHECKED BY: chatgpt/);
  assert.match(decision.reason, /coverage was 2\/3, not full/);
});

test('an advisor that answered with junk is SILENT, not agreeing', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'tidy a function' }),
    reviews: [approve('grok'), approve('gemini'), parseReview('chatgpt', 'yeah fine')],
  });
  assert.deepEqual(decision.silent, ['chatgpt'], 'junk counts as no answer, never as approval');
  assert.equal(decision.coverage, '2/3');
});

test('ONE CATCH IS ENOUGH — it does not need a second opinion', () => {
  // The whole point. A tripwire, not a quorum: a single advisor spotting a real
  // mistake stops the change while the other two are still saying it is fine.
  const decision = gate({
    proposal: buildProposal({ summary: 'delete the audit folder' }),
    reviews: [
      approve('grok'),
      approve('gemini'),
      parseReview('chatgpt', JSON.stringify({
        verdict: 'BLOCK', reason: 'this deletes the audit ledger with no backup',
      })),
    ],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.catches.length, 1, 'one catch, against two approvals');
  assert.match(decision.reason, /CAUGHT by chatgpt/);
  assert.match(decision.reason, /audit ledger/, "the catcher's own words reach the caller");
});

test('a CONCERN is a catch too — a mistake spotted is a mistake spotted', () => {
  const decision = gate({
    proposal: buildProposal({ summary: 'change a default' }),
    reviews: [
      approve('grok'),
      parseReview('gemini', JSON.stringify({
        verdict: 'CONCERN', reason: 'the summary says read-only but the diff writes a file',
      })),
    ],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /CAUGHT by gemini/);
});

test('A CATCH WITHOUT A REASON CANNOT STOP ANYTHING', () => {
  // Troy: "that needs to be reasons." A bare BLOCK with no usable reason is a
  // rubber stamp in reverse — parseReview refuses it, so it never reaches the
  // gate as a catch and cannot halt work on nothing.
  const bare = parseReview('grok', JSON.stringify({ verdict: 'BLOCK', reason: 'no' }));
  assert.equal(bare.counted, false);

  const decision = gate({
    proposal: buildProposal({ summary: 'a change' }),
    reviews: [bare, approve('gemini'), approve('chatgpt')],
  });
  assert.equal(decision.allowed, true, 'a reasonless BLOCK does not stop the work');
  assert.deepEqual(decision.silent, ['grok'], 'it is recorded as no answer from that advisor');
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

test('NOBODY REACHABLE: it proceeds, and says plainly that nothing was checked', () => {
  // The sharp edge of "silence is not a veto", and it is stated rather than
  // hidden. If every advisor is down, work is NOT blocked — but the decision
  // says in as many words that nothing was checked, so a reader can never
  // mistake zero coverage for a clean bill of health.
  const decision = gate({ proposal: buildProposal({ summary: 'x' }), reviews: [] });
  assert.equal(decision.allowed, true);
  assert.equal(decision.coverage, '0/3');
  assert.match(decision.reason, /Nothing was caught, and nothing was checked/);
  assert.deepEqual(decision.silent, ADVISORS);
});

test('coverage is always reported, so a pass can be read for what it is worth', () => {
  assert.equal(gate({ proposal: buildProposal({ summary: 'x' }), reviews: allApproved() }).coverage, '3/3');
  assert.equal(gate({ proposal: buildProposal({ summary: 'x' }), reviews: [approve('grok')] }).coverage, '1/3');
});

test('the gate ANSWERS, it does not act', () => {
  // It returns a verdict and nothing else. Rule 0.27: advisory output is
  // low-trust and never auto-promotes, so this module must have no write path.
  const decision = gate({ proposal: buildProposal({ summary: 'x' }), reviews: allApproved() });
  assert.deepEqual(
    Object.keys(decision).sort(),
    ['allowed', 'approvals', 'blocks', 'catches', 'concerns', 'counted', 'coverage', 'missing', 'reason', 'silent'],
  );
});

/* ─── THE PARSER, HARDENED AGAINST WHAT ADVISORS ACTUALLY SEND ──────────────
 *
 * Measured live 2026-07-30: an advisor answered with prose containing braces
 * around its JSON, and the naive first-{ to last-} slice produced a valid object
 * with no verdict. The gate refused it — safe, but it refused a review that had
 * actually been given, and reported that advisor as silent.
 *
 * Refusing is always the safe direction. Being unable to READ an answer that was
 * given is still a defect, and these pin the fix without loosening the refusals. */

test('a verdict is found inside prose that also contains braces', () => {
  const review = parseReview('grok',
    'Here { is some prose } and now my answer:\n'
    + '{"verdict":"BLOCK","reason":"this deletes the audit ledger with no backup"}');
  assert.equal(review.counted, true);
  assert.equal(review.verdict, 'BLOCK');
});

test('a verdict is found inside a markdown code fence', () => {
  const review = parseReview('gemini',
    '```json\n{"verdict":"CONCERN","reason":"the summary claims read-only but the diff writes"}\n```');
  assert.equal(review.counted, true);
  assert.equal(review.verdict, 'CONCERN');
});

test('a nested object does not confuse the scan', () => {
  const review = parseReview('chatgpt',
    '{"meta":{"model":"x","nested":{"deep":true}},"verdict":"APPROVED",'
    + '"reason":"checked every line against the stated intent"}');
  assert.equal(review.counted, true);
  assert.equal(review.verdict, 'APPROVED');
});

test('HARDENING DID NOT LOOSEN THE REFUSALS', () => {
  // The whole point of the change was to read more real answers, never to accept
  // more non-answers.
  for (const junk of [
    '{"note":"I think it is fine"}',
    'Looks good to me!',
    '{"verdict":"MAYBE","reason":"a perfectly long reason that still is not a verdict"}',
    '{ unbalanced',
  ]) {
    assert.equal(parseReview('grok', junk).counted, false, `must still refuse: ${junk.slice(0, 30)}`);
  }
});

test('findVerdictObject returns null rather than guessing when nothing is there', () => {
  assert.equal(findVerdictObject('no braces at all'), null);
  assert.equal(findVerdictObject(''), null);
});

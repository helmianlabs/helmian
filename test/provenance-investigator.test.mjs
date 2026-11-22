// Milestone 2 of the provenance verification build (Scribe 1154): the
// Sandbox Investigator. The plan is deterministic, the sandbox is a
// capability boundary (one injected lookup, allowlisted categories, budget
// and timeouts), bad evidence is rejected AND recorded, failures leave named
// gaps, and the dossier's vector is computed by documented math — then fed
// into the real Milestone 1 guardrail hook in the last tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVESTIGATION_CATEGORIES,
  buildInvestigationPlan,
  validateEvidenceItem,
  isIndependentEvidence,
  scoreDossier,
  runInvestigation,
  toGuardrailClaim,
  investigatorIsolation,
} from '../src/core/provenance-investigator.mjs';
import {
  createProvenanceRecord,
  runPreResponseVerification,
} from '../src/core/provenance-verification.mjs';

const HASH = 'c'.repeat(64);

const CLAIM = {
  claimId: 'claim-1',
  claimText: 'Compound X reduces Y by 40 percent.',
  authors: ['A. Researcher'],
  institutions: ['Example Institute'],
};

function verifiedRecord(id) {
  return createProvenanceRecord({
    recordId: id, sourceUrl: 'https://example.org/src', sourceHash: HASH,
    signatureStatus: 'verified', attributionStatus: 'verified',
  });
}

function item(overrides = {}) {
  return {
    evidenceId: 'e1', category: 'replication', summary: 'An independent group replicated the result.',
    stance: 'supports', sourcePublisher: 'Other University',
    provenanceRecord: verifiedRecord('ev-1'),
    ...overrides,
  };
}

/** A lookup that answers from a map keyed by category, [] elsewhere. */
function lookupFrom(map) {
  return async (subquery) => map[subquery.category] ?? [];
}

/* ── The plan ────────────────────────────────────────────────────────────── */

test('the plan covers authors, institutions, and the claim itself — deterministically', () => {
  const plan = buildInvestigationPlan(CLAIM);
  const again = buildInvestigationPlan(CLAIM);
  assert.deepEqual(plan, again, 'same claim must produce the same plan, ids included');
  const pairs = plan.map((q) => `${q.category}:${q.subjectKind}`);
  for (const expected of [
    'financial-disclosure:author', 'affiliation:author', 'lobbying:author',
    'grant-registry:institution', 'affiliation:institution', 'financial-disclosure:institution',
    'rebuttal:claim', 'retraction:claim', 'replication:claim', 'primary-source:claim',
  ]) assert.ok(pairs.includes(expected), `plan is missing ${expected}`);
  assert.equal(plan.length, 10);
  assert.ok(plan.every((q) => INVESTIGATION_CATEGORIES.includes(q.category)));
});

test('a claim with no authors or institutions still gets the claim-level checks', () => {
  const plan = buildInvestigationPlan({ claimId: 'c', claimText: 'Something happened.' });
  assert.deepEqual(plan.map((q) => q.category), ['rebuttal', 'retraction', 'replication', 'primary-source']);
});

test('malformed claims are refused at planning time', () => {
  assert.throws(() => buildInvestigationPlan({ claimText: 'x' }), /claimId/);
  assert.throws(() => buildInvestigationPlan({ claimId: 'c' }), /claimText/);
  assert.throws(() => buildInvestigationPlan({ claimId: 'c', claimText: 'x', authors: 'nobody' }), /authors/);
});

/* ── Evidence validation and independence ────────────────────────────────── */

test('evidence validation names exactly what is wrong', () => {
  assert.equal(validateEvidenceItem(item()).valid, true);
  const bad = validateEvidenceItem(item({ category: 'gossip', stance: 'shrug', rigor: 7 }));
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /category/.test(e)));
  assert.ok(bad.errors.some((e) => /stance/.test(e)));
  assert.ok(bad.errors.some((e) => /rigor/.test(e)));
});

test('independence is DERIVED from names and conflicts, never self-declared', () => {
  assert.equal(isIndependentEvidence(item(), CLAIM), true);
  assert.equal(isIndependentEvidence(item({ sourceAuthor: 'a. researcher' }), CLAIM), false, 'the claim\'s own author is not independent, case aside');
  assert.equal(isIndependentEvidence(item({ sourcePublisher: 'Example Institute' }), CLAIM), false);
  assert.equal(isIndependentEvidence(item({ financialConflict: { disclosed: false } }), CLAIM), false);
  assert.equal(isIndependentEvidence(item({ financialConflict: { disclosed: true } }), CLAIM), true, 'a disclosed tie does not by itself destroy independence');
});

/* ── Scoring ─────────────────────────────────────────────────────────────── */

test('scoring follows the documented math, including the unknown-consensus case', () => {
  // Four DISTINCT origins (own summary, publisher and address each):
  // the anti-sybil grouping counts each once, so the documented math
  // reads exactly as it did before grouping existed.
  const evidence = [
    item({ evidenceId: 's1', stance: 'supports', summary: 'Replication one summary.', sourcePublisher: 'Other University', sourceUrl: 'https://one.example.edu/r' }),
    item({ evidenceId: 's2', stance: 'supports', category: 'primary-source', summary: 'Primary source summary.', sourcePublisher: 'Primary Institute', sourceUrl: 'https://two.example.org/p' }),
    item({ evidenceId: 'd1', stance: 'disputes', category: 'rebuttal', rigor: 0.75, summary: 'Rebuttal summary.', sourcePublisher: 'Rebuttal College', sourceUrl: 'https://three.example.net/b' }),
    item({ evidenceId: 'x1', stance: 'context', category: 'affiliation', provenanceRecord: null, summary: 'Affiliation summary.', sourcePublisher: 'Affiliation Body', sourceUrl: 'https://four.example.com/a' }),
  ];
  const { vector, inputs } = scoreDossier(evidence, CLAIM);
  assert.deepEqual(
    { total: inputs.total, groups: inputs.groups, verified: inputs.verified, independent: inputs.independent, supports: inputs.supports, disputes: inputs.disputes },
    { total: 4, groups: 4, verified: 3, independent: 4, supports: 2, disputes: 1 },
  );
  assert.equal(inputs.groupDetail.length, 4);
  assert.equal(vector.provenanceScore, 0.75);
  assert.equal(vector.independenceScore, 1);
  assert.ok(Math.abs(vector.consensusRatio - 2 / 3) < 1e-9);
  assert.equal(vector.dissentRigor, 0.75);

  const empty = scoreDossier([], CLAIM);
  assert.equal(empty.vector.consensusRatio, 0.5, 'no stance evidence is unknown, not agreement');
  assert.equal(empty.vector.provenanceScore, 0);
  assert.equal(empty.vector.dissentRigor, 0);
});

test('anti-sybil: ten copies of one supporting story weigh one source against a single dispute', () => {
  const copies = Array.from({ length: 10 }, (_, i) => item({
    evidenceId: `copy-${i}`,
    stance: 'supports',
    summary: 'The wire story everyone republished, word for word.',
    sourcePublisher: 'Wire Service',
    sourceUrl: `https://mirror${i}.example.net/wire`,
  }));
  const dispute = item({
    evidenceId: 'lone-dispute', stance: 'disputes', category: 'rebuttal', rigor: 0.6,
    summary: 'An independent laboratory report reaching the opposite conclusion.',
    sourcePublisher: 'Independent Lab', sourceUrl: 'https://lab.example.org/report',
  });
  const { vector, inputs } = scoreDossier([...copies, dispute], CLAIM);
  assert.equal(inputs.total, 11, 'the raw item count is still reported');
  assert.equal(inputs.groups, 2, 'the ten copies are one origin');
  assert.equal(inputs.supports, 1, 'support weighs one source, not ten');
  assert.equal(inputs.disputes, 1);
  assert.equal(vector.consensusRatio, 0.5, 'one origin against one origin is an open question, not a 10-to-1 consensus');
  const wireGroup = inputs.groupDetail.find((g) => g.copies === 10);
  assert.ok(wireGroup, 'the weighting itself is visible in the dossier inputs');
});

test('category rigor defaults apply when an item carries none — a retraction outweighs a rebuttal', () => {
  const { vector } = scoreDossier([
    item({ evidenceId: 'd1', stance: 'disputes', category: 'rebuttal', rigor: undefined }),
    item({ evidenceId: 'd2', stance: 'disputes', category: 'retraction', rigor: undefined }),
  ], CLAIM);
  assert.equal(vector.dissentRigor, 0.9);
});

/* ── The investigation ───────────────────────────────────────────────────── */

test('a full investigation produces a complete dossier with grouped findings', async () => {
  const dossier = await runInvestigation({
    claim: { ...CLAIM, provenanceRecord: verifiedRecord('primary-1') },
    lookup: lookupFrom({
      replication: [item()],
      retraction: [item({ evidenceId: 'e2', category: 'retraction', stance: 'context', summary: 'No retraction on record.' })],
    }),
  });
  assert.equal(dossier.status, 'complete');
  assert.deepEqual(dossier.gaps, []);
  assert.deepEqual(dossier.findings.replication, ['e1']);
  assert.deepEqual(dossier.findings.retraction, ['e2']);
  assert.equal(dossier.primaryProvenanceRecord.recordId, 'primary-1');
  assert.equal(dossier.contestationVector.provenanceScore, 1);
});

test('a throwing lookup leaves a NAMED GAP and a partial dossier — never a silent nothing-found', async () => {
  const dossier = await runInvestigation({
    claim: CLAIM,
    lookup: async (subquery) => {
      if (subquery.category === 'lobbying') throw new Error('registry unavailable');
      return [];
    },
  });
  assert.equal(dossier.status, 'partial');
  assert.equal(dossier.gaps.length, 1);
  assert.match(dossier.gaps[0].reason, /registry unavailable/);
  assert.equal(dossier.gaps[0].category, 'lobbying');
});

test('a slow lookup times out into a gap instead of hanging the investigation', async () => {
  const dossier = await runInvestigation({
    claim: { claimId: 'c', claimText: 'x' },
    limits: { perQueryTimeoutMs: 25 },
    lookup: async (subquery) => {
      if (subquery.category === 'rebuttal') await new Promise((r) => setTimeout(r, 500));
      return [];
    },
  });
  assert.ok(dossier.gaps.some((g) => g.category === 'rebuttal' && /timed out/.test(g.reason)));
});

test('malformed, miscategorised, and duplicate evidence is REJECTED AND RECORDED, never counted', async () => {
  const dossier = await runInvestigation({
    claim: CLAIM,
    lookup: lookupFrom({
      replication: [
        item(),
        item({ evidenceId: 'e1' }), // duplicate id
        item({ evidenceId: 'e3', category: 'rebuttal' }), // answers the wrong sub-query
        { evidenceId: 'e4', category: 'replication' }, // missing summary + stance
      ],
    }),
  });
  assert.equal(dossier.status, 'partial');
  assert.deepEqual(dossier.evidence.map((e) => e.evidenceId), ['e1']);
  assert.equal(dossier.rejected.length, 3);
  assert.ok(dossier.rejected.some((r) => /duplicate/.test(r.errors.join(' '))));
  assert.ok(dossier.rejected.some((r) => /does not answer/.test(r.errors.join(' '))));
});

test('the query budget truncates the plan and names what was not run', async () => {
  let calls = 0;
  const dossier = await runInvestigation({
    claim: CLAIM,
    limits: { maxQueries: 3 },
    lookup: async () => { calls += 1; return []; },
  });
  assert.equal(calls, 3);
  assert.equal(dossier.gaps.length, 7);
  assert.ok(dossier.gaps.every((g) => /budget exhausted/.test(g.reason)));
});

test('the investigator REFUSES to run without an injected lookup — it holds no capability of its own', async () => {
  await assert.rejects(() => runInvestigation({ claim: CLAIM }), /injected lookup/);
  const isolation = investigatorIsolation();
  assert.match(isolation.achieved, /capability isolation/);
  assert.match(isolation.isNot, /an OS sandbox, a VM, or a container/);
});

test('an undisclosed financial conflict found in evidence is surfaced by id in the dossier', async () => {
  const dossier = await runInvestigation({
    claim: CLAIM,
    lookup: lookupFrom({
      'financial-disclosure': [item({
        evidenceId: 'fin-1', category: 'financial-disclosure', stance: 'context',
        summary: 'The study was funded by the compound\'s manufacturer; not disclosed in the paper.',
        sourcePublisher: 'SEC filings', financialConflict: { disclosed: false },
      })],
    }),
  });
  assert.deepEqual(dossier.undisclosedConflicts, ['fin-1']);
  assert.equal(dossier.evidence[0].independent, false);
});

/* ── Feeding Milestone 1 ─────────────────────────────────────────────────── */

test('the dossier feeds the REAL Milestone 1 hook: contested claim is annotated with the dissent attached', async () => {
  const dossier = await runInvestigation({
    claim: { ...CLAIM, provenanceRecord: verifiedRecord('primary-1') },
    lookup: lookupFrom({
      replication: [item({ evidenceId: 'd1', stance: 'disputes', category: 'replication', rigor: 0.9, summary: 'Two labs failed to replicate.' })],
      rebuttal: [item({ evidenceId: 'd2', category: 'rebuttal', stance: 'disputes', rigor: 0.8, summary: 'Methodological rebuttal published.' })],
    }),
  });
  const guardrailClaim = toGuardrailClaim(dossier);
  assert.equal(guardrailClaim.contestationVector.consensusRatio, 0);
  const result = await runPreResponseVerification({
    text: 'Compound X reduces Y by 40 percent.',
    claims: [guardrailClaim],
  });
  assert.equal(result.action, 'annotate');
  assert.match(result.text, /high contestation/);
});

test('an investigation that finds nothing leaves the claim annotated as unexamined, not passed as clean', async () => {
  const dossier = await runInvestigation({ claim: CLAIM, lookup: lookupFrom({}) });
  const result = await runPreResponseVerification({
    text: 'Compound X reduces Y by 40 percent.',
    claims: [toGuardrailClaim(dossier)],
  });
  // No provenance record and a zero-provenance vector: annotate, never allow.
  assert.equal(result.action, 'annotate');
});

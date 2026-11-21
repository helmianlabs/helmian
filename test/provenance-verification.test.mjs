// Milestone 1 of the provenance verification build (Scribe 1154):
// the ProvenanceRecord and ContestationVector schemas, the guardrail
// evaluation core, and the pre-response hook registry.
//
// The standard here matches the neighbouring suites: every rule that fires
// is paired with a near-identical case that must NOT fire, and the wiring
// suite (provenance-verification-wiring.test.mjs) proves the agent loop
// actually runs these hooks on the real reply path.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVENANCE_VERIFICATION_SCHEMA_VERSION,
  UNVERIFIED_PROVENANCE_FLAG,
  SIGNATURE_STATUSES,
  ATTRIBUTION_STATUSES,
  EVIDENCE_CLUSTERS,
  createProvenanceRecord,
  validateProvenanceRecord,
  provenanceFlagReasons,
  isUnverifiedProvenance,
  createContestationVector,
  validateContestationVector,
  toVectorArray,
  contestationVectorFromArray,
  isHighContestation,
  resolveWeightingProfile,
  validateWeightingProfile,
  DEFAULT_WEIGHTING_PROFILE,
  evaluateClaimGuardrails,
  createProvenanceHookRegistry,
  createDefaultProvenanceHookRegistry,
  provenanceGuardrailHook,
  runPreResponseVerification,
} from '../src/core/provenance-verification.mjs';

const HASH = 'a'.repeat(64);

function verifiedRecord(overrides = {}) {
  return createProvenanceRecord({
    recordId: 'src-1',
    sourceUrl: 'https://example.org/paper',
    sourceHash: HASH,
    signatureStatus: 'verified',
    attributionStatus: 'verified',
    publisher: 'Example Institute',
    author: 'A. Researcher',
    ...overrides,
  });
}

function settledVector(overrides = {}) {
  return createContestationVector({
    provenanceScore: 0.9, independenceScore: 0.9, consensusRatio: 0.95, dissentRigor: 0.2,
    ...overrides,
  });
}

/* ── ProvenanceRecord ────────────────────────────────────────────────────── */

test('a fully attributed, signed, hashed record is NOT flagged', () => {
  const record = verifiedRecord();
  assert.equal(record.schema, PROVENANCE_VERIFICATION_SCHEMA_VERSION);
  assert.equal(record.unverifiedProvenance, false);
  assert.deepEqual(record.flagReasons, []);
  assert.equal('flag' in record, false);
  assert.equal(validateProvenanceRecord(record).valid, true);
  assert.ok(Date.parse(record.retrievedAt) > 0, 'retrieval timestamp is recorded by default');
});

test('an anonymous, unsigned, unhashed source IS flagged Unverified Provenance', () => {
  const record = createProvenanceRecord({
    recordId: 'src-2', sourceUrl: 'https://paste.example/xyz',
    signatureStatus: 'absent', attributionStatus: 'anonymous',
  });
  assert.equal(record.unverifiedProvenance, true);
  assert.equal(record.flag, UNVERIFIED_PROVENANCE_FLAG);
  assert.ok(record.flagReasons.some((r) => /source hash/.test(r)));
  assert.ok(record.flagReasons.some((r) => /no cryptographic signature/.test(r)));
  assert.ok(record.flagReasons.some((r) => /anonymously mutable/.test(r)));
});

test('a failed signature is flagged, and the reason says it failed', () => {
  const record = verifiedRecord({ signatureStatus: 'failed' });
  assert.equal(isUnverifiedProvenance(record), true);
  assert.ok(provenanceFlagReasons(record).some((r) => /failed verification/.test(r)));
});

test('publisher-only attribution with a verified signature is NOT flagged on attribution alone', () => {
  const record = verifiedRecord({ attributionStatus: 'publisher-only', author: '' });
  assert.equal(record.unverifiedProvenance, false);
});

test('a malformed hash that is present fails validation; a missing hash flags instead', () => {
  const bad = { ...verifiedRecord(), sourceHash: 'not-a-hash' };
  const result = validateProvenanceRecord(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /sourceHash/.test(e)));
  assert.throws(() => verifiedRecord({ sourceHash: 'zz' }), /sourceHash/);
});

test('record creation refuses missing identity fields', () => {
  assert.throws(() => createProvenanceRecord({ sourceUrl: 'https://x.example', signatureStatus: 'verified', attributionStatus: 'verified' }), /recordId/);
  assert.throws(() => verifiedRecord({ signatureStatus: 'maybe' }), /signatureStatus/);
  assert.throws(() => verifiedRecord({ retrievedAt: 'not a date' }), /retrievedAt/);
});

test('the status tables carry the specification vocabulary', () => {
  assert.deepEqual([...SIGNATURE_STATUSES], ['verified', 'absent', 'failed', 'not-checked']);
  assert.ok(ATTRIBUTION_STATUSES.includes('anonymous'));
  assert.deepEqual([...EVIDENCE_CLUSTERS], ['institutional-consensus', 'replicated-empirical', 'dissenting']);
});

/* ── ContestationVector ──────────────────────────────────────────────────── */

test('a vector round-trips through the specification ordered array form', () => {
  const vector = settledVector({ clusters: { dissenting: 2 } });
  assert.deepEqual(toVectorArray(vector), [0.9, 0.9, 0.95, 0.2]);
  assert.deepEqual(contestationVectorFromArray([0.1, 0.2, 0.3, 0.4]), {
    provenanceScore: 0.1, independenceScore: 0.2, consensusRatio: 0.3, dissentRigor: 0.4,
  });
});

test('scores outside 0..1, missing scores, and wrong-length arrays are refused', () => {
  assert.throws(() => settledVector({ consensusRatio: 1.2 }), /consensusRatio/);
  assert.throws(() => createContestationVector({ provenanceScore: 0.5 }), /independenceScore/);
  assert.throws(() => contestationVectorFromArray([0.1, 0.2]), /exactly four/);
  assert.equal(validateContestationVector({ provenanceScore: 0, independenceScore: 0, consensusRatio: 0, dissentRigor: 0 }).valid, true, 'zero is a real score, not a missing one');
});

test('high contestation needs BOTH an unsettled consensus AND rigorous dissent', () => {
  assert.equal(isHighContestation(settledVector({ consensusRatio: 0.5, dissentRigor: 0.8 })), true);
  assert.equal(isHighContestation(settledVector({ consensusRatio: 0.5, dissentRigor: 0.1 })), false, 'weak dissent is not contestation');
  assert.equal(isHighContestation(settledVector({ consensusRatio: 0.95, dissentRigor: 0.9 })), false, 'rigorous dissent against a settled consensus is a footnote');
  assert.equal(isHighContestation(null), false);
});

/* ── Weighting profile ───────────────────────────────────────────────────── */

test('a partial profile inherits defaults; an out-of-range or unknown key is refused', () => {
  const resolved = resolveWeightingProfile({ institutionalConsensusWeight: 0.5 });
  assert.equal(resolved.institutionalConsensusWeight, 0.5);
  assert.equal(resolved.provenanceWeight, DEFAULT_WEIGHTING_PROFILE.provenanceWeight);
  assert.equal(validateWeightingProfile({ provenanceWeight: 2 }).valid, false);
  assert.throws(() => resolveWeightingProfile({ bogusWeight: 1 }), /unknown weighting profile key/);
});

/* ── Guardrail evaluation ────────────────────────────────────────────────── */

test('a verified, settled claim is allowed with no annotation', () => {
  const result = evaluateClaimGuardrails({ claimId: 'c1', provenanceRecord: verifiedRecord(), contestationVector: settledVector() });
  assert.equal(result.action, 'allow');
  assert.deepEqual(result.reasons, []);
});

test('a failed signature HARD BLOCKS, even with a settled vector', () => {
  const result = evaluateClaimGuardrails({
    claimId: 'c2',
    provenanceRecord: verifiedRecord({ signatureStatus: 'failed' }),
    contestationVector: settledVector(),
  });
  assert.equal(result.action, 'block');
  assert.ok(result.reasons.some((r) => /cryptographic integrity/.test(r)));
});

test('an undisclosed financial conflict with no replication QUARANTINES', () => {
  const record = verifiedRecord({
    conflicts: [{ kind: 'financial', disclosed: false, detail: 'funded by the vendor' }],
    hasIndependentReplication: false,
  });
  const result = evaluateClaimGuardrails({
    claimId: 'c3', provenanceRecord: record,
    contestationVector: settledVector({ independenceScore: 0.1 }),
  });
  assert.equal(result.action, 'quarantine');
});

test('the same conflict WITH independent replication only annotates', () => {
  const record = verifiedRecord({
    conflicts: [{ kind: 'financial', disclosed: false }],
    hasIndependentReplication: true,
  });
  const result = evaluateClaimGuardrails({ claimId: 'c4', provenanceRecord: record, contestationVector: settledVector() });
  assert.equal(result.action, 'annotate');
});

test('a disclosed financial conflict on a verified settled claim is allowed', () => {
  const record = verifiedRecord({ conflicts: [{ kind: 'financial', disclosed: true }] });
  const result = evaluateClaimGuardrails({ claimId: 'c5', provenanceRecord: record, contestationVector: settledVector() });
  assert.equal(result.action, 'allow');
});

test('unverified provenance and high contestation each ANNOTATE, never block', () => {
  const unverified = evaluateClaimGuardrails({
    claimId: 'c6',
    provenanceRecord: createProvenanceRecord({ recordId: 's', sourceUrl: 'https://x.example', signatureStatus: 'absent', attributionStatus: 'unknown' }),
    contestationVector: settledVector(),
  });
  assert.equal(unverified.action, 'annotate');
  assert.equal(unverified.unverifiedProvenance, true);

  const contested = evaluateClaimGuardrails({
    claimId: 'c7', provenanceRecord: verifiedRecord(),
    contestationVector: settledVector({ consensusRatio: 0.5, dissentRigor: 0.8 }),
  });
  assert.equal(contested.action, 'annotate');
  assert.ok(contested.reasons.some((r) => /high contestation/.test(r)));
});

test('a claim with NO record and NO vector is annotated, never passed as verified', () => {
  const result = evaluateClaimGuardrails({ claimId: 'c8' });
  assert.equal(result.action, 'annotate');
  assert.equal(result.unverifiedProvenance, true);
  assert.ok(result.reasons.some((r) => /no provenance record/.test(r)));
  assert.ok(result.reasons.some((r) => /no contestation vector/.test(r)));
});

test('a malformed record or vector QUARANTINES — unreadable evidence is not passing evidence', () => {
  const badRecord = evaluateClaimGuardrails({
    claimId: 'c9', provenanceRecord: { recordId: 'x' }, contestationVector: settledVector(),
  });
  assert.equal(badRecord.action, 'quarantine');
  const badVector = evaluateClaimGuardrails({
    claimId: 'c10', provenanceRecord: verifiedRecord(), contestationVector: { provenanceScore: 9 },
  });
  assert.equal(badVector.action, 'quarantine');
});

/* ── Pre-response hooks ──────────────────────────────────────────────────── */

test('the default registry runs the guardrail hook and annotates the delivered text', async () => {
  const result = await runPreResponseVerification({
    text: 'The study found a 40 percent effect.',
    claims: [{ claimId: 'c1' }],
  });
  assert.equal(result.action, 'annotate');
  assert.match(result.text, /The study found a 40 percent effect\./);
  assert.match(result.text, /Unverified Provenance/);
});

test('a blocked claim replaces the delivered text and never carries the original', async () => {
  const result = await runPreResponseVerification({
    text: 'SECRET-CLAIM-TEXT',
    claims: [{
      claimId: 'c1',
      provenanceRecord: verifiedRecord({ signatureStatus: 'failed' }),
      contestationVector: settledVector(),
    }],
  });
  assert.equal(result.action, 'block');
  assert.equal(result.blocked, true);
  assert.equal(result.text.includes('SECRET-CLAIM-TEXT'), false);
  assert.match(result.text, /blocked by the Executive Guard/);
});

test('a reply with no claims passes through byte-identical', async () => {
  const result = await runPreResponseVerification({ text: 'Hello there.', claims: [] });
  assert.equal(result.action, 'allow');
  assert.equal(result.text, 'Hello there.');
  assert.deepEqual(provenanceGuardrailHook({ text: 'hi' }).evaluations, []);
});

test('hooks run in registration order and the strongest action wins', async () => {
  const order = [];
  const registry = createProvenanceHookRegistry()
    .register('first', () => { order.push('first'); return { action: 'annotate', annotations: ['note one'] }; })
    .register('second', () => { order.push('second'); return { action: 'quarantine', reasons: ['held'] }; });
  assert.deepEqual(registry.list(), ['first', 'second']);
  const result = await registry.run({ text: 'x' });
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(result.action, 'quarantine');
  assert.deepEqual(result.annotations, ['note one']);
});

test('a hook that throws QUARANTINES — verification fails closed', async () => {
  const registry = createProvenanceHookRegistry()
    .register('broken', () => { throw new Error('kaboom'); });
  const result = await registry.run({ text: 'x' });
  assert.equal(result.action, 'quarantine');
  assert.ok(result.reasons.some((r) => /fails closed/.test(r) && /kaboom/.test(r)));
});

test('a hook returning an unreadable verdict QUARANTINES', async () => {
  const registry = createProvenanceHookRegistry().register('weird', () => 'yes');
  const result = await registry.run({ text: 'x' });
  assert.equal(result.action, 'quarantine');
});

test('duplicate hook names and non-functions are refused at registration', () => {
  const registry = createDefaultProvenanceHookRegistry();
  assert.deepEqual(registry.list(), ['provenance-guardrails']);
  assert.throws(() => registry.register('provenance-guardrails', () => {}), /already registered/);
  assert.throws(() => registry.register('x', 'not a function'), /must be a function/);
});

test('async hooks are awaited', async () => {
  const registry = createProvenanceHookRegistry()
    .register('slow', async () => ({ action: 'annotate', annotations: ['async note'] }));
  const result = await runPreResponseVerification({ text: 'body' }, { registry });
  assert.equal(result.action, 'annotate');
  assert.match(result.text, /async note/);
});

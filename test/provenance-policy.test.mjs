// Milestone 3 of the provenance verification build (Scribe 1154): the
// Guardrail Policy Ruleset and the guard badges.
//
// The centre of this suite is PARITY: the default policy is the Milestone 1
// guardrail core restated as an editable Executive Guard-format ruleset, so
// a claim matrix runs through BOTH evaluators and every action must agree.
// If a future ruleset edit changes a decision the core would not make, the
// matrix names the claim that diverged.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVENANCE_POLICY_VERSION,
  ProvenancePolicyError,
  DEFAULT_PROVENANCE_POLICY,
  buildProvenancePolicy,
  validateProvenancePolicy,
  deriveClaimSignals,
  evaluateProvenancePolicy,
  badgeForClaim,
  formatBadgeText,
} from '../src/core/provenance-policy.mjs';
import {
  createProvenanceRecord,
  createContestationVector,
  evaluateClaimGuardrails,
} from '../src/core/provenance-verification.mjs';
import { DEFAULT_POLICY } from '../executive-guard/src/policy.mjs';

const HASH = 'd'.repeat(64);

function record(overrides = {}) {
  return createProvenanceRecord({
    recordId: 'src-1', sourceUrl: 'https://example.org/paper', sourceHash: HASH,
    signatureStatus: 'verified', attributionStatus: 'verified',
    ...overrides,
  });
}
function vector(overrides = {}) {
  return createContestationVector({
    provenanceScore: 0.9, independenceScore: 0.9, consensusRatio: 0.95, dissentRigor: 0.2,
    ...overrides,
  });
}
const conflictRecord = (overrides = {}) => record({
  conflicts: [{ kind: 'financial', disclosed: false }], hasIndependentReplication: false, ...overrides,
});

/* ── Format ──────────────────────────────────────────────────────────────── */

test('the policy document mirrors the Executive Guard policy shape', () => {
  assert.equal(DEFAULT_PROVENANCE_POLICY.version, PROVENANCE_POLICY_VERSION);
  assert.equal(typeof DEFAULT_PROVENANCE_POLICY.defaultAction, 'string');
  for (const key of ['version', 'rules']) assert.ok(key in DEFAULT_POLICY && key in DEFAULT_PROVENANCE_POLICY, `shape key ${key}`);
  for (const rule of DEFAULT_PROVENANCE_POLICY.rules) {
    assert.deepEqual(Object.keys(rule).sort(), ['action', 'id', 'reason', 'when']);
  }
  assert.equal(DEFAULT_PROVENANCE_POLICY.defaultAction, 'annotate', 'an unmatched claim is annotated, never silently passed');
  assert.equal(validateProvenancePolicy(DEFAULT_PROVENANCE_POLICY), DEFAULT_PROVENANCE_POLICY);
});

test('policy validation refuses duplicate ids, bad actions, and unknown signals', () => {
  const dupe = buildProvenancePolicy();
  dupe.rules.push({ ...dupe.rules[0] });
  assert.throws(() => validateProvenancePolicy(dupe), ProvenancePolicyError);
  assert.throws(() => validateProvenancePolicy(dupe), /duplicate rule id/);

  const badAction = buildProvenancePolicy();
  badAction.rules[0] = { ...badAction.rules[0], action: 'shrug' };
  assert.throws(() => validateProvenancePolicy(badAction), /invalid action/);

  const badSignal = buildProvenancePolicy();
  badSignal.rules[0] = { ...badSignal.rules[0], when: { vibes: true } };
  assert.throws(() => validateProvenancePolicy(badSignal), /unknown signal/);
});

/* ── Parity with the Milestone 1 core ────────────────────────────────────── */

const MATRIX = [
  ['verified and settled', { claimId: 'm1', provenanceRecord: record(), contestationVector: vector() }],
  ['failed signature', { claimId: 'm2', provenanceRecord: record({ signatureStatus: 'failed' }), contestationVector: vector() }],
  ['failed signature AND malformed vector', { claimId: 'm3', provenanceRecord: record({ signatureStatus: 'failed' }), contestationVector: { provenanceScore: 9 } }],
  ['absent signature (unverified)', { claimId: 'm4', provenanceRecord: record({ signatureStatus: 'absent' }), contestationVector: vector() }],
  ['anonymous source, no hash', { claimId: 'm5', provenanceRecord: createProvenanceRecord({ recordId: 's', sourceUrl: 'https://x.example', signatureStatus: 'absent', attributionStatus: 'anonymous' }), contestationVector: vector() }],
  ['malformed record', { claimId: 'm6', provenanceRecord: { recordId: 'x' }, contestationVector: vector() }],
  ['malformed vector', { claimId: 'm7', provenanceRecord: record(), contestationVector: { provenanceScore: 9 } }],
  ['conflict, no replication, low independence', { claimId: 'm8', provenanceRecord: conflictRecord(), contestationVector: vector({ independenceScore: 0.1 }) }],
  ['conflict, no replication, high independence', { claimId: 'm9', provenanceRecord: conflictRecord(), contestationVector: vector({ independenceScore: 0.9 }) }],
  ['conflict WITH replication', { claimId: 'm10', provenanceRecord: conflictRecord({ hasIndependentReplication: true }), contestationVector: vector({ independenceScore: 0.1 }) }],
  ['conflict, no vector at all', { claimId: 'm11', provenanceRecord: conflictRecord() }],
  ['high contestation', { claimId: 'm12', provenanceRecord: record(), contestationVector: vector({ consensusRatio: 0.5, dissentRigor: 0.8 }) }],
  ['no record, valid vector', { claimId: 'm13', contestationVector: vector() }],
  ['valid record, no vector', { claimId: 'm14', provenanceRecord: record() }],
  ['nothing at all', { claimId: 'm15' }],
  ['no record AND malformed vector', { claimId: 'm16', contestationVector: { provenanceScore: 9 } }],
  ['unverified AND high contestation', { claimId: 'm17', provenanceRecord: record({ signatureStatus: 'not-checked' }), contestationVector: vector({ consensusRatio: 0.4, dissentRigor: 0.9 }) }],
];

test('PARITY: the default policy and the Milestone 1 core agree on every matrix claim', () => {
  for (const [name, claim] of MATRIX) {
    const core = evaluateClaimGuardrails(claim);
    const policy = evaluateProvenancePolicy(claim);
    assert.equal(policy.action, core.action, `divergence on "${name}": policy=${policy.action} (${policy.ruleId}) core=${core.action}`);
  }
});

test('the winning rule is named, Executive Guard style', () => {
  assert.equal(evaluateProvenancePolicy(MATRIX[1][1]).ruleId, 'failed-signature-block');
  assert.equal(evaluateProvenancePolicy(MATRIX[0][1]).ruleId, 'verified-settled-allow');
  assert.equal(evaluateProvenancePolicy(MATRIX[14][1]).ruleId, 'missing-record-annotate');
});

/* ── Threshold evaluators and profile-driven rulesets ────────────────────── */

test('a stricter profile rebuilds the ruleset thresholds — contestation that annotated now still annotates, borderline flips by the numbers', () => {
  const borderline = {
    claimId: 'b1', provenanceRecord: record(),
    contestationVector: vector({ consensusRatio: 0.8, dissentRigor: 0.5 }),
  };
  // Default profile: consensusMax 0.7 — 0.8 is settled enough, allowed.
  assert.equal(evaluateProvenancePolicy(borderline).action, 'allow');
  // A profile that treats anything under 0.85 consensus as contested:
  const strict = buildProvenancePolicy({ highContestationConsensusMax: 0.85, highContestationDissentRigorMin: 0.4 });
  const result = evaluateProvenancePolicy(borderline, strict);
  assert.equal(result.action, 'annotate');
  assert.equal(result.ruleId, 'high-contestation-annotate');
});

test('a custom threshold rule can quarantine low-provenance claims — the ruleset is genuinely editable', () => {
  const policy = buildProvenancePolicy();
  policy.rules.unshift({
    id: 'thin-provenance-quarantine',
    when: { vectorValid: true, provenanceScoreMax: 0.3 },
    action: 'quarantine',
    reason: 'provenance score too thin to deliver',
  });
  const thin = { claimId: 't1', provenanceRecord: record(), contestationVector: vector({ provenanceScore: 0.2 }) };
  const result = evaluateProvenancePolicy(thin, policy);
  assert.equal(result.action, 'quarantine');
  assert.equal(result.ruleId, 'thin-provenance-quarantine');
  // And the same claim under the default policy is untouched by that rule.
  assert.equal(evaluateProvenancePolicy(thin).action, 'allow');
});

test('signals are derived with the core semantics: no vector means independence 0, not independent', () => {
  const signals = deriveClaimSignals({ claimId: 's1', provenanceRecord: conflictRecord() });
  assert.equal(signals.independenceScore, 0);
  assert.equal(signals.undisclosedFinancialConflict, true);
  assert.equal(signals.unverifiedProvenance, false);
});

/* ── Badges ──────────────────────────────────────────────────────────────── */

test('badges: verified claim gets the green Verified Provenance badge with its vector', () => {
  const badge = badgeForClaim(MATRIX[0][1]);
  assert.equal(badge.id, 'verified-provenance');
  assert.equal(badge.tone, 'green');
  assert.deepEqual(badge.vector, [0.9, 0.9, 0.95, 0.2]);
  assert.match(formatBadgeText(badge), /Verified Provenance \[0\.90, 0\.90, 0\.95, 0\.20\]/);
});

test('badges: unverified, contested, quarantined, and blocked claims each get their own badge', () => {
  const unverified = badgeForClaim(MATRIX[4][1]);
  assert.equal(unverified.id, 'unverified-provenance');
  assert.equal(unverified.tone, 'amber');

  const contested = badgeForClaim(MATRIX[11][1]);
  assert.equal(contested.id, 'high-contestation');
  assert.equal(contested.tone, 'orange');
  assert.match(contested.detail, /counter-evidence/);

  const quarantined = badgeForClaim(MATRIX[7][1]);
  assert.equal(quarantined.id, 'quarantined-review');
  assert.equal(quarantined.tone, 'red');

  const blocked = badgeForClaim(MATRIX[1][1]);
  assert.equal(blocked.id, 'blocked-integrity');
  assert.equal(blocked.tone, 'red');
  assert.match(blocked.detail, /not delivered/);
});

test('badges: a claim with no evidence never wears a green badge', () => {
  const badge = badgeForClaim({ claimId: 'bare' });
  assert.notEqual(badge.tone, 'green');
  assert.equal(badge.id, 'unverified-provenance');
  assert.equal(badge.vector, null);
});

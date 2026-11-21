// Milestone 3 of the provenance verification build (specification: Scribe
// 1154, Stage 4 + Milestone 3) — the Guardrail Policy Ruleset and the guard
// badges.
//
// THE FORMAT IS THE EXECUTIVE GUARD'S OWN. executive-guard/src/policy.mjs
// already runs a policy of { version, defaultVerdict, rules: [{ id, when,
// verdict, reason }] } — first matching rule wins, and anything no rule
// matches falls to the default, which fails closed. This module speaks that
// same shape for provenance claims, so the Executive Guard, Site Guard, and
// the browser extension Guard are all reading one kind of document:
//
//   { version, defaultAction,
//     rules: [{ id, when: {…claim signals…}, action, reason }] }
//
// Actions are the Milestone 1 guardrail actions (allow / annotate /
// quarantine / block); the default action is 'annotate' — an unmatched
// claim is surfaced with a note, never silently passed as verified.
//
// THE DEFAULT POLICY IS THE MILESTONE 1 CORE, RESTATED AS RULES. The
// deterministic decisions evaluateClaimGuardrails has made since Milestone 1
// are expressed here as an editable ruleset, with the weighting profile's
// thresholds baked in by buildProvenancePolicy(profile). The parity suite
// (provenance-policy.test.mjs) runs a claim matrix through BOTH evaluators
// and requires the same action from each — a ruleset edit that changes a
// decision without changing the core, or the reverse, fails the suite and
// says which claim diverged. When Milestone 4 syncs a user's weighting
// profile, what travels is this document.
//
// BADGES. badgeForClaim returns the visual badge a surface paints — Site
// Guard overlay, extension, workspace — as DATA ({ id, label, tone, detail,
// vector }): the surfaces own rendering, this module owns what the badge
// says and when it changes. A badge is a claim about verification state, so
// it is derived from the evaluation, never supplied by content.
//
// Browser-safe: no imports beyond the Milestone 1 core, no Node APIs.

import {
  GUARDRAIL_ACTIONS,
  resolveWeightingProfile,
  validateProvenanceRecord,
  validateContestationVector,
  isUnverifiedProvenance,
  toVectorArray,
} from './provenance-verification.mjs';

export const PROVENANCE_POLICY_VERSION = 1;

export class ProvenancePolicyError extends Error {}

/* ── Claim signals ───────────────────────────────────────────────────────── */

/**
 * The facts a rule's `when` clause may test. Derived ONCE from the claim,
 * with exactly the Milestone 1 core's semantics — including its fallback
 * that a claim with no usable independence score is treated as independence
 * 0 for the conflict rule, never as independent.
 */
export function deriveClaimSignals(claim = {}) {
  const record = claim?.provenanceRecord ?? null;
  const vector = claim?.contestationVector ?? null;

  const recordCheck = record ? validateProvenanceRecord(record) : null;
  const vectorCheck = vector ? validateContestationVector(vector) : null;

  const undisclosedFinancialConflict = record
    ? (record.conflicts ?? []).some(
      (c) => String(c?.kind ?? '').toLowerCase() === 'financial' && c?.disclosed === false,
    )
    : false;

  return {
    recordPresent: record !== null,
    recordValid: recordCheck ? recordCheck.valid : false,
    signatureStatus: record && typeof record.signatureStatus === 'string' ? record.signatureStatus : null,
    attributionStatus: record && typeof record.attributionStatus === 'string' ? record.attributionStatus : null,
    unverifiedProvenance: record ? isUnverifiedProvenance(record) : true,
    undisclosedFinancialConflict,
    independentReplication: record?.hasIndependentReplication === true,
    vectorPresent: vector !== null,
    vectorValid: vectorCheck ? vectorCheck.valid : false,
    provenanceScore: vector && Number.isFinite(vector.provenanceScore) ? vector.provenanceScore : null,
    independenceScore: vector && Number.isFinite(vector.independenceScore) ? vector.independenceScore : 0,
    consensusRatio: vector && Number.isFinite(vector.consensusRatio) ? vector.consensusRatio : null,
    dissentRigor: vector && Number.isFinite(vector.dissentRigor) ? vector.dissentRigor : null,
  };
}

/* ── The default ruleset ─────────────────────────────────────────────────── */

/**
 * The Stage 4 rules as a policy document. Thresholds come from the resolved
 * weighting profile, so buildProvenancePolicy(profile) is how a user's
 * synced profile (Milestone 4) becomes the ruleset their surfaces run.
 * Rule ORDER is decision order: strongest outcomes first, matching the
 * Milestone 1 core's strongest-action-wins aggregation.
 */
export function buildProvenancePolicy(profile = null) {
  const resolved = resolveWeightingProfile(profile);
  return {
    version: PROVENANCE_POLICY_VERSION,
    defaultAction: 'annotate',
    rules: [
      { id: 'failed-signature-block',
        when: { recordValid: true, signatureStatus: 'failed' },
        action: 'block',
        reason: 'the source failed its cryptographic integrity check' },
      { id: 'malformed-record-quarantine',
        when: { recordPresent: true, recordValid: false },
        action: 'quarantine',
        reason: 'the provenance record is malformed — malformed evidence proves nothing, including safety' },
      { id: 'malformed-vector-quarantine',
        when: { vectorPresent: true, vectorValid: false },
        action: 'quarantine',
        reason: 'the contestation vector is malformed — malformed evidence proves nothing, including safety' },
      { id: 'undisclosed-conflict-quarantine',
        when: {
          undisclosedFinancialConflict: true,
          independentReplication: false,
          independenceScoreMax: resolved.quarantineIndependenceMax,
        },
        action: 'quarantine',
        reason: 'an undisclosed direct financial conflict stands behind this claim and no independent replication supports it' },
      { id: 'undisclosed-conflict-annotate',
        when: { undisclosedFinancialConflict: true },
        action: 'annotate',
        reason: 'an undisclosed direct financial conflict stands behind this claim' },
      { id: 'unverified-provenance-annotate',
        when: { recordPresent: true, unverifiedProvenance: true },
        action: 'annotate',
        reason: 'Unverified Provenance: the source lacks a complete cryptographic attribution chain' },
      { id: 'missing-record-annotate',
        when: { recordPresent: false },
        action: 'annotate',
        reason: 'no provenance record accompanies this claim' },
      { id: 'missing-vector-annotate',
        when: { vectorPresent: false },
        action: 'annotate',
        reason: 'no contestation vector accompanies this claim' },
      { id: 'high-contestation-annotate',
        when: {
          highContestation: {
            consensusMax: resolved.highContestationConsensusMax,
            dissentRigorMin: resolved.highContestationDissentRigorMin,
          },
        },
        action: 'annotate',
        reason: 'high contestation: the claim and its top counter-evidence must both be surfaced' },
      { id: 'verified-settled-allow',
        when: { recordPresent: true, recordValid: true, vectorPresent: true, vectorValid: true },
        action: 'allow',
        reason: 'verified provenance and a settled contestation vector' },
    ],
  };
}

export const DEFAULT_PROVENANCE_POLICY = Object.freeze(buildProvenancePolicy());

/* ── Validation (the Executive Guard validator's shape) ──────────────────── */

const WHEN_KEYS = Object.freeze([
  'recordPresent', 'recordValid', 'vectorPresent', 'vectorValid',
  'signatureStatus', 'attributionStatus', 'unverifiedProvenance',
  'undisclosedFinancialConflict', 'independentReplication',
  'provenanceScoreMin', 'provenanceScoreMax',
  'independenceScoreMin', 'independenceScoreMax',
  'consensusRatioMin', 'consensusRatioMax',
  'dissentRigorMin', 'dissentRigorMax',
  'highContestation',
]);

export function validateProvenancePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ProvenancePolicyError('policy must be an object');
  }
  if (policy.version !== PROVENANCE_POLICY_VERSION) {
    throw new ProvenancePolicyError(`policy version must be ${PROVENANCE_POLICY_VERSION}`);
  }
  if (!GUARDRAIL_ACTIONS.includes(policy.defaultAction)) {
    throw new ProvenancePolicyError(`defaultAction must be one of ${GUARDRAIL_ACTIONS.join(', ')}`);
  }
  if (!Array.isArray(policy.rules)) throw new ProvenancePolicyError('rules must be an array');
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id) throw new ProvenancePolicyError('every rule needs an id');
    if (ids.has(rule.id)) throw new ProvenancePolicyError(`duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!GUARDRAIL_ACTIONS.includes(rule.action)) {
      throw new ProvenancePolicyError(`rule ${rule.id} has an invalid action`);
    }
    if (!rule.when || typeof rule.when !== 'object' || Array.isArray(rule.when)) {
      throw new ProvenancePolicyError(`rule ${rule.id} needs a when clause`);
    }
    for (const key of Object.keys(rule.when)) {
      if (!WHEN_KEYS.includes(key)) throw new ProvenancePolicyError(`rule ${rule.id} tests an unknown signal: ${key}`);
    }
    if (rule.when.highContestation !== undefined) {
      const h = rule.when.highContestation;
      if (!h || typeof h !== 'object'
        || !Number.isFinite(h.consensusMax) || !Number.isFinite(h.dissentRigorMin)) {
        throw new ProvenancePolicyError(`rule ${rule.id} highContestation needs numeric consensusMax and dissentRigorMin`);
      }
    }
  }
  return policy;
}

/* ── Evaluation ──────────────────────────────────────────────────────────── */

function matches(when, signals) {
  for (const [key, expected] of Object.entries(when)) {
    switch (key) {
      case 'recordPresent': if (signals.recordPresent !== expected) return false; break;
      case 'recordValid': if (signals.recordValid !== expected) return false; break;
      case 'vectorPresent': if (signals.vectorPresent !== expected) return false; break;
      case 'vectorValid': if (signals.vectorValid !== expected) return false; break;
      case 'unverifiedProvenance': if (signals.unverifiedProvenance !== expected) return false; break;
      case 'undisclosedFinancialConflict': if (signals.undisclosedFinancialConflict !== expected) return false; break;
      case 'independentReplication': if (signals.independentReplication !== expected) return false; break;
      case 'signatureStatus':
        if (!(Array.isArray(expected) ? expected : [expected]).includes(signals.signatureStatus)) return false;
        break;
      case 'attributionStatus':
        if (!(Array.isArray(expected) ? expected : [expected]).includes(signals.attributionStatus)) return false;
        break;
      case 'provenanceScoreMin': if (signals.provenanceScore === null || signals.provenanceScore < expected) return false; break;
      case 'provenanceScoreMax': if (signals.provenanceScore === null || signals.provenanceScore > expected) return false; break;
      case 'independenceScoreMin': if (signals.independenceScore < expected) return false; break;
      case 'independenceScoreMax': if (signals.independenceScore > expected) return false; break;
      case 'consensusRatioMin': if (signals.consensusRatio === null || signals.consensusRatio < expected) return false; break;
      case 'consensusRatioMax': if (signals.consensusRatio === null || signals.consensusRatio > expected) return false; break;
      case 'dissentRigorMin': if (signals.dissentRigor === null || signals.dissentRigor < expected) return false; break;
      case 'dissentRigorMax': if (signals.dissentRigor === null || signals.dissentRigor > expected) return false; break;
      case 'highContestation':
        if (!signals.vectorValid) return false;
        if (signals.consensusRatio === null || signals.consensusRatio > expected.consensusMax) return false;
        if (signals.dissentRigor === null || signals.dissentRigor < expected.dissentRigorMin) return false;
        break;
      default: return false;
    }
  }
  return true;
}

/**
 * Evaluate ONE claim against a policy. First matching rule wins, exactly as
 * the Executive Guard evaluates its own policies; no match falls to the
 * policy's defaultAction.
 *
 * @returns {{claimId: string, action: string, ruleId: string,
 *            reasons: string[], signals: object}}
 */
export function evaluateProvenancePolicy(claim = {}, policy = DEFAULT_PROVENANCE_POLICY) {
  validateProvenancePolicy(policy);
  const signals = deriveClaimSignals(claim);
  for (const rule of policy.rules) {
    if (matches(rule.when, signals)) {
      return {
        claimId: String(claim?.claimId ?? ''),
        action: rule.action,
        ruleId: rule.id,
        reasons: [rule.reason || ''],
        signals,
      };
    }
  }
  return {
    claimId: String(claim?.claimId ?? ''),
    action: policy.defaultAction,
    ruleId: 'default',
    reasons: ['no rule matched; the policy default applies'],
    signals,
  };
}

/* ── Guard badges ────────────────────────────────────────────────────────── */

export const BADGE_TONES = Object.freeze(['green', 'amber', 'orange', 'red']);

/**
 * The badge a surface paints for a claim. Derived from the policy
 * evaluation and the claim's signals — in that order: the action decides
 * the family, the signals decide which badge inside it.
 *
 * @returns {{id: string, label: string, tone: string, action: string,
 *            claimId: string, detail: string, vector: number[]|null}}
 */
export function badgeForClaim(claim = {}, policy = DEFAULT_PROVENANCE_POLICY) {
  const evaluation = evaluateProvenancePolicy(claim, policy);
  const { signals } = evaluation;
  const vector = claim?.contestationVector && signals.vectorValid
    ? toVectorArray(claim.contestationVector)
    : null;
  const base = { action: evaluation.action, claimId: evaluation.claimId, vector };

  if (evaluation.action === 'block') {
    return { ...base, id: 'blocked-integrity', label: 'Blocked — Integrity Failure', tone: 'red',
      detail: 'The source failed its cryptographic integrity check. This claim is not delivered.' };
  }
  if (evaluation.action === 'quarantine') {
    return { ...base, id: 'quarantined-review', label: 'Quarantined — Pending Review', tone: 'red',
      detail: evaluation.reasons[0] };
  }
  if (evaluation.action === 'annotate') {
    if (evaluation.ruleId === 'high-contestation-annotate') {
      return { ...base, id: 'high-contestation', label: 'High Contestation', tone: 'orange',
        detail: 'This claim is actively contested. The claim and its top counter-evidence must both be shown.' };
    }
    if (signals.undisclosedFinancialConflict) {
      return { ...base, id: 'conflict-disclosed', label: 'Undisclosed Conflict', tone: 'orange',
        detail: 'An undisclosed direct financial conflict stands behind this claim.' };
    }
    if (!signals.recordPresent || signals.unverifiedProvenance) {
      return { ...base, id: 'unverified-provenance', label: 'Unverified Provenance', tone: 'amber',
        detail: 'The source lacks a complete cryptographic attribution chain.' };
    }
    return { ...base, id: 'verification-note', label: 'Verification Note', tone: 'amber',
      detail: evaluation.reasons[0] };
  }
  return { ...base, id: 'verified-provenance', label: 'Verified Provenance', tone: 'green',
    detail: 'Verified source, settled contestation. Scores are [provenance, independence, consensus, dissent rigor].' };
}

/** The one-line text form of a badge, for overlays that render text. */
export function formatBadgeText(badge) {
  if (!badge || typeof badge !== 'object') return '';
  const vector = Array.isArray(badge.vector)
    ? ` [${badge.vector.map((n) => n.toFixed(2)).join(', ')}]`
    : '';
  return `${badge.label}${vector} — ${badge.detail}`;
}

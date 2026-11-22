// GENERATED FILE — DO NOT EDIT.
//
// Byte-for-byte copy of src/core/provenance-verification.mjs.
// Produced by extension/tools/sync-kernel.mjs. Edit the original, then run:
//     node extension/tools/sync-kernel.mjs
//
// extension/test/kernel-sync.test.mjs fails if this file and the original
// ever differ, so the two can never drift apart quietly.
// ==== END OF GENERATED HEADER — verbatim copy starts on the next line ====
// PROVENANCE VERIFICATION — where a claim came from, how contested it is,
// and what the Executive Guard must do with it before a reply is delivered.
//
// Build specification: Scribe 1154 (2026-11-20), "Helmian Provenance
// Verification, Consensus Mapping & Executive Guardrails", Milestone 1.
// This file is Milestone 1 only: the two schemas and the pre-response
// verification hooks. The Sandbox Investigator Worker (Milestone 2), the
// Guard badge surface (Milestone 3) and Profile Sync transport (Milestone 4)
// are later bites and are NOT built here.
//
// THIS IS NOT src/core/provenance-log.mjs. That ledger answers "which MODEL
// answered me" and records a completion after it arrives. This module answers
// a different question about a different thing: "which SOURCE stands behind
// this CLAIM, can that source be verified, and how much independent evidence
// disagrees with it". The two share a word and nothing else — different
// records, different writers, different readers. Naming the source record
// `ProvenanceRecord` follows the specification's own name; the model ledger
// keeps its own `recordCompletion` and is untouched by this file.
//
// THIS IS NOT src/core/unverified-claims.mjs either. That detector flags
// hedged, unsourced prose after a model writes it, and it NEVER BLOCKS —
// that pin stays. This module gates on structured evidence a caller supplies
// (a signed source, a hash, a contestation vector), not on English phrasing.
// A claim with no structured evidence attached is annotated as unverified,
// never silently treated as verified.
//
// BROWSER-SAFE ON PURPOSE, like unverified-claims.mjs: no imports at all.
// A source hash is a field the caller supplies (Node code computes it with
// node:crypto, the extension with SubtleCrypto); this file validates its
// shape and never computes one, so the same file can be copied into the
// extension by extension/tools/sync-kernel.mjs in a later bite. Copying is
// NOT wired in this bite — the generated copy would be a second source of
// truth to keep in step, and Milestone 1 has no extension consumer yet.
//
// DETERMINISTIC, NEVER A BINARY TRUE/FALSE. The specification forbids
// collapsing a contested claim into a true/false label. The output here is
// a vector of four scores plus a guardrail ACTION (allow, annotate,
// quarantine, block) with the reasons that produced it. The action is a
// delivery decision, not a truth verdict: "quarantine" means "do not deliver
// this as settled", never "this is false".

export const PROVENANCE_VERIFICATION_SCHEMA_VERSION = 1;

/** The flag the specification names, in the exact words it names it. */
export const UNVERIFIED_PROVENANCE_FLAG = 'Unverified Provenance';

/** How a source's cryptographic signature checked out at ingestion. */
export const SIGNATURE_STATUSES = Object.freeze([
  'verified',   // a signature was present and validated
  'absent',     // no signature was offered at all
  'failed',     // a signature was offered and did NOT validate
  'not-checked', // ingestion did not attempt a check — honest, not verified
]);

/** Who stands behind a source, as far as ingestion could establish it. */
export const ATTRIBUTION_STATUSES = Object.freeze([
  'verified',     // publisher and author identity both established
  'publisher-only', // the publisher/domain is established, the author is not
  'anonymous',    // anonymously mutable: anyone could have written or edited it
  'unknown',      // ingestion could not establish anything
]);

/** The three evidence clusters the specification partitions evidence into. */
export const EVIDENCE_CLUSTERS = Object.freeze([
  'institutional-consensus', // Cluster A: institutional / peer-reviewed consensus
  'replicated-empirical',    // Cluster B: replicated empirical / primary source
  'dissenting',              // Cluster C: dissenting / minority, with a rigor score
]);

/** Guardrail actions, weakest to strongest. Aggregation takes the strongest. */
export const GUARDRAIL_ACTIONS = Object.freeze(['allow', 'annotate', 'quarantine', 'block']);

const ACTION_RANK = Object.freeze({ allow: 0, annotate: 1, quarantine: 2, block: 3 });

/** A sha256 hex digest: 64 lowercase or uppercase hex characters, nothing else. */
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * The weighting profile shape (specification Stage 4). Syncing a profile
 * across devices and agents is Milestone 4; Milestone 1 defines the shape,
 * validates it, and lets a caller pass one in. Weights are 0..1 each and do
 * NOT have to sum to 1 — they are independent dials, and normalising them
 * here would silently change what an operator set.
 */
export const DEFAULT_WEIGHTING_PROFILE = Object.freeze({
  provenanceWeight: 1,
  financialIndependenceWeight: 1,
  institutionalConsensusWeight: 1,
  replicationWeight: 1,
  // Delivery thresholds carried on the same profile so one synced object
  // fully describes a gate's behaviour.
  highContestationConsensusMax: 0.7,
  highContestationDissentRigorMin: 0.3,
  quarantineIndependenceMax: 0.25,
});

const PROFILE_KEYS = Object.freeze(Object.keys(DEFAULT_WEIGHTING_PROFILE));

export function validateWeightingProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { valid: false, errors: ['weighting profile must be an object'] };
  }
  for (const key of PROFILE_KEYS) {
    if (profile[key] === undefined) continue; // a partial profile inherits defaults
    const value = profile[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${key} must be a number between 0 and 1`);
    }
  }
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(key)) errors.push(`unknown weighting profile key: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

/** A full profile: the caller's partial profile laid over the defaults. */
export function resolveWeightingProfile(profile = null) {
  if (profile === null || profile === undefined) return { ...DEFAULT_WEIGHTING_PROFILE };
  const { valid, errors } = validateWeightingProfile(profile);
  if (!valid) throw new TypeError(`invalid weighting profile: ${errors.join('; ')}`);
  return { ...DEFAULT_WEIGHTING_PROFILE, ...profile };
}

/* ─── ProvenanceRecord ──────────────────────────────────────────────────────
 *
 * One ingested source artifact, as the specification's Stage 1 describes it:
 * cryptographic attribution, an immutable source hash, and a retrieval
 * timestamp, recorded before downstream processing. `unverifiedProvenance`
 * is DERIVED, never supplied: a caller that could set it directly could also
 * clear it directly, and the flag would mean nothing.
 */

/**
 * Why a record is (or is not) flagged Unverified Provenance. A record is
 * flagged when ANY of these hold:
 *   - its source hash is missing (no chain of custody to check against)
 *   - its signature is absent, failed, or was never checked
 *   - its attribution is anonymous or unknown
 * A verified signature with publisher-only attribution is NOT flagged on
 * attribution alone: a signed institutional release with no named author is
 * a normal, verifiable artifact, and flagging it would train readers to
 * ignore the flag.
 */
export function provenanceFlagReasons(record) {
  const reasons = [];
  if (!record || typeof record !== 'object') return ['no provenance record'];
  if (!SHA256_HEX.test(String(record.sourceHash ?? ''))) reasons.push('source hash is missing or not a sha256 digest');
  if (record.signatureStatus === 'failed') reasons.push('cryptographic signature failed verification');
  else if (record.signatureStatus === 'absent') reasons.push('no cryptographic signature was offered');
  else if (record.signatureStatus === 'not-checked') reasons.push('cryptographic signature was not checked');
  else if (record.signatureStatus !== 'verified') reasons.push(`signature status is ${JSON.stringify(record.signatureStatus ?? null)}`);
  if (record.attributionStatus === 'anonymous') reasons.push('source is anonymously mutable');
  else if (record.attributionStatus === 'unknown') reasons.push('source attribution is unknown');
  else if (!ATTRIBUTION_STATUSES.includes(record.attributionStatus)) reasons.push(`attribution status is ${JSON.stringify(record.attributionStatus ?? null)}`);
  return reasons;
}

export function isUnverifiedProvenance(record) {
  return provenanceFlagReasons(record).length > 0;
}

export function validateProvenanceRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['provenance record must be an object'] };
  }
  if (record.schema !== undefined && record.schema !== PROVENANCE_VERIFICATION_SCHEMA_VERSION) {
    errors.push(`schema must be ${PROVENANCE_VERIFICATION_SCHEMA_VERSION}`);
  }
  if (!String(record.recordId ?? '').trim()) errors.push('recordId is required');
  if (!String(record.sourceUrl ?? '').trim()) errors.push('sourceUrl is required');
  // sourceHash is required by the SCHEMA as a field, but a record whose hash
  // could not be taken is still a record — it is a flagged one. So presence
  // is not a validation error here; the flag derivation above is what a
  // missing or malformed hash costs. A hash that IS present must be a digest.
  if (record.sourceHash !== undefined && record.sourceHash !== null && record.sourceHash !== ''
    && !SHA256_HEX.test(String(record.sourceHash))) {
    errors.push('sourceHash must be a 64-character sha256 hex digest');
  }
  if (!String(record.retrievedAt ?? '').trim()) errors.push('retrievedAt is required');
  else if (!Number.isFinite(Date.parse(record.retrievedAt))) errors.push('retrievedAt must be a parseable timestamp');
  if (!SIGNATURE_STATUSES.includes(record.signatureStatus)) {
    errors.push(`signatureStatus must be one of: ${SIGNATURE_STATUSES.join(', ')}`);
  }
  if (!ATTRIBUTION_STATUSES.includes(record.attributionStatus)) {
    errors.push(`attributionStatus must be one of: ${ATTRIBUTION_STATUSES.join(', ')}`);
  }
  if (record.conflicts !== undefined) {
    if (!Array.isArray(record.conflicts)) errors.push('conflicts must be a list');
    else {
      record.conflicts.forEach((conflict, index) => {
        if (!conflict || typeof conflict !== 'object') { errors.push(`conflicts[${index}] must be an object`); return; }
        if (!String(conflict.kind ?? '').trim()) errors.push(`conflicts[${index}].kind is required`);
        if (typeof conflict.disclosed !== 'boolean') errors.push(`conflicts[${index}].disclosed must be a boolean`);
      });
    }
  }
  if (record.hasIndependentReplication !== undefined && typeof record.hasIndependentReplication !== 'boolean') {
    errors.push('hasIndependentReplication must be a boolean');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Build one ProvenanceRecord, normalised and flagged.
 *
 * @param {object} input
 * @param {string} input.recordId        caller-chosen stable id for this artifact
 * @param {string} input.sourceUrl       where the artifact was retrieved from
 * @param {string} [input.sourceHash]    sha256 hex of the artifact bytes at retrieval
 * @param {string} [input.retrievedAt]   ISO timestamp; defaults to `now`
 * @param {string} input.signatureStatus one of SIGNATURE_STATUSES
 * @param {string} input.attributionStatus one of ATTRIBUTION_STATUSES
 * @param {string} [input.publisher]     publisher / domain owner, when known
 * @param {string} [input.author]        author identity, when known
 * @param {string} [input.signer]        who or what signed, when a signature exists
 * @param {Array<{kind: string, disclosed: boolean, detail?: string}>} [input.conflicts]
 * @param {boolean} [input.hasIndependentReplication]
 * @param {object} [options]
 * @param {Date} [options.now]           clock override, for tests
 * @returns {object} the record, with `unverifiedProvenance` and
 *                   `flagReasons` derived and attached
 */
export function createProvenanceRecord(input = {}, { now = new Date() } = {}) {
  const record = {
    schema: PROVENANCE_VERIFICATION_SCHEMA_VERSION,
    recordId: String(input.recordId ?? ''),
    sourceUrl: String(input.sourceUrl ?? ''),
    sourceHash: input.sourceHash === undefined || input.sourceHash === null ? '' : String(input.sourceHash),
    retrievedAt: input.retrievedAt ? String(input.retrievedAt) : new Date(now).toISOString(),
    signatureStatus: input.signatureStatus,
    attributionStatus: input.attributionStatus,
    publisher: input.publisher ? String(input.publisher) : '',
    author: input.author ? String(input.author) : '',
    signer: input.signer ? String(input.signer) : '',
    conflicts: Array.isArray(input.conflicts) ? input.conflicts.map((c) => ({ ...c })) : [],
    hasIndependentReplication: input.hasIndependentReplication === true,
  };
  const { valid, errors } = validateProvenanceRecord(record);
  if (!valid) throw new TypeError(`invalid provenance record: ${errors.join('; ')}`);
  const flagReasons = provenanceFlagReasons(record);
  record.unverifiedProvenance = flagReasons.length > 0;
  record.flagReasons = flagReasons;
  if (record.unverifiedProvenance) record.flag = UNVERIFIED_PROVENANCE_FLAG;
  return record;
}

/* ─── ContestationVector ────────────────────────────────────────────────────
 *
 * The Credibility & Contestation Vector from the specification's Stage 3:
 * [provenance_score, independence_score, consensus_ratio, dissent_rigor],
 * each 0..1. Field names in this codebase are camelCase; `toVectorArray`
 * and `contestationVectorFromArray` convert to and from the specification's
 * ordered form without renaming the scores.
 */

const VECTOR_KEYS = Object.freeze(['provenanceScore', 'independenceScore', 'consensusRatio', 'dissentRigor']);

export function validateContestationVector(vector) {
  const errors = [];
  if (!vector || typeof vector !== 'object' || Array.isArray(vector)) {
    return { valid: false, errors: ['contestation vector must be an object'] };
  }
  for (const key of VECTOR_KEYS) {
    const value = vector[key];
    if (!Number.isFinite(value)) errors.push(`${key} is required and must be a number`);
    else if (value < 0 || value > 1) errors.push(`${key} must be between 0 and 1`);
  }
  if (vector.clusters !== undefined) {
    if (!vector.clusters || typeof vector.clusters !== 'object' || Array.isArray(vector.clusters)) {
      errors.push('clusters must be an object keyed by evidence cluster');
    } else {
      for (const key of Object.keys(vector.clusters)) {
        if (!EVIDENCE_CLUSTERS.includes(key)) errors.push(`unknown evidence cluster: ${key}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createContestationVector(input = {}) {
  const vector = {
    provenanceScore: input.provenanceScore,
    independenceScore: input.independenceScore,
    consensusRatio: input.consensusRatio,
    dissentRigor: input.dissentRigor,
  };
  if (input.clusters !== undefined) vector.clusters = { ...input.clusters };
  const { valid, errors } = validateContestationVector(vector);
  if (!valid) throw new TypeError(`invalid contestation vector: ${errors.join('; ')}`);
  return vector;
}

/** The specification's ordered form: [provenance, independence, consensus, dissent]. */
export function toVectorArray(vector) {
  const { valid, errors } = validateContestationVector(vector);
  if (!valid) throw new TypeError(`invalid contestation vector: ${errors.join('; ')}`);
  return [vector.provenanceScore, vector.independenceScore, vector.consensusRatio, vector.dissentRigor];
}

export function contestationVectorFromArray(values) {
  if (!Array.isArray(values) || values.length !== 4) {
    throw new TypeError('a contestation vector array must carry exactly four scores');
  }
  return createContestationVector({
    provenanceScore: values[0],
    independenceScore: values[1],
    consensusRatio: values[2],
    dissentRigor: values[3],
  });
}

/**
 * High contestation, as the specification's Stage 4 uses it for mandatory
 * annotation: the consensus is not settled (consensusRatio at or below the
 * profile's ceiling) AND the dissent is not noise (dissentRigor at or above
 * the profile's floor). Either half alone is not contestation — a low
 * consensus with no rigorous dissent is just a weak claim, and rigorous
 * dissent against a settled consensus is a footnote.
 */
export function isHighContestation(vector, profile = null) {
  const resolved = resolveWeightingProfile(profile);
  const { valid } = validateContestationVector(vector);
  if (!valid) return false;
  return vector.consensusRatio <= resolved.highContestationConsensusMax
    && vector.dissentRigor >= resolved.highContestationDissentRigorMin;
}

/* ─── Guardrail evaluation (the deterministic core of Stage 4) ──────────────
 *
 * The full Executive Guard ruleset is Milestone 3. What Milestone 1 needs —
 * and what the pre-response hooks below run — is the evaluation core the
 * specification already states in full:
 *
 *   HARD BLOCK:      a claim whose source fails its cryptographic integrity
 *                    check (signatureStatus 'failed').
 *   QUARANTINE:      a claim carrying an undisclosed direct financial
 *                    conflict with no independent replication behind it.
 *   ANNOTATE:        a claim that is high-contestation, or whose provenance
 *                    is unverified, or that carries no provenance record or
 *                    no contestation vector at all. Annotation is mandatory,
 *                    never optional, in all three cases.
 *   ALLOW:           none of the above.
 *
 * Anti-gaming / Sybil weighting of open scrutiny signals is NOT here: it
 * needs the reputation inputs Milestone 2's investigator produces, and a
 * placeholder weight here would be a rule nobody can explain.
 */

/**
 * Evaluate ONE claim.
 *
 * @param {object} claim
 * @param {string} claim.claimId
 * @param {object|null} [claim.provenanceRecord]  a ProvenanceRecord, or null
 * @param {object|null} [claim.contestationVector] a ContestationVector, or null
 * @param {object} [profile] a partial weighting profile
 * @returns {{claimId: string, action: string, reasons: string[],
 *            unverifiedProvenance: boolean}}
 */
export function evaluateClaimGuardrails(claim = {}, profile = null) {
  const resolved = resolveWeightingProfile(profile);
  const claimId = String(claim.claimId ?? '');
  const record = claim.provenanceRecord ?? null;
  const vector = claim.contestationVector ?? null;
  const reasons = [];
  let action = 'allow';

  const raise = (next, reason) => {
    reasons.push(reason);
    if (ACTION_RANK[next] > ACTION_RANK[action]) action = next;
  };

  if (!record) {
    raise('annotate', 'no provenance record accompanies this claim');
  } else {
    const { valid, errors } = validateProvenanceRecord(record);
    if (!valid) {
      // A malformed record is not evidence of anything, including safety.
      raise('quarantine', `the provenance record is malformed: ${errors.join('; ')}`);
    } else if (record.signatureStatus === 'failed') {
      raise('block', 'the source failed its cryptographic integrity check');
    }
    if (isUnverifiedProvenance(record)) {
      raise('annotate', `${UNVERIFIED_PROVENANCE_FLAG}: ${provenanceFlagReasons(record).join('; ')}`);
    }
    const undisclosedFinancial = (record.conflicts ?? [])
      .some((c) => String(c?.kind ?? '').toLowerCase() === 'financial' && c?.disclosed === false);
    if (undisclosedFinancial) {
      const independence = vector && Number.isFinite(vector.independenceScore)
        ? vector.independenceScore : 0;
      if (record.hasIndependentReplication !== true && independence <= resolved.quarantineIndependenceMax) {
        raise('quarantine', 'an undisclosed direct financial conflict stands behind this claim and no independent replication supports it');
      } else {
        // The conflict is still undisclosed, so it is still surfaced — the
        // replication changes the delivery decision, not the disclosure duty.
        raise('annotate', 'an undisclosed direct financial conflict stands behind this claim');
      }
    }
  }

  if (!vector) {
    raise('annotate', 'no contestation vector accompanies this claim');
  } else {
    const { valid, errors } = validateContestationVector(vector);
    if (!valid) raise('quarantine', `the contestation vector is malformed: ${errors.join('; ')}`);
    else if (isHighContestation(vector, resolved)) {
      raise('annotate', 'high contestation: the claim and its top counter-evidence must both be surfaced');
    }
  }

  return {
    claimId,
    action,
    reasons,
    unverifiedProvenance: record ? isUnverifiedProvenance(record) : true,
  };
}

/** The annotation text a delivery surface shows for one evaluated claim. */
export function annotationForEvaluation(evaluation, claim = {}) {
  const label = claim.claimId ? `Claim ${claim.claimId}` : 'Claim';
  if (evaluation.action === 'allow') return '';
  if (evaluation.action === 'block') return `${label} was blocked by the Executive Guard: ${evaluation.reasons.join('; ')}.`;
  if (evaluation.action === 'quarantine') return `${label} is quarantined pending review: ${evaluation.reasons.join('; ')}.`;
  return `${label} — ${UNVERIFIED_PROVENANCE_FLAG} / contestation note: ${evaluation.reasons.join('; ')}.`;
}

/* ─── Pre-response verification hooks ───────────────────────────────────────
 *
 * The registration point the specification's Milestone 1 names. A hook is a
 * function taking the response context and returning (or resolving to) a
 * partial verdict: { action?, annotations?, reasons? }. Hooks run in
 * registration order, before a reply is delivered; the aggregate action is
 * the strongest any hook asked for.
 *
 * FAIL CLOSED, in the governance-gate sense: a hook that throws, or returns
 * a shape this runner cannot read, quarantines the response and says why.
 * A verification step that could not complete must never read as a
 * verification step that passed.
 *
 * The response context shape:
 *   {
 *     text: string,                       the reply about to be delivered
 *     claims: [{ claimId, text?, provenanceRecord, contestationVector }],
 *     profile?: object,                   a partial weighting profile
 *   }
 */

export function createProvenanceHookRegistry() {
  const hooks = [];
  return {
    register(name, hook) {
      if (!String(name ?? '').trim()) throw new TypeError('a pre-response hook needs a name');
      if (typeof hook !== 'function') throw new TypeError(`pre-response hook "${name}" must be a function`);
      if (hooks.some((entry) => entry.name === name)) throw new Error(`pre-response hook "${name}" is already registered`);
      hooks.push({ name: String(name), hook });
      return this;
    },
    list() {
      return hooks.map((entry) => entry.name);
    },
    async run(context = {}) {
      const annotations = [];
      const reasons = [];
      const evaluations = [];
      let action = 'allow';
      const raise = (next) => { if (ACTION_RANK[next] > ACTION_RANK[action]) action = next; };

      for (const { name, hook } of hooks) {
        let verdict;
        try {
          verdict = await hook(context);
        } catch (err) {
          raise('quarantine');
          reasons.push(`pre-response hook "${name}" failed and verification fails closed: ${err.message}`);
          continue;
        }
        if (verdict === null || verdict === undefined) continue;
        if (typeof verdict !== 'object' || Array.isArray(verdict)) {
          raise('quarantine');
          reasons.push(`pre-response hook "${name}" returned an unreadable verdict and verification fails closed`);
          continue;
        }
        if (verdict.action !== undefined) {
          if (!GUARDRAIL_ACTIONS.includes(verdict.action)) {
            raise('quarantine');
            reasons.push(`pre-response hook "${name}" returned an unknown action ${JSON.stringify(verdict.action)} and verification fails closed`);
          } else {
            raise(verdict.action);
          }
        }
        if (Array.isArray(verdict.annotations)) annotations.push(...verdict.annotations.map(String));
        if (Array.isArray(verdict.reasons)) reasons.push(...verdict.reasons.map(String));
        if (Array.isArray(verdict.evaluations)) evaluations.push(...verdict.evaluations);
      }

      return { action, blocked: action === 'block', quarantined: action === 'quarantine', annotations, reasons, evaluations };
    },
  };
}

/**
 * The built-in hook: evaluate every claim in the context against the
 * guardrail core above. A context with NO claims is allowed untouched —
 * most replies assert no externally sourced claim, and annotating every
 * conversational reply would train readers to ignore the annotation.
 */
export function provenanceGuardrailHook(context = {}) {
  const claims = Array.isArray(context.claims) ? context.claims : [];
  if (!claims.length) return { action: 'allow', annotations: [], reasons: [], evaluations: [] };
  const evaluations = claims.map((claim) => evaluateClaimGuardrails(claim, context.profile ?? null));
  let action = 'allow';
  const annotations = [];
  const reasons = [];
  for (const evaluation of evaluations) {
    if (ACTION_RANK[evaluation.action] > ACTION_RANK[action]) action = evaluation.action;
    const claim = claims.find((c) => String(c?.claimId ?? '') === evaluation.claimId) ?? {};
    const annotation = annotationForEvaluation(evaluation, claim);
    if (annotation) annotations.push(annotation);
    for (const reason of evaluation.reasons) reasons.push(`${evaluation.claimId || 'claim'}: ${reason}`);
  }
  return { action, annotations, reasons, evaluations };
}

/** A registry carrying the built-in hook, the default every caller starts from. */
export function createDefaultProvenanceHookRegistry() {
  return createProvenanceHookRegistry().register('provenance-guardrails', provenanceGuardrailHook);
}

/**
 * Run the pre-response verification for one reply.
 *
 * @param {object} context  the response context described above
 * @param {object} [options]
 * @param {object} [options.registry]  defaults to the default registry
 * @returns {Promise<{action: string, blocked: boolean, quarantined: boolean,
 *           annotations: string[], reasons: string[], evaluations: object[],
 *           text: string}>} `text` is the reply as it may be delivered:
 *           unchanged on allow, with annotations appended on annotate, and
 *           replaced by the quarantine / block notice on quarantine / block
 *           (the original text is never carried on a blocked result, so a
 *           caller cannot deliver it by accident).
 */
export async function runPreResponseVerification(context = {}, { registry = null } = {}) {
  const active = registry ?? createDefaultProvenanceHookRegistry();
  const result = await active.run(context);
  const original = String(context.text ?? '');
  let text = original;
  if (result.action === 'annotate' && result.annotations.length) {
    text = `${original}\n\n${result.annotations.join('\n')}`;
  } else if (result.action === 'quarantine') {
    text = `This response is quarantined pending provenance review: ${result.reasons.join('; ') || 'verification did not pass'}.`;
  } else if (result.action === 'block') {
    text = `This response was blocked by the Executive Guard: ${result.reasons.join('; ') || 'a source failed its integrity check'}.`;
  }
  return { ...result, text };
}

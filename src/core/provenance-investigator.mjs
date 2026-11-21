// Milestone 2 of the provenance verification build (specification: Scribe
// 1154, Stage 2) — the Sandbox Investigator Worker.
//
// WHAT THIS IS. Before a claim reaches the Executive Guard, an isolated
// investigator pass cross-references it the way an investigative journalist
// would: the primary authors, the institutions behind them, and the claim
// itself are checked against financial disclosures, grant registries,
// affiliations, lobbying records, peer-reviewed rebuttals, retractions,
// replication studies, and primary source documents. The output is a
// structured Conflict & Provenance Dossier — the raw material the Milestone 1
// ContestationVector is computed from. The dossier is deliberately NOT
// collapsed into a consensus paragraph: supports, disputes, conflicts, and
// gaps each stay visible as their own entries.
//
// THE SANDBOX, STATED HONESTLY (the same discipline as mcp-sandbox.mjs's
// isolation statement). The investigator core holds NO capabilities of its
// own: it cannot read files, open the network, spawn processes, or call a
// model. Its only door to the outside world is ONE injected lookup function,
// and it may only call that function with sub-queries from its own
// deterministic plan, in allowlisted categories, inside a bounded query
// budget and a per-query timeout. That is capability isolation, not an OS
// boundary — see investigatorIsolation(). The lookup function itself belongs
// to the caller, and what IT can reach is the caller's responsibility; the
// worker entry point (provenance-investigator-worker.mjs) supplies lookups
// from a file, so the shipped worker process holds no network capability at
// all.
//
// EVIDENCE INTEGRITY (the mcp-sandbox lesson, applied). A lookup result that
// does not fit the evidence schema is REJECTED AND RECORDED, never silently
// dropped and never counted. A lookup that throws or times out leaves a
// named gap and a partial dossier — an incomplete investigation is reported
// as incomplete, never as "nothing found".
//
// The vector math is deterministic and documented at scoreDossier(). No
// model judgement enters the scores; a model's place is inside the caller's
// lookup, gathering evidence, never deciding the numbers.

import {
  createContestationVector,
  validateContestationVector,
  validateProvenanceRecord,
  isUnverifiedProvenance,
  EVIDENCE_CLUSTERS,
} from './provenance-verification.mjs';

export const DOSSIER_SCHEMA_VERSION = 1;

/** The only categories a sub-query may ask about. Anything else is refused
 *  at planning time and rejected at evidence time. */
export const INVESTIGATION_CATEGORIES = Object.freeze([
  'financial-disclosure',
  'grant-registry',
  'affiliation',
  'lobbying',
  'rebuttal',
  'retraction',
  'replication',
  'primary-source',
]);

export const EVIDENCE_STANCES = Object.freeze(['supports', 'disputes', 'context']);

/** Default dissent/support weight of a category when an evidence item does
 *  not carry its own rigor. A retraction outweighs an affiliation note. */
export const CATEGORY_RIGOR_DEFAULTS = Object.freeze({
  'financial-disclosure': 0.7,
  'grant-registry': 0.7,
  affiliation: 0.5,
  lobbying: 0.5,
  rebuttal: 0.6,
  retraction: 0.9,
  replication: 0.8,
  'primary-source': 0.85,
});

export const DEFAULT_INVESTIGATION_LIMITS = Object.freeze({
  maxQueries: 40,
  perQueryTimeoutMs: 15000,
});

export function investigatorIsolation() {
  return {
    achieved: 'capability isolation: the investigator core imports no fs, network, process, or model module; its only external call is the single injected lookup function, invoked only with planned sub-queries in allowlisted categories, under a query budget and per-query timeouts',
    isNot: 'an OS sandbox, a VM, or a container; the core runs in the caller\'s process, and the injected lookup function executes with whatever capabilities the caller gave it',
    workerNote: 'the shipped worker entry point injects a file-backed lookup, so the worker process itself performs no network access and writes only its dossier output file',
  };
}

/* ── The plan ────────────────────────────────────────────────────────────── */

/**
 * The deterministic sub-query plan for a claim. Same claim in, same plan
 * out — query ids are stable, so a file of lookup answers can be keyed by
 * them and an investigation can be replayed.
 *
 * claim: { claimId, claimText, authors?: string[], institutions?: string[],
 *          provenanceRecord?: ProvenanceRecord }
 */
export function buildInvestigationPlan(claim = {}) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new TypeError('an investigation needs a claim object');
  }
  if (typeof claim.claimId !== 'string' || claim.claimId.trim() === '') {
    throw new TypeError('a claim needs a claimId');
  }
  if (typeof claim.claimText !== 'string' || claim.claimText.trim() === '') {
    throw new TypeError('a claim needs claimText');
  }
  const authors = cleanNames(claim.authors, 'authors');
  const institutions = cleanNames(claim.institutions, 'institutions');

  const plan = [];
  const seen = new Set();
  const add = (category, subjectKind, subject) => {
    const key = `${category}|${subjectKind}|${subject.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({
      queryId: `q${plan.length + 1}`,
      category,
      subjectKind,
      subject,
      query: `${category} records concerning ${subject} in relation to claim ${claim.claimId}: ${claim.claimText}`,
    });
  };

  for (const author of authors) {
    add('financial-disclosure', 'author', author);
    add('affiliation', 'author', author);
    add('lobbying', 'author', author);
  }
  for (const institution of institutions) {
    add('grant-registry', 'institution', institution);
    add('affiliation', 'institution', institution);
    add('financial-disclosure', 'institution', institution);
  }
  add('rebuttal', 'claim', claim.claimId);
  add('retraction', 'claim', claim.claimId);
  add('replication', 'claim', claim.claimId);
  add('primary-source', 'claim', claim.claimId);
  return plan;
}

function cleanNames(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new TypeError(`claim.${field} must be an array of non-empty names`);
  }
  return [...value];
}

/* ── Evidence ────────────────────────────────────────────────────────────── */

/**
 * One piece of cross-reference evidence, as a lookup returns it:
 * { evidenceId, category, summary, sourceUrl?, stance, rigor?,
 *   cluster?, sourcePublisher?, sourceAuthor?,
 *   financialConflict?: { disclosed } | null,
 *   provenanceRecord?: ProvenanceRecord }
 * stance is 'supports' | 'disputes' | 'context' (context = bears on the
 * dossier, e.g. a disclosed affiliation, without taking a side on the claim).
 */
export function validateEvidenceItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, errors: ['an evidence item must be an object'] };
  }
  if (typeof item.evidenceId !== 'string' || item.evidenceId.trim() === '') errors.push('evidenceId is required');
  if (!INVESTIGATION_CATEGORIES.includes(item.category)) {
    errors.push(`category must be one of ${INVESTIGATION_CATEGORIES.join(', ')}`);
  }
  if (typeof item.summary !== 'string' || item.summary.trim() === '') errors.push('summary is required');
  if (!EVIDENCE_STANCES.includes(item.stance)) {
    errors.push(`stance must be one of ${EVIDENCE_STANCES.join(', ')}`);
  }
  if (item.rigor !== undefined
    && (typeof item.rigor !== 'number' || !Number.isFinite(item.rigor) || item.rigor < 0 || item.rigor > 1)) {
    errors.push('rigor must be a number between 0 and 1');
  }
  if (item.cluster !== undefined && !EVIDENCE_CLUSTERS.includes(item.cluster)) {
    errors.push(`cluster must be one of ${EVIDENCE_CLUSTERS.join(', ')}`);
  }
  if (item.financialConflict !== undefined && item.financialConflict !== null) {
    if (typeof item.financialConflict !== 'object' || typeof item.financialConflict.disclosed !== 'boolean') {
      errors.push('financialConflict must be null or an object with a boolean disclosed');
    }
  }
  if (item.provenanceRecord !== undefined && item.provenanceRecord !== null) {
    const check = validateProvenanceRecord(item.provenanceRecord);
    if (!check.valid) errors.push(...check.errors.map((e) => `provenanceRecord: ${e}`));
  }
  return { valid: errors.length === 0, errors };
}

function nameMatches(name, names) {
  if (typeof name !== 'string' || name.trim() === '') return false;
  const needle = name.trim().toLowerCase();
  return names.some((n) => n.trim().toLowerCase() === needle);
}

/** Is this evidence independent of the claim's own authors and institutions,
 *  and free of an undisclosed financial tie? Derived, never self-declared. */
export function isIndependentEvidence(item, claim = {}) {
  const subjects = [...(claim.authors ?? []), ...(claim.institutions ?? [])];
  if (nameMatches(item.sourceAuthor, subjects) || nameMatches(item.sourcePublisher, subjects)) return false;
  if (item.financialConflict && item.financialConflict.disclosed === false) return false;
  return true;
}

function rigorOf(item) {
  return typeof item.rigor === 'number' ? item.rigor : (CATEGORY_RIGOR_DEFAULTS[item.category] ?? 0.5);
}

/* ── Scoring: dossier evidence -> ContestationVector ─────────────────────── */

/**
 * The vector math, in the open:
 *   provenanceScore   share of evidence items carrying a provenance record
 *                     that is NOT flagged Unverified Provenance (0 when the
 *                     investigation gathered no evidence at all).
 *   independenceScore share of evidence items independent of the claim's
 *                     authors/institutions with no undisclosed financial tie.
 *   consensusRatio    supports / (supports + disputes) among stance-bearing
 *                     items; 0.5 — genuinely unknown, not agreement — when no
 *                     item takes a side.
 *   dissentRigor      the highest rigor among disputing items (category
 *                     defaults when an item carries none); 0 when nothing
 *                     disputes the claim.
 * Clusters count the stance-bearing items that declared one.
 */
export function scoreDossier(evidence = [], claim = {}) {
  const items = Array.isArray(evidence) ? evidence : [];
  const total = items.length;
  const verified = items.filter((i) => i.provenanceRecord && !isUnverifiedProvenance(i.provenanceRecord)).length;
  const independent = items.filter((i) => isIndependentEvidence(i, claim)).length;
  const supports = items.filter((i) => i.stance === 'supports').length;
  const disputes = items.filter((i) => i.stance === 'disputes').length;
  const dissentRigor = disputes
    ? Math.max(...items.filter((i) => i.stance === 'disputes').map(rigorOf))
    : 0;
  const clusters = {};
  for (const item of items) {
    if (item.cluster && item.stance !== 'context') {
      clusters[item.cluster] = (clusters[item.cluster] ?? 0) + 1;
    }
  }
  const vector = createContestationVector({
    provenanceScore: total ? verified / total : 0,
    independenceScore: total ? independent / total : 0,
    consensusRatio: supports + disputes ? supports / (supports + disputes) : 0.5,
    dissentRigor,
    ...(Object.keys(clusters).length ? { clusters } : {}),
  });
  return {
    vector,
    inputs: { total, verified, independent, supports, disputes },
  };
}

/* ── Dossier shape ───────────────────────────────────────────────────────── */

export function validateDossier(dossier) {
  const errors = [];
  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) {
    return { valid: false, errors: ['a dossier must be an object'] };
  }
  if (dossier.schema !== DOSSIER_SCHEMA_VERSION) errors.push(`schema must be ${DOSSIER_SCHEMA_VERSION}`);
  if (typeof dossier.dossierId !== 'string' || dossier.dossierId.trim() === '') errors.push('dossierId is required');
  if (typeof dossier.claimId !== 'string' || dossier.claimId.trim() === '') errors.push('claimId is required');
  if (!['complete', 'partial'].includes(dossier.status)) errors.push('status must be complete or partial');
  if (!Array.isArray(dossier.evidence)) errors.push('evidence must be an array');
  if (dossier.contestationVector !== null && dossier.contestationVector !== undefined) {
    const check = validateContestationVector(dossier.contestationVector);
    if (!check.valid) errors.push(...check.errors.map((e) => `contestationVector: ${e}`));
  }
  return { valid: errors.length === 0, errors };
}

/* ── The investigation ───────────────────────────────────────────────────── */

async function callLookup(lookup, subquery, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookup(subquery)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`lookup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one investigation.
 *
 * @param {object} args
 * @param {object} args.claim   { claimId, claimText, authors?, institutions?,
 *                                provenanceRecord? } — the provenanceRecord is
 *                                the Milestone 1 Stage 1 record for the
 *                                claim's primary source, carried through.
 * @param {Function} args.lookup  async (subquery) => evidenceItem[]. The ONLY
 *                                capability the investigator is given.
 * @param {object} [args.limits]  partial { maxQueries, perQueryTimeoutMs }.
 * @param {Date} [args.now]
 * @returns the dossier (see validateDossier). Never throws for lookup
 *          failures — those land in gaps. Throws TypeError for a malformed
 *          claim or a missing lookup: a caller error, not evidence.
 */
export async function runInvestigation({ claim, lookup, limits = {}, now = new Date() } = {}) {
  if (typeof lookup !== 'function') {
    throw new TypeError('an investigation needs an injected lookup function — the investigator holds no lookup capability of its own');
  }
  const plan = buildInvestigationPlan(claim); // throws on a malformed claim
  if (claim.provenanceRecord !== undefined && claim.provenanceRecord !== null) {
    const check = validateProvenanceRecord(claim.provenanceRecord);
    if (!check.valid) throw new TypeError(`claim.provenanceRecord is invalid: ${check.errors.join('; ')}`);
  }
  const maxQueries = limits.maxQueries ?? DEFAULT_INVESTIGATION_LIMITS.maxQueries;
  const perQueryTimeoutMs = limits.perQueryTimeoutMs ?? DEFAULT_INVESTIGATION_LIMITS.perQueryTimeoutMs;
  if (!Number.isInteger(maxQueries) || maxQueries < 1) throw new TypeError('limits.maxQueries must be a positive integer');
  if (!Number.isFinite(perQueryTimeoutMs) || perQueryTimeoutMs < 1) throw new TypeError('limits.perQueryTimeoutMs must be a positive number');

  const evidence = [];
  const rejected = [];
  const gaps = [];
  const seenEvidenceIds = new Set();

  const runnable = plan.slice(0, maxQueries);
  for (const skipped of plan.slice(maxQueries)) {
    gaps.push({ queryId: skipped.queryId, category: skipped.category, subject: skipped.subject, reason: 'not run: investigation query budget exhausted' });
  }

  for (const subquery of runnable) {
    let items;
    try {
      items = await callLookup(lookup, subquery, perQueryTimeoutMs);
    } catch (err) {
      gaps.push({ queryId: subquery.queryId, category: subquery.category, subject: subquery.subject, reason: `lookup failed: ${err?.message ?? String(err)}` });
      continue;
    }
    if (!Array.isArray(items)) {
      gaps.push({ queryId: subquery.queryId, category: subquery.category, subject: subquery.subject, reason: 'lookup returned a non-array result' });
      continue;
    }
    for (const item of items) {
      const check = validateEvidenceItem(item);
      if (!check.valid) {
        rejected.push({ queryId: subquery.queryId, evidenceId: item?.evidenceId ?? null, errors: check.errors });
        continue;
      }
      if (item.category !== subquery.category) {
        rejected.push({ queryId: subquery.queryId, evidenceId: item.evidenceId, errors: [`evidence category ${item.category} does not answer sub-query category ${subquery.category}`] });
        continue;
      }
      if (seenEvidenceIds.has(item.evidenceId)) {
        rejected.push({ queryId: subquery.queryId, evidenceId: item.evidenceId, errors: ['duplicate evidenceId — the first occurrence stands'] });
        continue;
      }
      seenEvidenceIds.add(item.evidenceId);
      evidence.push({ ...item, queryId: subquery.queryId, independent: isIndependentEvidence(item, claim) });
    }
  }

  const { vector, inputs } = scoreDossier(evidence, claim);
  const findings = {};
  for (const category of INVESTIGATION_CATEGORIES) findings[category] = [];
  for (const item of evidence) findings[item.category].push(item.evidenceId);

  const dossier = {
    schema: DOSSIER_SCHEMA_VERSION,
    dossierId: `dossier-${claim.claimId}`,
    claimId: claim.claimId,
    claimText: claim.claimText,
    subject: { authors: [...(claim.authors ?? [])], institutions: [...(claim.institutions ?? [])] },
    generatedAt: now.toISOString(),
    status: gaps.length || rejected.length ? 'partial' : 'complete',
    plan,
    evidence,
    findings,
    undisclosedConflicts: evidence
      .filter((i) => i.financialConflict && i.financialConflict.disclosed === false)
      .map((i) => i.evidenceId),
    rejected,
    gaps,
    vectorInputs: inputs,
    contestationVector: vector,
    primaryProvenanceRecord: claim.provenanceRecord ?? null,
    isolation: investigatorIsolation(),
  };
  const check = validateDossier(dossier);
  if (!check.valid) throw new Error(`investigator produced an invalid dossier: ${check.errors.join('; ')}`);
  return dossier;
}

/**
 * The bridge back to Milestone 1: the claim object the pre-response
 * guardrail hook consumes — the primary source's provenance record plus the
 * vector this investigation computed.
 */
export function toGuardrailClaim(dossier) {
  if (!dossier || typeof dossier !== 'object') throw new TypeError('toGuardrailClaim needs a dossier');
  return {
    claimId: dossier.claimId,
    provenanceRecord: dossier.primaryProvenanceRecord ?? undefined,
    contestationVector: dossier.contestationVector ?? undefined,
  };
}

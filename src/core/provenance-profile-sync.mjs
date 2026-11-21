// Milestone 4 of the provenance verification build (specification: Scribe
// 1154, Stage 4 + Milestone 4) — Profile Sync Integration for the weighting
// profile.
//
// WHAT SYNCS, AND WHY IT IS THE PROFILE AND NOT THE POLICY. A user's
// weighting choices are seven numbers (the Milestone 1 weighting profile).
// The Milestone 3 ruleset is DERIVED from those numbers by
// buildProvenancePolicy. So the thing that travels between a user's devices
// and agents is the profile, in one small deterministic file; every surface
// rebuilds the identical policy from it on arrival. A file that carries a
// policy disagreeing with its own profile is rejected — the policy is never
// independently editable in transit, so a synced ruleset cannot be quietly
// rewritten by editing the file's second half.
//
// THE FILE. `.helmion/provenance/weighting-profile.json` inside the
// workspace — the same state directory the provenance ledger already lives
// in (.helmion/audit). Its bytes are deterministic for a given profile and
// timestamp (sorted keys, fixed shape), so the existing Profile Sync job
// system (src/cloud/profile-sync.mjs), which already moves rendered files
// cloud -> PC bridge -> disk and verifies them by sha256 read-back, can
// carry and check this file with no new transport. Wiring it into the
// Agent OS kit render is the follow-up integration; this module is the
// contract that wiring will carry.
//
// CONFIG EXPOSURE. WEIGHTING_SLIDERS is the Helmian config contract: one
// slider descriptor per profile field, labelled in the specification's own
// language ("Financial Independence Weight", "Institutional Consensus
// Weight", …), each 0..1. A settings surface renders these; it does not
// invent its own list, so the sliders a user sees are exactly the numbers
// the guardrails run on.
//
// FAIL CLOSED, as everywhere in this build: a synced file that is missing
// is simply "no sync yet" (defaults, named as such); a synced file that is
// present but unreadable, the wrong version, or internally inconsistent
// throws ProvenanceProfileSyncError. Running on silent defaults while a
// corrupt profile sits on disk would be a lie about what the user set.

import {
  DEFAULT_WEIGHTING_PROFILE,
  resolveWeightingProfile,
  validateWeightingProfile,
} from './provenance-verification.mjs';
import {
  buildProvenancePolicy,
  validateProvenancePolicy,
} from './provenance-policy.mjs';

export const PROVENANCE_PROFILE_SYNC_VERSION = 1;
export const PROVENANCE_PROFILE_KIND = 'provenance-weighting-profile';
export const PROVENANCE_PROFILE_RELATIVE_PATH = '.helmion/provenance/weighting-profile.json';

export class ProvenanceProfileSyncError extends Error {}

/* ── The config surface: one slider per profile field ────────────────────── */

export const WEIGHTING_SLIDERS = Object.freeze([
  { key: 'provenanceWeight', label: 'Provenance Weight', min: 0, max: 1, step: 0.05,
    description: 'How much a source\'s cryptographic attribution chain counts toward its claims.' },
  { key: 'financialIndependenceWeight', label: 'Financial Independence Weight', min: 0, max: 1, step: 0.05,
    description: 'How much weight independent, conflict-free evidence carries against interested sources.' },
  { key: 'institutionalConsensusWeight', label: 'Institutional Consensus Weight', min: 0, max: 1, step: 0.05,
    description: 'How much the institutional consensus cluster counts toward a settled reading.' },
  { key: 'replicationWeight', label: 'Replication Weight', min: 0, max: 1, step: 0.05,
    description: 'How much independent replication counts toward a claim standing.' },
  { key: 'highContestationConsensusMax', label: 'Contestation: Consensus Ceiling', min: 0, max: 1, step: 0.05,
    description: 'At or below this consensus ratio, a claim counts as contested when dissent is rigorous.' },
  { key: 'highContestationDissentRigorMin', label: 'Contestation: Dissent Rigor Floor', min: 0, max: 1, step: 0.05,
    description: 'At or above this dissent rigor, dissent counts as rigorous for the contestation test.' },
  { key: 'quarantineIndependenceMax', label: 'Quarantine: Independence Ceiling', min: 0, max: 1, step: 0.05,
    description: 'An undisclosed financial conflict with independence at or below this level quarantines the claim.' },
]);

/** The slider keys and the profile keys are the same set — pinned by test. */
export function sliderKeys() {
  return WEIGHTING_SLIDERS.map((s) => s.key);
}

/* ── The sync payload ────────────────────────────────────────────────────── */

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/**
 * Build the payload that syncs. The profile is stored RESOLVED (all seven
 * numbers, defaults filled), so a receiving surface never guesses which
 * fields a partial profile meant to leave alone — what syncs is the whole
 * effective profile, and a later edit syncs the new whole.
 */
export function createProvenanceSyncPayload(profile = null, { now = new Date(), source = null } = {}) {
  const resolved = resolveWeightingProfile(profile);
  const payload = {
    kind: PROVENANCE_PROFILE_KIND,
    version: PROVENANCE_PROFILE_SYNC_VERSION,
    updatedAt: now.toISOString(),
    source: source ? String(source).slice(0, 200) : null,
    profile: resolved,
    policy: buildProvenancePolicy(resolved),
  };
  const check = validateProvenanceSyncPayload(payload);
  if (!check.valid) throw new ProvenanceProfileSyncError(check.errors.join('; '));
  return payload;
}

/**
 * Validate a payload — including the integrity rule: the carried policy
 * must be EXACTLY the policy the carried profile builds. Anything else is
 * a tampered or stale file, and it is refused whole.
 */
export function validateProvenanceSyncPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['a sync payload must be an object'] };
  }
  if (payload.kind !== PROVENANCE_PROFILE_KIND) errors.push(`kind must be ${PROVENANCE_PROFILE_KIND}`);
  if (payload.version !== PROVENANCE_PROFILE_SYNC_VERSION) {
    errors.push(`version must be ${PROVENANCE_PROFILE_SYNC_VERSION}`);
  }
  if (typeof payload.updatedAt !== 'string' || Number.isNaN(Date.parse(payload.updatedAt))) {
    errors.push('updatedAt must be an ISO timestamp');
  }
  const profileCheck = validateWeightingProfile(payload.profile);
  if (!profileCheck.valid) errors.push(...profileCheck.errors.map((e) => `profile: ${e}`));
  if (payload.profile && profileCheck.valid) {
    // A synced profile must be complete: every field present, so the
    // receiver runs the sender's whole intent, not a merge with its own
    // local defaults.
    for (const key of Object.keys(DEFAULT_WEIGHTING_PROFILE)) {
      if (!(key in payload.profile)) errors.push(`profile is missing ${key} — a synced profile is complete or it does not sync`);
    }
  }
  if (errors.length === 0) {
    try {
      validateProvenancePolicy(payload.policy);
      const expected = buildProvenancePolicy(resolveWeightingProfile(payload.profile));
      if (JSON.stringify(sortKeys(payload.policy)) !== JSON.stringify(sortKeys(expected))) {
        errors.push('the carried policy does not match the policy its profile builds — refusing a tampered or stale payload');
      }
    } catch (err) {
      errors.push(`policy: ${err?.message ?? String(err)}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** The deterministic file bytes for a payload. Same payload, same bytes —
 *  the property the Profile Sync sha256 read-back check relies on. */
export function renderProvenanceProfileFile(payload) {
  const check = validateProvenanceSyncPayload(payload);
  if (!check.valid) throw new ProvenanceProfileSyncError(check.errors.join('; '));
  return `${JSON.stringify(sortKeys(payload), null, 2)}\n`;
}

/** Parse file bytes back into a validated payload, or throw, naming why. */
export function parseProvenanceProfileFile(content) {
  let payload;
  try {
    payload = JSON.parse(String(content ?? ''));
  } catch (err) {
    throw new ProvenanceProfileSyncError(`the synced weighting profile is not readable JSON: ${err?.message ?? String(err)}`);
  }
  const check = validateProvenanceSyncPayload(payload);
  if (!check.valid) throw new ProvenanceProfileSyncError(check.errors.join('; '));
  return payload;
}

/**
 * The receiving end: a payload becomes the two things surfaces consume —
 * the resolved weighting profile (for the Milestone 1 core) and the built
 * policy (for the Milestone 3 evaluator).
 */
export function applyProvenanceSyncPayload(payload) {
  const check = validateProvenanceSyncPayload(payload);
  if (!check.valid) throw new ProvenanceProfileSyncError(check.errors.join('; '));
  return {
    profile: resolveWeightingProfile(payload.profile),
    policy: payload.policy,
    updatedAt: payload.updatedAt,
    // Named `origin`, not `source`: the store's result uses `source` for
    // WHERE the profile came from ('synced' vs 'default'), and the two
    // meanings must never overwrite each other.
    origin: payload.source ?? null,
  };
}

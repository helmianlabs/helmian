// Governance action identity for the Tier-B advisory consensus gate.
//
// helmion.advisory_reviews.action_hash is `not null references
// helmion.governance_actions(action_hash)` (sql/001_helmion.sql:83). That
// foreign key is the immutability anchor behind the tool description at
// src/mcp/server.mjs:43 — "Record one read-only advisor vote for an immutable
// action hash." It only means anything if the hash is a COMMITMENT to the
// operation rather than a caller-chosen label, so the hash is derived here from
// the canonical operation JSON and never accepted from the caller.
//
// Registering an action approves nothing. consensusStatus (src/core/governance.mjs:188-194)
// returns approved:false / requires_human_approval:true for every Tier B action
// no matter how many advisors vote. Human authorization stays with the Ed25519
// confirmation path (docs/HUMAN_CONFIRMATIONS.md). So an agent registering the
// action it wants reviewed cannot manufacture its own approval, which is why
// this has a writer while helmion.human_identity_keys deliberately does not.

import { createHash } from 'node:crypto';
import { canonicalJson } from './maestro.mjs';

export const GOVERNANCE_ACTION_AUDIENCE = 'helmion.governance_action.v1';

export class UnregisteredGovernanceActionError extends Error {
  constructor(actionHash) {
    super(
      `Governance action ${actionHash} is not registered. Advisor votes are `
      + 'bound to an immutable operation, so the action must be registered '
      + 'first — call helmion_register_action (store.registerGovernanceAction) '
      + 'with the exact operation being reviewed, then record the vote against '
      + 'the action_hash it returns.',
    );
    this.name = 'UnregisteredGovernanceActionError';
    this.actionHash = actionHash;
  }
}

export function assertOperationShape(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('operation must be a JSON object describing the exact action under review');
  }
  return operation;
}

// Key order must not change the hash — two sessions describing the same
// operation have to land on the same action, or advisor votes silently split
// across two hashes and consensus can never complete.
export function governanceActionHash(operation) {
  assertOperationShape(operation);
  return createHash('sha256')
    .update(canonicalJson({ audience: GOVERNANCE_ACTION_AUDIENCE, operation }))
    .digest('hex');
}

export function assertActionHashMatches(actionHash, operation) {
  const expected = governanceActionHash(operation);
  if (String(actionHash) !== expected) {
    throw new Error(
      `The supplied operation does not hash to the registered action: expected ${expected}, `
      + `got ${actionHash}. Advisor votes are bound to the exact operation that was reviewed; `
      + 'checking consensus against a different operation would inherit votes that were never cast for it.',
    );
  }
  return expected;
}

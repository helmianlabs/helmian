import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PILOT_DECISION,
  evaluatePilotAction,
} from '../src/core/pilot-policy.mjs';

test('explicit local reversible bounded work auto-runs inside clear guardrails', () => {
  const result = evaluatePilotAction({
    kind: 'local-code-edit',
    description: 'Add unit coverage for the local parser',
    pilotScope: 'local-workspace',
    wellBounded: true,
    reversible: true,
    sensitiveData: false,
  });
  assert.equal(result.decision, PILOT_DECISION.AUTO_RUN);
  assert.equal(result.tier, 'A');
  assert.equal(result.owner_confirmation_required, false);
});

test('protected boundaries and ambiguous work pause for an owner decision', () => {
  const migration = evaluatePilotAction({
    description: 'Apply migration 003',
    migration: true,
    pilotScope: 'shared-development',
  });
  assert.equal(migration.decision, PILOT_DECISION.PAUSE_FOR_OWNER);
  assert.equal(migration.tier, 'B');
  assert.equal(migration.owner_confirmation_required, true);
  assert.equal(migration.advisor_consensus_can_authorize, false);

  const ambiguous = evaluatePilotAction({
    description: 'Change something',
  });
  assert.equal(ambiguous.decision, PILOT_DECISION.PAUSE_FOR_OWNER);
  assert.match(ambiguous.reasons.join(' '), /ambiguous action defaults to owner review/);
});

test('deterministic guard blocks cannot be bypassed by owner confirmation', () => {
  const result = evaluatePilotAction(
    {
      description: 'Force-delete generated files',
      destructive: true,
      pilotScope: 'local-workspace',
    },
    { guardBlocked: true },
  );
  assert.equal(result.decision, PILOT_DECISION.BLOCK);
  assert.equal(result.owner_confirmation_required, false);
  assert.match(result.reasons.join(' '), /destructive-operation guard blocked/);
});
